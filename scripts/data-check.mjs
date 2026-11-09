#!/usr/bin/env node
// ─── data-check: read-only integrity check of every store the tester writes ───
// Cross-checks the saved runs (results/runs/test-NNN), the runs index, the SQLite
// DB (results, error_logs, sol_channels) and the leftover-dir rules. It never writes.
// Two overwrite bugs were found by hand on 2026-10-20 (test-plan into #79, run-load
// into #88); this makes that class of damage visible in one command.
//
//   node scripts/data-check.mjs            human report, exit 1 on any problem
//   node scripts/data-check.mjs --json     machine report
//   node scripts/data-check.mjs --root <dir>   check another copy (tests use this)
//   node scripts/data-check.mjs --repair <num>[,<num>] [--write]
//       rebuild a saved run's results.json + index totals from the DB rows recorded
//       inside that run's own time window (latest row per node). Dry run unless
//       --write; --write keeps the old file as results.json.before-repair-<ts>.
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const ROOT = path.resolve(opt('--root') || path.join(HERE, '..'));
const RESULTS_DIR = path.join(ROOT, 'results');
const RUNS_DIR = path.join(RESULTS_DIR, 'runs');
const DB_PATH = path.join(ROOT, 'data', 'audit.db');
const CLIENTS_DIR = path.join(RESULTS_DIR, 'clients');
// A row stamped this long after its run's saved end did not come from that run.
const LATE_ROW_SLACK_MS = 15_000;
// Channels still "open"/"closing" this long after opening have missed the sweep.
const STUCK_CHANNEL_MS = 6 * 3600_000;

const problems = [];
const warnings = [];
const info = {};
const problem = (code, msg) => problems.push({ code, msg });
const warn = (code, msg) => warnings.push({ code, msg });

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function rowTime(r) {
  const t = Date.parse(r?.timestamp || r?.testedAt || '');
  return Number.isFinite(t) ? t : null;
}

// ─── Runs index ───
let index = { runs: [], activeRun: null };
const indexFile = path.join(RUNS_DIR, 'index.json');
if (!existsSync(indexFile)) {
  warn('NO_INDEX', 'results/runs/index.json does not exist (no saved runs yet)');
} else {
  try {
    index = readJson(indexFile);
  } catch (err) {
    problem('INDEX_CORRUPT', `index.json does not parse: ${err.message}`);
  }
}
const runs = Array.isArray(index.runs) ? index.runs : [];
info.savedRuns = runs.length;

const seen = new Set();
let prevNum = -Infinity;
for (const r of runs) {
  if (seen.has(r.number)) problem('RUN_NUMBER_DUP', `run number ${r.number} appears twice in the index`);
  seen.add(r.number);
  if (r.number <= prevNum) problem('RUN_NUMBER_ORDER', `run ${r.number} listed after ${prevNum}`);
  prevNum = r.number;
}
if (index.activeRun != null && !existsSync(path.join(RUNS_DIR, `test-${String(index.activeRun).padStart(3, '0')}`))) {
  problem('ACTIVE_RUN_MISSING', `index.activeRun = ${index.activeRun} but its folder does not exist`);
}

// ─── Database (read-only) ───
let db = null;
if (existsSync(DB_PATH)) {
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (err) {
    problem('DB_OPEN', `cannot open ${DB_PATH} read-only: ${err.message}`);
  }
} else {
  warn('NO_DB', 'data/audit.db does not exist');
}
const dbRows = db ? db.prepare('SELECT id, node_addr, tested_at FROM results WHERE run_id = ? ORDER BY tested_at, id') : null;
const dbRun = db ? db.prepare('SELECT finished_at FROM runs WHERE id = ?') : null;

/** A saved run's end: the later of the index date and the DB run's finish (retests extend it). */
function runEnd(r) {
  const idx = Date.parse(r.date || '');
  const fin = db && r.dbRunId != null ? Number(dbRun.get(Number(r.dbRunId))?.finished_at) || null : null;
  const ends = [idx, fin].filter(Number.isFinite);
  return ends.length ? Math.max(...ends) : null;
}

/** DB rows recorded inside the run's own window, and the ones written later under its id. */
function windowRows(r) {
  const all = dbRows.all(Number(r.dbRunId));
  const end = runEnd(r);
  if (end == null) return { inside: all, after: [] };
  return {
    inside: all.filter((x) => x.tested_at <= end + LATE_ROW_SLACK_MS),
    after: all.filter((x) => x.tested_at > end + LATE_ROW_SLACK_MS),
  };
}

/** Same rule as server.js writeRunFailures: the run's own nodes, inside its own span. */
function ownFailureFilter(rows) {
  const nodes = new Set(rows.map((x) => x.address));
  const times = rows.map(rowTime).filter((t) => t != null);
  const from = times.length ? Math.min(...times) - 15 * 60_000 : -Infinity;
  const to = times.length ? Math.max(...times) + 60_000 : Infinity;
  return (j) => {
    const t = Date.parse(j.ts || '');
    return nodes.has(j.node) && (!Number.isFinite(t) || (t >= from && t <= to));
  };
}

// ─── Each saved run: folder, rows, index totals, DB rows, timestamps, failures ───
let foreignFailureRuns = 0;
let fixedFailureRuns = 0;
for (const r of runs) {
  const num = r.number;
  const dir = path.join(RUNS_DIR, `test-${String(num).padStart(3, '0')}`);
  const file = path.join(dir, 'results.json');
  if (!existsSync(file)) { problem('RUN_FILE_MISSING', `#${num}: ${path.relative(ROOT, file)} missing`); continue; }
  let rows;
  try {
    rows = readJson(file);
  } catch (err) {
    problem('RUN_FILE_CORRUPT', `#${num}: results.json does not parse: ${err.message}`);
    continue;
  }
  if (!Array.isArray(rows)) { problem('RUN_FILE_SHAPE', `#${num}: results.json is not an array`); continue; }

  if (Number(r.total) !== rows.length) {
    problem('RUN_TOTAL_MISMATCH', `#${num}: index says ${r.total} nodes, results.json has ${rows.length}`);
  }
  const passed = rows.filter((x) => x.actualMbps != null).length;
  if (r.passed != null && Number(r.passed) !== passed) {
    problem('RUN_PASSED_MISMATCH', `#${num}: index says ${r.passed} passed, results.json has ${passed}`);
  }

  // Rows stamped well after the run's end (retests included) were written by a later action.
  const end = runEnd(r);
  if (end != null) {
    const late = rows.filter((x) => { const t = rowTime(x); return t != null && t > end + LATE_ROW_SLACK_MS; });
    if (late.length) problem('RUN_LATE_ROWS', `#${num}: ${late.length} row(s) stamped after the run ended (${new Date(end).toISOString()}) — repair with --repair ${num}`);
  }

  // The file's nodes must equal the nodes the DB recorded inside this run's window.
  if (db && r.dbRunId != null) {
    const { inside, after } = windowRows(r);
    const inDb = new Set(inside.map((x) => x.node_addr));
    if (after.length) warn('DB_MISFILED_ROWS', `#${num}: DB run ${r.dbRunId} holds ${after.length} row(s) written after the run ended (result id ${after.map((x) => x.id).join(', ')}) — another action recorded under this run's DB id`);
    if (inDb.size === 0 && rows.length) {
      warn('RUN_NO_DB_ROWS', `#${num}: DB run ${r.dbRunId} has no result rows inside the run`);
    } else {
      const foreign = rows.filter((x) => x.address && !inDb.has(x.address));
      if (foreign.length) problem('RUN_FOREIGN_ROWS', `#${num}: ${foreign.length} row(s) not recorded under DB run ${r.dbRunId} during the run (${foreign.map((x) => x.address.slice(0, 8)).join(', ')})`);
      const fileAddrs = new Set(rows.map((x) => x.address));
      const missing = [...inDb].filter((a) => !fileAddrs.has(a));
      if (missing.length) problem('RUN_MISSING_ROWS', `#${num}: DB run ${r.dbRunId} has ${missing.length} node(s) absent from results.json (${missing.map((a) => a.slice(0, 8)).join(', ')}) — repair with --repair ${num}`);
    }
  }

  // A run's failures.jsonl holds only its own nodes inside its own span (server.js writeRunFailures).
  const fail = path.join(dir, 'failures.jsonl');
  if (existsSync(fail)) {
    const own = ownFailureFilter(rows);
    const lines = readFileSync(fail, 'utf8').split('\n').filter(Boolean);
    const keep = [];
    let corrupt = false;
    for (const l of lines) {
      try {
        if (own(JSON.parse(l))) keep.push(l);
      } catch (err) {
        problem('FAILURES_CORRUPT', `#${num}: failures.jsonl has an unparseable line (${err.message})`);
        corrupt = true;
        break;
      }
    }
    if (!corrupt && keep.length !== lines.length) {
      foreignFailureRuns++;
      if (flag('--fix-failures') && flag('--write')) {
        writeFileSync(`${fail}.tmp`, keep.length ? keep.join('\n') + '\n' : '', 'utf8');
        renameSync(`${fail}.tmp`, fail);
        fixedFailureRuns++;
      }
    }
  }
}
if (foreignFailureRuns) {
  if (fixedFailureRuns) info.failuresFixed = fixedFailureRuns;
  else warn('FAILURES_NOT_PER_RUN', `${foreignFailureRuns} saved run(s) carry other runs' failures in failures.jsonl — clean with --fix-failures --write`);
}

// ─── Repair: rebuild runs from the DB rows inside their own window ───
const repairArg = opt('--repair');
const repairs = [];
if (repairArg) {
  if (!db) throw new Error('--repair needs data/audit.db');
  const rawOne = db.prepare('SELECT raw_json FROM results WHERE id = ?');
  const write = flag('--write');
  for (const num of repairArg.split(',').map(Number).filter(Number.isFinite)) {
    const meta = runs.find((x) => x.number === num);
    if (!meta || meta.dbRunId == null) { repairs.push({ num, error: 'not in the index or no DB run id' }); continue; }
    // Latest row per node, in first-tested order, from the run's own window.
    const latest = new Map();
    for (const x of windowRows(meta).inside) { latest.delete(x.node_addr); latest.set(x.node_addr, x); }
    const rebuilt = [];
    for (const x of latest.values()) {
      const rawFile = path.join(RESULTS_DIR, 'raw', `run-${meta.dbRunId}`, `${x.id}.json`);
      const raw = existsSync(rawFile) ? readFileSync(rawFile, 'utf8') : rawOne.get(x.id)?.raw_json;
      if (!raw) { repairs.push({ num, error: `result ${x.id} has no raw JSON (file or column)` }); rebuilt.length = 0; break; }
      rebuilt.push(JSON.parse(raw));
    }
    if (!rebuilt.length) continue;
    const passed = rebuilt.filter((x) => x.actualMbps != null);
    const totals = { total: rebuilt.length, passed: passed.length, failed: rebuilt.length - passed.length, pass10: passed.filter((x) => x.actualMbps >= 10).length };
    const entry = { num, rows: rebuilt.map((x) => `${x.address.slice(0, 8)}:${x.errorCode || x.actualMbps}`), totals, written: false };
    if (write) {
      const dir = path.join(RUNS_DIR, `test-${String(num).padStart(3, '0')}`);
      const file = path.join(dir, 'results.json');
      if (existsSync(file)) copyFileSync(file, `${file}.before-repair-${Date.now()}`);
      writeFileSync(`${file}.tmp`, JSON.stringify(rebuilt, null, 2), 'utf8');
      renameSync(`${file}.tmp`, file);
      Object.assign(meta, totals);
      entry.written = true;
    }
    repairs.push(entry);
  }
  if (write && repairs.some((x) => x.written)) {
    writeFileSync(`${indexFile}.tmp`, JSON.stringify(index, null, 2), 'utf8');
    renameSync(`${indexFile}.tmp`, indexFile);
  }
  info.repairs = repairs;
}

// ─── DB-only checks ───
if (db) {
  const orphanLogs = db.prepare('SELECT COUNT(*) n FROM error_logs e LEFT JOIN results r ON r.id = e.result_id WHERE r.id IS NULL').get().n;
  if (orphanLogs) problem('ERROR_LOG_ORPHAN', `${orphanLogs} error_logs row(s) point at a missing result`);
  const failedNoLog = db.prepare(`SELECT COUNT(*) n FROM results r WHERE r.actual_mbps IS NULL AND r.error_code IS NOT NULL AND r.error_code != 'TEST_RUN_SKIP'
    AND NOT EXISTS (SELECT 1 FROM error_logs e WHERE e.result_id = r.id)`).get().n;
  if (failedNoLog) warn('FAILED_NO_LOG', `${failedNoLog} failed result(s) have no error_logs row`);

  const hasChannels = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sol_channels'").get();
  if (hasChannels) {
    const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM sol_channels GROUP BY status').all().map((x) => [x.status, x.n]));
    info.channels = byStatus;
    const stuck = db.prepare("SELECT address, status, opened_at FROM sol_channels WHERE status IN ('open','closing') AND opened_at < ?").all(Date.now() - STUCK_CHANNEL_MS);
    for (const c of stuck) problem('CHANNEL_STUCK', `channel ${c.address.slice(0, 8)} still ${c.status} ${Math.round((Date.now() - c.opened_at) / 3600_000)} h after opening`);
    const closedNoAmount = db.prepare("SELECT COUNT(*) n FROM sol_channels WHERE status = 'closed' AND redeemed_base IS NULL AND refunded_base IS NULL").get().n;
    if (closedNoAmount) warn('CHANNEL_NO_AMOUNTS', `${closedNoAmount} closed channel(s) have no redeemed/refunded amounts`);
  }
  db.close();
}

// ─── Leftovers ───
if (existsSync(CLIENTS_DIR)) {
  const left = readdirSync(CLIENTS_DIR).filter((n) => statSync(path.join(CLIENTS_DIR, n)).isDirectory());
  if (left.length) warn('CLIENT_DIRS', `${left.length} client session dir(s) in results/clients (each may hold a key copy; removed at next boot or run start)`);
}

// ─── Report ───
const out = { root: ROOT, ok: problems.length === 0, problems, warnings, info };
if (flag('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`data-check ${ROOT}`);
  console.log(`  saved runs: ${info.savedRuns}${info.channels ? ` · channels ${JSON.stringify(info.channels)}` : ''}`);
  for (const p of problems) console.log(`  ✗ ${p.code}  ${p.msg}`);
  for (const w of warnings) console.log(`  ⚠ ${w.code}  ${w.msg}`);
  for (const x of repairs) {
    console.log(x.error
      ? `  repair #${x.num}: ${x.error}`
      : `  repair #${x.num}: ${x.written ? 'WROTE' : 'would write'} ${x.totals.total} row(s) [${x.rows.join(' ')}]${x.written ? '' : ' (dry run; add --write)'}`);
  }
  console.log(problems.length ? `${problems.length} problem(s), ${warnings.length} warning(s)` : `0 problems, ${warnings.length} warning(s)`);
}
process.exit(problems.length ? 1 : 0);
