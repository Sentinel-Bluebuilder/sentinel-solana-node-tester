/**
 * Sentinel Node Tester — SQLite Persistence Layer
 * Opens/creates data/audit.db, runs migrations, exports prepared statements
 * and query helpers.
 *
 * Single-writer model: batch inserts are wrapped in db.transaction().
 * All timestamps are stored as unix milliseconds (INTEGER).
 */

import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { countryToContinent } from './countries.js';
import { RAW_DIR, DEFAULT_BATCH_RETENTION } from './constants.js';

// ─── Raw-JSON file offload ───────────────────────────────────────────────────
// The full JSON.stringify(result) blob is no longer stored inline in the
// results.raw_json column. Instead each result's blob is written to a per-run
// file: results/raw/run-<run_id>/<result_id>.json. The column is bound NULL
// going forward; readers transparently rehydrate from the file so the REST
// contract (er.raw_json as a JSON string) stays byte-identical.

/**
 * True when both ids are safe integer keys. result_id may arrive as a BigInt
 * (better-sqlite3 lastInsertRowid), so coerce via Number() for the check —
 * `Number.isInteger(Number(5n))` is true — while callers keep the original
 * value for the path string (BigInt stringifies cleanly). Guards against any
 * non-integer ever being interpolated into a filesystem path (defense-in-depth:
 * no `../` traversal if a stray string ever reaches these helpers).
 */
function _validRawJsonIds(run_id, result_id) {
  return Number.isInteger(Number(run_id)) && Number.isInteger(Number(result_id));
}

/**
 * True when the handle is an in-memory better-sqlite3 DB. `db.memory` is the
 * documented boolean (verified true for `new Database(':memory:')`, false for a
 * file path in this better-sqlite3 version); we fall back to the `:memory:`
 * name only if `db.memory` is somehow undefined on a future build.
 *
 * Why it matters: the raw_json file offload writes to a FIXED RAW_DIR that is
 * independent of which handle is active. An in-memory test DB issuing
 * (run_id, result_id) keys that collide with a real DB's rowids would overwrite
 * (or be served in place of) prod diagnostic blobs. In-memory handles therefore
 * keep raw_json inline and write no file at all.
 */
function _isMemoryDb(db) {
  if (db && typeof db.memory === 'boolean') return db.memory;
  return !!(db && db.name === ':memory:');
}

/** Deterministic path to a result's raw-json file. */
function rawJsonPath(run_id, result_id) {
  return path.join(RAW_DIR, `run-${run_id}`, `${result_id}.json`);
}

/**
 * Write the raw-json blob for a single result to its per-run file.
 * Logs but never throws — the file is a backup, not load-bearing for the insert
 * (mirrors pipeline.js raw-write philosophy). Works for :memory: DBs too since
 * the path is independent of the DB backend.
 *
 * NOTE: if this write fails, the row's raw_json column is already NULL and no
 * file exists, so the full-diag blob for that result is unrecoverable — the
 * admin drawer degrades to an empty diag block (it never errors). The audit
 * log + results/runs/* JSON still capture the run, so this is an accepted
 * tradeoff, but a logged write failure here means lost diag for that one row.
 *
 * @param {number} run_id
 * @param {number|bigint} result_id
 * @param {string} json - the JSON.stringify(result) string
 */
function writeRawJson(run_id, result_id, json) {
  if (!_validRawJsonIds(run_id, result_id)) {
    console.error(`[db] raw_json file write skipped: non-integer key (run_id=${run_id}, result_id=${result_id})`);
    return;
  }
  try {
    const dir = path.join(RAW_DIR, `run-${run_id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${result_id}.json`), json);
  } catch (e) {
    console.error('[db] raw_json file write failed:', e.message);
  }
}

/**
 * Read the raw-json blob for a result from its per-run file.
 *
 * @param {number} run_id
 * @param {number|bigint} result_id
 * @returns {string|null} the JSON string, or null if missing/unreadable
 */
export function readRawJson(run_id, result_id) {
  if (run_id == null || result_id == null) return null;
  if (!_validRawJsonIds(run_id, result_id)) return null;
  try {
    return readFileSync(rawJsonPath(run_id, result_id), 'utf8');
  } catch (e) {
    // A missing file is the expected forward-safe case (column was NULL and the
    // file was never written, or an old inline-blob row): stay silent — logging
    // per row would be noisy. Any OTHER fault (permissions, EISDIR, corrupt
    // read) is a real problem on a file that should exist — surface it.
    if (e && e.code !== 'ENOENT') {
      console.error('[db] raw_json file read failed:', e.message);
    }
    return null;
  }
}

/**
 * Mutate result rows in place: when raw_json is NULL/empty but run_id and id
 * are present, rehydrate raw_json from the per-run file. Keeps er.raw_json a
 * JSON string exactly as before the offload.
 *
 * @param {object[]} rows
 * @returns {object[]} the same array (mutated)
 */
function rehydrateRawJson(rows) {
  for (const row of rows) {
    if (!row || (row.raw_json != null && row.raw_json !== '')) continue;
    // Prefer result_id: getNodeErrors joins error_logs (el.*), so row.id is the
    // error_log id while result_id is the FK to results.id (the file key).
    // Plain results-table rows have only `id`, so fall back to it.
    const id = row.result_id ?? row.id;
    if (row.run_id != null && id != null) {
      row.raw_json = readRawJson(row.run_id, id);
    }
  }
  return rows;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH_REAL = path.join(DATA_DIR, 'audit.db');

// ─── Open / Create ───────────────────────────────────────────────────────────

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const _handles = { real: null };

/**
 * Returns the open Database instance, creating it on first call. Runs all
 * migrations automatically. Any scope param ('real', 'test', or a path) is
 * accepted for back-compat but always returns the single audit.db handle.
 *
 * @param {string} [which] - Ignored (back-compat). Pass ':memory:' for tests.
 * @returns {import('better-sqlite3').Database}
 */
export function getDb(which) {
  // Path-override path (test/back-compat): caller passed an actual file path
  // or ':memory:'. Don't cache; behave like the old getDb(dbPath) signature.
  if (typeof which === 'string' && (which === ':memory:' || path.isAbsolute(which) || which.endsWith('.db'))) {
    return _openHandle(which, /*cache*/ false);
  }

  if (_handles.real) return _handles.real;

  const db = _openHandle(DB_PATH_REAL, /*cache*/ false);
  _handles.real = db;
  return db;
}

function _openHandle(target, cache) {
  // Tripwire: prod DBs must never be opened from a test process.
  // A runaway continuous-loop test once wrote 55M rows to data/audit.db
  // before anyone noticed (WAL ballooned to 13GB). This hard-fails loudly
  // instead of silently accepting the writes.
  if (target !== ':memory:' && isTestEnv()) {
    throw new Error(
      `getDb() blocked: refusing to open prod DB (${target}) from a test process. ` +
      `Call useDb(getDb(":memory:")) at the top of your test's run() before any audit/* import.`
    );
  }

  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Wait up to 5s for a competing writer instead of failing immediately with
  // SQLITE_BUSY. Matters when ad-hoc scripts (backfill, probes, `node -e`
  // verifiers) run alongside the server.
  db.pragma('busy_timeout = 5000');
  runMigrations(db);

  // Row-count fuse: if the runs table is absurdly large, a runaway writer
  // has already struck. Refuse to start so the operator sees the damage
  // before it grows further.
  if (target !== ':memory:') {
    const row = db.prepare('SELECT COUNT(*) AS c FROM runs').get();
    if (row && row.c > 100_000) {
      db.close();
      throw new Error(
        `FATAL: runs table at ${target} has ${row.c.toLocaleString()} rows (limit: 100,000). ` +
        `This indicates a runaway writer. Run: node scripts/cleanup.mjs --fix`
      );
    }
  }

  return db;
}

function isTestEnv() {
  // Only fire when the PROCESS ITSELF is running a test file. We explicitly do
  // NOT check NODE_ENV alone because `security.test.js` spawns a real server
  // child with NODE_ENV=test — that child legitimately opens the prod DB.
  // Match only when argv[1] (the entry script) points into test/*.test.*js.
  const entry = (process.argv[1] || '').replace(/\\/g, '/');
  if (/\/test\/.*\.test\.m?js$/.test(entry)) return true;
  if (/\.smoke\.test\.m?js$/.test(entry)) return true;
  return false;
}

/**
 * Override the active singleton handle. Useful in tests:
 * `useDb(getDb(':memory:'))` redirects all helpers to an in-memory DB.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [which] - Ignored (back-compat).
 */
export function useDb(db, which) {
  // Match the pragmas _openHandle sets so test/in-memory DBs get the same
  // semantics as the prod handle (WAL is a no-op on :memory: but harmless).
  try { db.pragma('journal_mode = WAL'); }
  catch (e) { console.error('[db] useDb: WAL pragma failed:', e.message); }
  try { db.pragma('foreign_keys = ON'); }
  catch (e) { console.error('[db] useDb: foreign_keys pragma failed:', e.message); }
  try { db.pragma('busy_timeout = 5000'); }
  catch (e) { console.error('[db] useDb: busy_timeout pragma failed:', e.message); }
  _handles.real = db;
}

// ─── Migrations ──────────────────────────────────────────────────────────────

function runMigrations(db) {
  // Create the schema_version table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );
  `);

  // Read the highest applied version. The schema_version table has no
  // uniqueness constraint, so if two rows ever exist a bare `LIMIT 1` (no
  // ORDER BY) returns an arbitrary row and could re-run migrations. MAX()
  // always picks the latest applied version.
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get();
  const current = row && row.version != null ? row.version : 0;

  // Each migration runs inside a transaction so the DDL and the version
  // bump are atomic. If the process dies mid-migration, SQLite rolls back
  // and the next startup re-applies the whole block cleanly.
  if (current < 1) {
    db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id          INTEGER PRIMARY KEY,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        mode        TEXT NOT NULL,
        plan_id     TEXT,
        wallet_address TEXT,
        node_count  INTEGER DEFAULT 0,
        pass_count  INTEGER DEFAULT 0,
        notes       TEXT
      );

      CREATE TABLE IF NOT EXISTS results (
        id              INTEGER PRIMARY KEY,
        run_id          INTEGER NOT NULL REFERENCES runs(id),
        node_addr       TEXT NOT NULL,
        moniker         TEXT,
        country         TEXT,
        city            TEXT,
        service_type    TEXT,
        advertised_mbps REAL,
        actual_mbps     REAL,
        latency_ms      INTEGER,
        handshake_ok    INTEGER,
        session_ok      INTEGER,
        error_code      TEXT,
        error_message   TEXT,
        tested_at       INTEGER NOT NULL,
        raw_json        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_results_node_addr  ON results(node_addr);
      CREATE INDEX IF NOT EXISTS idx_results_run_id     ON results(run_id);
      CREATE INDEX IF NOT EXISTS idx_results_tested_at  ON results(tested_at);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at    ON runs(started_at);

      INSERT INTO schema_version (version) VALUES (1);
    `);
    })();
  }

  if (current < 2) {
    db.transaction(() => {
    // ── Migration v2: error_logs table + pass/stage columns on results ──────
    // Add pass (derived 0/1) and stage (failure stage) columns if absent.
    // SQLite does not support IF NOT EXISTS on ALTER TABLE — probe first.
    const resultCols = db.prepare(`PRAGMA table_info(results)`).all().map(c => c.name);
    if (!resultCols.includes('pass')) {
      db.exec(`ALTER TABLE results ADD COLUMN pass INTEGER`);
    }
    if (!resultCols.includes('stage')) {
      db.exec(`ALTER TABLE results ADD COLUMN stage TEXT`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS error_logs (
        id           INTEGER PRIMARY KEY,
        result_id    INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
        stage        TEXT NOT NULL,
        error_code   TEXT,
        error_message TEXT,
        log_snippet  TEXT,
        captured_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_error_logs_result_id ON error_logs(result_id);
      CREATE INDEX IF NOT EXISTS idx_error_logs_stage     ON error_logs(stage);
    `);

    // Bump version to 2 (works whether we came from 0→2 or 1→2)
    db.prepare('UPDATE schema_version SET version = 2').run();
    })();
  }

  if (current < 3) {
    db.transaction(() => {
    // ── Migration v3: tester identity + continent on results ────────────────
    const resultCols = db.prepare(`PRAGMA table_info(results)`).all().map(c => c.name);
    if (!resultCols.includes('sdk'))         db.exec(`ALTER TABLE results ADD COLUMN sdk TEXT`);
    if (!resultCols.includes('continent'))   db.exec(`ALTER TABLE results ADD COLUMN continent TEXT`);
    if (!resultCols.includes('tester_os'))   db.exec(`ALTER TABLE results ADD COLUMN tester_os TEXT`);

    const runCols = db.prepare(`PRAGMA table_info(runs)`).all().map(c => c.name);
    if (!runCols.includes('tester_sdk'))    db.exec(`ALTER TABLE runs ADD COLUMN tester_sdk TEXT`);
    if (!runCols.includes('tester_os'))     db.exec(`ALTER TABLE runs ADD COLUMN tester_os TEXT`);

    db.prepare('UPDATE schema_version SET version = 3').run();
    })();
  }

  if (current < 4) {
    db.transaction(() => {
    // ── Migration v4: public batch-model tables ──────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        id           INTEGER PRIMARY KEY,
        started_at   INTEGER NOT NULL,
        finished_at  INTEGER,
        snapshot_size INTEGER NOT NULL DEFAULT 0,
        passed       INTEGER NOT NULL DEFAULT 0,
        failed       INTEGER NOT NULL DEFAULT 0,
        mode         TEXT NOT NULL DEFAULT 'p2p'
      );

      CREATE TABLE IF NOT EXISTS batch_results (
        id          INTEGER PRIMARY KEY,
        batch_id    INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        node_address TEXT NOT NULL,
        type        TEXT,
        moniker     TEXT,
        country     TEXT,
        city        TEXT,
        actual_mbps REAL,
        peers       INTEGER,
        max_peers   INTEGER,
        error       TEXT,
        error_code  TEXT,
        tested_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_batch_results_batch_id    ON batch_results(batch_id);
      CREATE INDEX IF NOT EXISTS idx_batch_results_node_address ON batch_results(node_address);
      CREATE INDEX IF NOT EXISTS idx_batches_started_at        ON batches(started_at);
    `);

    db.prepare('UPDATE schema_version SET version = 4').run();
    })();
  }

  if (current < 5) {
    db.transaction(() => {
    const batchCols = db.prepare(`PRAGMA table_info(batches)`).all().map(c => c.name);
    if (!batchCols.includes('snapshot_addresses')) {
      db.exec(`ALTER TABLE batches ADD COLUMN snapshot_addresses TEXT`);
    }
    db.prepare('UPDATE schema_version SET version = 5').run();
    })();
  }

  if (current < 6) {
    db.transaction(() => {
    // ── Migration v6: country_code on batch_results for flag rendering ───────
    const brCols = db.prepare(`PRAGMA table_info(batch_results)`).all().map(c => c.name);
    if (!brCols.includes('country_code')) {
      db.exec(`ALTER TABLE batch_results ADD COLUMN country_code TEXT`);
    }
    db.prepare('UPDATE schema_version SET version = 6').run();
    })();
  }

  if (current < 7) {
    db.transaction(() => {
    // ── Migration v7: rename run mode 'dry' → 'test' ────────────────────────
    // Idempotent: WHERE mode='dry' matches nothing if already migrated.
    db.exec(`UPDATE runs SET mode='test' WHERE mode='dry'`);
    db.prepare('UPDATE schema_version SET version = 7').run();
    })();
  }

  if (current < 8) {
    db.transaction(() => {
    // ── Migration v8: composite indexes + error_logs(captured_at) ──────────
    // Speeds up the latest-per-node + window scans that drive searchNodes /
    // getLatestResultPerNode / getNetworkStats. SQLite's CREATE INDEX IF NOT
    // EXISTS makes this safe on dev DBs that already have manual indexes.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_results_addr_tested
        ON results(node_addr, tested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_results_run_addr_tested
        ON results(run_id, node_addr, tested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_finished_at
        ON runs(finished_at);
      CREATE INDEX IF NOT EXISTS idx_batch_results_batch_tested
        ON batch_results(batch_id, tested_at);
      CREATE INDEX IF NOT EXISTS idx_error_logs_result_captured
        ON error_logs(result_id, captured_at);
    `);
    db.prepare('UPDATE schema_version SET version = 8').run();
    })();
  }

  if (current < 9) {
    db.transaction(() => {
    // ── Migration v9: persist tester baseline-at-test on each result row ───
    // `results` and `batch_results` historically stored only the node-side
    // measurement (`actual_mbps`). The live admin log + `/live` need the
    // tester's contemporaneous baseline so the FAST/SLOW classification and
    // the "Tester Baseline" column survive page refresh and historical lookup.
    const resCols = db.prepare(`PRAGMA table_info(results)`).all().map(c => c.name);
    if (!resCols.includes('baseline_mbps')) {
      db.exec(`ALTER TABLE results ADD COLUMN baseline_mbps REAL`);
    }
    const brCols = db.prepare(`PRAGMA table_info(batch_results)`).all().map(c => c.name);
    if (!brCols.includes('baseline_mbps')) {
      db.exec(`ALTER TABLE batch_results ADD COLUMN baseline_mbps REAL`);
    }
    db.prepare('UPDATE schema_version SET version = 9').run();
    })();
  }

  if (current < 10) {
    db.transaction(() => {
    // ── Migration v10: per-run wallet accounting ────────────────────────────
    // Spend/refund were tracked only in-memory (state.spentUdvpn /
    // state.refundedUdvpn) — once a run completed, the per-run total was
    // lost. Persist on the runs row so historical accounting survives.
    // Stored as INTEGER udvpn (1 P2P = 1_000_000 udvpn) — matches the wire
    // unit used everywhere else in the chain layer.
    const runCols = db.prepare(`PRAGMA table_info(runs)`).all().map(c => c.name);
    if (!runCols.includes('spent_udvpn')) {
      db.exec(`ALTER TABLE runs ADD COLUMN spent_udvpn INTEGER DEFAULT 0`);
    }
    if (!runCols.includes('refunded_udvpn')) {
      db.exec(`ALTER TABLE runs ADD COLUMN refunded_udvpn INTEGER DEFAULT 0`);
    }
    db.prepare('UPDATE schema_version SET version = 10').run();
    })();
  }

  if (current < 11) {
    db.transaction(() => {
    // ── Migration v11: cap error_logs.log_snippet at 16384 chars ────────────
    // (16384 chars; UTF-8 byte size varies). The inline log_snippet column
    // historically stored up to ~512K chars per failure, bloating audit.db. The
    // full log already lives on disk in the per-run audit-*.log file, so the DB
    // only needs a readable snippet for the copy-failure UX. Going forward
    // insertErrorLog() caps at 16384 chars from the tail; this migration
    // truncates any legacy oversized rows to match.
    // substr(s, length(s) - 16384 + 1) keeps the LAST 16384 chars,
    // mirroring the `.slice(-16384)` tail semantics. Bounded fast UPDATE —
    // safe on the boot path (no file I/O here).
    db.prepare(`
      UPDATE error_logs
         SET log_snippet = substr(log_snippet, length(log_snippet) - 16384 + 1)
       WHERE log_snippet IS NOT NULL AND length(log_snippet) > 16384
    `).run();
    db.prepare('UPDATE schema_version SET version = 11').run();
    })();
  }
}

// ─── Run Mutations ───────────────────────────────────────────────────────────

/**
 * Insert a new run record. Returns the inserted row's id.
 *
 * @param {{ started_at: number, mode: string, plan_id?: string, wallet_address?: string, notes?: string }} opts
 * @returns {number} run id
 */
export function insertRun({
  started_at, mode, plan_id = null, wallet_address = null, notes = null,
  tester_sdk = null, tester_os = null,
}, which) {
  const db = getDb(which);
  const stmt = db.prepare(`
    INSERT INTO runs (started_at, mode, plan_id, wallet_address, notes, tester_sdk, tester_os)
    VALUES (@started_at, @mode, @plan_id, @wallet_address, @notes, @tester_sdk, @tester_os)
  `);
  const info = stmt.run({
    started_at, mode, plan_id, wallet_address, notes,
    tester_sdk, tester_os: tester_os || process.platform || null,
  });
  return info.lastInsertRowid;
}

/**
 * Update a run on completion.
 *
 * @param {number} runId
 * @param {{ finished_at: number, node_count: number, pass_count: number, spent_udvpn?: number, refunded_udvpn?: number }} opts
 */
export function updateRunOnFinish(runId, { finished_at, node_count, pass_count, spent_udvpn, refunded_udvpn }, which) {
  const db = getDb(which);
  // Persist accounting only when caller supplied a value — orphan cleanup on
  // boot doesn't know the live spend totals and must not zero them out.
  // Bind via parameters (NOT string interpolation) and round to a safe JS
  // integer: better-sqlite3 stores integers up to 2^53 exactly. The old
  // `| 0` coercion truncated to signed int32 and corrupted any value
  // ≥ 2,147,483,647 udvpn (~2147 P2P).
  const params = { id: runId, finished_at, node_count, pass_count };
  let setSpend = '';
  if (spent_udvpn != null) {
    setSpend = ', spent_udvpn = @spent_udvpn';
    params.spent_udvpn = Math.round(Number(spent_udvpn));
  }
  let setRefund = '';
  if (refunded_udvpn != null) {
    setRefund = ', refunded_udvpn = @refunded_udvpn';
    params.refunded_udvpn = Math.round(Number(refunded_udvpn));
  }
  db.prepare(`
    UPDATE runs SET finished_at = @finished_at, node_count = @node_count, pass_count = @pass_count${setSpend}${setRefund}
    WHERE id = @id
  `).run(params);
}

/**
 * Recover a saved run's spend/refund by matching the SQLite runs row to a
 * file-snapshot run. saveCurrentRun writes the snapshot's ISO `date` and the
 * SQLite `finished_at` in the same call with identical node counts, so closest
 * finish time + matching node_count is a precise (not heuristic) match.
 * Returns { spent_udvpn, refunded_udvpn } or null.
 *
 * @param {number} finishedAt - ms epoch (Date.parse of the snapshot date)
 * @param {number} nodeCount  - the snapshot's total node count
 * @param {number} [toleranceMs=15000]
 */
export function getRunSpendByFinish(finishedAt, nodeCount, toleranceMs = 15000, which) {
  if (!Number.isFinite(finishedAt)) return null;
  const db = getDb(which);
  const row = db.prepare(`
    SELECT spent_udvpn, refunded_udvpn
    FROM runs
    WHERE finished_at IS NOT NULL
      AND node_count = @nodeCount
      AND ABS(finished_at - @finishedAt) <= @tol
    ORDER BY ABS(finished_at - @finishedAt) ASC
    LIMIT 1
  `).get({ nodeCount, finishedAt, tol: toleranceMs });
  if (!row) return null;
  return { spent_udvpn: Number(row.spent_udvpn) || 0, refunded_udvpn: Number(row.refunded_udvpn) || 0 };
}

// ─── Result Mutations ─────────────────────────────────────────────────────────

/**
 * Derive the failure stage from a result object.
 * Inspects error text and diag fields to classify where the test failed.
 * Returns null when the test passed.
 *
 * @param {object} r
 * @returns {string|null}
 */
function deriveStage(r) {
  if (r.actualMbps != null && r.actualMbps > 0) return null; // passed — no stage
  const err = (r.error || '').toLowerCase();
  if (!err) return null;
  if (/insufficient|no udvpn pricing|no pricing/i.test(r.error)) return 'wallet';
  if (/rpc|abci query|broadcast|tx failed|sign|code: 1\d\d/i.test(r.error)) return 'rpc';
  if (/handshake|address mismatch|already exists|409|does not exist/i.test(r.error)) return 'handshake';
  if (/session|sessionid|waitforsession/i.test(r.error)) return 'session';
  if (/speed|socks5|mbps|tunnel|throughput/i.test(r.error)) return 'speedtest';
  return 'other';
}

function mapResultToRow(run_id, r) {
  // handshake_ok is best-effort: pipeline rarely sets r.diag.handshakeOk in
  // prod, so we infer success from a positive speed measurement when absent.
  // Without this, every prod row had handshake_ok=null → pass=0 forever.
  const handshake_ok = r.diag?.handshakeOk != null
    ? (r.diag.handshakeOk ? 1 : 0)
    : (r.actualMbps != null && r.actualMbps > 0 ? 1 : null);
  const session_ok   = r.actualMbps != null ? 1 : 0;
  // A node passes when it actually moved bytes. handshake_ok is informational
  // only — it's never set in the prod node-test path.
  const pass         = (r.actualMbps != null && r.actualMbps > 0 && !r.errorCode && !r.error) ? 1 : 0;
  const stage        = deriveStage(r);

  // Tolerate malformed timestamps: `new Date(garbage).getTime()` returns NaN
  // which SQLite stores as null and breaks every downstream ORDER BY tested_at.
  let tested_at;
  if (r.timestamp != null) {
    const t = typeof r.timestamp === 'number' ? r.timestamp : new Date(r.timestamp).getTime();
    tested_at = Number.isFinite(t) ? t : Date.now();
  } else {
    tested_at = Date.now();
  }

  return {
    run_id,
    node_addr:       r.address || '',
    moniker:         r.moniker || null,
    country:         r.country || null,
    city:            r.city || null,
    service_type:    (r.type || '').toLowerCase() === 'wireguard' ? 'wireguard'
                   : (r.type || '').toLowerCase() === 'v2ray' ? 'v2ray'
                   : r.type || null,
    advertised_mbps: r.reportedDownloadMbps ?? null,
    actual_mbps:     r.actualMbps ?? null,
    latency_ms:      r.diag?.latencyMs ?? null,
    handshake_ok,
    session_ok,
    error_code:      r.errorCode || null,
    error_message:   r.error || null,
    tested_at,
    // The writer decides how raw_json is persisted based on the active handle:
    //   - file-backed DB  → column bound NULL, blob offloaded to a per-run file
    //     (shrinks on-disk audit.db; readers rehydrate from the file).
    //   - in-memory DB     → blob bound to the column inline, NO file written
    //     (offload is pointless for :memory:, and a FIXED RAW_DIR shared across
    //     handles would let test fixtures collide with / overwrite prod blobs).
    // _rawJson carries the blob to the writer but is NEVER a column param —
    // only the resolved `raw_json` value is bound (extra named props are
    // ignored by better-sqlite3, but we strip it explicitly below).
    raw_json:        null,
    _rawJson:        JSON.stringify(r),
    pass,
    stage,
    sdk:             r.sdk || null,
    continent:       countryToContinent(r.country) || null,
    tester_os:       r.testerOs ?? r.os ?? process.platform ?? null,
    baseline_mbps:   r.baselineAtTest ?? r.baselineMbps ?? r.baseline_mbps ?? null,
  };
}

const _insertResultSql = `
  INSERT INTO results
    (run_id, node_addr, moniker, country, city, service_type, advertised_mbps,
     actual_mbps, latency_ms, handshake_ok, session_ok, error_code, error_message,
     tested_at, raw_json, pass, stage, sdk, continent, tester_os, baseline_mbps)
  VALUES
    (@run_id, @node_addr, @moniker, @country, @city, @service_type, @advertised_mbps,
     @actual_mbps, @latency_ms, @handshake_ok, @session_ok, @error_code, @error_message,
     @tested_at, @raw_json, @pass, @stage, @sdk, @continent, @tester_os, @baseline_mbps)
`;

/**
 * Insert a single result immediately (called as each node finishes).
 *
 * @param {number} run_id
 * @param {object} result - Raw result object from pipeline
 * @returns {number} inserted row id
 */
export function insertResult(run_id, result, which) {
  const db = getDb(which);
  const memory = _isMemoryDb(db);
  const row = mapResultToRow(run_id, result);
  const { _rawJson, ...bind } = row;
  // In-memory DB: keep the blob inline in the column, write no file. The RAW_DIR
  // offload exists only to shrink the on-DISK audit.db, which is moot for a
  // :memory: handle — and a fixed RAW_DIR shared across handles would let test
  // fixtures collide with prod blobs under the same (run_id, result_id) key.
  if (memory) bind.raw_json = _rawJson;
  const info = db.prepare(_insertResultSql).run(bind);
  if (!memory) writeRawJson(run_id, info.lastInsertRowid, _rawJson);
  return info.lastInsertRowid;
}

/**
 * Batch-insert multiple results in a single transaction.
 *
 * @param {number} run_id
 * @param {object[]} results
 * @param {'real'|'test'} [which='real']
 */
export function insertResultsBatch(run_id, results, which) {
  const db = getDb(which);
  const memory = _isMemoryDb(db);
  const stmt = db.prepare(_insertResultSql);
  const insert = db.transaction((rows) => {
    for (const row of rows) {
      const { _rawJson, ...bind } = row;
      // See insertResult: in-memory keeps the blob inline (no file); file-backed
      // NULLs the column and offloads to a per-run file.
      if (memory) bind.raw_json = _rawJson;
      const info = stmt.run(bind);
      if (!memory) writeRawJson(run_id, info.lastInsertRowid, _rawJson);
    }
  });
  insert(results.map(r => mapResultToRow(run_id, r)));
}

// ─── Run Queries ─────────────────────────────────────────────────────────────

/**
 * Fetch a single run by id.
 *
 * @param {number} id
 * @returns {object|undefined}
 */
export function getRun(id, which) {
  return getDb(which).prepare('SELECT * FROM runs WHERE id = @id').get({ id });
}

/**
 * Find a run by its started_at + mode (for idempotent backfill).
 *
 * @param {number} started_at
 * @param {string} mode
 * @returns {object|undefined}
 */
export function findRunByKey(started_at, mode, which) {
  return getDb(which).prepare(
    'SELECT * FROM runs WHERE started_at = @started_at AND mode = @mode LIMIT 1',
  ).get({ started_at, mode });
}

/**
 * List recent runs, most recent first.
 *
 * @param {{ limit?: number }} [opts]
 * @returns {object[]}
 */
export function listRuns({ limit = 50 } = {}, which) {
  return getDb(which).prepare(
    'SELECT * FROM runs ORDER BY started_at DESC LIMIT @limit',
  ).all({ limit });
}

/**
 * Return the most recently started run that has not finished yet, augmented
 * with in-progress counts. Returns null when nothing is running.
 */
export function getActiveRun(which) {
  const db = getDb(which);
  const run = db.prepare(
    'SELECT * FROM runs WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 1',
  ).get();
  if (!run) return null;
  const counts = db.prepare(`
    SELECT
      COUNT(DISTINCT node_addr) AS node_count_so_far,
      SUM(CASE WHEN pass = 1 THEN 1 ELSE 0 END) AS pass_count_so_far
    FROM results WHERE run_id = @id
  `).get({ id: run.id }) || {};
  return {
    id: run.id,
    started_at: run.started_at,
    mode: run.mode,
    plan_id: run.plan_id,
    node_count_so_far: counts.node_count_so_far || 0,
    pass_count_so_far: counts.pass_count_so_far || 0,
  };
}

/**
 * Return the most recently completed run, or null.
 */
export function getLastCompletedRun(which) {
  const run = getDb(which).prepare(
    'SELECT * FROM runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1',
  ).get();
  return run || null;
}

/**
 * Return bandwidth history rows for a node, newest first, filtered to rows
 * that actually measured a speed. Used by the node detail bandwidth chart.
 */
export function getBandwidthHistory(nodeAddr, { limit = 100 } = {}, which) {
  return getDb(which).prepare(`
    SELECT tested_at, actual_mbps, advertised_mbps
    FROM results
    WHERE node_addr = @nodeAddr AND actual_mbps IS NOT NULL
    ORDER BY tested_at DESC
    LIMIT @limit
  `).all({ nodeAddr, limit });
}

// ─── Result Queries ───────────────────────────────────────────────────────────

/**
 * Return one row per node address, using the most recent test result.
 * Supports filtering by query string (moniker/country/city/address) and country.
 *
 * @param {{ q?: string, country?: string, limit?: number, offset?: number }} [opts]
 * @returns {object[]}
 */
export function getLatestResultPerNode({ q = null, country = null, limit = 200, offset = 0 } = {}, which) {
  const db = getDb(which);

  // Sub-query: latest tested_at per node_addr
  let where = '';
  const params = {};

  const conditions = [];
  if (country) {
    conditions.push('r.country = @country');
    params.country = country;
  }
  if (q) {
    conditions.push(
      '(r.node_addr LIKE @q OR r.moniker LIKE @q OR r.country LIKE @q OR r.city LIKE @q)',
    );
    params.q = `%${q}%`;
  }
  if (conditions.length > 0) where = 'WHERE ' + conditions.join(' AND ');

  params.limit = limit;
  params.offset = offset;

  // "Latest" = highest id among all rows with the max tested_at for that node.
  // Using MAX(id) as tiebreaker ensures exactly one row per node_addr even if
  // two rows share the same tested_at value.
  return db.prepare(`
    SELECT r.*
    FROM results r
    INNER JOIN (
      SELECT node_addr,
             MAX(id) AS max_id
      FROM results r2
      WHERE (r2.node_addr, r2.tested_at) IN (
        SELECT node_addr, MAX(tested_at)
        FROM results
        GROUP BY node_addr
      )
      GROUP BY node_addr
    ) latest ON r.id = latest.max_id
    ${where}
    ORDER BY r.tested_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params);
}

/**
 * Return the full test history for a single node, most recent first.
 *
 * @param {string} nodeAddr
 * @param {{ limit?: number }} [opts]
 * @returns {object[]}
 */
export function getNodeHistory(nodeAddr, { limit = 50 } = {}, which) {
  const rows = getDb(which).prepare(
    'SELECT * FROM results WHERE node_addr = @node_addr ORDER BY tested_at DESC LIMIT @limit',
  ).all({ node_addr: nodeAddr, limit });
  return rehydrateRawJson(rows);
}

// ─── Aggregate Stats ──────────────────────────────────────────────────────────

/**
 * Compute high-level network stats across all stored results.
 *
 * @returns {{ totalNodes: number, passingPct: number, medianMbps: number|null, lastRunAt: number|null }}
 */
export function getNetworkStats(which) {
  const db = getDb(which);

  // Latest result per node (MAX(id) tiebreaker for equal tested_at).
  // No mode filter needed: real and test data live in separate DB files.
  const rows = db.prepare(`
    SELECT r.actual_mbps, r.pass
    FROM results r
    INNER JOIN (
      SELECT r2.node_addr, MAX(r2.id) AS max_id
      FROM results r2
      WHERE (r2.node_addr, r2.tested_at) IN (
        SELECT r3.node_addr, MAX(r3.tested_at)
        FROM results r3
        GROUP BY r3.node_addr
      )
      GROUP BY r2.node_addr
    ) latest ON r.id = latest.max_id
  `).all();

  const totalNodes = rows.length;
  const passing = rows.filter(r => r.pass === 1).length;
  const passingPct = totalNodes > 0 ? Math.round((passing / totalNodes) * 100) : 0;

  const speeds = rows
    .map(r => r.actual_mbps)
    .filter(v => v != null && v > 0)
    .sort((a, b) => a - b);

  let medianMbps = null;
  if (speeds.length > 0) {
    const mid = Math.floor(speeds.length / 2);
    medianMbps = speeds.length % 2 === 0
      ? parseFloat(((speeds[mid - 1] + speeds[mid]) / 2).toFixed(2))
      : parseFloat(speeds[mid].toFixed(2));
  }

  const lastRunRow = db.prepare('SELECT MAX(started_at) AS ts FROM runs').get();
  const lastRunAt = lastRunRow?.ts ?? null;

  return { totalNodes, passingPct, medianMbps, lastRunAt };
}

/**
 * Per-run version of getNetworkStats — scoped to a single run_id so the live
 * dashboard tiles show the *current* sweep's numbers instead of lifetime
 * averages across every node ever tested.
 *
 * @param {number} runId
 * @returns {{ totalNodes: number, passingPct: number, medianMbps: number|null, processed: number }}
 */
export function getRunStats(runId, which) {
  if (!runId || Number.isNaN(Number(runId))) {
    return { totalNodes: 0, passingPct: 0, medianMbps: null, processed: 0 };
  }
  const db = getDb(which);
  // No `skipped` column exists on `results` — explicit skips are encoded via
  // error_code (TEST_RUN_SKIP, OFFLINE_SKIP, NOT_IN_PLAN, etc.). Filter on
  // error_code so this query matches the actual schema.
  const rows = db.prepare(`
    SELECT actual_mbps, pass, error_code
    FROM results
    WHERE run_id = @runId
  `).all({ runId });

  const SKIP_CODES = new Set(['TEST_RUN_SKIP', 'OFFLINE_SKIP', 'NOT_IN_PLAN']);
  const processed = rows.filter(r => !SKIP_CODES.has(r.error_code));
  const passing = processed.filter(r => r.pass === 1).length;
  const totalNodes = processed.length;
  const passingPct = totalNodes > 0 ? Math.round((passing / totalNodes) * 100) : 0;

  const speeds = processed
    .map(r => r.actual_mbps)
    .filter(v => v != null && v > 0)
    .sort((a, b) => a - b);
  let medianMbps = null;
  if (speeds.length > 0) {
    const mid = Math.floor(speeds.length / 2);
    medianMbps = speeds.length % 2 === 0
      ? parseFloat(((speeds[mid - 1] + speeds[mid]) / 2).toFixed(2))
      : parseFloat(speeds[mid].toFixed(2));
  }
  return { totalNodes, passingPct, medianMbps, processed: totalNodes };
}

// ─── Error Log Mutations ──────────────────────────────────────────────────────

/**
 * Insert a detailed error-log row for a failed test result.
 * Call AFTER insertResult so the result_id exists.
 *
 * @param {object} opts
 * @param {number}  opts.result_id   - FK → results.id
 * @param {string}  opts.stage       - 'handshake'|'session'|'speedtest'|'wallet'|'rpc'|'other'
 * @param {string}  [opts.error_code]
 * @param {string}  [opts.error_message]
 * @param {string}  [opts.log_snippet] - a readable snippet of log context (capped at 16384 chars; UTF-8 byte size varies)
 * @returns {number} inserted id
 */
export function insertErrorLog({
  result_id,
  stage,
  error_code = null,
  error_message = null,
  log_snippet = null,
}, which) {
  const db = getDb(which);
  // Store only a readable snippet of the per-node tester log (capped at 16384
  // chars from the tail; UTF-8 byte size varies). The FULL log is persisted to disk in the
  // per-run audit-*.log file; the DB column exists purely to power the
  // copy-failure UX, so a bounded tail is all we need. Production callers
  // already pre-truncate to ~4 KB via pipeline.js (_sanitizeSnippet /
  // _MAX_SNIPPET); this slice is the backstop so a misbehaving caller can't
  // blow up the row and bloat audit.db.
  const snippet = log_snippet ? log_snippet.slice(-16384) : null;
  const info = db.prepare(`
    INSERT INTO error_logs (result_id, stage, error_code, error_message, log_snippet, captured_at)
    VALUES (@result_id, @stage, @error_code, @error_message, @log_snippet, @captured_at)
  `).run({
    result_id,
    stage,
    error_code,
    error_message,
    log_snippet: snippet,
    captured_at: Date.now(),
  });
  return info.lastInsertRowid;
}

// ─── Extended Search Helpers ──────────────────────────────────────────────────

/**
 * Search nodes with per-node pass statistics over the last `window` tests.
 * Returns one row per node_addr with aggregated pass/fail info and a pass_bar.
 *
 * @param {object} [opts]
 * @param {string}  [opts.q]       - free-text: moniker / addr / country / city
 * @param {string}  [opts.country] - ISO code or full country name (exact match)
 * @param {string}  [opts.service] - 'wireguard' | 'v2ray'
 * @param {string}  [opts.sort]    - 'mbps_desc'|'mbps_asc'|'pass_desc'|'tested_desc'|'moniker_asc'
 * @param {number}  [opts.window=25]  - how many recent tests to evaluate
 * @param {number}  [opts.limit=50]
 * @param {number}  [opts.offset=0]
 * @returns {object[]}
 */
export function searchNodes({
  q = null,
  country = null,
  service = null,
  sort = 'tested_desc',
  window: win = 25,
  limit = 50,
  offset = 0,
  runId = null,
} = {}, which) {
  const db = getDb(which);

  // Build WHERE clauses for the outer filter
  const conditions = [];
  const params = {};

  if (country) {
    // Accept ISO code (2-letter) or full name
    conditions.push('(n.country = @country OR n.country_code = @country)');
    params.country = country;
  }
  if (service) {
    conditions.push('n.service_type = @service');
    params.service = service.toLowerCase();
  }
  if (q) {
    conditions.push(
      '(n.node_addr LIKE @q OR n.moniker LIKE @q OR n.country LIKE @q OR n.city LIKE @q)',
    );
    params.q = `%${q}%`;
  }

  // Filter latest-per-node to a specific run when requested.
  const runFilter = runId != null ? 'WHERE run_id = @runId' : '';
  if (runId != null) params.runId = runId;

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Sort order mapping
  const sortMap = {
    mbps_desc:    'n.latest_mbps DESC NULLS LAST',
    mbps_asc:     'n.latest_mbps ASC NULLS LAST',
    pass_desc:    'n.pass_count DESC',
    tested_desc:  'n.latest_tested_at DESC',
    moniker_asc:  'n.moniker ASC',
  };
  const orderBy = sortMap[sort] || sortMap.tested_desc;

  params.win  = win;
  params.limit  = limit;
  params.offset = offset;

  // CTE-based query:
  //  1. latest_per_node — most recent result per node (for display fields)
  //  2. window_rows — up to `win` most recent results per node
  //  3. node_stats — aggregated pass count, total, and ranked history
  const rows = db.prepare(`
    WITH latest_per_node AS (
      SELECT
        r.node_addr,
        r.moniker,
        r.country,
        r.city,
        r.service_type,
        r.sdk,
        r.continent,
        r.tester_os,
        CASE
          WHEN r.country IS NOT NULL AND length(r.country) = 2 THEN r.country
          ELSE NULL
        END AS country_code,
        r.actual_mbps   AS latest_mbps,
        r.tested_at     AS latest_tested_at,
        r.error_code    AS latest_error_code
      FROM results r
      INNER JOIN (
        SELECT node_addr, MAX(id) AS max_id
        FROM (
          SELECT node_addr, id
          FROM results r2
          ${runId != null ? 'WHERE r2.run_id = @runId AND' : 'WHERE'} (r2.node_addr, r2.tested_at) IN (
            SELECT node_addr, MAX(tested_at) FROM results ${runFilter} GROUP BY node_addr
          )
        )
        GROUP BY node_addr
      ) lat ON r.id = lat.max_id
    ),
    window_rows AS (
      SELECT
        r.node_addr,
        r.pass,
        r.tested_at,
        ROW_NUMBER() OVER (
          PARTITION BY r.node_addr
          ORDER BY r.tested_at DESC
        ) AS rn
      FROM results r
      ${runId != null ? 'WHERE r.run_id = @runId' : ''}
    ),
    node_stats AS (
      SELECT
        node_addr,
        SUM(CASE WHEN pass = 1 THEN 1 ELSE 0 END)  AS pass_count,
        COUNT(*)                                    AS total_tests
      FROM window_rows
      WHERE rn <= @win
      GROUP BY node_addr
    )
    SELECT
      n.node_addr,
      n.moniker,
      n.country,
      n.city,
      n.service_type,
      n.sdk,
      n.continent,
      n.tester_os,
      n.country_code,
      n.latest_mbps,
      n.latest_tested_at,
      n.latest_error_code,
      COALESCE(s.pass_count,  0) AS pass_count,
      COALESCE(s.total_tests, 0) AS total_tests
    FROM latest_per_node n
    LEFT JOIN node_stats s ON n.node_addr = s.node_addr
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT @limit OFFSET @offset
  `).all(params);

  if (rows.length === 0) return [];

  // Build pass_bar for each node (in JS — window history query per node is
  // separate to avoid O(n*win) per-row sub-queries; done in one bulk query).
  const addrs = rows.map(r => r.node_addr);
  const placeholders = addrs.map((_, i) => `@a${i}`).join(',');
  const histParams = {};
  addrs.forEach((a, i) => { histParams[`a${i}`] = a; });
  histParams.win = win;

  if (runId != null) histParams.runId = runId;
  const histRows = db.prepare(`
    SELECT node_addr, pass, tested_at,
      ROW_NUMBER() OVER (PARTITION BY node_addr ORDER BY tested_at DESC) AS rn
    FROM results
    WHERE node_addr IN (${placeholders})
      ${runId != null ? 'AND run_id = @runId' : ''}
    ORDER BY node_addr, tested_at DESC
  `).all(histParams);

  // Group by node_addr, keep up to win rows, reverse to oldest→newest
  const histMap = {};
  for (const h of histRows) {
    if (h.rn > win) continue;
    if (!histMap[h.node_addr]) histMap[h.node_addr] = [];
    histMap[h.node_addr].push(h.pass);
  }

  return rows.map(row => {
    const raw = (histMap[row.node_addr] || []).reverse(); // oldest→newest
    // Pad left with nulls to fill window length
    const bar = Array(win - raw.length).fill(null).concat(raw.map(p => (p === 1 ? 1 : 0)));
    const passRate = row.total_tests > 0 ? row.pass_count / row.total_tests : 0;
    return {
      node_addr:         row.node_addr,
      moniker:           row.moniker,
      country:           row.country,
      city:              row.city,
      service_type:      row.service_type,
      sdk:               row.sdk,
      continent:         row.continent,
      tester_os:         row.tester_os,
      latest_mbps:       row.latest_mbps,
      latest_tested_at:  row.latest_tested_at,
      latest_error_code: row.latest_error_code,
      pass_count:        row.pass_count,
      total_tests:       row.total_tests,
      pass_rate:         parseFloat(passRate.toFixed(4)),
      pass_bar:          bar,
    };
  });
}

/**
 * Return detailed info for one node: latest node metadata, history rows, and
 * joined error_log rows.
 *
 * @param {string} addr
 * @param {{ historyLimit?: number }} [opts]
 * @returns {{ node: object|null, history: object[], errors: object[] }}
 */
export function getNodeDetail(addr, { historyLimit = 100 } = {}, which) {
  const db = getDb(which);

  // Latest result row used as the "node" record
  const node = db.prepare(`
    SELECT r.*
    FROM results r
    WHERE r.node_addr = @addr
    ORDER BY r.tested_at DESC
    LIMIT 1
  `).get({ addr });

  if (node) rehydrateRawJson([node]);

  const history = rehydrateRawJson(db.prepare(`
    SELECT * FROM results
    WHERE node_addr = @addr
    ORDER BY tested_at DESC
    LIMIT @limit
  `).all({ addr, limit: historyLimit }));

  const errors = db.prepare(`
    SELECT el.*, r.tested_at, r.actual_mbps, r.node_addr, r.moniker
    FROM error_logs el
    INNER JOIN results r ON el.result_id = r.id
    WHERE r.node_addr = @addr
    ORDER BY el.captured_at DESC
    LIMIT 100
  `).all({ addr });

  return { node: node || null, history, errors };
}

/**
 * Return error_log rows for a node, optionally filtered by stage.
 *
 * @param {string} addr
 * @param {{ limit?: number, stage?: string }} [opts]
 * @returns {object[]}
 */
export function getNodeErrors(addr, { limit = 50, stage = null } = {}, which) {
  const db = getDb(which);
  const params = { addr, limit };
  let stageClause = '';
  if (stage) {
    stageClause = 'AND el.stage = @stage';
    params.stage = stage;
  }
  const rows = db.prepare(`
    SELECT el.*, r.tested_at, r.actual_mbps, r.node_addr, r.moniker,
           r.country AS country,
           r.city    AS city,
           CASE WHEN r.country IS NOT NULL AND length(r.country) = 2 THEN r.country END AS country_code,
           r.service_type      AS service_type,
           r.advertised_mbps   AS advertised_mbps,
           r.latency_ms        AS latency_ms,
           r.handshake_ok      AS handshake_ok,
           r.session_ok        AS session_ok,
           r.pass              AS pass,
           r.sdk               AS sdk,
           r.continent         AS continent,
           r.tester_os         AS tester_os,
           r.run_id            AS run_id,
           r.raw_json          AS raw_json
    FROM error_logs el
    INNER JOIN results r ON el.result_id = r.id
    WHERE r.node_addr = @addr ${stageClause}
    ORDER BY el.captured_at DESC
    LIMIT @limit
  `).all(params);
  if (rows.length > 0) return rehydrateRawJson(rows);

  // Fallback: no error_logs row exists for this node yet (race between
  // upsertResult writing the result and insertErrorLog completing, or an old
  // schema-v1 row from before migration v2). Synthesize an entry from the
  // most recent failed `results` row so the popup never shows empty for a
  // failed node — this is the failure-log MUST contract from CLAUDE.md.
  const stageWhere = stage ? 'AND COALESCE(r.stage, \'unknown\') = @stage' : '';
  if (stage) params.stage = stage;
  const fallback = db.prepare(`
    SELECT NULL AS id, r.id AS result_id,
           COALESCE(r.stage, 'unknown')          AS stage,
           COALESCE(r.error_code, 'UNKNOWN')     AS error_code,
           COALESCE(r.error_message, '(no message captured)') AS error_message,
           NULL                                  AS log_snippet,
           r.tested_at                           AS captured_at,
           r.tested_at, r.actual_mbps, r.node_addr, r.moniker,
           r.country AS country,
           r.city    AS city,
           CASE WHEN r.country IS NOT NULL AND length(r.country) = 2 THEN r.country END AS country_code,
           r.service_type      AS service_type,
           r.advertised_mbps   AS advertised_mbps,
           r.latency_ms        AS latency_ms,
           r.handshake_ok      AS handshake_ok,
           r.session_ok        AS session_ok,
           r.pass              AS pass,
           r.sdk               AS sdk,
           r.continent         AS continent,
           r.tester_os         AS tester_os,
           r.run_id            AS run_id,
           r.raw_json          AS raw_json,
           1                   AS synthesized
    FROM results r
    WHERE r.node_addr = @addr
      AND (r.actual_mbps IS NULL OR r.error_code IS NOT NULL)
      ${stageWhere}
    ORDER BY r.tested_at DESC
    LIMIT @limit
  `).all(params);
  if (fallback.length > 0) return rehydrateRawJson(fallback);

  // Second fallback: continuous-loop (public) runs persist per node ONLY to
  // batch_results — never to results/error_logs — so a node that failed only
  // inside a loop has no row in either table queried above. batch_results does
  // store error + error_code, so synthesize a failure entry from the most recent
  // failed batch_results row. Without this the public failure-drawer is empty for
  // loop-only failures, violating the failure-log MUST contract. batch_results
  // has no `stage`, so a specific stage filter can't match here.
  if (stage && stage !== 'unknown') return fallback; // empty — no stage in batch_results
  const batchFallback = db.prepare(`
    SELECT NULL AS id, NULL AS result_id,
           'unknown'                                   AS stage,
           COALESCE(br.error_code, 'UNKNOWN')          AS error_code,
           COALESCE(br.error, '(no message captured)') AS error_message,
           NULL                                        AS log_snippet,
           br.tested_at                                AS captured_at,
           br.tested_at, br.actual_mbps,
           br.node_address     AS node_addr, br.moniker,
           br.country          AS country,
           br.city             AS city,
           br.country_code     AS country_code,
           br.type             AS service_type,
           NULL AS advertised_mbps, NULL AS latency_ms,
           NULL AS handshake_ok, NULL AS session_ok, NULL AS pass,
           NULL AS sdk, NULL AS continent, NULL AS tester_os,
           NULL AS run_id, NULL AS raw_json,
           1                   AS synthesized
    FROM batch_results br
    WHERE br.node_address = @addr
      AND (br.actual_mbps IS NULL OR br.error_code IS NOT NULL)
    ORDER BY br.tested_at DESC
    LIMIT @limit
  `).all(params);
  return batchFallback;
}

/**
 * Return distinct countries with node counts, suitable for a filter dropdown.
 *
 * @returns {Array<{ country: string, node_count: number }>}
 */
export function getCountryList(which) {
  return getDb(which).prepare(`
    WITH latest AS (
      SELECT node_addr, country
      FROM results
      WHERE id IN (
        SELECT MAX(id)
        FROM results
        GROUP BY node_addr
      )
    )
    SELECT country, COUNT(DISTINCT node_addr) AS node_count
    FROM latest
    WHERE country IS NOT NULL AND country != ''
    GROUP BY country
    ORDER BY node_count DESC, country ASC
  `).all();
}

// ─── Cross-Node Error Search ─────────────────────────────────────────────────

/**
 * Search error_logs across ALL nodes, joined with results for node metadata.
 *
 * @param {object} [opts]
 * @param {string}  [opts.q]      - free-text: matches node_addr, moniker, or error_message (LIKE)
 * @param {string}  [opts.stage]  - exact match on error_logs.stage
 * @param {number}  [opts.limit=100]  - cap 500
 * @param {number}  [opts.offset=0]
 * @returns {{ total: number, items: object[] }}
 */
export function searchErrors({ q = null, stage = null, limit = 100, offset = 0 } = {}, which) {
  const db = getDb(which);
  const cappedLimit = Math.min(Math.max(1, parseInt(limit, 10) || 100), 500);
  const safeOffset  = Math.max(0, parseInt(offset, 10) || 0);

  const conditions = [];
  const params = {};

  if (stage) {
    conditions.push('el.stage = @stage');
    params.stage = stage;
  }
  if (q) {
    conditions.push(
      '(r.node_addr LIKE @q OR r.moniker LIKE @q OR el.error_message LIKE @q)',
    );
    params.q = `%${q}%`;
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const countRow = db.prepare(`
    SELECT COUNT(*) AS n
    FROM error_logs el
    INNER JOIN results r ON el.result_id = r.id
    ${where}
  `).get(params);

  const total = countRow ? countRow.n : 0;

  if (total === 0) return { total: 0, items: [] };

  params.limit  = cappedLimit;
  params.offset = safeOffset;

  const rows = db.prepare(`
    SELECT
      el.id           AS error_log_id,
      el.result_id,
      r.node_addr,
      r.moniker,
      r.country,
      el.stage,
      el.error_code,
      el.error_message,
      el.log_snippet,
      el.captured_at,
      r.run_id
    FROM error_logs el
    INNER JOIN results r ON el.result_id = r.id
    ${where}
    ORDER BY el.captured_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params);

  return { total, items: rows };
}

// ─── Batch Mutations ──────────────────────────────────────────────────────────

/**
 * Insert a new batch record. Returns the inserted batch id.
 *
 * @param {{ started_at: number, snapshot_size: number, mode?: string, snapshot_addresses?: string[] }} opts
 * @returns {number} batch id
 */
export function insertBatch({ started_at, snapshot_size, mode = 'p2p', snapshot_addresses = null }, which) {
  const db = getDb(which);
  const addrsJson = Array.isArray(snapshot_addresses) && snapshot_addresses.length > 0
    ? JSON.stringify(snapshot_addresses)
    : null;
  const info = db.prepare(`
    INSERT INTO batches (started_at, snapshot_size, passed, failed, mode, snapshot_addresses)
    VALUES (@started_at, @snapshot_size, 0, 0, @mode, @snapshot_addresses)
  `).run({ started_at, snapshot_size, mode, snapshot_addresses: addrsJson });
  return info.lastInsertRowid;
}

/**
 * Update a batch record on completion.
 *
 * @param {number} batchId
 * @param {{ finished_at: number, passed: number, failed: number }} opts
 */
export function updateBatchOnFinish(batchId, { finished_at, passed, failed }, which) {
  getDb(which).prepare(`
    UPDATE batches SET finished_at = @finished_at, passed = @passed, failed = @failed
    WHERE id = @id
  `).run({ id: batchId, finished_at, passed, failed });
}

/**
 * Re-open a previously-closed batch so a resume can keep writing into it.
 * Sets finished_at back to NULL — getActiveBatch() will return this row again.
 */
export function reopenBatch(batchId, which) {
  getDb(which).prepare(`
    UPDATE batches SET finished_at = NULL WHERE id = @id
  `).run({ id: batchId });
}

/**
 * Look up a single batch row by id (no joined results).
 */
export function getBatchById(batchId, which) {
  return getDb(which).prepare(`
    SELECT id, started_at, finished_at, snapshot_size, passed, failed, mode
    FROM batches WHERE id = @id
  `).get({ id: batchId }) || null;
}

/**
 * Insert a single batch_results row (called as each node finishes).
 *
 * @param {number} batch_id
 * @param {object} r - Sanitized result object
 * @returns {number} inserted row id
 */
export function insertBatchResult(batch_id, r, which) {
  const db = getDb(which);
  const info = db.prepare(`
    INSERT INTO batch_results
      (batch_id, node_address, type, moniker, country, country_code, city,
       actual_mbps, peers, max_peers, error, error_code, tested_at, baseline_mbps)
    VALUES
      (@batch_id, @node_address, @type, @moniker, @country, @country_code, @city,
       @actual_mbps, @peers, @max_peers, @error, @error_code, @tested_at, @baseline_mbps)
  `).run({
    batch_id,
    node_address: r.address || r.node_address || '',
    type:         r.type || r.serviceType || null,
    moniker:      r.moniker || null,
    country:      r.country || null,
    country_code: r.countryCode || r.country_code || null,
    city:         r.city || null,
    actual_mbps:  r.actualMbps ?? r.actual_mbps ?? null,
    peers:        r.peers ?? null,
    max_peers:    r.maxPeers ?? r.max_peers ?? null,
    error:        r.error ? String(r.error).slice(0, 500) : null,
    error_code:   r.errorCode || r.error_code || null,
    tested_at:    r.testedAt || r.tested_at || Date.now(),
    baseline_mbps: r.baselineMbps ?? r.baseline_mbps ?? r.baselineAtTest ?? null,
  });
  return info.lastInsertRowid;
}

/**
 * List the most recent batches, newest first.
 *
 * @param {{ limit?: number }} [opts]
 * @returns {object[]}
 */
export function listBatches({ limit = 50 } = {}, which) {
  return getDb(which).prepare(`
    SELECT id, started_at, finished_at, snapshot_size, passed, failed, mode
    FROM batches
    ORDER BY started_at DESC
    LIMIT @limit
  `).all({ limit });
}

/**
 * Get the public-safe node results for a single batch.
 *
 * @param {number} batchId
 * @param {{ limit?: number, offset?: number }} [opts]
 * @returns {{ batch: object|null, results: object[] }}
 */
export function getBatchResults(batchId, { limit = 500, offset = 0 } = {}, which) {
  const db = getDb(which);
  const batch = db.prepare('SELECT * FROM batches WHERE id = @id').get({ id: batchId });
  if (!batch) return { batch: null, results: [] };
  const results = db.prepare(`
    SELECT node_address, type, moniker, country, country_code, city,
           actual_mbps, peers, max_peers, error, error_code, tested_at, baseline_mbps
    FROM batch_results
    WHERE batch_id = @batch_id
    ORDER BY tested_at ASC
    LIMIT @limit OFFSET @offset
  `).all({ batch_id: batchId, limit, offset });
  return { batch, results };
}

/**
 * Return the currently-running batch (finished_at IS NULL) plus every node
 * result persisted for it so far. Drives `/api/public/runs/current` so a
 * /live page refresh never goes blank mid-batch.
 *
 * @returns {{ batch: object, nodes: object[] }|null}
 */
export function getActiveBatch(which) {
  const db = getDb(which);
  const batch = db.prepare(`
    SELECT id, started_at, finished_at, snapshot_size, passed, failed, mode
    FROM batches
    WHERE finished_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `).get();
  if (!batch) return null;
  const nodes = db.prepare(`
    SELECT node_address AS address,
           moniker, country, country_code AS countryCode, city, type,
           actual_mbps AS actualMbps, peers, max_peers AS maxPeers,
           error, error_code AS errorCode, tested_at AS testedAt,
           baseline_mbps AS baselineMbps
    FROM batch_results
    WHERE batch_id = @batch_id
    ORDER BY tested_at ASC
  `).all({ batch_id: batch.id });
  // Derive live pass/fail counts from persisted rows. `batches.passed/failed`
  // are only written on finish — without this the mid-batch /live refresh
  // would always show 0/0.
  let passed = 0, failed = 0;
  for (const n of nodes) {
    if (n.actualMbps != null && n.actualMbps > 0 && !n.error) passed++;
    else failed++;
  }
  batch.passed = passed;
  batch.failed = failed;
  return { batch, nodes };
}

/**
 * Return a specific batch by id plus its node results, in the same shape
 * as getActiveBatch(). Used for the stop→refresh hydration path: when an
 * operator stops a run and reloads /live, the batch row has finished_at
 * set so getActiveBatch() returns null — but state.activeBatchId still
 * points at it for the eventual resume, so /live should keep painting it.
 *
 * @returns {{ batch: object, nodes: object[] }|null}
 */
export function getBatchWithNodes(batchId, which) {
  const db = getDb(which);
  const batch = db.prepare(`
    SELECT id, started_at, finished_at, snapshot_size, passed, failed, mode
    FROM batches
    WHERE id = @id
  `).get({ id: batchId });
  if (!batch) return null;
  const nodes = db.prepare(`
    SELECT node_address AS address,
           moniker, country, country_code AS countryCode, city, type,
           actual_mbps AS actualMbps, peers, max_peers AS maxPeers,
           error, error_code AS errorCode, tested_at AS testedAt,
           baseline_mbps AS baselineMbps
    FROM batch_results
    WHERE batch_id = @batch_id
    ORDER BY tested_at ASC
  `).all({ batch_id: batch.id });
  let passed = 0, failed = 0;
  for (const n of nodes) {
    if (n.actualMbps != null && n.actualMbps > 0 && !n.error) passed++;
    else failed++;
  }
  batch.passed = passed;
  batch.failed = failed;
  return { batch, nodes };
}

/**
 * Return the most-recent finished batch plus its node results. Mirrors
 * getActiveBatch() shape so /live's refresh-fallback path can hydrate from
 * the last completed sweep when no batch is currently running.
 *
 * @returns {{ batch: object, nodes: object[] }|null}
 */
export function getLastBatch(which) {
  const db = getDb(which);
  const batch = db.prepare(`
    SELECT id, started_at, finished_at, snapshot_size, passed, failed, mode
    FROM batches
    WHERE finished_at IS NOT NULL
    ORDER BY finished_at DESC
    LIMIT 1
  `).get();
  if (!batch) return null;
  const nodes = db.prepare(`
    SELECT node_address AS address,
           moniker, country, country_code AS countryCode, city, type,
           actual_mbps AS actualMbps, peers, max_peers AS maxPeers,
           error, error_code AS errorCode, tested_at AS testedAt,
           baseline_mbps AS baselineMbps
    FROM batch_results
    WHERE batch_id = @batch_id
    ORDER BY tested_at ASC
  `).all({ batch_id: batch.id });
  return { batch, nodes };
}

/**
 * Prune old batch_results (and their now-empty parent `batches` rows) so the
 * table stays bounded under continuous-loop mode, where every iteration
 * re-tests every node and writes a full set of rows.
 *
 * KEEP-SET RATIONALE — three readers must never lose their data:
 *   (a) ALL active/unfinished batches (finished_at IS NULL): the continuous-loop
 *       resume path re-seeds already-tested addresses from its batch_results
 *       (getActiveBatch + raw SELECTs in audit/continuous.js). Pruning one
 *       mid-flight would lose the resume seed. We keep EVERY unfinished batch,
 *       not just getActiveBatch's single newest one — if two+ batches have
 *       finished_at IS NULL, dropping the older one's batch_results would orphan
 *       its parent row (the parent DELETE guards finished_at IS NOT NULL, so the
 *       childless row would survive).
 *   (b) the single most-recent FINISHED batch (getLastBatch): drives the /live
 *       last-completed snapshot. Pruning it would blank /live between runs.
 *   (c) the last K batches overall (by recency): preserves recent history for
 *       the failure-log batch-fallback in getNodeErrors and operator review.
 * The union of these three is the keep-set. Everything else is deleted.
 *
 * Children (batch_results) are deleted explicitly BEFORE parents (batches) to
 * keep `PRAGMA foreign_key_check` clean, mirroring scripts/cleanup.mjs. An
 * active/unfinished batch row is NEVER deleted from `batches` even if it somehow
 * fell outside the recency window (the keep-set already includes it, but the
 * `finished_at IS NOT NULL` guard on the parent delete is a second backstop).
 *
 * Pruning is housekeeping — it is NOT called on the insert hot path (that would
 * risk the active batch). audit/continuous.js calls it once per iteration,
 * immediately after the just-finished batch becomes the last-finished one.
 *
 * @param {{ keepBatches?: number }} [opts] - how many recent batches to retain
 * @param {string} [which] - DB scope (back-compat); pass ':memory:' in tests
 * @returns {{ deletedBatchResults: number, deletedBatches: number, keptBatches: number }}
 */
export function pruneBatchResults({ keepBatches = DEFAULT_BATCH_RETENTION } = {}, which) {
  const db = getDb(which);
  const keep = Math.max(1, Number(keepBatches) || DEFAULT_BATCH_RETENTION);

  return db.transaction(() => {
    // Build the keep-set of batch ids.
    const keepIds = new Set();

    // (c) last K batches overall, by recency. `batches` is ordered by
    // started_at everywhere else (getActiveBatch / idx_batches_started_at).
    for (const row of db.prepare(
      'SELECT id FROM batches ORDER BY started_at DESC LIMIT @keep',
    ).all({ keep })) {
      keepIds.add(row.id);
    }

    // (a) ALL active/unfinished batches (finished_at IS NULL). Keeping only
    // getActiveBatch's single newest unfinished batch would let the child DELETE
    // strip a second unfinished batch's batch_results, orphaning its parent row.
    for (const row of db.prepare(
      'SELECT id FROM batches WHERE finished_at IS NULL',
    ).all()) {
      keepIds.add(row.id);
    }

    // (b) the most-recent finished batch.
    const last = getLastBatch(which);
    if (last?.batch?.id != null) keepIds.add(last.batch.id);

    const ids = [...keepIds];
    // Guard: an empty keep-set would delete everything. `keep >= 1` plus the
    // active/last lookups mean this is only empty when there are no batches at
    // all — in which case both deletes below are no-ops anyway, but bail early.
    if (ids.length === 0) {
      return { deletedBatchResults: 0, deletedBatches: 0, keptBatches: 0 };
    }

    const placeholders = ids.map((_, i) => `@k${i}`).join(',');
    const params = {};
    ids.forEach((id, i) => { params[`k${i}`] = id; });

    // Child delete first (batch_results), then parent (batches) — never delete
    // an unfinished/active batch row.
    const delResults = db.prepare(
      `DELETE FROM batch_results WHERE batch_id NOT IN (${placeholders})`,
    ).run(params);
    const delBatches = db.prepare(
      `DELETE FROM batches WHERE id NOT IN (${placeholders}) AND finished_at IS NOT NULL`,
    ).run(params);

    return {
      deletedBatchResults: delResults.changes,
      deletedBatches: delBatches.changes,
      keptBatches: ids.length,
    };
  })();
}

// ─── Close ────────────────────────────────────────────────────────────────────

/**
 * Close the singleton DB handle.
 *
 * @param {string} [which] - Ignored (back-compat).
 */
export function closeDb(which) {
  if (_handles.real) {
    // Force a checkpoint so WAL changes land in the main DB file before close.
    // Without this, an aborted shutdown can leave audit.db-wal multi-GB on disk.
    try { _handles.real.pragma('wal_checkpoint(TRUNCATE)'); }
    catch (e) { console.error('[db] wal_checkpoint failed on close:', e.message); }
    _handles.real.close();
    _handles.real = null;
  }
}

// Auto-close on process exit so ad-hoc importers (e.g. `node -e
// "import('./core/db.js')..."` verification scripts) never leave the WAL
// locked. Without this, a hung script blocks every subsequent `getDb()` —
// which is exactly how the server boot-hang on 2026-04-30 happened.
process.on('exit', () => { try { closeDb(); } catch { /* exit handlers can't throw */ } });
