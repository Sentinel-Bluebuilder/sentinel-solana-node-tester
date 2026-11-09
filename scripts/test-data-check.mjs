#!/usr/bin/env node
// ─── data-check fixture test ───
// Builds a throwaway results/ + data/audit.db holding the damage found on 2026-10-20
// (a saved run overwritten by a later action, a foreign failure line, a leftover client
// dir) and asserts data-check finds each one, then repairs back to 0 problems.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, 'data-check.mjs');
let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
function run(root, ...extra) {
  const r = spawnSync(process.execPath, [CHECK, '--root', root, '--json', ...extra], { encoding: 'utf8' });
  try {
    return { code: r.status, ...JSON.parse(r.stdout) };
  } catch (err) {
    throw new Error(`data-check output did not parse (${err.message}): ${r.stdout}${r.stderr}`);
  }
}
const codes = (list) => list.map((x) => x.code);

// ─── Fixture ───
const root = mkdtempSync(path.join(tmpdir(), 'snt-datacheck-'));
const runsDir = path.join(root, 'results', 'runs');
mkdirSync(path.join(root, 'data'), { recursive: true });
mkdirSync(runsDir, { recursive: true });
const t0 = Date.parse('2026-10-20T10:00:00Z');
const row = (address, t, mbps, errorCode = null) => ({ address, type: 'WireGuard', actualMbps: mbps, errorCode, error: errorCode ? 'x' : null, timestamp: new Date(t).toISOString() });

const db = new Database(path.join(root, 'data', 'audit.db'));
db.exec(`
  CREATE TABLE runs (id INTEGER PRIMARY KEY, started_at INTEGER, finished_at INTEGER, mode TEXT);
  CREATE TABLE results (id INTEGER PRIMARY KEY, run_id INTEGER, node_addr TEXT, tested_at INTEGER, actual_mbps REAL, error_code TEXT, raw_json TEXT);
  CREATE TABLE error_logs (id INTEGER PRIMARY KEY, result_id INTEGER);
  CREATE TABLE sol_channels (address TEXT PRIMARY KEY, status TEXT, opened_at INTEGER, redeemed_base INTEGER, refunded_base INTEGER);
`);
const insRes = db.prepare('INSERT INTO results (id, run_id, node_addr, tested_at, actual_mbps, error_code, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)');

// Run #1 — healthy: A passed, B failed (with its error log).
const a = row('AAAAAAAAAAAAAAAA', t0, 12.5);
const b = row('BBBBBBBBBBBBBBBB', t0 + 10_000, null, 'UNREACHABLE');
db.prepare('INSERT INTO runs VALUES (1, ?, ?, ?)').run(t0 - 5_000, t0 + 20_000, 'p2p');
insRes.run(1, 1, a.address, t0, 12.5, null, JSON.stringify(a));
insRes.run(2, 1, b.address, t0 + 10_000, null, 'UNREACHABLE', JSON.stringify(b));
db.prepare('INSERT INTO error_logs (result_id) VALUES (2)').run();

// Run #2 — overwritten: C was tested in the run; D was recorded 10 min after it ended
// under the same DB run (the test-plan bug) and the file now holds only D.
const t1 = t0 + 3600_000;
const c = row('CCCCCCCCCCCCCCCC', t1, 30);
const d = row('DDDDDDDDDDDDDDDD', t1 + 600_000, 8);
db.prepare('INSERT INTO runs VALUES (2, ?, ?, ?)').run(t1 - 5_000, t1 + 5_000, 'p2p');
insRes.run(3, 2, c.address, t1, 30, null, JSON.stringify(c));
insRes.run(4, 2, d.address, t1 + 600_000, 8, null, JSON.stringify(d));
db.prepare("INSERT INTO sol_channels VALUES ('chan1', 'closed', ?, 1000, 0)").run(t0);
db.close();

const save = (num, rows, failures = []) => {
  const dir = path.join(runsDir, `test-${String(num).padStart(3, '0')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'results.json'), JSON.stringify(rows));
  writeFileSync(path.join(dir, 'failures.jsonl'), failures.map((f) => JSON.stringify(f)).join('\n') + (failures.length ? '\n' : ''));
};
save(1, [a, b], [
  { ts: new Date(t0 + 10_000).toISOString(), node: b.address, error: 'x' },
  { ts: new Date(t1).toISOString(), node: 'ZZZZZZZZZZZZZZZZ', error: 'another run' },
]);
save(2, [d]);
writeFileSync(path.join(runsDir, 'index.json'), JSON.stringify({
  activeRun: 2,
  runs: [
    { number: 1, date: new Date(t0 + 20_000).toISOString(), total: 2, passed: 1, failed: 1, dbRunId: 1 },
    { number: 2, date: new Date(t1 + 5_000).toISOString(), total: 1, passed: 1, failed: 0, dbRunId: 2 },
  ],
}));
mkdirSync(path.join(root, 'results', 'clients', 'leftover'), { recursive: true });

// ─── Detect ───
console.log('data-check detects the damage');
const r1 = run(root);
check('exit 1 when a problem exists', r1.code === 1 && r1.ok === false, `code ${r1.code}`);
check('overwritten run: rows missing from the file', codes(r1.problems).includes('RUN_MISSING_ROWS'));
check('overwritten run: row from after the run', codes(r1.problems).includes('RUN_LATE_ROWS'));
check('overwritten run: row not recorded during the run', codes(r1.problems).includes('RUN_FOREIGN_ROWS'));
check('DB row filed under the wrong run', codes(r1.warnings).includes('DB_MISFILED_ROWS'));
check('foreign failure line', codes(r1.warnings).includes('FAILURES_NOT_PER_RUN'));
check('leftover client dir', codes(r1.warnings).includes('CLIENT_DIRS'));
check('healthy run raises nothing', !r1.problems.some((p) => p.msg.startsWith('#1:')), JSON.stringify(r1.problems));

// ─── Repair ───
console.log('repair restores the run');
const dry = run(root, '--repair', '2');
check('dry run writes nothing', JSON.parse(readFileSync(path.join(runsDir, 'test-002', 'results.json'), 'utf8'))[0].address === d.address && dry.info.repairs[0].written === false);
run(root, '--repair', '2', '--write');
const fixed = JSON.parse(readFileSync(path.join(runsDir, 'test-002', 'results.json'), 'utf8'));
check('run rebuilt from its own window', fixed.length === 1 && fixed[0].address === c.address, JSON.stringify(fixed.map((x) => x.address)));
const idx = JSON.parse(readFileSync(path.join(runsDir, 'index.json'), 'utf8'));
check('index totals follow', idx.runs[1].total === 1 && idx.runs[1].passed === 1);
run(root, '--fix-failures', '--write');
const fl = readFileSync(path.join(runsDir, 'test-001', 'failures.jsonl'), 'utf8').split('\n').filter(Boolean);
check('foreign failure line removed, own kept', fl.length === 1 && JSON.parse(fl[0]).node === b.address, JSON.stringify(fl));
const r2 = run(root);
check('0 problems after repair', r2.ok === true && r2.code === 0, JSON.stringify(r2.problems));

rmSync(root, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
