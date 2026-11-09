// ─── Solana-only persistence ─────────────────────────────────────────────────
// Lives in the SAME audit.db as the shared Cosmos schema (core/db.js), in its
// own tables, created on first use:
//   sol_channels  every voucher channel a test opened, until closed and refunded
//   sol_reports   every SNTR1 report memo the tester posted
//   sol_kv        small flags (refundPending)
import { getDb as coreDb } from '../core/db.js';

let _ready = null;

export function getDb() {
  const db = coreDb();
  if (_ready !== db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sol_channels (
        address          TEXT PRIMARY KEY,
        node_addr        TEXT NOT NULL,
        run_id           INTEGER,
        opened_at        INTEGER NOT NULL,
        escrow_base      INTEGER,
        status           TEXT NOT NULL DEFAULT 'open',
        close_started_at INTEGER,
        closed_at        INTEGER,
        redeemed_base    INTEGER,
        refunded_base    INTEGER,
        tx_start_close   TEXT,
        tx_close         TEXT,
        last_error       TEXT
      );
      CREATE TABLE IF NOT EXISTS sol_reports (
        id           INTEGER PRIMARY KEY,
        signature    TEXT NOT NULL UNIQUE,
        slot         INTEGER,
        run_id       INTEGER,
        record_count INTEGER NOT NULL,
        memo         TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sol_kv (key TEXT PRIMARY KEY, value TEXT);
    `);
    _ready = db;
  }
  return db;
}

export function recordChannel({ address, node_addr, run_id = null, escrow_base = null }) {
  getDb().prepare(`
    INSERT INTO sol_channels (address, node_addr, run_id, opened_at, escrow_base)
    VALUES (@address, @node_addr, @run_id, @opened_at, @escrow_base)
    ON CONFLICT(address) DO NOTHING
  `).run({ address, node_addr, run_id, opened_at: Date.now(), escrow_base });
}

const CHANNEL_COLUMNS = ['status', 'close_started_at', 'closed_at', 'redeemed_base', 'refunded_base', 'tx_start_close', 'tx_close', 'last_error'];

export function updateChannel(address, patch) {
  const sets = Object.keys(patch).filter((k) => CHANNEL_COLUMNS.includes(k));
  if (!sets.length) return;
  getDb().prepare(`UPDATE sol_channels SET ${sets.map((k) => `${k} = @${k}`).join(', ')} WHERE address = @address`).run({ ...patch, address });
}

export function listChannels({ openOnly = false } = {}) {
  return getDb().prepare(openOnly
    ? "SELECT * FROM sol_channels WHERE status IN ('open','closing') ORDER BY opened_at DESC"
    : 'SELECT * FROM sol_channels ORDER BY opened_at DESC LIMIT 500').all();
}

export function insertReport({ signature, slot = null, run_id = null, record_count, memo }) {
  getDb().prepare(`
    INSERT INTO sol_reports (signature, slot, run_id, record_count, memo, created_at)
    VALUES (@signature, @slot, @run_id, @record_count, @memo, @created_at)
    ON CONFLICT(signature) DO NOTHING
  `).run({ signature, slot, run_id, record_count, memo, created_at: Date.now() });
}

export function listReports({ limit = 50 } = {}) {
  return getDb().prepare('SELECT * FROM sol_reports ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function kvGet(key) {
  const row = getDb().prepare('SELECT value FROM sol_kv WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function kvSet(key, value) {
  getDb().prepare('INSERT INTO sol_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
