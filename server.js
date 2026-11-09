/**
 * Sentinel dVPN Network Audit — Server
 * Thin Express server: API routes, SSE, imports from modular architecture.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { adminOnly, attachAdminFlag, safeEq, setAdminSessionValidator } from './core/auth.js';
import { rateLimit, sseLimit } from './core/rate-limit.js';

import { MNEMONIC, DENOM, GAS_PRICE, PORT, LCD_ENDPOINTS, RPC_ENDPOINTS, PROJECT_ROOT, DNS_PRESETS, ACTIVE_DNS, setActiveDns } from './core/constants.js';
import { getSettings, updateSettings, getDefaultSettings } from './core/settings.js';
import { queryReports as queryOnchainReports } from './core/onchain-report.js';
import { cachedWalletSetup, createFreshClient } from './core/wallet.js';
import { ensureLcd, getActiveLcd, cleanupRpc, getAllNodes } from './core/chain.js';
import { nodeStatusV3 } from './protocol/v3protocol.js';
import { createState, runAudit, runRetestSkips, runPlanTest, runSubPlanTest, getResults, saveResults, triggerPipelineStop } from './audit/pipeline.js';
import {
  insertRun, updateRunOnFinish, getRunSpendByFinish, getRun,
  insertResult, insertErrorLog,
  searchNodes, getNodeDetail, getNodeErrors, getCountryList,
  getActiveRun, getLastCompletedRun, getBandwidthHistory,
  searchErrors, getNetworkStats, getRunStats,
  listBatches, getBatchResults, getActiveBatch, getLastBatch,
  insertBatch, updateBatchOnFinish, insertBatchResult,
  reopenBatch, getBatchById, getBatchWithNodes,
  getDb,
} from './core/db.js';
import * as continuous from './audit/continuous.js';
import { getInstalledVersions, verifyAllSdks, verifySdk } from './core/sdk-verify.js';
// Force line-buffered stdout/stderr so boot diagnostics flush immediately
// even when redirected to a file (Windows defaults to block-buffering, which
// hides every console.log if the process hangs before app.listen).
try { process.stdout._handle?.setBlocking?.(true); } catch (e) { console.error('[boot] stdout setBlocking failed:', e.message); }
try { process.stderr._handle?.setBlocking?.(true); } catch (e) { console.error('[boot] stderr setBlocking failed:', e.message); }

// Platform-aware WireGuard import — Windows / Linux / macOS each have full implementations
// Wrapped in a 5s timeout: the windows module runs sync `execSync` probes
// (`net session`, `where wireguard.exe`, `wg-quick --version`) at its own
// module scope. Any of those can stall on a slow Service Control Manager
// and deadlock the entire server boot. Falling back to WG_AVAILABLE=false
// is preferable to a silent zombie.
let emergencyCleanupSync, watchdogCheck, WG_AVAILABLE, IS_ADMIN;
const _wgFallback = () => {
  console.error('[boot] WireGuard module init timed out — continuing with WG disabled');
  emergencyCleanupSync = () => {};
  watchdogCheck = () => {};
  WG_AVAILABLE = false;
  IS_ADMIN = false;
};
const _wgImport = (() => {
  if (process.platform === 'win32') return import('./platforms/windows/wireguard.js');
  if (process.platform === 'linux') return import('./platforms/linux/wireguard.js');
  if (process.platform === 'darwin') return import('./platforms/macos/wireguard.js');
  return null;
})();
if (_wgImport) {
  const _wgTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('wg-import-timeout')), 5000));
  try {
    ({ emergencyCleanupSync, watchdogCheck, WG_AVAILABLE, IS_ADMIN } = await Promise.race([_wgImport, _wgTimeout]));
  } catch (e) {
    console.error(`[boot] WireGuard import failed: ${e.message}`);
    _wgFallback();
  }
} else {
  emergencyCleanupSync = () => {};
  watchdogCheck = () => {};
  WG_AVAILABLE = false;
  IS_ADMIN = process.getuid?.() === 0 || false;
}
import { loadTransportCache, getCacheStats } from './core/transport-cache.js';

// Solana: the tester wallet is the TEST_KEYFILE keypair; balances are tDVPN base
// units (6 decimals, the same scale the dashboards use). No CosmJS client.
import { tokenBalanceBase } from './core/wallet.js';
import { walletAddress as solanaWalletAddress } from './lib/wallet.js';
import { TOKEN_LABEL, DVPND_IMAGE } from './lib/constants.js';
import { dockerStatus, imagePresent } from './audit/docker.js';
import solanaRoutes from './routes/solana.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.PATH = path.join(__dirname, 'bin') + path.delimiter + (process.env.PATH || '');

// ─── Env sanity check ───────────────────────────────────────────────────────
const PUBLIC_MODE = process.env.PUBLIC_MODE === 'true';
const ADMIN_PATH = process.env.ADMIN_PATH || '/admin';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// M-05: use ephemeral per-process secret when ADMIN_TOKEN is absent; forbids
// forged signed cookies even in single-user/dev mode.
import crypto from 'node:crypto';
const COOKIE_SECRET = ADMIN_TOKEN || crypto.randomBytes(32).toString('hex');

// ─── Admin session store (H-02) ─────────────────────────────────────────────
// Map<sessionId, expiryMs>. Session ID is stored in the signed cookie instead
// of the raw ADMIN_TOKEN so cookie theft cannot recover the backend token.
// In-memory only: admin logouts drop entries; process restart invalidates all sessions.
const ADMIN_SESSIONS = new Map();
const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Cap to bound memory under sustained brute-force or buggy clients that never
// log out. Map iteration order is insertion order — drop the oldest entry when
// we exceed the cap. 1000 sessions × ~80 bytes = ~80 KB worst case.
const ADMIN_SESSIONS_MAX = 1000;

export function createAdminSession() {
  const id = crypto.randomBytes(32).toString('hex');
  if (ADMIN_SESSIONS.size >= ADMIN_SESSIONS_MAX) {
    const oldest = ADMIN_SESSIONS.keys().next().value;
    if (oldest) ADMIN_SESSIONS.delete(oldest);
  }
  ADMIN_SESSIONS.set(id, Date.now() + ADMIN_SESSION_TTL_MS);
  return id;
}

export function isValidAdminSession(id) {
  if (!id || typeof id !== 'string') return false;
  const exp = ADMIN_SESSIONS.get(id);
  if (!exp) return false;
  if (exp < Date.now()) { ADMIN_SESSIONS.delete(id); return false; }
  return true;
}

export function revokeAdminSession(id) {
  if (id) ADMIN_SESSIONS.delete(id);
}

// Periodic cleanup of expired sessions — 1-hour interval
setInterval(() => {
  const now = Date.now();
  for (const [id, exp] of ADMIN_SESSIONS) {
    if (exp < now) ADMIN_SESSIONS.delete(id);
  }
}, 60 * 60 * 1000).unref();

// Inject the validator into the auth middleware. Must run before any admin request.
setAdminSessionValidator(isValidAdminSession);

if (PUBLIC_MODE && !ADMIN_TOKEN) {
  console.error('');
  console.error('ERROR: PUBLIC_MODE=true requires ADMIN_TOKEN to be set.');
  console.error('  Without ADMIN_TOKEN, the admin surface has no protection.');
  console.error('  Generate one:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  console.error('  Then add ADMIN_TOKEN=<value> to your .env file.');
  console.error('');
  process.exit(1);
}

if (!MNEMONIC || !MNEMONIC.trim()) {
  console.warn('');
  console.warn('⚠  TEST_KEYFILE is not set.');
  console.warn('   The server will start, but any test that pays a session will fail.');
  console.warn('   Fix: copy .env.example to .env and set TEST_KEYFILE to a solana-keygen JSON key file.');
  console.warn('');
}

// ─── WireGuard Safety: cleanup on ANY exit ──────────────────────────────────
// Boot-time cleanup is deferred until AFTER app.listen — running it inline
// here can block the event loop for 10–30s on a slow Service Control Manager
// (sc query / sc stop / sc delete each carry their own 5s timeouts).

function onProcessExit() { cleanupRpc(); emergencyCleanupSync(); }
process.on('exit', onProcessExit);

// Graceful shutdown: stop the continuous loop before exit so it can't keep
// writing `runs` rows after the HTTP listener closes. Best-effort only; the
// hard exit fires after 2s regardless so Ctrl-C is still snappy.
function gracefulShutdown(signal, exitCode) {
  console.log(`[server] ${signal} received — stopping continuous loop`);
  // Force a final snapshot before teardown so a Ctrl-C / SIGTERM within the
  // throttle window still persists the latest in-flight state for resume.
  try { flushStateSnapshot(); } catch (e) { console.error('[shutdown] snapshot flush failed:', e.message); }
  try { continuous.stop(); } catch {}
  onProcessExit();
  setTimeout(() => process.exit(exitCode), 2_000).unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT', 130));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 143));
// Crash loud, crash fast. Without process.exit, the handler runs cleanup and
// the event loop keeps going on a half-initialised state — silent zombie.
process.on('uncaughtException', (err) => {
  const msg = err?.stack || err?.message || String(err);
  console.error(`[uncaughtException] ${msg}`);
  try { emergencyCleanupSync(); } catch (e) { console.error('[uncaughtException] cleanup failed:', e.message); }
  setTimeout(() => process.exit(1), 500).unref();
});
process.on('unhandledRejection', (reason) => {
  const msg = reason?.stack || reason?.message || String(reason);
  console.error(`[unhandledRejection] ${msg}`);
  try { emergencyCleanupSync(); } catch (e) { console.error('[unhandledRejection] cleanup failed:', e.message); }
  setTimeout(() => process.exit(1), 500).unref();
});

// Watchdog: every 5s, check if a tunnel has been up too long
setInterval(() => {
  if (watchdogCheck()) {
    broadcast('log', { msg: '⚠ WATCHDOG: Force-killed stale WireGuard tunnel' });
  }
}, 5_000);

// ─── SSE ────────────────────────────────────────────────────────────────────
const emitter = new EventEmitter();
emitter.setMaxListeners(100);
// Sized to comfortably hold the full log of a typical run (~10–20 lines per
// node × hundreds of nodes) plus headroom. SSE init replays this to admin and
// live so a refresh / reconnect / resume sees the run's full prior history,
// not just the last few lines.
const LOG_BUFFER_MAX = 5000;
// The full LOG_BUFFER_MAX backlog is kept server-side, but the SSE `init`
// bootstrap frame replays only the most recent INIT_LOG_REPLAY lines. A fresh
// tab needs recent context, not 5000 lines — replaying the whole buffer made
// the init frame hundreds of KB. /live is unaffected: it separately refetches
// the full backlog from GET /api/public/logs (live.html), which still returns
// the whole (filtered) buffer. admin.html relies on the init replay, so the
// admin log pane shows the most recent INIT_LOG_REPLAY lines on a fresh
// connect/refresh; subsequent live lines stream in normally as events arrive.
const INIT_LOG_REPLAY = 500;
const logBuffer = [];

// ─── State Snapshot (persists volatile fields across restarts) ───────────────
const STATE_SNAPSHOT_FILE = path.join(__dirname, 'results', '.state-snapshot.json');
let _lastSnapshotTs = 0;

function saveStateSnapshot(force = false) {
  // Throttle: save at most every 5 seconds to avoid disk thrashing — unless
  // `force` is set. Terminal status transitions (stop/done/error) and explicit
  // flush points pass force=true so a crash/stop within the 5s window can't
  // lose the latest activeBatchId / spend / resumeHeadAddr / activeDbRunId.
  const now = Date.now();
  if (!force && now - _lastSnapshotTs < 5_000) return;
  _lastSnapshotTs = now;
  try {
    _writeAtomic(STATE_SNAPSHOT_FILE, JSON.stringify({
      baselineHistory: state.baselineHistory,
      nodeSpeedHistory: state.nodeSpeedHistory,
      spentUdvpn: state.spentUdvpn,
      runSpentUdvpn: state.runSpentUdvpn ?? 0,
      balanceUdvpn: state.balanceUdvpn,
      balance: state.balance,
      estimatedTotalCost: state.estimatedTotalCost,
      startedAt: state.startedAt,
      baselineMbps: state.baselineMbps,
      totalNodes: state.totalNodes,
      status: state.status,
      // Run-mode context — without this, /api/resume after a process bounce
      // silently demotes a subscription run to P2P (the C-1 family of bugs).
      runMode: state.runMode,
      testRun: state.testRun,
      runPlanId: state.runPlanId,
      runSubscriptionId: state.runSubscriptionId,
      runGranter: state.runGranter,
      pricingMode: state.pricingMode,
      activeSDK: state.activeSDK,
      continuousLoop: state.continuousLoop,
      // Persist the open batch handle so /api/resume after a process bounce
      // can re-attach to the same batches row instead of starting a new one.
      activeBatchId: state.activeBatchId || 0,
      // Address of the in-flight node when stop hit, so resume can hoist
      // it back to the front of the next scan order.
      resumeHeadAddr: state.resumeHeadAddr || null,
      // Path of the audit log file currently being appended to. Survives
      // process bounce so /api/resume reuses the same file instead of
      // creating a fresh `audit-<ts>.log` and orphaning prior entries.
      auditLogPath: state.auditLogPath || null,
      // SQLite runs.id of the in-flight run. Without this, /api/resume after
      // a process bounce leaves state.activeDbRunId=null and post-resume failures
      // skip insertErrorLog — the node-detail popup then has nothing to show.
      activeDbRunId: state.activeDbRunId || null,
      // The run currently displayed (dropdown selection + save/resume dir). Must
      // survive a bounce so boot doesn't re-alias an unsaved run onto a saved one.
      activeRunNumber: state.activeRunNumber ?? null,
      // H-1: read-only marker for a loaded historical run. Without persisting +
      // restoring this, a process bounce clears it and /api/resume would let an
      // incomplete loaded run be resumed (appending live rows onto a past run).
      loadedReadonly: !!state.loadedReadonly,
    }), 'utf8');
  } catch (e) { console.error('[snapshot] write failed:', e.message); }
}

// Force a non-throttled snapshot write. Call on terminal status transitions
// and in /api/stop so the latest volatile fields survive a stop/crash that
// lands inside the 5s throttle window.
function flushStateSnapshot() { saveStateSnapshot(true); }

// ─── Log categorization ──────────────────────────────────────────────────────
// Every log line gets exactly ONE category: 'events' | 'sys' | 'node'.
//   EVENTS — operator/lifecycle (start/stop/save/load, on-chain, wallet, DNS…)
//   SYS    — in-run diagnostics (baseline, balance, connectivity, scan…)
//   NODE   — per-node results incl. failures (default).
// First match wins, checked in EVENTS → SYS → NODE order. The 📡 emoji is shared
// by on-chain (events) and baseline (sys), so classify by the WORDS, not emoji.
// IMPORTANT: keep these keyword lists byte-identical to admin.html's logCategory().
function classifyLogCategory(msg) {
  const s = String(msg == null ? '' : msg);
  // NOTE: no bare '💾' — it also prefixes the per-node "💾 Cached:" transport
  // line; 'Saved' already covers the lifecycle save lines. 'Resuming Test' is a
  // lifecycle sibling of 'Starting Test'.
  const EVENTS = ['Starting Test', 'Resuming Test', 'Stop requested', '⏹', 'Loop continues', '♾', 'Deleted Test', '🗑', 'Saved', 'Loaded Test', '📂', 'DNS', '🔧', 'On-chain reporting', 'On-chain report posted', 'Setting up wallet', '🔑', 'Log file', '📝', 'subscribing', '📋', 'SDK switched', 'Broadcast'];
  const SYS = ['baseline', 'Baseline', 'Balance', '💰', 'internet', 'Internet', 'connectivity', '🌐', 'Transport cache', '🧠', 'Fetching node list', '🔍', 'V2Ray:', 'WireGuard:', 'Admin:', 'Cloudflare', 'Discovered', 'active plans', 'online scan', 'Scanning'];
  for (const k of EVENTS) if (s.includes(k)) return 'events';
  for (const k of SYS) if (s.includes(k)) return 'sys';
  return 'node';
}

// Public /live shows per-NODE activity only — operator EVENTS and in-run SYS
// diagnostics are hidden from spectators (the admin dashboard still shows all).
// Filters the rolling string buffer for the public log endpoints.
function publicLogBuffer() {
  return logBuffer.filter(e => classifyLogCategory(e.msg) === 'node');
}

// Is there an ACTIVE run worth showing to /live right now? Public live surfaces
// (SSE init, /logs, /live-state) must return EMPTY work payloads when no run is
// in flight — otherwise a paused/idle page (e.g. right after boot, when
// logBuffer is hydrated from results/audit-*.log) ships the last run's log
// backlog + results behind the "Testing Has Been Paused" overlay. The overlay
// is opaque so it's not visible, but the page still LOADS that data — which is
// exactly what we don't want. Gate the payload at the source instead.
function publicRunActive() {
  try { if (continuous.status()?.running) return true; } catch (e) { console.error('[publicRunActive] continuous.status failed:', e.message); }
  try { if (getActiveBatch()) return true; } catch (e) { console.error('[publicRunActive] getActiveBatch failed:', e.message); }
  const st = state && state.status;
  return st === 'running' || (typeof st === 'string' && st.indexOf('paused') === 0);
}

// EVENTS persist to a file (separate from per-run runs/test-NNN/audit.log), with
// a simple 1-file rotation at ~2MB so it can't grow unbounded.
const EVENTS_LOG_FILE = path.join(__dirname, 'results', 'events.log');
const EVENTS_LOG_MAX_BYTES = 2 * 1024 * 1024;
function appendEventLog(msg) {
  try {
    try {
      const st = _statSync(EVENTS_LOG_FILE);
      if (st && st.size > EVENTS_LOG_MAX_BYTES) {
        _rfs2(EVENTS_LOG_FILE, EVENTS_LOG_FILE + '.1');
      }
    } catch (e) {
      // ENOENT (no file yet) is expected — only log genuine stat/rotate errors.
      if (e && e.code !== 'ENOENT') console.error('[events.log] rotate failed:', e.message);
    }
    _afs(EVENTS_LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch (e) {
    console.error('[events.log] append failed:', e.message);
  }
}

// ─── Server-authoritative ETA (windowed real-throughput) ───────────────────
// Both admin.html and live.html used to compute ETA independently from
// different inputs, so they disagreed. The server now owns the single source
// of truth: it keeps a rolling window of the last ETA_WINDOW node-completion
// timestamps, derives the current completion RATE (nodes/ms), and broadcasts
// a REMAINING DURATION (`etaRemainingMs`) — NOT an absolute epoch. Each client
// anchors that duration to its OWN clock at receipt and counts it down, so a
// skewed browser clock can't distort the ETA (an absolute server epoch rendered
// against a skewed client Date.now() drifted by the offset — minutes). The math
// is throughput-based (parallelism-aware), not per-node-duration based.
const ETA_WINDOW = 12;
let _etaCompletions = [];   // recent node-completion epoch ms (rolling, current pass)
let _etaLastDone = -1;      // last seen completed-count, to detect a new pass
let _etaPrevStatus = null;  // last seen status, to detect a fresh →running transition

// Resolve the (done, total) pair the ETA should measure against. During a
// retest (runRetestSkips), every node already has a result row so the whole-run
// counters are saturated (done ≈ total) and remaining ≤ 0 — the ETA would pin
// at 00:00:00 for the entire retest. The retest's REAL progress lives in
// separate fields (retestTested / retestPassed+retestFailed / retestTotal), so
// when retestMode is set with a usable retestTotal we measure against those
// instead. Falls back to the whole-run counters whenever the retest fields are
// absent or non-positive (defensive — never let a missing field zero the ETA).
function etaProgress(st) {
  if (st.retestMode && Number(st.retestTotal) > 0) {
    // retestTested already counts every retested node (pass + fail), so it is
    // the authoritative "done" for the retest pass; fall back to summing
    // retestPassed+retestFailed if retestTested is somehow absent.
    let done = Number(st.retestTested);
    if (!(done >= 0)) done = (Number(st.retestPassed) || 0) + (Number(st.retestFailed) || 0);
    return { done, total: Number(st.retestTotal) };
  }
  const done = (st.testedNodes || 0) + (st.failedNodes || 0) + (st.skippedNodes || 0);
  const total = st.totalNodes || 0;
  return { done, total };
}

// Returns the REMAINING milliseconds until the active pass completes, or null
// when not computable (not running / <2 completions / total<=0). 0 when there
// is no work left. Clients anchor this to their own clock and tick it down.
function computeEtaRemainingMs(st) {
  if (!st || typeof st !== 'object') return null;
  // Only meaningful while a pass is actively running. done/idle/paused_* → null.
  if (st.status !== 'running') return null;
  const { done, total } = etaProgress(st);
  if (total <= 0) return null;
  const remaining = total - done;
  if (remaining <= 0) return 0; // no work left → renders 00:00:00
  if (_etaCompletions.length < 2) return null; // not enough data → client shows "Calculating…"
  const span = _etaCompletions[_etaCompletions.length - 1] - _etaCompletions[0];
  if (span <= 0) return null;
  const n = _etaCompletions.length - 1; // intervals across the window
  const ratePerMs = n / span;
  const etaMs = remaining / ratePerMs;
  return Math.round(etaMs);
}

function broadcast(type, data = {}) {
  if (type === 'log' && data.msg) {
    // Tag the live SSE 'log' event with a category so admin/live can filter
    // without re-deriving it. Set BEFORE emitter.emit below.
    data.cat = data.cat || classifyLogCategory(data.msg);
    // Stamp emission time ONCE, here, so every surface shows WHEN a line was
    // produced — not when the client rendered/replayed it. The ts rides on the
    // live SSE event (data.ts), the in-memory buffer ({ts,msg}), and — via the
    // pipeline's ISO-prefixed logLine — the on-disk audit log, so it survives a
    // restart too. Buffer entries are {ts,msg} objects; consumers read .msg.
    if (data.ts == null) data.ts = Date.now();
    logBuffer.push({ ts: data.ts, msg: data.msg });
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    if (data.cat === 'events') appendEventLog(data.msg);
  }
  if (type === 'state' || type === 'result') saveStateSnapshot();
  // ─── ETA bookkeeping ──────────────────────────────────────────────────────
  // Record the just-finished node FIRST (so it's in the window), then compute
  // the remaining duration and stamp it onto any state payload so admin (which
  // ticks on 'result' events) and live (which ticks on 'state') both anchor the
  // same value to their own clocks.
  if (type === 'result') {
    _etaCompletions.push(Date.now());
    if (_etaCompletions.length > ETA_WINDOW) {
      _etaCompletions = _etaCompletions.slice(-ETA_WINDOW);
    }
  }
  if (data && data.state && typeof data.state === 'object') {
    const s = data.state;
    // Explicit fresh-run ring reset: when status transitions INTO 'running' from
    // any non-running status, wipe the window so a new run can never inherit the
    // prior run's completion timestamps. This no longer relies on an incidental
    // zero-`done` broadcast landing before the first result of the new run.
    if (s.status === 'running' && _etaPrevStatus !== 'running') {
      _etaCompletions = [];
      _etaLastDone = -1;
    }
    _etaPrevStatus = s.status;
    const { done } = etaProgress(s);
    // Belt-and-suspenders per-pass reset within a continuous loop: each
    // iteration's counters reset to 0, so a drop below the last-seen done count
    // means a new pass started — clear the window.
    if (done < _etaLastDone) _etaCompletions = [];
    _etaLastDone = done;
    // NOTE: for most callers data.state IS the long-lived global `state` object,
    // so this assignment MUTATES the global in place — etaRemainingMs is not a
    // per-payload-only field. That's fine: it's recomputed on every broadcast,
    // and computeEtaRemainingMs SELF-CLEARS it to null whenever status !==
    // 'running' (done/idle/paused_*), so a stale value can never linger on the
    // global. saveStateSnapshot's allowlist also excludes it, so it never persists.
    data.state.etaRemainingMs = computeEtaRemainingMs(data.state);
  }
  // NOTE: spread `data` FIRST so a payload field named `type` (e.g. the node's
  // service-type like 'wireguard') cannot clobber the SSE event type. The
  // event type is the dispatch key — clients switch on d.type — so it must win.
  emitter.emit('update', { ...data, type });
}

// Use this for any state change where the client must replace its row table:
// run start, /api/clear, retest, load. The admin client treats `msg.results`
// presence as the wipe signal — omitting it leaves stale rows on screen, which
// has burned us before (5 stale TEST_RUN_SKIP rows after New Test).
function broadcastStateFresh(extra = {}) {
  broadcast('state', { state, results: getResults(), ...extra });
}

// ─── Batch persistence wrapper for direct pipeline calls ────────────────────
// audit/continuous.js writes batches/batch_results for continuous-loop runs.
// Direct pipeline calls (subscription start/resume, p2p start/resume, plan-test,
// retest) bypass continuous.js entirely — without this wrapper they never
// produce a `batches` row, so /api/public/runs/current returns 404 and the
// /live page can't reconstruct in-flight progress on refresh.
//
// `mode` MUST match the run intent so the dashboard never confuses subscription
// (Plan #N), p2p (pay-per-GB), and test (TEST_RUN_SKIP) runs.
function withBatchTracking(baseBroadcast, mode, opts = {}) {
  // Resume re-attaches to the previously-open batch via opts.existingBatchId so
  // /live's hydrate-from-DB path returns the full pre-pause + post-resume row
  // set as one batch. Without this, every resume opens a fresh batches row and
  // the table on /live wipes back to whatever was tested AFTER resume only.
  let batchId = opts.existingBatchId ? Number(opts.existingBatchId) : 0;
  let opened = batchId > 0;
  let closed = false;
  let startEmitted = false;
  if (opened) {
    state.activeBatchId = batchId;
    try { reopenBatch(batchId, 'real'); } catch (e) { console.error('[withBatchTracking reopen]', e.message); }
  }
  return function tracked(type, data = {}) {
    try {
      if (!closed && !opened && type === 'result' && data && data.result) {
        batchId = insertBatch({
          started_at:    Date.now(),
          snapshot_size: state.totalNodes || 0,
          mode,
        }, 'real');
        state.activeBatchId = batchId;
        opened = true;
      }
      if (opened && !closed && type === 'result' && data && data.result) {
        const r = data.result;
        insertBatchResult(batchId, {
          address:       r.address || '',
          moniker:       r.moniker || null,
          country:       r.country || null,
          country_code:  r.countryCode || r.country_code || null,
          city:          r.city || null,
          type:          r.type || null,
          actual_mbps:   r.actualMbps ?? null,
          peers:         r.peers ?? null,
          max_peers:     r.maxPeers ?? null,
          error:         r.error ? String(r.error).slice(0, 200) : null,
          error_code:    r.errorCode || null,
          tested_at:     Date.now(),
          baseline_mbps: r.baselineAtTest ?? r.baselineMbps ?? null,
        }, 'real');
        // Emit batch:start once + batch:node:result per row so /live's Current
        // Batch panel ticks for direct-pipeline runs (sub-plan, p2p, retest)
        // exactly like continuous.js does. Without this, /live falls back on
        // resultsArr.length which can desync if any 'result' SSE event is
        // dropped (broadcastLive flip race, reconnect gap), leaving the
        // counter stuck at the count from the last full REST hydrate.
        if (!startEmitted) {
          baseBroadcast('batch:start', {
            batchId,
            iteration:    null,
            startedAt:    new Date().toISOString(),
            snapshotSize: state.totalNodes || 0,
            mode,
          });
          startEmitted = true;
        }
        baseBroadcast('batch:node:result', {
          batchId,
          address:      r.address || '',
          moniker:      r.moniker || null,
          country:      r.country || null,
          countryCode:  r.countryCode || r.country_code || null,
          city:         r.city || null,
          serviceType:  r.type || null,
          actualMbps:   r.actualMbps ?? null,
          baselineMbps: r.baselineAtTest ?? r.baselineMbps ?? null,
          peers:        r.peers ?? null,
          maxPeers:     r.maxPeers ?? null,
          error:        r.error ? String(r.error).slice(0, 200) : null,
          errorCode:    r.errorCode || null,
          testedAt:     Date.now(),
        });
      }
      if (opened && !closed && type === 'state' && data && data.state) {
        const status = data.state.status;
        if (status === 'done' || status === 'error' || status === 'stopped') {
          const passed = data.state.testedNodes || 0;
          const failed = data.state.failedNodes || 0;
          updateBatchOnFinish(batchId, {
            finished_at: Date.now(),
            passed,
            failed,
          }, 'real');
          closed = true;
          if (startEmitted) {
            baseBroadcast('batch:end', {
              batchId,
              passed,
              failed,
              durationMs: null,
            });
          }
          // Keep state.activeBatchId so /api/resume can find this batch and
          // reopen it. /api/start clears it explicitly when a new test begins.
        }
      }
    } catch (err) {
      console.error(`[withBatchTracking ${mode}] ${err.message}`);
    }
    baseBroadcast(type, data);
  };
}

// ─── Continuous Loop SSE forwarding ─────────────────────────────────────────
// Forward loop and batch events from the continuous runner into the broadcast bus.
{
  const LOOP_EVENTS = [
    'loop:started', 'loop:stopping', 'loop:stopped', 'loop:error',
    'iteration:start', 'iteration:end',
  ];
  for (const evt of LOOP_EVENTS) {
    continuous.on(evt, (data) => broadcast(evt, data || {}));
  }

  const BATCH_EVENTS = ['batch:start', 'batch:node:result', 'batch:end', 'batch:gap'];
  for (const evt of BATCH_EVENTS) {
    continuous.on(evt, (data) => broadcast(evt, data || {}));
  }

  // Forward per-node log/state/result/progress from inside the continuous
  // pipeline so the live dashboard mirrors the admin dashboard 1:1 during
  // continuous-loop runs (not only direct /api/start runs).
  const LIVE_EVENTS = ['log', 'state', 'result', 'progress'];
  for (const evt of LIVE_EVENTS) {
    continuous.on(evt, (data) => broadcast(evt, data || {}));
  }
}

// ─── State ──────────────────────────────────────────────────────────────────
const state = createState();
// Initialize the read-only marker so the key is always present in admin SSE /
// /api/stats payloads (the admin dashboard reads state.loadedReadonly to hide
// the Resume button for loaded runs). Set true by /api/runs/load, cleared by
// startFreshRun / resume, and persisted+restored across bounces (H-1).
state.loadedReadonly = false;
// Derived flag: is the currently-loaded run already saved in the runs index?
// Drives the admin SAVE button (shown only for an UNSAVED loaded run). Maintained
// at the run-lifecycle points (startFreshRun=false, saveCurrentRun/persistActiveRun
// =true, loadRunIntoState=computed, clearActiveRunView=false, boot=computed) — same
// discipline as loadedReadonly — so it flows to the client via SSE automatically.
state.activeRunSaved = false;

// ─── Canonical "audit busy" predicates — ONE source of truth ─────────────────
// These replace ~10 hand-copied `state.status === 'running' || ...` checks that
// drifted out of sync: new pipeline pause states (paused_balance/paused_internet)
// were added but only some guards were updated, so a run parked on insufficient
// funds looked "idle" to half the guards. Always reach for these helpers.
//
// PIPELINE_BUSY_STATUSES = states where the audit pipeline holds the active run
// dir + SQLite run id and a live writer is either running or parked in a poll
// loop that RESUMES per-node writes on recovery. Launching a new run, retesting,
// deleting the run, or swapping SDK against any of these is unsafe.
//   running          — actively testing
//   paused_balance   — parked in the insufficient-funds poll loop (will resume)
//   paused_internet  — parked in the no-connectivity poll loop (will resume)
//   paused           — diagnostics-subsystem pause (protocol/diagnostics.js)
// NOTE: the periodic balance refresher's `running || paused_balance` check is a
// DIFFERENT concept ("is the pipeline doing its own balance refresh right now")
// and intentionally does NOT use this set — don't fold it in.
const PIPELINE_BUSY_STATUSES = ['running', 'paused', 'paused_balance', 'paused_internet'];
function isPipelineBusy() { return PIPELINE_BUSY_STATUSES.includes(state.status); }
// Pipeline busy OR the continuous-loop runner is active. Use where there is no
// separate continuous-takeover handling (delete, SDK swap).
function isAuditBusy() { return isPipelineBusy() || continuous.status().running; }

// Synchronous "an audit is being launched" guard. /api/start and /api/resume have
// an AWAIT (the continuous-takeover pause-poll) between the isPipelineBusy() check
// and the moment runAudit sets status='running'. Without a flag set before that
// await, two near-simultaneous starts both pass the check, mint duplicate run
// numbers, and overlap on the shared pipeline run dir. Set true before the
// takeover await, cleared once it completes — the rest of the launch is
// synchronous up to status='running', so no concurrent request can interleave.
let _auditLaunching = false;

// Persist Broadcast Live across restarts so the operator's choice survives
// process bounces — without this, every restart silently flips public /live
// back to "paused" even though the admin UI still shows BROADCAST ON.
const BROADCAST_PREF_FILE = path.join(__dirname, 'results', '.broadcast-live');
try { state.broadcastLive = _rfs(BROADCAST_PREF_FILE, 'utf8').trim() === '1'; } catch { state.broadcastLive = false; }
function persistBroadcastPref() {
  try { _wfs(BROADCAST_PREF_FILE, state.broadcastLive ? '1' : '0'); } catch {}
}

// Persist SDK choice to disk so it survives restarts
const SDK_PREF_FILE = path.join(__dirname, 'results', '.sdk-preference');
// Solana: one client implementation — the reference dvpnd in the client container.
state.activeSDK = 'dvpnd';

// Helper: re-hydrate logBuffer from a specific log file on disk. Used both at
// boot (after snapshot restore) and on /api/resume so the SSE init replay
// always carries the in-flight run's full prior log history — not the last
// few lines, and not a different file's contents.
// Parse one on-disk audit line back into a {ts,msg} buffer entry. Lines are
// written as `[<ISO>] <msg>` by audit/pipeline.js logLine. Recover the emission
// timestamp when the prefix is present; lines from older runs (no prefix) yield
// ts:null so the client renders a BLANK time rather than a misleading one.
function parseLogLine(line) {
  const m = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]\s([\s\S]*)$/.exec(line);
  if (m) {
    const t = Date.parse(m[1]);
    return { ts: Number.isNaN(t) ? null : t, msg: m[2] };
  }
  return { ts: null, msg: line };
}

function hydrateLogBufferFromFile(filePath) {
  try {
    const txt = _rfs(filePath, 'utf8');
    const lines = txt.split('\n').filter(l => l.trim());
    const tail = lines.slice(-LOG_BUFFER_MAX);
    logBuffer.length = 0;
    logBuffer.push(...tail.map(parseLogLine));
    return tail.length;
  } catch { return 0; }
}

// ─── Test Run Management ─────────────────────────────────────────────────────
import { readFileSync as _rfs, writeFileSync as _wfs, mkdirSync as _mkd, existsSync as _ex, readdirSync as _rd, copyFileSync as _cp, rmSync as _rm, statSync as _statSync, renameSync as _rfs2, appendFileSync as _afs } from 'fs';

const RUNS_DIR = path.join(__dirname, 'results', 'runs');
const RUNS_INDEX = path.join(RUNS_DIR, 'index.json');
if (!_ex(RUNS_DIR)) _mkd(RUNS_DIR, { recursive: true });

function loadRunsIndex() {
  if (!_ex(RUNS_INDEX)) return { runs: [], activeRun: null };
  try {
    return JSON.parse(_rfs(RUNS_INDEX, 'utf8'));
  } catch (err) {
    console.error(`[loadRunsIndex] corrupt or unreadable ${RUNS_INDEX}: ${err.message} — rebuilding from run folders`);
    return rebuildRunsIndex();
  }
}

function rebuildRunsIndex() {
  const keep = `${RUNS_INDEX}.corrupt-${Date.now()}`;
  try { _cp(RUNS_INDEX, keep); } catch (e) { console.error('[runs] could not keep the corrupt index:', e.message); }
  const runs = [];
  for (const name of _rd(RUNS_DIR)) {
    const m = /^test-(\d+)$/.exec(name);
    if (!m) continue;
    const file = path.join(RUNS_DIR, name, 'results.json');
    if (!_ex(file)) continue;
    try {
      const rows = JSON.parse(_rfs(file, 'utf8'));
      const passed = rows.filter(r => r.actualMbps != null);
      runs.push({
        number: Number(m[1]), label: `Test #${Number(m[1])} (recovered)`, date: _statSync(file).mtime.toISOString(),
        total: rows.length, passed: passed.length, failed: rows.length - passed.length,
        pass10: passed.filter(r => r.actualMbps >= 10).length, recovered: true,
      });
    } catch (e) { console.error(`[runs] ${name}/results.json unreadable, left out of the rebuilt index: ${e.message}`); }
  }
  runs.sort((a, b) => a.number - b.number);
  const index = { runs, activeRun: null };
  saveRunsIndex(index);
  console.error(`[runs] index rebuilt from ${runs.length} run folder(s); the corrupt file is kept as ${path.basename(keep)}`);
  return index;
}

// A run's failures.jsonl holds only that run's failures: lines for its own nodes, stamped
// inside its own span. The global results/failures.jsonl keeps every run's lines.
// JSON stores are written tmp + rename: a crash mid-write must never leave half a file.
function _writeAtomic(file, data) {
  const tmp = file + '.tmp';
  _wfs(tmp, data, 'utf8');
  try { _rfs2(tmp, file); } catch (e) {
    console.error(`[store] rename of ${path.basename(file)} failed, writing in place:`, e.message);
    _wfs(file, data, 'utf8');
  }
}

function writeRunFailures(runDir, rows) {
  const failLog = path.join(__dirname, 'results', 'failures.jsonl');
  if (!_ex(failLog)) return;
  const nodes = new Set(rows.map(r => r.address));
  const times = rows.map(r => Date.parse(r.timestamp || '')).filter(Number.isFinite);
  const from = times.length ? Math.min(...times) - 15 * 60_000 : -Infinity;
  const to = times.length ? Math.max(...times) + 60_000 : Infinity;
  const keep = _rfs(failLog, 'utf8').split('\n').filter((l) => {
    if (!l) return false;
    try {
      const j = JSON.parse(l);
      const t = Date.parse(j.ts || '');
      return nodes.has(j.node) && (!Number.isFinite(t) || (t >= from && t <= to));
    } catch (e) {
      console.error('[runs] unparseable failures.jsonl line skipped:', e.message);
      return false;
    }
  });
  _wfs(path.join(runDir, 'failures.jsonl'), keep.length ? keep.join('\n') + '\n' : '', 'utf8');
}

function saveRunsIndex(index) {
  const nums = index.runs.map(r => r.number).filter(Number.isFinite);
  if (Number.isFinite(index.activeRun)) nums.push(index.activeRun);
  index.highWater = Math.max(Number(index.highWater) || 0, 0, ...nums);
  const data = JSON.stringify(index, null, 2);
  const tmp = RUNS_INDEX + '.tmp';
  _wfs(tmp, data, 'utf8');
  try { _rfs2(tmp, RUNS_INDEX); } catch (e) {
    console.error('[runs] index rename failed, writing in place:', e.message);
    _wfs(RUNS_INDEX, data, 'utf8');
  }
}

function getNextRunNumber() {
  const index = loadRunsIndex();
  const nums = index.runs.map(r => r.number).filter(Number.isFinite);
  if (Number.isFinite(index.activeRun)) nums.push(index.activeRun);
  return Math.max(Number(index.highWater) || 0, 0, ...nums) + 1;
}

function saveCurrentRun(label) {
  const results = getResults();
  if (results.length === 0) return null;

  // C-1(b) guard: if the currently-active run is ALREADY a saved run (its index
  // entry exists AND aliases the same SQLite dbRunId we'd write to), do NOT
  // allocate a new run number / create a duplicate index entry / overwrite the
  // SQLite spend downward. This happens after load+retest (or resume-then-Save):
  // state.activeDbRunId still points at the saved run. Re-persist into the SAME
  // run with accumulateSpend=false so we never reduce stored spend, then return
  // the existing number. persistActiveRun keeps index + SQLite in lockstep.
  if (state.activeRunNumber != null && state.activeDbRunId != null) {
    const idxGuard = loadRunsIndex();
    const existing = idxGuard.runs.find(r => r.number === state.activeRunNumber);
    if (existing && existing.dbRunId != null && Number(existing.dbRunId) === Number(state.activeDbRunId)) {
      // Compare against the CUMULATIVE run spend (runSpentUdvpn), NOT the
      // balance-delta spentUdvpn: when resuming an already-saved run, the index
      // entry still holds the pre-resume total while the post-resume spend lives
      // only in runSpentUdvpn — reading spentUdvpn here would record the stale
      // (smaller) figure and silently drop the resume-pass spend from the
      // on-chain oracle. accumulateSpend=false treats this as the full cumulative.
      const storedSpent = Number(existing.spentUdvpn) || 0;
      const liveSpent = Number(state.runSpentUdvpn) || 0;
      const passSpent = Math.max(storedSpent, liveSpent);
      state.activeRunSaved = true;
      try {
        const r = persistActiveRun(label || existing.label, { accumulateSpend: false, passSpent });
        if (r) return r.number;
      } catch (e) {
        console.error('[saveCurrentRun] re-persist of active saved run failed:', e.message);
      }
      // Fall through to a fresh save only if re-persist threw with no result.
      return state.activeRunNumber;
    }
  }

  // Persist into the run's RESERVED number (startFreshRun pinned it as
  // state.activeRunNumber) — NOT a freshly re-derived getNextRunNumber(). One run
  // = one number = one dir = one index entry. Re-deriving here let a concurrent
  // delete/save shift max(index.runs) so the snapshot dir, index entry, SQLite
  // row, and state.activeRunNumber ended up split across two numbers. Fall back
  // to getNextRunNumber only when no run is reserved (e.g. the first-boot
  // "Initial Audit" save before activeRunNumber is resolved).
  const num = state.activeRunNumber != null ? state.activeRunNumber : getNextRunNumber();
  const runDir = path.join(RUNS_DIR, `test-${String(num).padStart(3, '0')}`);
  _mkd(runDir, { recursive: true });

  // Save results
  _writeAtomic(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2));

  // Save summary
  const passed = results.filter(r => r.actualMbps != null);
  const failed = results.filter(r => r.actualMbps == null);
  const pass10 = passed.filter(r => r.actualMbps >= 10);
  const summary = [
    `Test #${num} — ${label || 'Full Audit'}`,
    `Date: ${new Date().toISOString()}`,
    `${'='.repeat(60)}`,
    `Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`,
    `Success Rate: ${results.length > 0 ? (passed.length / results.length * 100).toFixed(1) : '0.0'}%`,
    `Pass 10 Mbps SLA: ${pass10.length} (${passed.length > 0 ? (pass10.length / passed.length * 100).toFixed(1) : '0.0'}%)`,
    ``,
    `── Passed Nodes (${passed.length}) ──`,
    ...passed.map(r => `  ${r.address.slice(0, 25)}... | ${r.actualMbps} Mbps | ${r.type} | ${r.moniker} | ${r.city}, ${r.country} | Google: ${r.googleAccessible === true ? 'YES' : r.googleAccessible === false ? 'NO' : '?'}`),
    ``,
    `── Failed Nodes (${failed.length}) ──`,
    ...failed.map(r => `  ${r.address.slice(0, 25)}... | ${r.type} | ${r.moniker} | ${r.city}, ${r.country} | peers=${r.peers ?? '?'} | ${(r.error || '').slice(0, 80)}`),
  ].join('\n');
  _wfs(path.join(runDir, 'summary.txt'), summary, 'utf8');

  // Copy failures log
  writeRunFailures(runDir, results);

  // Snapshot the run's execution log so loading the run later shows ITS log
  // (not the last live run's rolling buffer).
  if (state.auditLogPath && _ex(state.auditLogPath)) {
    try { _cp(state.auditLogPath, path.join(runDir, 'audit.log')); } catch { }
  }

  // Update index — find-or-update on the reserved number so re-saving the SAME
  // run updates its entry in place instead of pushing a duplicate (one run = one
  // entry). spentUdvpn/dbRunId persist the run's net spend + SQLite id so loading
  // it later restores Net Spend deterministically; auditLog lets delete purge the
  // raw log.
  const index = loadRunsIndex();
  const entryData = {
    number: num,
    label: label || 'Full Audit',
    date: new Date().toISOString(),
    total: results.length,
    passed: passed.length,
    failed: failed.length,
    pass10: pass10.length,
    sdk: state.activeSDK,
    spentUdvpn: Number(state.runSpentUdvpn) || 0,
    dbRunId: state.activeDbRunId || null,
    auditLog: state.auditLogPath ? path.basename(state.auditLogPath) : null,
  };
  const _existingIdx = index.runs.findIndex(r => r.number === num);
  if (_existingIdx !== -1) index.runs[_existingIdx] = entryData;
  else index.runs.push(entryData);
  index.activeRun = num;
  saveRunsIndex(index);

  // ─── SQLite: mark the run as finished ────────────────────────────────────
  if (state.activeDbRunId) {
    try {
      updateRunOnFinish(state.activeDbRunId, {
        finished_at:    Date.now(),
        node_count:     results.length,
        pass_count:     passed.length,
        spent_udvpn:    Number(state.runSpentUdvpn) || 0,
      });
    } catch (dbErr) {
      console.error(`[db] updateRunOnFinish failed: ${dbErr.message}`);
    }
  }

  state.activeRunSaved = true;
  return num;
}

/**
 * Persist the current in-memory results back to the ACTIVE run's snapshot dir
 * (test-NNN/) + its index entry, WITHOUT allocating a new run number. Used by
 * retest endpoints so a retest's mutated results land on disk + SQLite for the
 * same run the operator was viewing — otherwise file / index / SQLite / live
 * state diverge (the retest-divergence bug). Re-syncs the index counts in place
 * and updates the SQLite run row when one is attached.
 *
 * Returns { number, cumulativeSpent } written, or null when there's
 * nothing/nowhere to save. Callers use cumulativeSpent to reset
 * state.spentUdvpn to the true running total (retest passes reset it to
 * this-pass-only before this runs).
 *
 * `passSpent` (optional) is the spend to ACCUMULATE for this pass. Callers
 * snapshot state.spentUdvpn at the moment the pass spend is known and pass it
 * here, because the idle balance refresher can zero state.spentUdvpn in the gap
 * between a retest flipping status to 'done' and this async persist running.
 * When omitted, falls back to the live state.spentUdvpn.
 */
function persistActiveRun(label, { accumulateSpend = true, passSpent = null } = {}) {
  const num = state.activeRunNumber;
  if (num == null) return null;
  const results = getResults();
  if (results.length === 0) return null;

  const runDir = path.join(RUNS_DIR, `test-${String(num).padStart(3, '0')}`);
  try { _mkd(runDir, { recursive: true }); } catch (e) { console.error('[persistActiveRun] mkdir failed:', e.message); }
  _writeAtomic(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2));

  try { writeRunFailures(runDir, results); } catch (e) { console.error('[persistActiveRun] failures write failed:', e.message); }
  if (state.auditLogPath && _ex(state.auditLogPath)) {
    try { _cp(state.auditLogPath, path.join(runDir, 'audit.log')); } catch (e) { console.error('[persistActiveRun] log copy failed:', e.message); }
  }

  const passed = results.filter(r => r.actualMbps != null);
  const failed = results.filter(r => r.actualMbps == null);
  const pass10 = passed.filter(r => r.actualMbps >= 10);

  // Spend accounting on the retest-persist path:
  // runRetestSkips resets state.spentUdvpn to 0 at its top so the
  // LIVE header shows ONLY this retest pass's spend. The run's STORED total must
  // therefore ACCUMULATE: read the prior cumulative from the existing index
  // entry (default 0) and write prior + this-pass to BOTH the index entry and
  // the SQLite row. This is specific to persistActiveRun (the no-new-number
  // retest path); saveCurrentRun writes a full run's spend and is NOT additive.
  // accumulateSpend can be passed false for callers that already hold the full
  // cumulative figure in state.
  const index = loadRunsIndex();
  let entry = index.runs.find(r => r.number === num);
  const priorSpent    = accumulateSpend ? (Number(entry?.spentUdvpn)    || 0) : 0;
  // Snapshot the pass spend the caller captured (defends against the idle
  // balance refresher zeroing state.spentUdvpn mid-gap); fall back to live state.
  const thisPassSpent = passSpent != null ? (Number(passSpent) || 0) : (Number(state.runSpentUdvpn) || 0);
  const cumulativeSpent    = priorSpent    + thisPassSpent;
  if (!entry) {
    // M-2: no index entry for the active run → create one so index + SQLite
    // stay in lockstep instead of diverging (SQLite written below, index left
    // stale). prior=0 for a brand-new entry, so cumulative == this pass.
    entry = {
      number: num,
      label: label || 'Full Audit',
      date: new Date().toISOString(),
      sdk: state.activeSDK || 'js',
      auditLog: state.auditLogPath ? path.basename(state.auditLogPath) : null,
    };
    index.runs.push(entry);
  }
  entry.total = results.length;
  entry.passed = passed.length;
  entry.failed = failed.length;
  entry.pass10 = pass10.length;
  entry.spentUdvpn = cumulativeSpent;
  if (label) entry.label = label;
  if (state.activeDbRunId) entry.dbRunId = state.activeDbRunId;
  saveRunsIndex(index);

  if (state.activeDbRunId) {
    try {
      updateRunOnFinish(state.activeDbRunId, {
        finished_at:    Date.now(),
        node_count:     results.length,
        pass_count:     passed.length,
        spent_udvpn:    cumulativeSpent,
      });
    } catch (dbErr) {
      console.error(`[persistActiveRun] updateRunOnFinish failed: ${dbErr.message}`);
    }
  }
  state.activeRunSaved = true;
  return { number: num, cumulativeSpent };
}

function loadRun(num) {
  const runDir = path.join(RUNS_DIR, `test-${String(num).padStart(3, '0')}`);
  const resultsPath = path.join(runDir, 'results.json');
  if (!_ex(resultsPath)) return null;
  return JSON.parse(_rfs(resultsPath, 'utf8'));
}

/**
 * Load a saved run's snapshot into the live `state` + working results so the
 * dashboard displays it as a read-only historical run. Single source of truth
 * for "show this run", used by:
 *   - POST /api/runs/load/:num (operator picks a run from the dropdown)
 *   - the boot path (admin always lands on the latest run, never a blank "new")
 *   - the delete-of-active fallback (drop back to the latest remaining run)
 * Returns the loaded results array, or null when the snapshot is missing. Does
 * NOT broadcast — callers broadcast/respond as appropriate.
 */
function loadRunIntoState(num) {
  const data = loadRun(num);
  if (!data) return null;
  // Replace the working set with the loaded run.
  const results = getResults();
  results.length = 0;
  results.push(...data);
  state.activeRunDir = path.join(RUNS_DIR, `test-${String(num).padStart(3, '0')}`);
  saveResults(state);
  rehydrateState(data);
  // A loaded run is a complete set, so its Total is its own node count — not the
  // last live audit's chain total (which rehydrateState deliberately leaves in
  // place). Without this the header's Total/Remaining stuck on the prior run.
  state.totalNodes = data.length;
  // Restore this run's spend total (rehydrateState only recomputes per-node
  // counts). spentUdvpn is already net.
  const _idx = loadRunsIndex();
  const _runMeta = _idx.runs.find(r => r.number === num);
  let _spent = Number(_runMeta?.spentUdvpn) || 0;
  if (_runMeta && _runMeta.spentUdvpn == null) {
    // Preferred path: a stored dbRunId makes the spend lookup deterministic.
    // Fall back to the getRunSpendByFinish time+count heuristic only when no
    // dbRunId was recorded (runs saved before that field existed).
    let recovered = false;
    if (_runMeta.dbRunId) {
      try {
        const row = getRun(Number(_runMeta.dbRunId));
        if (row) { _spent = Number(row.spent_udvpn) || 0; _runMeta.spentUdvpn = _spent; saveRunsIndex(_idx); recovered = true; }
      } catch (e) { console.error('[runs] spend lookup by dbRunId failed:', e.message); }
    }
    if (!recovered && _runMeta.date) {
      try {
        const m = getRunSpendByFinish(Date.parse(_runMeta.date), Number(_runMeta.total) || 0);
        if (m) { _spent = m.spent_udvpn; _runMeta.spentUdvpn = _spent; saveRunsIndex(_idx); }
      } catch (e) { console.error('[runs] spend backfill failed:', e.message); }
    }
  }
  state.spentUdvpn = _spent;
  state.runSpentUdvpn = _spent; // loaded run's stored cumulative spend
  state.estimatedTotalCost = _spent > 0 ? `${(_spent / 1_000_000).toFixed(4)} ${TOKEN_LABEL}` : `0 ${TOKEN_LABEL}`;
  // Live Log follows the loaded run: replace the rolling buffer with this run's
  // saved execution log (empty if the run predates per-run log capture).
  const _runLogPath = path.join(RUNS_DIR, `test-${String(num).padStart(3, '0')}`, 'audit.log');
  logBuffer.length = 0;
  if (_ex(_runLogPath)) { try { hydrateLogBufferFromFile(_runLogPath); } catch { } }
  state.activeRunNumber = num;
  state.status = 'idle';
  // Mark as a loaded, read-only historical snapshot. /api/resume refuses while
  // this is set so a resume can't append live rows onto a past run. Cleared by
  // startFreshRun() (New Test / Retest) and a genuine in-flight resume.
  state.loadedReadonly = true;
  // Saved iff this run has an index entry (it does when _runMeta was found).
  state.activeRunSaved = !!_runMeta;
  // Point the pipeline at THIS run's SQLite row (or detach when unknown) so a
  // later Retest → persistActiveRun updates the correct runs row instead of a
  // stale prior-run id left in state from an earlier live run.
  state.activeDbRunId = _runMeta?.dbRunId != null ? Number(_runMeta.dbRunId) : null;
  // Route-isolation: a loaded run is a read-only historical snapshot. Reset the
  // run-mode context so a subsequent Retest (which clears loadedReadonly) can't
  // inherit a stale mode from the PRIOR live run — e.g. loading a P2P run after a
  // TEST RUN would otherwise leave state.testRun=true / runMode='test' and the
  // Retest would hijack into TEST_RUN_SKIP rows (the hijack CLAUDE.md warns of).
  // Derive the loaded run's mode from its SQLite row when known; default to
  // 'p2p' and NEVER leave 'test'.
  let _loadedMode = 'p2p';
  if (state.activeDbRunId != null) {
    try {
      const _runRow = getRun(state.activeDbRunId);
      if (_runRow && _runRow.mode && _runRow.mode !== 'test') _loadedMode = _runRow.mode;
    } catch (e) { console.error('[runs] mode lookup on load failed:', e.message); }
  }
  state.testRun = false;
  state.runMode = _loadedMode;
  state.runPlanId = null;
  state.runSubscriptionId = null;
  state.runGranter = null;
  state.activeBatchId = 0;
  state.resumeHeadAddr = null;
  state.currentNode = null;
  state.continuousLoop = false;
  return data;
}

/**
 * The latest DISPLAYABLE run number, or null when none can be shown.
 *
 * "Latest" is NOT simply max(index.runs[].number): startFreshRun reserves the
 * current run as `index.activeRun = getNextRunNumber()` (= max+1) BEFORE it is
 * folded into index.runs (that happens later in saveCurrentRun). So the genuinely
 * latest/current run lives at `index.activeRun`, one ahead of the highest entry
 * in index.runs. Using max(index.runs) here returned "latest − 1". This mirrors
 * the boot IF-branch, which also prefers index.activeRun.
 *
 * Candidate order: index.activeRun first, then the highest saved run number. We
 * return the first candidate that has an on-disk snapshot (results.json) so the
 * empty-working-set boot path can't land on a run with no data.
 */
function latestRunNumber() {
  const index = loadRunsIndex();
  const candidates = [];
  if (index.activeRun != null) candidates.push(index.activeRun);
  if (index.runs.length) {
    candidates.push(index.runs.reduce((max, r) => (r.number > max ? r.number : max), index.runs[0].number));
  }
  for (const num of candidates) {
    if (_ex(path.join(RUNS_DIR, `test-${String(num).padStart(3, '0')}`, 'results.json'))) return num;
  }
  return null;
}

function deleteRun(num) {
  const index = loadRunsIndex();
  const i = index.runs.findIndex(r => r.number === num);
  const entry = i !== -1 ? index.runs[i] : null;
  // Allow discarding the currently-loaded run even when it was never saved to
  // the index (a brand-new/interrupted run has only its activeRun pointer + a
  // test-NNN dir, no index entry). For any OTHER not-in-index number, refuse.
  if (i === -1 && state.activeRunNumber !== num) return false;
  index.highWater = Math.max(Number(index.highWater) || 0, num);
  if (i !== -1) index.runs.splice(i, 1);
  if (index.activeRun === num) index.activeRun = null;
  saveRunsIndex(index);
  // NOTE: we deliberately do NOT delete this run's raw_json dir
  // (results/raw/run-<id>) here. That dir is keyed by the SQLite runs-table id,
  // whereas deleteRun operates on the file-index run NUMBER — a DIFFERENT
  // namespace. The entry MAY carry a `dbRunId`, but it is null for legacy runs
  // (pre-dbRunId field) and entirely absent for the interrupted/brand-new run
  // case (i === -1, entry === null), where the only id available is
  // state.activeDbRunId — i.e. the LIVE run's raw data. There is no mapping that
  // holds for every code path, and a wrong-id `rm -rf` would destroy a live
  // run's raw blobs. Correctness over completeness: the raw dir is reclaimed
  // (namespace-correctly) by scripts/cleanup.mjs's orphan-raw-dir sweep, which
  // matches run-<id> dirs against the runs table directly.
  // Remove the snapshot dir (results.json, summary.txt, failures.jsonl, audit.log).
  const runDir = path.join(RUNS_DIR, `test-${String(num).padStart(3, '0')}`);
  if (_ex(runDir)) {
    try { _rm(runDir, { recursive: true, force: true }); }
    catch (err) { console.error(`[deleteRun] failed to remove ${runDir}: ${err.message}`); }
  }
  // Also purge the run's raw execution log so a deleted run can't linger in the
  // Live Log on next boot — but never the currently-active run's log.
  if (entry && entry.auditLog) {
    const rawLog = path.join(__dirname, 'results', entry.auditLog);
    const isActive = state.auditLogPath && path.basename(state.auditLogPath) === entry.auditLog;
    // Don't delete a log file still referenced by ANOTHER saved run — resume
    // reuses one audit-*.log across passes, so deleting this run's basename would
    // orphan another run's Live Log. index.runs here is already post-splice (this
    // entry removed), so .some() checks only the runs that remain.
    const sharedByOther = index.runs.some(r => r.auditLog === entry.auditLog);
    if (!isActive && !sharedByOther && _ex(rawLog)) {
      try { _rm(rawLog, { force: true }); }
      catch (err) { console.error(`[deleteRun] failed to remove log: ${err.message}`); }
    }
  }
  return true;
}

/**
 * Reset the live/displayed view to an empty idle state. Called when the operator
 * deletes the run that is currently loaded/selected. Without this, results,
 * totalNodes, activeRunNumber and activeDbRunId would keep pointing at a now-gone
 * run dir, and a later Save/Resume would build a `test-null` dir or overwrite the
 * wrong SQLite row.
 */
function clearActiveRunView() {
  // Detach the run dir + db id FIRST so saveResults() below doesn't
  // try a crash-safe copy into the directory deleteRun just removed.
  state.activeDbRunId = null;
  state.activeRunDir = null;
  const results = getResults();
  results.length = 0;
  saveResults(state);
  rehydrateState([]);            // zero every per-node counter
  state.totalNodes = 0;
  state.activeRunNumber = null;
  state.activeDbRunId = null;
  state.loadedReadonly = false;
  state.activeRunSaved = false;
  state.status = 'idle';
  state.spentUdvpn = 0;
  state.runSpentUdvpn = 0;
  state.estimatedTotalCost = `0 ${TOKEN_LABEL}`;
  state.auditLogPath = null;
  // Charts + transient run pointers also belong to the now-deleted run: without
  // clearing these the dashboard's "Last 10 baseline" / "Last 10 node speeds"
  // and currentNode keep rendering the DELETED run's data, and a stale
  // activeBatchId/resumeHeadAddr could mis-target a later resume.
  state.baselineHistory = [];
  state.nodeSpeedHistory = [];
  // Also clear the single current-baseline value — the "Avg Baseline" header
  // stat falls back to baselineMbps when baselineHistory is empty, so without
  // this the DELETED run's baseline keeps showing after a delete.
  state.baselineMbps = null;
  state.currentNode = null;
  state.resumeHeadAddr = null;
  state.activeBatchId = 0;
  logBuffer.length = 0;
  try { flushStateSnapshot(); } catch (e) { console.error('[deleteRun] snapshot flush failed:', e.message); }
}

/**
 * Repair stale run-index labels: recompute each run's total/passed/failed/pass10
 * from its actual saved results.json. A snapshot dir can be overwritten (e.g. an
 * interrupted run auto-saved into an existing run's dir when the run pointer was
 * stale) while the index label keeps the old counts — that drift is what made
 * "Test #11 — 19/19" actually hold a 1052-node run. Returns true if anything
 * changed.
 */
function resyncRunsIndex() {
  const index = loadRunsIndex();
  let changed = false;
  for (const entry of index.runs) {
    const data = loadRun(entry.number);
    if (!data) continue;
    const passed = data.filter(r => r.actualMbps != null).length;
    const failed = data.filter(r => r.actualMbps == null).length;
    const pass10 = data.filter(r => r.actualMbps != null && r.actualMbps >= 10).length;
    if (entry.total !== data.length || entry.passed !== passed || entry.failed !== failed || entry.pass10 !== pass10) {
      entry.total = data.length; entry.passed = passed; entry.failed = failed; entry.pass10 = pass10;
      changed = true;
    }
  }
  if (changed) saveRunsIndex(index);
  return changed;
}

// ─── Rehydrate state from results.json on startup ───────────────────────────
function rehydrateState(results) {
  state.testedNodes = results.filter(r => r.actualMbps != null).length;
  state.failedNodes = results.filter(r => r.actualMbps == null && !r.skipped && r.errorCode !== 'TEST_RUN_SKIP').length;
  state.skippedNodes = results.filter(r => r.skipped || r.errorCode === 'TEST_RUN_SKIP').length;
  // Do NOT set totalNodes here — it must come from snapshot (last known chain total).
  // results.length = how many we tested, NOT how many exist on chain.
  state.passed10 = results.filter(r => r.actualMbps != null && r.actualMbps >= 10).length;
  state.passed15 = results.filter(r => r.actualMbps != null && r.actualMbps >= 15).length;
  state.passedBaseline = results.filter(r => {
    const thresh = r.dynamicThreshold != null ? r.dynamicThreshold : (r.baselineAtTest != null ? r.baselineAtTest * 0.5 : null);
    return thresh != null && r.actualMbps >= thresh;
  }).length;
}

{
  const results = getResults();
  if (results.length > 0) {
    rehydrateState(results);
    state.status = 'idle';

    // Restore volatile state (history, balance, baseline) from snapshot
    try {
      const snap = JSON.parse(_rfs(STATE_SNAPSHOT_FILE, 'utf8'));
      if (snap.baselineHistory?.length) state.baselineHistory = snap.baselineHistory;
      if (snap.nodeSpeedHistory?.length) state.nodeSpeedHistory = snap.nodeSpeedHistory;
      // Don't restore spentUdvpn from snapshot — it accumulates across restarts
      // and causes negative balance display. Balance is queried fresh from chain on audit start.
      // Only restore for display purposes, capped to prevent negative.
      if (snap.balanceUdvpn) state.balanceUdvpn = snap.balanceUdvpn;
      if (snap.spentUdvpn) state.spentUdvpn = Math.min(snap.spentUdvpn, state.balanceUdvpn);
      // runSpentUdvpn is a cumulative payment total (not a balance delta) — restore
      // uncapped so a stop→bounce→resume preserves the true recorded run spend.
      if (snap.runSpentUdvpn != null) state.runSpentUdvpn = snap.runSpentUdvpn;
      const remaining = Math.max(0, state.balanceUdvpn - state.spentUdvpn);
      state.balance = `${(remaining / 1_000_000).toFixed(4)} ${TOKEN_LABEL}`;
      if (snap.estimatedTotalCost) state.estimatedTotalCost = snap.estimatedTotalCost;
      if (snap.startedAt) state.startedAt = snap.startedAt;
      if (snap.baselineMbps) state.baselineMbps = snap.baselineMbps;
      if (snap.totalNodes) state.totalNodes = snap.totalNodes;
      // Restore run-mode context so /api/resume after a process bounce can
      // route to the correct pipeline (P2P vs subscription vs test).
      if (snap.runMode) state.runMode = snap.runMode;
      if (snap.testRun != null) state.testRun = snap.testRun;
      if (snap.runPlanId) state.runPlanId = snap.runPlanId;
      if (snap.runSubscriptionId) state.runSubscriptionId = snap.runSubscriptionId;
      if (snap.runGranter) state.runGranter = snap.runGranter;
      if (snap.pricingMode) state.pricingMode = snap.pricingMode;
      if (snap.activeSDK) state.activeSDK = snap.activeSDK;
      if (snap.continuousLoop != null) state.continuousLoop = snap.continuousLoop;
      if (snap.activeBatchId) state.activeBatchId = snap.activeBatchId;
      if (snap.resumeHeadAddr) state.resumeHeadAddr = snap.resumeHeadAddr;
      if (snap.auditLogPath) state.auditLogPath = snap.auditLogPath;
      if (snap.activeDbRunId) {
        state.activeDbRunId = Number(snap.activeDbRunId);
      }
      if (snap.activeRunNumber != null) state.activeRunNumber = snap.activeRunNumber;
      // H-1: restore the read-only marker so an incomplete loaded run can't be
      // resumed after a restart (the LOADED_RUN_READONLY guard in /api/resume).
      if (snap.loadedReadonly != null) state.loadedReadonly = !!snap.loadedReadonly;
      console.log(`State snapshot restored: baseline=${snap.baselineHistory?.length || 0} readings, speeds=${snap.nodeSpeedHistory?.length || 0} nodes, total=${state.totalNodes}, runMode=${state.runMode || 'none'}`);
    } catch (e) { console.error('[boot] state snapshot restore failed:', e.message); }

    // Hydrate logBuffer from the IN-FLIGHT audit log (the file the run was
    // appending to before the bounce), so SSE init replays the actual run's
    // history. Falls back to the alphabetically-newest file only if the
    // snapshot didn't preserve a path or the file vanished.
    try {
      const logDir = path.join(__dirname, 'results');
      let used = null;
      if (state.auditLogPath && _ex(state.auditLogPath)) {
        if (hydrateLogBufferFromFile(state.auditLogPath) > 0) used = state.auditLogPath;
      }
      if (!used) {
        const logFiles = _rd(logDir).filter(f => /^(audit|retest)-.*\.log$/.test(f)).sort().reverse();
        if (logFiles.length > 0) {
          const candidate = path.join(logDir, logFiles[0]);
          if (hydrateLogBufferFromFile(candidate) > 0) used = candidate;
        }
      }
      if (used) console.log(`Log buffer hydrated from ${path.basename(used)} (${logBuffer.length} lines)`);
    } catch { }

    // Resume the active test — DON'T create a new one on restart
    const index = loadRunsIndex();
    if (index.runs.length === 0) {
      // First ever boot — save as Test #1
      const num = saveCurrentRun('Initial Audit');
      console.log(`Saved existing data as Test #${num}`);
    }
    // Repair any stale index labels against the real snapshot contents.
    try { if (resyncRunsIndex()) console.log('[boot] runs index labels re-synced from snapshots'); }
    catch (e) { console.error('[boot] resyncRunsIndex failed:', e.message); }

    // activeRunNumber = the run currently displayed (dropdown selection + the
    // save/resume dir). If the snapshot restored it, keep it. Otherwise only
    // adopt the last saved run when the restored results actually match it; an
    // unsaved/interrupted run gets a fresh number so it can't alias — and later
    // overwrite — a real saved run (the bug that corrupted Test #11).
    if (state.activeRunNumber == null) {
      const cand = index.activeRun != null ? index.activeRun
                 : (index.runs.length > 0 ? Math.max(...index.runs.map(r => r.number)) : null);
      const candData = cand != null ? loadRun(cand) : null;
      // Strengthen "is the working set the SAME run as `cand`?" beyond length:
      // two DIFFERENT audits of the same chain set have identical length but
      // different per-node timestamps/speeds. Matching on length alone aliased
      // them, so a later save overwrote a real saved run (the "Test #11"
      // corruption). Compare an order-independent content key; err STRICT (fresh
      // number when unsure) — a fresh number can never overwrite a saved run.
      const _runKey = rows => rows.map(r => `${r.address}|${r.timestamp || ''}|${r.actualMbps == null ? 'x' : r.actualMbps}`).sort().join('\n');
      const reused = candData
        && candData.length === results.length
        && _runKey(candData) === _runKey(results);
      state.activeRunNumber = reused ? cand : getNextRunNumber();
      // When we assigned a FRESH number (not reusing a saved run), reserve it by
      // persisting it into the snapshot immediately. getNextRunNumber() only
      // looks at the saved index — across repeated crashes before this run is
      // ever saved, it would hand out the SAME number again and a later save
      // could overwrite a different run. Forcing a snapshot now means the next
      // boot restores this number instead of recomputing it.
      if (!reused) {
        // Fresh number → a NEW unsaved run with no SQLite row of its own. Drop any
        // activeDbRunId the snapshot restored: it points at a DIFFERENT run, and
        // keeping it would make a later Save updateRunOnFinish the wrong row
        // (clobbering that run's counts/spend). Same intent as startFreshRun,
        // which overwrites it via insertRun — here there's no insertRun, so null.
        state.activeDbRunId = null;
        try { flushStateSnapshot(); }
        catch (e) { console.error('[boot] reserve run-number snapshot failed:', e.message); }
      }
    }

    // Saved iff the restored active run has an index entry (an interrupted run
    // that never completed has only its activeRun pointer, not an index entry).
    state.activeRunSaved = index.runs.some(r => r.number === state.activeRunNumber);

    console.log(`Resuming Test #${state.activeRunNumber} | ${results.length} results: ${state.testedNodes} passed, ${state.failedNodes} failed | SDK: ${state.activeSDK}`);
  } else {
    // No working-set results on disk (fresh boot after a delete-of-active or a
    // wipe) — but saved runs may still exist. Land the admin on the LATEST saved
    // run so login shows a real run, never a blank "new" one. A new run only
    // appears when the operator clicks Start New Test.
    try {
      const latest = latestRunNumber();
      if (latest != null && loadRunIntoState(latest)) {
        console.log(`[boot] no live results — showing latest saved run Test #${latest}`);
        // Reserve the loaded run + read-only marker in the snapshot now so a
        // bounce before the next periodic write doesn't drop back to blank.
        try { flushStateSnapshot(); } catch (e) { console.error('[boot] snapshot flush after autoload failed:', e.message); }
      }
    } catch (e) { console.error('[boot] latest-run autoload failed:', e.message); }
  }
}

// ─── Express ────────────────────────────────────────────────────────────────
const app = express();
// Trust exactly one proxy hop so that req.ip is populated from X-Forwarded-For
// only when a real reverse proxy (nginx, Caddy, etc.) sits in front.
// Without this, req.ip is always the direct socket address — which is what
// clientIp() in core/rate-limit.js now uses exclusively (F-02).
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));
// Parse HTML form posts (application/x-www-form-urlencoded) — the admin login
// form submits the token this way; without this req.body is undefined for it.
// extended:false (querystring, no nested objects) + small 64kb cap is plenty.
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
// cookie-parser with HMAC signing so admin_token cookie cannot be forged
app.use(cookieParser(COOKIE_SECRET));
// Serve static assets (logo, fonts etc.) but do NOT auto-serve index files.
// Routes below explicitly control which HTML file each path gets.
app.use(express.static(__dirname, { index: false }));

// ─── Security headers (all responses) ───────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // M-01: clickjacking defence covers admin routes (public CSP has frame-ancestors).
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // HSTS only when reachable over TLS (operator opts in via env var so local
  // http://localhost dev is unaffected).
  if (process.env.ENABLE_HSTS === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  next();
});

// ─── CSP helper (public HTML responses only) ─────────────────────────────────
const PUBLIC_CSP = [
  "default-src 'self'",
  // flagcdn.com serves ISO 3166 country flag PNGs. Needed because Windows
  // Chrome/Edge don't render regional-indicator emoji as flag glyphs — they
  // fall back to letter tiles ("US", "DE") which users reported as "distorted".
  "img-src 'self' data: https://flagcdn.com",
  // sentinel.css @imports Noto Sans Mono from jsDelivr (Plan Manager canon).
  // Europa Bold is self-hosted from /fonts/, so no external font-src needed.
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function setPublicCsp(res) {
  res.setHeader('Content-Security-Policy', PUBLIC_CSP);
}

// ─── Rate-limit tiers ────────────────────────────────────────────────────────
// "public-read": 120 req / 60 s for all read-only public API endpoints.
const rlPublicRead = rateLimit({ windowMs: 60_000, max: 120, bucket: 'public-read' });
// "public-sse": max 5 concurrent SSE connections per IP.
const rlPublicSse = sseLimit({ maxPerIp: 5, bucket: 'public-sse' });
// "onchain-reports": tighter than public-read (30/60s) — each hit can run an
// RPC tx_search and, in the cold path, key-derivation from the mnemonic.
const rlOnchainReports = rateLimit({ windowMs: 60_000, max: 30, bucket: 'onchain-reports' });


// ─── Public routes: no auth, read-only ──────────────────────────────────────

// Root: serve public dashboard when PUBLIC_MODE=true, otherwise admin.html (or redirect to login)
app.get('/', attachAdminFlag, (req, res) => {
  if (PUBLIC_MODE) {
    setPublicCsp(res);
    return res.sendFile(path.join(__dirname, 'public.html'));
  }
  // PUBLIC_MODE=false: no auth check needed for local/single-user setups
  if (!ADMIN_TOKEN || req.admin) {
    return res.sendFile(path.join(__dirname, 'admin.html'));
  }
  res.redirect(ADMIN_PATH + '/login');
});

// Per-node detail page (public, read-only SPA served on any /node/:addr path)
app.get('/node/:addr', attachAdminFlag, (req, res) => {
  setPublicCsp(res);
  res.sendFile(path.join(__dirname, 'node.html'));
});

// Public live-testing view — shareable URL, zero action buttons
app.get('/live', attachAdminFlag, (req, res) => {
  setPublicCsp(res);
  res.sendFile(path.join(__dirname, 'live.html'));
});

// /about is now a modal on /live (and /). Redirect direct hits to /live so
// users land on the canonical page where the About button opens the modal.
app.get('/about', (req, res) => {
  res.redirect(302, '/live');
});

// ─── Public API: read-only, no wallet or chain writes ────────────────────────
// NOTE: these handlers MUST NOT import from audit/, core/wallet.js, or chain write paths.
// A grep-based assertion in test/security.test.js enforces this invariant on every build.

/**
 * GET /api/public/nodes
 * Query params: q, country, service, sort, window, limit, offset
 * Returns one row per node with pass_count, pass_rate, pass_bar.
 */
app.get('/api/public/nodes', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const q       = req.query.q       || null;
    const country = req.query.country || null;
    const service = req.query.service || null;
    const sort    = req.query.sort    || 'tested_desc';
    const win     = Math.min(parseInt(req.query.window || '25', 10), 100);
    const limit   = Math.min(parseInt(req.query.limit  || '50',  10), 500);
    const offset  = parseInt(req.query.offset || '0', 10);
    const runId   = req.query.runId ? parseInt(req.query.runId, 10) : null;

    const nodes = searchNodes({ q, country, service, sort, window: win, limit, offset, runId });

    res.json({ total: nodes.length, offset, limit, window: win, results: nodes });
  } catch (err) {
    console.error('[api/public/nodes]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/node/:addr?historyLimit=N
 * Returns { node, history, errors } for a single node.
 */
app.get('/api/public/node/:addr', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const addr   = req.params.addr;
    const hLimit = parseInt(req.query.historyLimit || '100', 10);
    const detail = getNodeDetail(addr, { historyLimit: hLimit });
    if (!detail.node) {
      return res.status(404).json({ error: 'Node not found' });
    }
    // Strip raw_json from the PUBLIC response. raw_json is a JSON.stringify of
    // the full per-node result (diag.wgServerEndpoint, diag.remoteUrl,
    // sessionId, handshake internals) and must never reach anonymous visitors.
    // log_snippet (already address-sanitized) is preserved for the Failure-Log UX.
    // Authenticated admins (req.admin via signed session cookie or bearer token)
    // KEEP raw_json — the admin failure-diagnostic drawer parses raw.diag/raw.type
    // from this exact endpoint. Stripping it for everyone blanks the operator's
    // failure report; the strip must be gated on identity, not applied blindly.
    if (!req.admin) {
      const stripRaw = (row) => { if (row && typeof row === 'object') delete row.raw_json; return row; };
      const stripErr = (row) => {
        if (row && typeof row === 'object') {
          delete row.raw_json;
          if (row.error_message != null) row.error_message = _redactPublicError(row.error_message, 2048);
        }
        return row;
      };
      if (detail.node) stripRaw(detail.node);
      if (Array.isArray(detail.history)) detail.history.forEach(stripRaw);
      if (Array.isArray(detail.errors))  detail.errors.forEach(stripErr);
    }
    res.json(detail);
  } catch (err) {
    console.error('[api/public/node]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/node/:addr/errors?limit=N&stage=X
 * Returns error_log rows for a node, optionally filtered by stage.
 */
app.get('/api/public/node/:addr/errors', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const addr   = req.params.addr;
    const limit  = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
    const stage  = req.query.stage || null;
    const errors = getNodeErrors(addr, { limit, stage });
    // For anonymous visitors: strip raw_json (operator-internal diag payload)
    // and redact bech32 addresses from error_message (stored verbatim at write
    // time, so it can carry wallet/granter addresses from RPC rawLogs).
    // log_snippet stays — it is already address-sanitized and required by the
    // Failure-Log UX. Authenticated admins (req.admin) see the unredacted rows;
    // the admin failure drawer parses raw_json from this endpoint.
    if (!req.admin && Array.isArray(errors)) {
      for (const row of errors) {
        if (row && typeof row === 'object') {
          delete row.raw_json;
          if (row.error_message != null) row.error_message = _redactPublicError(row.error_message, 2048);
        }
      }
    }
    res.json({ node_addr: addr, total: errors.length, errors });
  } catch (err) {
    console.error('[api/public/node/errors]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/errors?q=&stage=&limit=&offset=
 * Cross-node error search. Returns recent failures across ALL nodes.
 * q matches node_addr, moniker, or error_message (LIKE, case-insensitive).
 * stage filters error_logs.stage exactly.
 * limit default 100 cap 500; offset default 0. Ordered by captured_at DESC.
 */
app.get('/api/public/errors', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const q      = req.query.q     || null;
    const stage  = req.query.stage || null;
    const limit  = Math.min(parseInt(req.query.limit  || '100', 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset || '0',   10) || 0,   0);
    const { total, items } = searchErrors({ q, stage, limit, offset });
    res.json({ total, items });
  } catch (err) {
    console.error('[api/public/errors]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/countries
 * Returns distinct countries with node counts.
 */
app.get('/api/public/countries', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const countries = getCountryList();
    res.json({ total: countries.length, countries });
  } catch (err) {
    console.error('[api/public/countries]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/runs/current — current in-progress batch (+ per-node
 * results so far) so /live can hydrate on refresh without waiting for SSE.
 * Returns 404 when nothing is mid-flight.
 */
app.get('/api/public/runs/current', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    // The admin's own /live view must mirror the admin dashboard 1:1 regardless
    // of the public broadcast toggle — operator needs to see resume-in-progress
    // even with broadcast off. Public visitors still gated by broadcastLive.
    const showLive = state.broadcastLive || req.admin === true;
    let data = showLive ? getActiveBatch() : getLastBatch();
    // Stopped-but-resumable: the batch was closed (finished_at set) on stop,
    // but state.activeBatchId still points at it for the eventual resume.
    // /live should keep painting it so a refresh while stopped doesn't go
    // blank or fall through to a different historical run.
    if (!data
        && showLive
        && state.status === 'stopped'
        && state.activeBatchId) {
      data = getBatchWithNodes(state.activeBatchId);
    }
    if (!data) return res.status(404).json({ error: 'No active run' });
    const { batch, nodes } = data;
    res.json({
      id: batch.id,
      started_at: batch.started_at,
      finished_at: batch.finished_at,
      snapshot_size: batch.snapshot_size,
      passed: batch.passed,
      failed: batch.failed,
      mode: batch.mode,
      // Mirror the in-memory run mode so /live renders the same badge as admin
      // before any SSE state event arrives. runPlanId is null unless plan mode.
      runMode: state.runMode || null,
      runPlanId: state.runPlanId || null,
      // Tell /live this is a paused-but-pinned run so it paints rows even
      // though finished_at is set. Without this flag, the client treats
      // any finished_at as "historical" and skips painting under broadcast.
      stopped: state.status === 'stopped' && state.activeBatchId === batch.id,
      nodes,
    });
  } catch (err) {
    console.error('[api/public/runs/current]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/runs/last — most recent completed run, or 404.
 */
app.get('/api/public/runs/last', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    // Prefer the last completed batch (has nodes) so /live can hydrate fully
    // on refresh without waiting for SSE. Fall back to legacy run row only
    // when no batch has ever been recorded.
    const last = getLastBatch();
    if (last) {
      const { batch, nodes } = last;
      return res.json({
        id: batch.id,
        started_at: batch.started_at,
        finished_at: batch.finished_at,
        snapshot_size: batch.snapshot_size,
        passed: batch.passed,
        failed: batch.failed,
        mode: batch.mode,
        nodes,
      });
    }
    const run = getLastCompletedRun();
    if (!run) return res.status(404).json({ error: 'No completed runs' });
    res.json(run);
  } catch (err) {
    console.error('[api/public/runs/last]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/node/:addr/bandwidth?limit=N — bandwidth chart data.
 */
app.get('/api/public/node/:addr/bandwidth', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const addr = req.params.addr;
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const history = getBandwidthHistory(addr, { limit });
    res.json({ node_addr: addr, total: history.length, history });
  } catch (err) {
    console.error('[api/public/node/bandwidth]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/public/runs', attachAdminFlag, rlPublicRead, (req, res) => {
  const index = loadRunsIndex();
  const safe = (index.runs || []).map(r => ({
    number: r.number,
    label: r.label,
    date: r.date,
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    pass10: r.pass10,
  }));
  res.json({ runs: safe, total: safe.length });
});

app.get('/api/public/stats', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    // Per-run scoping: live page wants the *current* sweep's numbers, not
    // lifetime DB averages. Active > last completed > lifetime fallback for
    // totalNodes / passingPct / lastRunAt. medianMbps is intentionally NOT
    // backfilled from lifetime — a stale historical median painted on a fresh
    // server boot makes the /live "Network Median" tile look hardcoded.
    const lifetime = getNetworkStats();
    const active = getActiveRun();
    const last = active ? null : getLastCompletedRun();
    const scopedRunId = active?.id || last?.id || null;
    const scoped = scopedRunId ? getRunStats(scopedRunId) : null;

    const useScoped = scoped && scoped.processed > 0;
    // medianMbps is intentionally gated on an *active* run. A "last completed"
    // median is stale by definition — painting it on /live makes the tile look
    // hardcoded between sweeps. When idle, the tile collapses to "—".
    const medianMbps = active && useScoped && scoped.medianMbps != null && scoped.medianMbps > 0
      ? scoped.medianMbps
      : null;
    res.json({
      totalNodes: useScoped ? scoped.totalNodes : lifetime.totalNodes,
      passingPct: useScoped ? scoped.passingPct : lifetime.passingPct,
      medianMbps,
      lastRunAt: lifetime.lastRunAt,
      runId: scopedRunId,
      runScope: useScoped ? (active ? 'active' : 'last') : 'lifetime',
      status: continuous.status().running ? 'running' : 'idle',
    });
  } catch (err) {
    console.error('[api/public/stats]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/sdk-info
 * Read-only: which SDK the tester is currently using + its installed version.
 * Used by /live to render the SDK badge next to the run-mode label so the
 * public can see exactly which client implementation produced the numbers.
 * Maps state.activeSDK ('js' | 'tkd' | 'csharp') → tracked SDK key + display
 * name. C# isn't tracked by sdk-verify (no npm pkg), so version is null.
 */
app.get('/api/public/sdk-info', attachAdminFlag, rlPublicRead, async (req, res) => {
  try {
    const active = state.activeSDK || 'js';
    const ACTIVE_TO_TRACKED = { dvpnd: 'dvpnd' };
    const DISPLAY_NAME = { dvpnd: 'dvpnd', js: 'dvpnd', tkd: 'dvpnd', csharp: 'dvpnd' };
    const trackedKey = ACTIVE_TO_TRACKED[active] || null;
    let version = null;
    if (trackedKey) {
      const versions = getInstalledVersions(__dirname);
      version = versions[trackedKey]?.version || null;
    }
    res.json({
      active,
      name: DISPLAY_NAME[active] || active,
      version,
    });
  } catch (err) {
    console.error('[api/public/sdk-info]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/batches?limit=N
 * Returns the last N batches (default 50, max 100), newest first.
 * Each batch has: id, started_at, finished_at, snapshot_size, passed, failed, mode.
 */
app.get('/api/public/batches', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 100);
    const batches = listBatches({ limit });
    res.json({ total: batches.length, batches });
  } catch (err) {
    console.error('[api/public/batches]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/public/batch/:id?limit=N&offset=N
 * Returns the batch header + public-safe node results for one batch.
 * Strips wallet, SDK, OS, diag fields — only:
 *   node_address, type, moniker, country, city, actual_mbps,
 *   peers, max_peers, error, error_code, tested_at
 */
app.get('/api/public/batch/:id', attachAdminFlag, rlPublicRead, (req, res) => {
  try {
    const batchId = parseInt(req.params.id, 10);
    if (!batchId || batchId < 1) return res.status(400).json({ error: 'Invalid batch id' });
    const limit  = Math.min(parseInt(req.query.limit  || '500', 10) || 500, 1000);
    const offset = Math.max(parseInt(req.query.offset || '0',   10) || 0,   0);
    const { batch, results } = getBatchResults(batchId, { limit, offset });
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    const { snapshot_addresses: _addrs, ...batchPublic } = batch;
    res.json({ batch: batchPublic, results, total: results.length });
  } catch (err) {
    console.error('[api/public/batch]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── Admin login / logout ─────────────────────────────────────────────────────
app.get(ADMIN_PATH + '/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sentinel Audit — Admin Login</title>
  <link rel="stylesheet" href="/sentinel.css">
  <style>
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .login-card { max-width: 380px; width: 100%; padding: 40px 36px; }
    .login-title { font-family: var(--font-display); font-size: 20px; font-weight: 700; letter-spacing: 2px; margin: 0 0 6px; color: var(--text); }
    .login-sub { font-size: 12px; color: var(--text-dim); margin: 0 0 28px; }
    .login-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text-dim); display: block; margin-bottom: 6px; }
    .login-input { width: 100%; margin-bottom: 20px; }
  </style>
</head>
<body class="boot-pending">
  <script>document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark'; document.addEventListener('DOMContentLoaded', () => document.body.classList.remove('boot-pending'));</script>
  <div class="card login-card">
    <h1 class="login-title">SENTINEL AUDIT</h1>
    <p class="login-sub">Admin access required</p>
    <form method="POST" action="${ADMIN_PATH}/login">
      <label class="login-label" for="token">Admin Token</label>
      <input class="login-input" type="password" id="token" name="token" placeholder="Enter admin token" autocomplete="current-password" required>
      <button class="btn-primary btn-block" type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`);
});

app.post(ADMIN_PATH + '/login', rateLimit({ windowMs: 60_000, max: 10, bucket: 'login' }), (req, res) => {
  const { token } = req.body || {};
  if (token && ADMIN_TOKEN && safeEq(token, ADMIN_TOKEN)) {
    // H-02: store opaque session ID in the cookie, not the raw ADMIN_TOKEN.
    // Cookie theft (XSS, stolen jar) no longer recovers the backend token.
    const sessionId = createAdminSession();
    res.cookie('admin_session', sessionId, {
      signed: true,
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.INSECURE_COOKIE !== 'true',
      maxAge: ADMIN_SESSION_TTL_MS,
    });
    // Clear any legacy admin_token cookie from earlier deploys
    res.clearCookie('admin_token');
    return res.redirect(ADMIN_PATH);
  }
  res.status(401).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login failed</title>
<link rel="stylesheet" href="/sentinel.css">
<style>body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.fail{max-width:380px;width:100%;text-align:center}.fail a{color:var(--accent);text-decoration:none;font-weight:600}.fail a:hover{color:var(--accent-bright)}</style>
</head><body class="boot-pending">
<script>document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark'; document.addEventListener('DOMContentLoaded', () => document.body.classList.remove('boot-pending'));</script>
<div class="fail">
  <div class="callout-error" style="margin-bottom:16px">Invalid token</div>
  <a href="${ADMIN_PATH}/login">Try again</a>
</div></body></html>`);
});

app.post(ADMIN_PATH + '/logout', (req, res) => {
  if (req.headers['x-admin-request'] !== '1') {
    return res.status(403).json({ error: 'Forbidden', hint: 'Include X-Admin-Request: 1 header' });
  }
  const sid = req.signedCookies?.admin_session;
  if (sid) revokeAdminSession(sid);
  res.clearCookie('admin_session');
  res.clearCookie('admin_token'); // legacy
  res.redirect(PUBLIC_MODE ? '/' : ADMIN_PATH + '/login');
});

// ─── Admin dashboard ──────────────────────────────────────────────────────────
app.get(ADMIN_PATH, adminOnly, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Fast stats-only (no results payload) — admin only (includes wallet balance)
app.get('/api/stats', adminOnly, (req, res) => {
  res.json({ state });
});

// ─── SDK version + GitHub parity endpoints ──────────────────────────────────

/** Installed SDK versions — instant, no network. */
app.get('/api/sdk-versions', adminOnly, async (req, res) => {
  try {
    const { readFileSync } = await import('fs');
    const versions = getInstalledVersions(__dirname);
    const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    res.json({ tester: { version: pkg.version, name: pkg.name, platform: process.platform }, sdks: versions });
  } catch (err) {
    console.error('[api/sdk-versions]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/** Cached verification state (avoid re-downloading on every UI poll). */
let _sdkVerifyCache = { ts: 0, data: null };
const SDK_VERIFY_TTL_MS = 5 * 60 * 1000;

/** Cached npm-latest lookup. 1h TTL — npm-registry rate-limits aggressive polling. */
let _sdkLatestCache = { ts: 0, data: null };
const SDK_LATEST_TTL_MS = 60 * 60 * 1000;
// dvpnd is not published to npm: the client is the pinned image (DVPND_IMAGE, see /api/sdk-versions).
const NPM_PKGS = {};

app.get('/api/sdk-latest', adminOnly, async (req, res) => {
  const now = Date.now();
  if (!req.query.refresh && _sdkLatestCache.data && (now - _sdkLatestCache.ts) < SDK_LATEST_TTL_MS) {
    res.setHeader('x-cache', 'hit');
    return res.json(_sdkLatestCache.data);
  }
  const out = {};
  await Promise.all(Object.entries(NPM_PKGS).map(async ([key, pkg]) => {
    try {
      const r = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) { out[key] = { pkg, latest: null, error: `npm ${r.status}` }; return; }
      const d = await r.json();
      out[key] = { pkg, latest: d.version || null };
    } catch (err) {
      out[key] = { pkg, latest: null, error: err.message };
    }
  }));
  _sdkLatestCache = { ts: now, data: out };
  res.setHeader('x-cache', 'miss');
  res.json(out);
});

/** Verify every SDK matches its GitHub tag. Slow (~5s) — downloads tarballs. */
app.get('/api/sdk-verify', adminOnly, async (req, res) => {
  const now = Date.now();
  const forceRefresh = req.query.refresh === '1';
  if (!forceRefresh && _sdkVerifyCache.data && (now - _sdkVerifyCache.ts) < SDK_VERIFY_TTL_MS) {
    res.setHeader('x-cache', 'hit');
    return res.json(_sdkVerifyCache.data);
  }
  try {
    const results = await verifyAllSdks(__dirname);
    _sdkVerifyCache = { ts: now, data: results };
    res.setHeader('x-cache', 'miss');
    res.json(results);
  } catch (err) {
    console.error('[api/sdk-verify]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

/** Verify one SDK by key. ?key=blue-js or ?key=tkd-js */
app.get('/api/sdk-verify/:key', adminOnly, async (req, res) => {
  try {
    const result = await verifySdk(req.params.key, __dirname);
    res.json(result);
  } catch (err) {
    if (err && /^Unknown SDK key/.test(err.message || '')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[api/sdk-verify]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Full state + results
app.get('/api/state', adminOnly, (req, res) => {
  const results = getResults();
  res.json({ state, results });
});

app.get('/api/results', adminOnly, (req, res) => {
  const results = getResults();
  const page = parseInt(req.query.page || '1', 10);
  const limit = parseInt(req.query.limit || '100', 10);
  const start = (page - 1) * limit;
  res.json({ total: results.length, page, results: results.slice(start, start + limit) });
});

// ─── Public SSE stream ──────────────────────────────────────────────────────
// Broadcasts the same events but strips any operator-only fields.
const PUBLIC_EVENT_WHITELIST = new Set([
  'loop:started',
  'loop:stopping',
  'loop:stopped',
  'loop:error',
  'iteration:start',
  'iteration:end',
  // Batch-model events (each full node-sweep is one batch)
  'batch:start',
  'batch:node:result',
  'batch:end',
  'batch:gap',
  // Live operator log lines — needed so /live shows real-time activity.
  // sanitizeForPublic already truncates evt.msg to 400 chars.
  'log',
  // Full state + per-node result events — /live mirrors the admin dashboard
  // counters and per-row results 1:1 when broadcastLive is on.
  'state',
  'result',
  'progress',
]);

// Redact bech32 wallet/granter addresses (sent1…/sentnode1…/sentpub1…/
// sentvaloper1…) from any error/log string before it reaches a public surface.
// Mirrors audit/pipeline.js _sanitizeSnippet's address scrub, which is not in
// scope here. Raw thrown-error / RPC rawLog text can otherwise carry the
// tester's wallet or a plan owner's granter address.
// Solana: base58 public keys (wallets, providers, PDAs) — 32–44 chars, no 0/O/I/l.
// Longer base58 runs (tx signatures) have no word boundary inside, so they stay.
const _PUBLIC_ADDR_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
function _redactPublicError(v, max = 200) {
  if (v == null) return null;
  return String(v).replace(_PUBLIC_ADDR_RE, '[addr]').slice(0, max);
}

// Keep only the state fields /live actually reads. Strips wallet, balance*,
// spent*, MNEMONIC-derived data, errorMessage internals, and any counter or
// progress field the public surfaces never consume.
// Each key below is verified read by live.html (and a subset — testRun /
// runMode / runPlanId / pricingMode — also by public.html):
//   - status / totalNodes / testRun / runMode / runPlanId / pricingMode /
//     activeRunNumber are read directly off _liveState.
//   - baselineMbps / baselineHistory feed computeBaselineAvg(_liveState) for
//     the Server-Baseline header tile.
//   - activeSDK ('js' | 'tkd' | 'csharp') surfaces next to the run-mode label;
//     display name + version are joined client-side via /api/public/sdk-info.
//   - etaRemainingMs is the server-authoritative REMAINING duration (ms);
//     live.html anchors it to its own clock at receipt and counts it down, so it
//     matches admin.html without being distorted by client clock skew.
const PUBLIC_STATE_KEYS = [
  'status',
  'scanning',
  'totalNodes',
  'etaRemainingMs',
  'baselineMbps',
  'baselineHistory',
  'testRun',
  'runMode',
  'runPlanId',
  'pricingMode',
  'activeSDK',
  'activeRunNumber',
];
function sanitizePublicState(s) {
  if (!s || typeof s !== 'object') return {};
  const out = {};
  for (const k of PUBLIC_STATE_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out;
}
// Mirror of admin's per-node result row, minus operator-internal fields.
function sanitizePublicResult(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    address: r.address,
    moniker: r.moniker,
    serviceType: r.type ?? r.serviceType,
    countryCode: r.countryCode,
    city: r.city,
    actualMbps: r.actualMbps,
    peers: r.peers,
    maxPeers: r.maxPeers,
    errorCode: r.errorCode,
    error: r.error ? _redactPublicError(r.error) : null,
    skipped: r.skipped === true ? true : undefined,
    inPlan: r.inPlan === true ? true : undefined,
    testedAt: r.testedAt,
    baselineAtTest: r.baselineAtTest,
  };
}
function sanitizeForPublic(evt) {
  const safe = { type: evt.type };
  // Nested state/result payloads (admin emits broadcast('state', { state }) / broadcast('result', { result }))
  if (evt.state && typeof evt.state === 'object') safe.state = sanitizePublicState(evt.state);
  if (evt.result && typeof evt.result === 'object') {
    const sr = sanitizePublicResult(evt.result);
    if (sr) safe.result = sr;
  }
  if (evt.iteration != null)   safe.iteration   = evt.iteration;
  if (evt.passed != null)      safe.passed      = evt.passed;
  if (evt.failed != null)      safe.failed      = evt.failed;
  if (evt.error != null)       safe.error       = _redactPublicError(evt.error);
  // batch:* event fields — only public-safe node-level data
  if (evt.batchId != null)      safe.batchId      = evt.batchId;
  if (evt.snapshotSize != null) safe.snapshotSize = evt.snapshotSize;
  if (evt.startedAt != null)    safe.startedAt    = evt.startedAt;
  // batch:start carries resumed:true on the resume-intent pass. /live uses it to
  // re-hydrate the full batch (already-tested nodes aren't re-emitted on resume).
  if (evt.resumed === true)     safe.resumed      = true;
  if (evt.gapMs != null)        safe.gapMs        = evt.gapMs;
  if (evt.nextBatchAt != null)  safe.nextBatchAt  = evt.nextBatchAt;
  // batch:node:result public-safe fields.
  // The payload's `type` field (service type: 'wireguard' / 'v2ray' / 1 / 2)
  // would collide with the SSE dispatch `type`, so forward it as `serviceType`.
  if (evt.address != null)    safe.address    = evt.address;
  if (evt.serviceType != null) safe.serviceType = evt.serviceType;
  if (evt.countryCode != null) safe.countryCode = evt.countryCode;
  if (evt.city != null)       safe.city       = evt.city;
  if (evt.actualMbps != null) safe.actualMbps = evt.actualMbps;
  if (evt.peers != null)      safe.peers      = evt.peers;
  if (evt.maxPeers != null)   safe.maxPeers   = evt.maxPeers;
  if (evt.errorCode != null)  safe.errorCode  = evt.errorCode;
  if (evt.testedAt != null)   safe.testedAt   = evt.testedAt;
  if (evt.msg != null)        safe.msg        = String(evt.msg).slice(0, 400);
  if (evt.cat != null)        safe.cat        = evt.cat;
  // Emission timestamp — lets /live show WHEN a line was produced, not when it
  // was rendered (matters for the seeded backlog + reconnect replay).
  if (evt.ts != null)         safe.ts         = evt.ts;
  if (evt.baselineMbps != null) safe.baselineMbps = evt.baselineMbps;
  if (evt.skipped === true)   safe.skipped    = true;
  if (evt.inPlan === true)    safe.inPlan     = true;
  if (evt.next_in_ms != null) safe.next_in_ms = evt.next_in_ms;
  return safe;
}

const SSE_PING_MS = 20_000; // 20-second heartbeat keeps proxies from dropping the connection

app.get('/api/public/events', attachAdminFlag, rlPublicSse, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  // H-01: strip operator-internal fields (planId, minDelayMs, subscriptionId, etc.) from public init
  const s = continuous.status();
  // Attach the currently-running batch id (if any) so /live can pick up mid-batch on reconnect.
  let activeBatchId = null;
  let activeSnapshotSize = null;
  let activeBatchMode = null;
  try {
    const ab = getActiveBatch();
    if (ab) {
      activeBatchId = ab.batch.id;
      activeSnapshotSize = ab.batch.snapshot_size;
      activeBatchMode = ab.batch.mode;
    }
  } catch (_) {}
  // Sanitized snapshot of in-memory state and per-node results so /live paints
  // the full dashboard on connect/refresh — fully identical to admin (minus
  // operator-internal fields). Empty when broadcastLive is off (unless admin).
  const isAdminViewer = req.admin === true;
  const liveOn = !!state.broadcastLive || isAdminViewer;
  // Only ship the live work payload (log backlog + per-node results) when a run
  // is actually in flight. With broadcast on but idle (e.g. just-booted server
  // with a hydrated logBuffer, or a finished run), /live must paint NOTHING
  // behind the paused overlay — it should show the overlay only, not load data.
  const workOn = liveOn && publicRunActive();
  const initState = liveOn ? sanitizePublicState(state) : {};
  const initResults = workOn ? getResults().map(sanitizePublicResult).filter(Boolean) : [];
  send({
    type: 'init',
    status: { running: s.running, iteration: s.iteration, mode: s.mode, startedAt: s.startedAt, uptime: s.uptime },
    batchId: activeBatchId,
    snapshotSize: activeSnapshotSize,
    batchMode: activeBatchMode,
    // Persisted log backlog so /live shows full history on refresh, not a blank
    // panel — but ONLY during an active run. logBuffer is hydrated from
    // results/audit-*.log on boot, so an idle page would otherwise leak it.
    logs: workOn ? publicLogBuffer().slice(-INIT_LOG_REPLAY) : [],
    state: initState,
    results: initResults,
    // Report effective-live so the admin's own /live page flips into live mode
    // (skipping the paused overlay) without forcing the operator to also flip
    // the public broadcast toggle. Public visitors get the real flag.
    broadcastLive: liveOn,
  });
  const handler = (data) => {
    // Admin's own /live SSE: forward live events even when broadcast is off so
    // the operator's view stays in lockstep with the admin dashboard. Public
    // visitors only get events when broadcastLive is on.
    if (!state.broadcastLive && !isAdminViewer) return;
    if (!PUBLIC_EVENT_WHITELIST.has(data.type)) return;
    // /live is per-node activity only — drop operator EVENTS + in-run SYS lines.
    if (data.type === 'log' && (data.cat === 'events' || data.cat === 'sys')) return;
    send(sanitizeForPublic(data));
  };
  emitter.on('update', handler);
  // 20s heartbeat comment-line — keeps the TCP connection alive through proxies
  const pingInterval = setInterval(() => { try { res.write(':\n\n'); } catch (_) {} }, SSE_PING_MS);
  req.on('close', () => {
    emitter.off('update', handler);
    clearInterval(pingInterval);
  });
});

/**
 * GET /api/public/logs
 * Returns the rolling log buffer so /live can paint the full backlog on
 * page refresh — not just events received since the SSE socket opened.
 * Empty when broadcastLive is off (public must not see live activity then).
 */
app.get('/api/public/logs', attachAdminFlag, rlPublicRead, (req, res) => {
  // Admin's own /live: always return logs so the operator can monitor without
  // toggling broadcast. Public visitors still gated by broadcastLive.
  const showLive = state.broadcastLive || req.admin === true;
  if (!showLive) return res.json({ logs: [], broadcastLive: false });
  // No active run → no backlog. A paused/idle /live must stay blank behind the
  // overlay, not replay the last run's log buffer.
  if (!publicRunActive()) return res.json({ logs: [], broadcastLive: true });
  // Report effective-live so admin viewers get the live-mode UI on /live.
  res.json({ logs: publicLogBuffer(), broadcastLive: true });
});

/**
 * GET /api/public/live-state
 * Sanitized snapshot of state + results so /live can rehydrate after refresh
 * even before SSE init lands. Mirrors admin /api/state + /api/results minus
 * operator-internal fields. Empty when broadcastLive is off.
 */
app.get('/api/public/live-state', attachAdminFlag, rlPublicRead, (req, res) => {
  // Admin's own /live: always reveal live state so operator's view matches the
  // admin dashboard. Public visitors still gated by broadcastLive.
  const showLive = state.broadcastLive || req.admin === true;
  if (!showLive) {
    return res.json({ broadcastLive: false, state: {}, results: [] });
  }
  // Surface the active batch id + snapshot size so /live's seed path can pin
  // _cb.batchId before any SSE batch:start lands. Without this, the very
  // first batch:start arriving after a refresh sees `_cb.batchId == null`
  // with already-painted rows and treats them as stale → wipes the table
  // mid-run for sub-plan / p2p / retest (continuous loop is unaffected because
  // its batch ids are also surfaced via SSE init.batchId).
  let activeBatchId = null;
  let activeSnapshotSize = null;
  try {
    const ab = getActiveBatch();
    if (ab) {
      activeBatchId = ab.batch.id;
      activeSnapshotSize = ab.batch.snapshot_size;
    }
  } catch (_) {}
  // Results only when a run is in flight — an idle page must seed an empty
  // table behind the paused overlay, not the last run's rows.
  const workOn = publicRunActive();
  res.json({
    // Report effective-live so admin viewers get the live-mode UI on /live.
    broadcastLive: true,
    state: sanitizePublicState(state),
    results: workOn ? getResults().map(sanitizePublicResult).filter(Boolean) : [],
    activeBatchId,
    snapshotSize: activeSnapshotSize,
  });
});

/**
 * GET /api/public/test/status
 * Read-only loop status snapshot. No wallet / plan IDs.
 */
app.get('/api/public/test/status', attachAdminFlag, rlPublicRead, (req, res) => {
  const s = continuous.status();
  // Only surface a baseline reading when a test is actively running. Restored
  // snapshot values from a prior session would otherwise paint /live with a
  // stale number on a cold server boot, making the tile look hardcoded.
  const baselineMbps = s.running && state.baselineMbps != null
    ? Number(state.baselineMbps)
    : null;
  res.json({
    running:   s.running,
    iteration: s.iteration,
    mode:      s.mode,
    startedAt: s.startedAt,
    uptime:    s.uptime,
    lastError: s.lastError ? String(s.lastError).slice(0, 200) : null,
    allowPublicStart: process.env.ALLOW_PUBLIC_TEST === 'true',
    baselineMbps,
  });
});

// Rate-limit: one public start per IP per minute. Entries older than the
// window are useless; sweep them every 5 min so the Map can't grow unbounded
// under internet exposure.
const _publicStartLast = new Map();
const _RATE_WINDOW_MS = 60_000;
function publicStartRateOk(ip) {
  const now = Date.now();
  const prev = _publicStartLast.get(ip) || 0;
  if (now - prev < _RATE_WINDOW_MS) return false;
  _publicStartLast.set(ip, now);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - _RATE_WINDOW_MS;
  for (const [ip, ts] of _publicStartLast) {
    if (ts < cutoff) _publicStartLast.delete(ip);
  }
}, 5 * 60_000).unref();

/**
 * POST /api/public/test/start
 * Gated by ALLOW_PUBLIC_TEST=true. Body: { mode: 'p2p' | 'subscription' }.
 * Subscription mode requires ADMIN to have pre-configured a plan — public body
 * cannot supply planId or wallet. If not configured, start is rejected.
 */
app.post('/api/public/test/start', attachAdminFlag, async (req, res) => {
  if (process.env.ALLOW_PUBLIC_TEST !== 'true') {
    return res.status(403).json({ error: 'Public test start disabled' });
  }
  // Use req.ip (populated from X-Forwarded-For only via the single trusted
  // proxy hop configured by `app.set('trust proxy', 1)`), NOT the raw
  // X-Forwarded-For header — that header is fully attacker-spoofable and would
  // let a single client mint unlimited distinct "IPs" to bypass this limiter on
  // the only unauthenticated wallet-spending route. Matches clientIp() in
  // core/rate-limit.js (F-02).
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!publicStartRateOk(ip)) {
    return res.status(429).json({ error: 'Rate limit: one start per minute per IP' });
  }
  if (isPipelineBusy()) {
    return res.status(409).json({ error: 'A regular audit is running — try again later.' });
  }
  const mode = (req.body?.mode === 'subscription') ? 'subscription' : 'p2p';
  const planId = mode === 'subscription' ? process.env.PUBLIC_TEST_PLAN_ID : undefined;
  const subscriptionId = mode === 'subscription' ? process.env.PUBLIC_TEST_SUB_ID : undefined;
  const subscriptionGranter = mode === 'subscription' ? process.env.PUBLIC_TEST_SUB_GRANTER : undefined;
  if (mode === 'subscription' && !planId) {
    return res.status(400).json({ error: 'Subscription mode not configured on this server' });
  }
  const result = await continuous.start({ mode, planId, subscriptionId, subscriptionGranter });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, mode, iteration: result.iteration });
});

/**
 * POST /api/public/test/stop
 * Also gated by ALLOW_PUBLIC_TEST.
 */
app.post('/api/public/test/stop', attachAdminFlag, (req, res) => {
  if (process.env.ALLOW_PUBLIC_TEST !== 'true') {
    return res.status(403).json({ error: 'Public test stop disabled' });
  }
  const result = continuous.stop();
  res.json(result);
});

// ─── Broadcast Live toggle ───────────────────────────────────────────────────
app.post('/api/broadcast', adminOnly, (req, res) => {
  state.broadcastLive = !state.broadcastLive;
  persistBroadcastPref();
  res.json({ broadcastLive: state.broadcastLive });
});

app.get('/api/broadcast', (req, res) => {
  // `activeRun` lets /live gate ALL of its work calls behind this single poll:
  // while paused it hits only this endpoint, and fans out (SSE, live-state,
  // logs, runs, stats) only once there's a run to actually show.
  res.json({
    broadcastLive: state.broadcastLive,
    activeRun: state.broadcastLive && publicRunActive(),
  });
});

// ─── Audit settings (P2P payment tunables) ───────────────────────────────────
// Read-anywhere / write-admin. Hot-reloaded by audit pipeline at run start.
app.get('/api/settings', (req, res) => {
  res.json({ settings: getSettings(), defaults: getDefaultSettings() });
});

app.post('/api/settings', adminOnly, (req, res) => {
  const patch = (req.body && typeof req.body === 'object') ? req.body : {};
  const next = updateSettings(patch);
  res.json({ settings: next, defaults: getDefaultSettings() });
});

// ─── On-chain reports (RPC tx_search by tester wallet) ───────────────────────
// Returns recent decoded report TXs posted by this tester. Open endpoint —
// the data is already public on-chain. Limit capped at 50 per request.
app.get('/api/onchain-reports', rlOnchainReports, async (req, res) => {
  try {
    // Prefer the explicit ?address, then the already-cached tester wallet
    // (set at boot). Only re-derive from the mnemonic as a last resort — that
    // path does key-derivation work on the request thread and is rate-limited
    // above, but we'd rather not run it at all on the common case.
    const address = req.query.address || state.walletAddress || solanaWalletAddress();
    if (!address) return res.status(503).json({ error: 'tester wallet not yet initialized' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const fromHeight = Math.max(0, parseInt(req.query.fromHeight, 10) || 0);
    const reports = await queryOnchainReports(address, { limit, fromHeight });
    res.json({ address, count: reports.length, reports });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trim a result row's `diag` blob down to the only 4 subfields the admin
// dashboard reads off a LIVE SSE row (the results-table transport-detail
// renderer: v2rayProto / v2rayTransport / v2raySecurity / v2rayPort). The full
// diag carries internal/sensitive diagnostics — the V2Ray credential
// `v2rayUUID`, raw `v2rayConfig` / `hsConfig`, process `v2rayStdout` /
// `v2rayStderr`, `wgServerEndpoint`, etc. — that never need to reach the
// browser. The rich node-detail drawer + failure-report builder source diag
// from the persisted error-log over REST (`er.raw_json`), NOT from the SSE row,
// so trimming the SSE row does not regress them.
//
// MUST be non-mutating: result rows are SHARED references with DB persistence
// (insertBatchResult → raw_json) and the in-memory state (getResults()). Return
// a shallow CLONE with a fresh trimmed diag; never touch the original row, its
// diag, or the getResults() arrays — mutating would strip the diag the
// drawer/persistence depend on. Rows without a diag (skips, wireguard-only)
// pass through untouched; we do NOT fabricate an empty diag key.
function trimRowDiag(r) {
  if (!r || typeof r !== 'object' || !r.diag || typeof r.diag !== 'object') return r;
  return {
    ...r,
    diag: {
      v2rayProto: r.diag.v2rayProto,
      v2rayTransport: r.diag.v2rayTransport,
      v2raySecurity: r.diag.v2raySecurity,
      v2rayPort: r.diag.v2rayPort,
    },
  };
}

// Strip the state fields the admin browser never consumes from a LIVE event's
// state payload. admin.html DOES read walletAddress + balance (the wallet
// header in applyState, kept current via `Object.assign(state, msg.state)` on
// progress/result events) — those MUST keep flowing. But balanceUdvpn and
// spentUdvpn are read NOWHERE in admin.html, and runGranter (subscription
// granter address) is server-internal. Non-mutating: rest-spread a clone so the
// global `state` is never touched.
function sanitizeAdminState(s) {
  if (!s || typeof s !== 'object') return s;
  const { balanceUdvpn, spentUdvpn, runGranter, ...rest } = s;
  return rest;
}

const rlAdminSse = sseLimit({ maxPerIp: 10, bucket: 'admin-sse' });
app.get('/api/events', adminOnly, rlAdminSse, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const results = getResults();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  // Strip wallet + balance internals AND runGranter (subscription granter
  // address — operator-internal, never needs to leave the server).
  const { walletAddress, balance, balanceUdvpn, spentUdvpn, runGranter, ...stateForSse } = state;
  // The global `state` doesn't carry a fresh etaRemainingMs (it's stamped onto
  // broadcast payloads, not the global), so a freshly-connected admin would be
  // blank until the next event. Compute it once here for the init frame.
  stateForSse.etaRemainingMs = computeEtaRemainingMs(state);
  // Trim each result row's diag to the 4 fields the dashboard reads (drop the
  // credential/config/stdout blob). New array of clones — getResults() returns
  // the shared in-memory state rows; never mutate them.
  send({ type: 'init', state: stateForSse, results: results.map(trimRowDiag), logs: logBuffer.slice(-INIT_LOG_REPLAY) });
  const ADMIN_BLOCK = /^(loop:|iteration:|batch:)/;
  const handler = (data) => {
    if (data && typeof data.type === 'string' && ADMIN_BLOCK.test(data.type)) return;
    let out = data;
    // ANY live event carrying a state payload (state, result, progress) gets the
    // unconsumed wallet internals + server-internal granter stripped uniformly.
    if (data && data.state && typeof data.state === 'object') {
      out = { ...out, state: sanitizeAdminState(data.state) };
    }
    // result events forward the same row object insertBatchResult persists to
    // raw_json — clone+trim its diag for the wire, leave data.result untouched.
    if (data && data.type === 'result' && data.result && typeof data.result === 'object') {
      out = { ...out, result: trimRowDiag(data.result) };
    }
    // state events also carry results[] (broadcastStateFresh) — trim each row's
    // diag too. New array of clones; do not mutate data.results.
    if (out && Array.isArray(out.results)) {
      out = { ...out, results: out.results.map(trimRowDiag) };
    }
    send(out);
  };
  emitter.on('update', handler);
  // 20s heartbeat comment-line — keeps the TCP connection alive through proxies
  const pingInterval = setInterval(() => { try { res.write(':\n\n'); } catch (_) {} }, SSE_PING_MS);
  req.on('close', () => {
    emitter.off('update', handler);
    clearInterval(pingInterval);
  });
});

// ─── Audit Control Routes ───────────────────────────────────────────────────

// Shared helper: save current run (if any), clear results, allocate new run number + dir.
function startFreshRun(label, { mode = 'p2p', plan_id = null } = {}) {
  const prevResults = getResults();
  if (!Number.isFinite(state.activeRunNumber)) state.activeRunNumber = getNextRunNumber();
  if (prevResults.length > 0) {
    const runDir = path.join(RUNS_DIR, `test-${String(state.activeRunNumber).padStart(3, '0')}`);
    try { _mkd(runDir, { recursive: true }); } catch { }
    _writeAtomic(path.join(runDir, 'results.json'), JSON.stringify(prevResults, null, 2));
    try { writeRunFailures(runDir, prevResults); } catch (e) { console.error('[runs] failures write failed:', e.message); }
    const idx = loadRunsIndex();
    const passed = prevResults.filter(r => r.actualMbps != null).length;
    const failed = prevResults.filter(r => r.actualMbps == null).length;
    const pass10 = prevResults.filter(r => r.actualMbps != null && r.actualMbps >= 10).length;
    const existingRun = idx.runs.find(r => r.number === state.activeRunNumber);
    if (existingRun) {
      // Keep the index label in sync with the results we just wrote — otherwise
      // the label drifts from the snapshot (what corrupted Test #11's label).
      existingRun.total = prevResults.length;
      existingRun.passed = passed;
      existingRun.failed = failed;
      existingRun.pass10 = pass10;
    } else {
      idx.runs.push({
        number: state.activeRunNumber,
        label: `Auto-save before ${label}`,
        date: new Date().toISOString(),
        total: prevResults.length,
        passed, failed, pass10,
        sdk: state.activeSDK || 'js',
      });
    }
    saveRunsIndex(idx);
    broadcast('log', { msg: `💾 Saved Test #${state.activeRunNumber} (${prevResults.length} results) before starting ${label}` });
  }

  // Reset in-memory results so the new run starts from zero
  prevResults.length = 0;

  const newNum = getNextRunNumber();
  state.activeRunNumber = newNum;
  // A fresh run is live/writable — clear any read-only marker left by a prior
  // /api/runs/load so /api/resume works again for this new run.
  state.loadedReadonly = false;
  // Brand-new run isn't in the saved index yet (saveCurrentRun adds it on
  // completion) — so it's UNSAVED until then. Drives the SAVE button.
  state.activeRunSaved = false;
  state.stopRequested = false;
  state.testedNodes = 0;
  state.failedNodes = 0;
  state.skippedNodes = 0;
  state.passed15 = 0;
  state.passed10 = 0;
  state.passedBaseline = 0;
  state.totalNodes = 0;
  state.retryCount = 0;
  state.estimatedTotalCost = `0 ${TOKEN_LABEL}`;
  state.spentUdvpn = 0;
  state.runSpentUdvpn = 0;
  // Surface the active mode so the UI can render a clear "what's running" badge:
  // 'subscription' (sub-plan), 'p2p', 'test'. Plan id is null unless mode === 'subscription'.
  state.runMode = mode;
  state.runPlanId = plan_id || null;

  try { _wfs(STATE_SNAPSHOT_FILE, '{}', 'utf8'); } catch { }

  const newRunDir = path.join(RUNS_DIR, `test-${String(newNum).padStart(3, '0')}`);
  try { _mkd(newRunDir, { recursive: true }); } catch { }
  state.activeRunDir = newRunDir;

  const idx2 = loadRunsIndex();
  idx2.activeRun = newNum;
  saveRunsIndex(idx2);

  // ─── SQLite: open a new run record ───────────────────────────────────────
  try {
    const dbRunId = insertRun({
      started_at:     Date.now(),
      mode,
      plan_id:        plan_id || null,
      wallet_address: state.walletAddress || null,
      tester_sdk:     state.activeSDK || 'js',
      tester_os:      process.platform,
    });
    state.activeDbRunId = Number(dbRunId);
  } catch (dbErr) {
    console.error(`[db] insertRun failed: ${dbErr.message}`);
  }

  return { newNum, newRunDir };
}

// Start NEW test (saves current, clears, starts fresh).
app.post('/api/start', adminOnly, async (req, res) => {
  const testRun = !!(req.body?.testRun || req.query.testRun);
  const infiniteLoop = !!(req.body?.infiniteLoop || req.query.infiniteLoop);
  const pricingMode = (req.body?.pricingMode === 'hours' || req.query.pricingMode === 'hours') ? 'hours' : 'gigabytes';
  // Solana: test only these node PDAs (a hosted lab node set); empty = every listed node.
  const onlyAddresses = Array.isArray(req.body?.addresses) ? req.body.addresses.filter((a) => typeof a === 'string' && a) : [];

  if (isPipelineBusy() || _auditLaunching) return res.json({ error: 'Already running' });
  if (continuous.status().running) {
    if (!req.body?.takeover) {
      return res.status(409).json({ error: 'PUBLIC_RUN_ACTIVE', message: 'A public run is active. Pause it and start an audit?' });
    }
    // Synchronously claim the launch BEFORE the pause-poll await so a second
    // concurrent start/resume can't slip through the isPipelineBusy() check.
    // try/finally guarantees the flag clears on EVERY path (return or throw) so
    // it can never get stuck true and wedge all future starts. The flag clears
    // at the END of this block — safe ONLY because the remaining launch path is
    // synchronous up to status='running'. DO NOT add an await between here and
    // status='running', or the TOCTOU window silently reopens.
    _auditLaunching = true;
    try {
      const pr = continuous.pause();
      if (!pr.ok) return res.status(500).json({ error: 'pause failed: ' + pr.error });
      for (let i = 0; i < 100; i++) {
        if (!continuous.status().running) break;
        await new Promise(r => setTimeout(r, 100));
      }
    } finally {
      _auditLaunching = false;
    }
  }
  if (!testRun && !MNEMONIC) return res.json({ error: 'TEST_KEYFILE not set in .env' });

  state.continuousLoop = infiniteLoop;
  state.testRun = testRun;
  state.pricingMode = pricingMode;
  const runMode = testRun ? 'test' : 'p2p';
  state.runMode = runMode;
  state.runPlanId = null;
  state.runSubscriptionId = null;
  state.runGranter = null;
  // Brand-new test → drop any prior batch handle. Resume reuses; start does not.
  state.activeBatchId = 0;
  state.resumeHeadAddr = null;
  state.auditLogPath = null;
  const { newNum: firstNum } = startFreshRun(`Test #${getNextRunNumber()}`, { mode: runMode });

  const SDK_LABELS = { dvpnd: 'DVPND' };
  const label = `${SDK_LABELS[state.activeSDK] || state.activeSDK} client, ${process.platform === 'win32' ? 'Windows' : process.platform}`;
  const modeTag = testRun ? 'Test Run (sample data)' : 'P2P (all online nodes)';
  broadcast('log', { msg: `🚀 Starting Test #${firstNum} — Mode: ${modeTag} | ${label}${infiniteLoop ? ' | ∞ LOOP' : ''} | Pricing: ${pricingMode === 'hours' ? 'Per Hour' : 'Per GB'}` });
  res.json({ ok: true, testNumber: firstNum, testRun, infiniteLoop, pricingMode });
  broadcastStateFresh();

  (async () => {
    let curNum = firstNum;
    // First pass + any further passes if continuousLoop stays true.
    while (true) {
      // Fresh wrapper per pass so each iteration writes its own batches row.
      const tracked = withBatchTracking(broadcast, testRun ? 'test' : 'p2p');
      try {
        await runAudit(false, state, tracked, null, { testRun, pricingMode, addresses: onlyAddresses });
        saveCurrentRun(`Test #${curNum}`);
        tracked('log', { msg: `💾 Test #${curNum} complete and saved` });
      } catch (err) {
        state.status = 'error';
        state.errorMessage = err.message;
        tracked('state', { state });
        break;
      }
      if (!state.continuousLoop || state.stopRequested) break;
      // Re-snapshot the chain and start a fresh run.
      curNum = getNextRunNumber();
      startFreshRun(`Test #${curNum}`, { mode: runMode });
      broadcast('log', { msg: `♾  Loop continues — starting Test #${curNum}` });
      broadcastStateFresh();
    }
    state.continuousLoop = false;
    broadcast('state', { state });
  })();
});

// Resume CURRENT test from where it left off (skips already-tested nodes).
app.post('/api/resume', adminOnly, async (req, res) => {
  if (isPipelineBusy() || _auditLaunching) return res.json({ error: 'Already running' });
  if (continuous.status().running) {
    if (!req.body?.takeover) {
      return res.status(409).json({ error: 'PUBLIC_RUN_ACTIVE', message: 'A public run is active. Pause it and start an audit?' });
    }
    // Synchronously claim the launch BEFORE the pause-poll await so a second
    // concurrent start/resume can't slip through the isPipelineBusy() check.
    // try/finally guarantees the flag clears on EVERY path (return or throw) so
    // it can never get stuck true and wedge all future starts. The flag clears
    // at the END of this block — safe ONLY because the remaining launch path is
    // synchronous up to status='running'. DO NOT add an await between here and
    // status='running', or the TOCTOU window silently reopens.
    _auditLaunching = true;
    try {
      const pr = continuous.pause();
      if (!pr.ok) return res.status(500).json({ error: 'pause failed: ' + pr.error });
      for (let i = 0; i < 100; i++) {
        if (!continuous.status().running) break;
        await new Promise(r => setTimeout(r, 100));
      }
    } finally {
      _auditLaunching = false;
    }
  }
  if (!MNEMONIC) return res.json({ error: 'TEST_KEYFILE not set in .env' });
  const results = getResults();
  if (results.length === 0) return res.json({ error: 'No results to resume from. Use Start to begin a new test.' });
  // A loaded historical snapshot is read-only — resuming it would append live
  // results onto a past run and mint a duplicate run number with a stale
  // db-run-id/mode. Force the operator to start a New Test or Retest Failed.
  if (state.loadedReadonly) {
    return res.status(409).json({
      error: 'LOADED_RUN_READONLY',
      message: 'This is a loaded past run — start a New Test or Retest Failed instead.',
    });
  }
  // Resume only continues an INCOMPLETE run. A completed run has nothing left to
  // test — Retest Failed is the action there. (Defense-in-depth: the UI already
  // hides Resume when complete.)
  const _doneNodes = (state.testedNodes || 0) + (state.failedNodes || 0) + (state.skippedNodes || 0);
  if ((state.totalNodes || 0) - _doneNodes <= 0) {
    return res.json({ error: 'RUN_COMPLETE', message: 'Run is complete — nothing to resume. Use Retest Failed to re-test failures.' });
  }
  // Ensure run directory exists and is active for continuous saves
  const resumeRunDir = path.join(RUNS_DIR, `test-${String(state.activeRunNumber).padStart(3, '0')}`);
  try { _mkd(resumeRunDir, { recursive: true }); } catch { }
  state.activeRunDir = resumeRunDir;

  // Re-hydrate the live log buffer from the in-flight audit log. Without this,
  // a Stop that happened earlier in the same process (no bounce) leaves the
  // buffer with only the lines emitted live during this process — but a fresh
  // admin / live tab opening after Resume sees the SSE init replay only those
  // post-bounce lines. Hydrating from the on-disk log file guarantees the
  // resumed live log mirrors the prior session exactly.
  if (state.auditLogPath && _ex(state.auditLogPath)) {
    const n = hydrateLogBufferFromFile(state.auditLogPath);
    if (n > 0) console.log(`Resume: rehydrated logBuffer from ${path.basename(state.auditLogPath)} (${n} lines)`);
  }

  // Refuse to silently demote an unknown-mode resume to P2P. If the snapshot
  // didn't preserve runMode (older runs pre-snapshot-v2) the operator must
  // start a fresh test so we don't pay-per-node on a subscription chain or
  // accidentally TEST_RUN_SKIP a real audit.
  if (!state.runMode) {
    return res.status(409).json({
      error: 'NO_RUN_MODE',
      message: 'Cannot resume — run mode is unknown (snapshot did not preserve mode). Start a new test instead.',
    });
  }
  const runMode = state.runMode;
  const modeTag = runMode === 'subscription' ? `Sub. Plan ${state.runPlanId}` : (runMode === 'test' ? 'Test Run' : 'P2P');
  // Flip status to 'running' synchronously and push a state event BEFORE the
  // pipeline goroutine starts. Without this, a live tab that fires its SSE
  // `init` between this response and the runner's first `broadcast('state')`
  // sees the stale `status: 'stopped'` snapshot and shows the paused overlay
  // — even though the audit is fully resumed. Pushes the full results array
  // too so the live table re-paints any rows the client may have wiped.
  state.status = 'running';
  state.stopRequested = false;
  // The runner reads state.activeDbRunId directly, so post-resume failures still
  // write to error_logs — no global to re-arm. (Without DB persistence the
  // node-detail "View error details" popup would show "No stored failure log".)
  broadcast('log', { msg: `▶ Resuming Test #${state.activeRunNumber} (${modeTag}) from node ${results.length + 1} (${results.length} already tested, SDK: ${state.activeSDK.toUpperCase()})` });
  broadcastStateFresh();
  res.json({ ok: true, testNumber: state.activeRunNumber, resumeFrom: results.length, runMode });

  // Resume: re-attach to the prior batch row if we still have its id, so /live's
  // hydrate-from-DB returns the full pre-pause + post-resume row set as one
  // batch. Without existingBatchId, withBatchTracking opens a fresh batches row
  // and the live table wipes back to only post-resume rows.
  const existingBatchId = state.activeBatchId || 0;
  if (runMode === 'subscription') {
    if (!state.runPlanId || !state.runSubscriptionId || !state.runGranter) {
      state.status = 'error';
      state.errorMessage = 'Cannot resume subscription run — missing plan context. Start a new test.';
      broadcast('state', { state });
      return;
    }
    const tracked = withBatchTracking(broadcast, 'subscription', { existingBatchId });
    runSubPlanTest(state.runPlanId, state.runSubscriptionId, state.runGranter, state, tracked, { resume: true }).then(() => {
      saveCurrentRun(`Test #${state.activeRunNumber} — Sub. Plan ${state.runPlanId}`);
      tracked('log', { msg: `💾 Test #${state.activeRunNumber} saved` });
    }).catch(err => {
      state.status = 'error';
      state.errorMessage = err.message;
      tracked('state', { state });
    });
  } else {
    const tracked = withBatchTracking(broadcast, state.testRun ? 'test' : 'p2p', { existingBatchId });
    runAudit(true, state, tracked, null, { testRun: !!state.testRun, pricingMode: state.pricingMode }).then(() => {
      saveCurrentRun(`Test #${state.activeRunNumber}`);
      tracked('log', { msg: `💾 Test #${state.activeRunNumber} saved` });
    }).catch(err => {
      state.status = 'error';
      state.errorMessage = err.message;
      tracked('state', { state });
    });
  }
});

app.post('/api/stop', adminOnly, (req, res) => {
  // Set stop flags first so any wakeup from the kills below sees them.
  state.stopRequested = true;
  state.continuousLoop = false;
  try { continuous.stop(); } catch {}

  // Wake every in-flight pipeline `await sleep(...)` immediately so the per-node
  // loop drops back to its `if (state.stopRequested) break` check on the next tick.
  // Without this the longest pending sleep (e.g. balance-poll 5min) holds up Stop.
  try { triggerPipelineStop(); } catch {}

  // Snap the UI to stopped immediately — the pipeline still has to finish unwinding,
  // but the user gets feedback the moment they click Stop.
  state.status = 'stopped';
  // Force a non-throttled snapshot NOW so a process exit within the next 5s
  // can't lose the in-flight activeBatchId / spend / resumeHeadAddr needed for
  // a later /api/resume.
  flushStateSnapshot();
  broadcast('log', { msg: '⏹ Stop — force-terminating in-flight test.' });
  broadcast('state', { state });

  // Force-stop in-flight node test: kill V2Ray (causes waitForPort/speedtest to fail
  // immediately), then run WG cleanup. Without this, Stop waits up to ~20s for the
  // current node's session/handshake/speedtest timers to expire.
  (async () => {
    try {
      // Pick the platform-correct v2ray module. Importing the Windows one on
      // Linux ran `taskkill … 2>nul`, which (taskkill is Windows-only) failed
      // and left a stray file literally named `nul` in the cwd.
      let killAllV2Ray;
      if (process.platform === 'win32') {
        ({ killAllV2Ray } = await import('./platforms/windows/v2ray.js'));
      } else if (process.platform === 'linux') {
        ({ killAllV2Ray } = await import('./platforms/linux/v2ray.js'));
      } else if (process.platform === 'darwin') {
        ({ killAllV2Ray } = await import('./platforms/macos/v2ray.js'));
      }
      killAllV2Ray?.();
    } catch {}
    try { emergencyCleanupSync(); } catch {}
    broadcast('state', { state });
  })();

  res.json({ ok: true });
});

app.post('/api/retest-skips', adminOnly, async (req, res) => {
  if (isPipelineBusy() || _auditLaunching) return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'TEST_KEYFILE not set in .env' });
  const results = getResults();
  const skipAddrs = results.filter(r => r.actualMbps == null && /unreachable/i.test(r.error || '')).map(r => r.address);
  if (skipAddrs.length === 0) return res.json({ error: 'No unreachable failures to retest' });
  state.stopRequested = false;
  res.json({ ok: true, retesting: skipAddrs.length });
  // Pin the retest to the active run's dir so per-node saveResults() writes into
  // THIS run, and persist the mutated set back to disk + index + SQLite on
  // completion (same treatment as /api/auto-retest) — otherwise file / index /
  // SQLite / live state diverge from what's on screen.
  if (state.activeRunNumber != null) {
    const retestRunDir = path.join(RUNS_DIR, `test-${String(state.activeRunNumber).padStart(3, '0')}`);
    try { _mkd(retestRunDir, { recursive: true }); } catch (e) { console.error('[retest-skips] mkdir failed:', e.message); }
    state.activeRunDir = retestRunDir;
  }
  const tracked = withBatchTracking(broadcast, state.runMode || 'p2p');
  runRetestSkips(skipAddrs, state, tracked).then(() => {
    // Snapshot this-pass spend NOW, before the idle balance refresher can zero
    // state.spentUdvpn in the gap before persist. runRetestSkips resets the
    // cumulative accumulator (runSpentUdvpn) to 0 at its top, so this-pass spend
    // lives in runSpentUdvpn. Then set BOTH state.spentUdvpn (balance-delta) and
    // state.runSpentUdvpn (cumulative) to the true running total so the live
    // header + any later Save reflect the real total.
    const passSpent = Number(state.runSpentUdvpn) || 0;
    try {
      const r = persistActiveRun(undefined, { passSpent });
      if (r) { state.spentUdvpn = r.cumulativeSpent; state.runSpentUdvpn = r.cumulativeSpent; }
    } catch (e) { console.error('[retest-skips] persistActiveRun failed:', e.message); }
  }).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    tracked('state', { state });
  });
});

app.post('/api/retest-fails', adminOnly, async (req, res) => {
  if (isPipelineBusy() || _auditLaunching) return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'TEST_KEYFILE not set in .env' });
  const results = getResults();
  const specific = req.body?.addresses;
  const failAddrs = specific && specific.length > 0
    ? specific
    : results.filter(r => r.error && r.actualMbps == null
        && !r.error.includes('insufficient funds')
        && !r.error.includes('domainsocket')
      ).map(r => r.address);
  if (failAddrs.length === 0) return res.json({ error: 'No failures to retest' });
  state.stopRequested = false;
  res.json({ ok: true, retesting: failAddrs.length, addresses: failAddrs });
  // Pin + persist to the active run's dir, same treatment as /api/auto-retest.
  if (state.activeRunNumber != null) {
    const retestRunDir = path.join(RUNS_DIR, `test-${String(state.activeRunNumber).padStart(3, '0')}`);
    try { _mkd(retestRunDir, { recursive: true }); } catch (e) { console.error('[retest-fails] mkdir failed:', e.message); }
    state.activeRunDir = retestRunDir;
  }
  const tracked = withBatchTracking(broadcast, state.runMode || 'p2p');
  runRetestSkips(failAddrs, state, tracked).then(() => {
    // Snapshot this-pass spend (from runSpentUdvpn, the cumulative accumulator
    // which runRetestSkips reset to 0 at its top) before the idle refresher can
    // zero it; set BOTH state.spentUdvpn (balance-delta) and state.runSpentUdvpn
    // (cumulative) to the true cumulative for the live header + later Save.
    const passSpent = Number(state.runSpentUdvpn) || 0;
    try {
      const r = persistActiveRun(undefined, { passSpent });
      if (r) { state.spentUdvpn = r.cumulativeSpent; state.runSpentUdvpn = r.cumulativeSpent; }
    } catch (e) { console.error('[retest-fails] persistActiveRun failed:', e.message); }
  }).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    tracked('state', { state });
  });
});

// DEPRECATED: Plan testing is WIP — hidden from dashboard, endpoint still functional for API callers
app.post('/api/test-plan', adminOnly, async (req, res) => {
  if (isPipelineBusy() || _auditLaunching) return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'TEST_KEYFILE not set in .env' });
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId required' });
  state.stopRequested = false;
  const { newNum } = startFreshRun(`Plan ${planId}`, { mode: 'subscription', plan_id: String(planId) });
  state.continuousLoop = false;
  state.runMode = 'subscription';
  state.runPlanId = String(planId);
  state.testRun = false;
  state.planAddresses = Array.isArray(req.body.addresses) && req.body.addresses.length ? req.body.addresses.map(String) : null;
  state.activeBatchId = 0;
  state.resumeHeadAddr = null;
  state.auditLogPath = null;
  broadcastStateFresh();
  broadcast('log', { msg: `🚀 Starting Test #${newNum} — Mode: Plan ${planId} (subscribe, then access-ticket sessions)${state.planAddresses ? ` — ${state.planAddresses.length} roster node(s) only` : ''}` });
  res.json({ ok: true, planId, testNumber: newNum });
  const tracked = withBatchTracking(broadcast, 'subscription');
  runPlanTest(String(planId), state, tracked).then(() => {
    saveCurrentRun(`Test #${newNum} — Plan ${planId}`);
    tracked('log', { msg: `💾 Test #${newNum} complete and saved` });
  }).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    tracked('state', { state });
  });
});

app.get('/api/plans', adminOnly, async (req, res) => {
  try {
    const { discoverPlans } = await import('./core/chain.js');
    const plans = await discoverPlans(null, { maxId: 100 });
    plans.sort((a, b) => b.subscribers - a.subscribers);
    res.json({ plans });
  } catch (err) {
    console.error('[api/plans]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/subscriptions', adminOnly, async (req, res) => {
  try {
    const { querySubscriptions } = await import('./core/chain.js');
    const subs = await querySubscriptions(state.walletAddress);
    res.json({ subscriptions: subs });
  } catch (err) {
    console.error('[api/subscriptions]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Sub. Plan mode: enriched subs with plan owner + fee-grant status + node count
app.get('/api/sub-plans', adminOnly, async (req, res) => {
  try {
    const addr = req.query.address || state.walletAddress;
    if (!addr) return res.json({ plans: [], walletAddress: null });
    const { querySubscriberPlansEnriched } = await import('./core/chain.js');
    const plans = await querySubscriberPlansEnriched(addr);
    res.json({ plans, walletAddress: addr });
  } catch (err) {
    console.error('[api/sub-plans]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Sub. Plan mode: run fee-granted plan test — starts as a fresh run with clean counters.
app.post('/api/test-sub-plan', adminOnly, async (req, res) => {
  if (isPipelineBusy() || _auditLaunching) return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'TEST_KEYFILE not set in .env' });
  const { planId, subscriptionId, granter } = req.body || {};
  if (!planId) return res.status(400).json({ error: 'planId required' });
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' });
  if (!granter) return res.status(400).json({ error: 'granter (provider PDA) required' });
  const infiniteLoop = !!(req.body?.infiniteLoop || req.query.infiniteLoop);

  const { newNum } = startFreshRun(`Sub. Plan ${planId}`, { mode: 'subscription', plan_id: String(planId) });
  state.continuousLoop = infiniteLoop;
  state.runMode = 'subscription';
  state.runPlanId = String(planId);
  state.runSubscriptionId = String(subscriptionId);
  state.runGranter = String(granter);
  state.testRun = false;
  state.planAddresses = Array.isArray(req.body?.addresses) && req.body.addresses.length ? req.body.addresses.map(String) : null;
  // Brand-new test → drop any prior batch handle. Resume reuses; start does not.
  state.activeBatchId = 0;
  state.resumeHeadAddr = null;
  state.auditLogPath = null;
  broadcastStateFresh();
  broadcast('log', { msg: `🚀 Starting Test #${newNum} — Mode: Plan #${planId} (access-ticket sessions, plan-scoped node set)${infiniteLoop ? ' | ∞ LOOP' : ''}` });
  res.json({ ok: true, testNumber: newNum, planId, subscriptionId, granter, infiniteLoop });

  (async () => {
    let curNum = newNum;
    while (true) {
      // Fresh wrapper per pass so each iteration writes its own batches row.
      const tracked = withBatchTracking(broadcast, 'subscription');
      try {
        await runSubPlanTest(String(planId), String(subscriptionId), String(granter), state, tracked);
        saveCurrentRun(`Test #${curNum} — Sub. Plan ${planId}`);
        tracked('log', { msg: `💾 Test #${curNum} complete and saved` });
      } catch (err) {
        state.status = 'error';
        state.errorMessage = err.message;
        tracked('state', { state });
        break;
      }
      if (!state.continuousLoop || state.stopRequested) break;
      curNum = getNextRunNumber();
      startFreshRun(`Sub. Plan ${planId}`, { mode: 'subscription', plan_id: String(planId) });
      state.continuousLoop = true;
      broadcast('log', { msg: `♾  Loop continues — starting Test #${curNum} (Plan #${planId})` });
      broadcastStateFresh();
    }
    state.continuousLoop = false;
    broadcast('state', { state });
  })();
});

app.post('/api/clear', adminOnly, (req, res) => {
  // Guard: clearing mid-run corrupts state — the pipeline keeps pushing rows
  // into the same results array we'd be emptying. Refuse while a run is live.
  if (isPipelineBusy()) return res.status(409).json({ error: 'RUN_ACTIVE', message: 'Stop the run before clearing.' });
  getResults().length = 0;
  state.testedNodes = state.failedNodes = state.skippedNodes = state.passed15 = state.passed10 = state.passedBaseline = 0;
  state.retryCount = 0;
  state.baselineHistory = [];
  state.nodeSpeedHistory = [];
  state.baselineMbps = null; // else "Avg Baseline" falls back to the stale value
  // /api/clear wipes the DISPLAYED rows but keeps the active-run identity
  // (activeRunNumber / activeDbRunId / pipeline run dir stay attached — use
  // clearActiveRunView()/deleteRun to drop the identity). The counters above
  // leave spend/total/currentNode stale, so the header would still show the old
  // Net Spend / Total. Reset those transient fields too for a consistent wipe.
  state.spentUdvpn = 0;
  state.runSpentUdvpn = 0;
  state.estimatedTotalCost = `0 ${TOKEN_LABEL}`;
  state.totalNodes = 0;
  state.currentNode = null;
  state.resumeHeadAddr = null;
  state.activeBatchId = 0;
  // Drop a stale 'stopped'/'error' status so the wiped view isn't shown under a
  // paused/error overlay with zero rows.
  state.status = 'idle';
  saveResults({ activeRunDir: null });
  broadcastStateFresh();
  res.json({ ok: true });
});

/**
 * GET /api/admin/plans
 * Lists available Sentinel plans (delegates to discoverPlans in chain.js).
 * Optional query param: ?maxId=200
 */
app.get('/api/admin/plans', adminOnly, async (req, res) => {
  try {
    const { discoverPlans } = await import('./core/chain.js');
    const maxId = req.query.maxId ? parseInt(req.query.maxId, 10) : 100;
    const plans = await discoverPlans(null, { maxId });
    plans.sort((a, b) => b.subscribers - a.subscribers);
    res.json({ plans });
  } catch (err) {
    console.error('[api/admin/plans]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── Failure Analysis API ────────────────────────────────────────────────────
app.get('/api/failure-analysis', adminOnly, (req, res) => {
  const results = getResults();
  const failed = results.filter(r => r.actualMbps == null);
  const analysis = {
    total: results.length,
    passed: results.filter(r => r.actualMbps != null).length,
    failed: failed.length,
    successRate: results.length > 0 ? ((results.filter(r => r.actualMbps != null).length / results.length) * 100).toFixed(1) + '%' : '0%',
    categories: {},
    retestable: [],
    dead: [],
  };

  for (const r of failed) {
    const err = r.error || '';
    let cat, retestable = false, reason;

    if (/already exists/i.test(err)) {
      cat = '409_SESSION_EXISTS'; retestable = true; reason = 'Indexing race — retry with delay';
    } else if (/invalid status inactive|Code: 105/i.test(err)) {
      cat = 'CODE_105_INACTIVE'; retestable = true; reason = 'Listing stale — may have reactivated';
    } else if (/invalid price|code: 106/i.test(err)) {
      cat = 'INVALID_PRICE'; retestable = true; reason = 'Chain rejects price — retry without max_price';
    } else if (/V2Ray service dead|TCP port.*not reachable/i.test(err)) {
      cat = 'TCP_PORT_DEAD'; retestable = false; reason = 'V2Ray proxy down on node';
    } else if (/timed out/i.test(err)) {
      cat = 'NODE_TIMEOUT'; retestable = true; reason = 'Node slow or overloaded — retry later';
    } else if (/address mismatch/i.test(err)) {
      cat = 'ADDRESS_MISMATCH'; retestable = false; reason = 'Node config wrong';
    } else if (/ABCI query failed/i.test(err)) {
      cat = 'NODE_RPC_BROKEN'; retestable = true; reason = 'RPC congestion — may be transient';
    } else if (/timeout of (45|90)000ms/i.test(err)) {
      cat = 'HANDSHAKE_TIMEOUT'; retestable = true; reason = 'Node overloaded — retry later';
    } else if (/duplicate payment/i.test(err)) {
      cat = 'DUPLICATE_PAYMENT'; retestable = true; reason = 'Code bug fixed — should pass now';
    } else if (/SOCKS5.*no internet/i.test(err)) {
      cat = 'SOCKS5_NO_CONNECTIVITY'; retestable = true; reason = 'Tunnel routing dead — intermittent';
    } else if (/database corrupt/i.test(err)) {
      cat = 'NODE_DB_CORRUPT'; retestable = false; reason = 'Node DB broken';
    } else if (/insufficient/i.test(err)) {
      cat = 'INSUFFICIENT_FUNDS'; retestable = false; reason = `Need more ${TOKEN_LABEL}`;
    } else {
      cat = 'OTHER'; retestable = true; reason = 'Unknown — worth retrying';
    }

    if (!analysis.categories[cat]) analysis.categories[cat] = { count: 0, retestable, reason, nodes: [] };
    analysis.categories[cat].count++;
    analysis.categories[cat].nodes.push({
      address: r.address, moniker: r.moniker, country: r.country,
      city: r.city, peers: r.peers, type: r.type,
      error: (r.error || '').slice(0, 100),
    });

    if (retestable && r.peers > 0) analysis.retestable.push(r.address);
    else analysis.dead.push(r.address);
  }

  res.json(analysis);
});

// ─── Chain node list (admin-only) ───────────────────────────────────────────
app.get('/api/chain/nodes', adminOnly, async (req, res) => {
  try {
    await ensureLcd();
    const all = await getAllNodes(null);
    res.json({ total: all.length, results: all });
  } catch (err) {
    console.error('[api/chain/nodes]', err);
    res.status(500).json({ error: 'chain fetch failed' });
  }
});

// ─── SSRF guard ─────────────────────────────────────────────────────────────
// Reject internal/loopback/link-local targets so admin-driven proxy fetches
// can't be turned into an internal-network probe (cloud metadata, intranet, etc.).
function isPrivateOrLoopbackHost(host) {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
  // IPv4 private + link-local + multicast + 0.0.0.0
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
  }
  // IPv6 ULA / link-local
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:') || h.startsWith('[fc') || h.startsWith('[fd') || h.startsWith('[fe80:')) return true;
  return false;
}

// ─── Live node status (admin-only) ───────────────────────────────────────────
// Proxies nodeStatusV3 against the node's own remoteUrl for the admin UI.
app.get('/api/chain/node-status', adminOnly, async (req, res) => {
  const remoteUrl = String(req.query.remoteUrl || '').trim();
  if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) {
    return res.status(400).json({ error: 'remoteUrl query param required' });
  }
  let parsed;
  try { parsed = new URL(remoteUrl); } catch { return res.status(400).json({ error: 'invalid remoteUrl' }); }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return res.status(400).json({ error: 'private / loopback hosts are not allowed' });
  }
  try {
    const s = await nodeStatusV3(remoteUrl);
    res.json({
      address: s.address || '',
      moniker: s.moniker || '',
      type: s.type || '',
      peers: s.peers ?? null,
      maxPeers: s.qos?.max_peers ?? null,
      city: s.location?.city || '',
      country: s.location?.country || '',
      countryCode: s.location?.country_code || '',
      downloadBps: s.bandwidth?.download ?? null,
      uploadBps: s.bandwidth?.upload ?? null,
    });
  } catch (err) {
    res.status(502).json({ error: err?.message || 'node status failed' });
  }
});

// ─── Transport Intelligence Cache API ────────────────────────────────────────
app.get('/api/transport-cache', adminOnly, (req, res) => {
  loadTransportCache();
  res.json(getCacheStats());
});

// Auto-retest: analyze failures, retest all retestable nodes in one shot
app.post('/api/auto-retest', adminOnly, async (req, res) => {
  if (isPipelineBusy() || _auditLaunching) return res.json({ error: 'Already running' });
  if (!MNEMONIC) return res.json({ error: 'TEST_KEYFILE not set in .env' });

  const force = req.body?.force === true;
  const results = getResults();
  // Iron Rule: peers > 0 = our fault. Also include peers: null (unknown) for retest.
  const failed = results.filter(r => r.actualMbps == null && r.error);
  const retestable = force ? failed : failed.filter(r => {
    const err = r.error || '';
    if (/No udvpn pricing/i.test(err)) return false;
    return true;
  });

  if (retestable.length === 0) return res.json({ error: 'No retestable failures found' });

  state.stopRequested = false;
  res.json({ ok: true, retesting: retestable.length, addresses: retestable.map(r => r.address) });

  // Pin the retest to the active run's snapshot dir so per-node saveResults()
  // inside the pipeline write into THIS run's dir, and persist the mutated
  // result set back to disk + SQLite + index on completion — otherwise the
  // retest updates only in-memory results and the file/index/SQLite snapshot
  // for state.activeRunNumber diverges from what's on screen.
  if (state.activeRunNumber != null) {
    const retestRunDir = path.join(RUNS_DIR, `test-${String(state.activeRunNumber).padStart(3, '0')}`);
    try { _mkd(retestRunDir, { recursive: true }); } catch (e) { console.error('[auto-retest] mkdir failed:', e.message); }
    state.activeRunDir = retestRunDir;
  }

  const { runRetestSkips } = await import('./audit/pipeline.js');
  const tracked = withBatchTracking(broadcast, state.runMode || 'p2p');
  runRetestSkips(retestable.map(r => r.address), state, tracked).then(() => {
    // Persist back to the SAME run number — no new run is created.
    // Snapshot this-pass spend from runSpentUdvpn (the cumulative accumulator
    // runRetestSkips reset to 0 at its top) before the idle refresher can zero
    // it; set BOTH state.spentUdvpn (balance-delta) and state.runSpentUdvpn
    // (cumulative) to the true cumulative for the live header + later Save.
    const passSpent = Number(state.runSpentUdvpn) || 0;
    try {
      const r = persistActiveRun(undefined, { passSpent });
      if (r) { state.spentUdvpn = r.cumulativeSpent; state.runSpentUdvpn = r.cumulativeSpent; }
    } catch (e) { console.error('[auto-retest] persistActiveRun failed:', e.message); }
  }).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    tracked('state', { state });
  });
});

// ─── Test Run Management API ────────────────────────────────────────────────
app.get('/api/runs', adminOnly, (req, res) => {
  const index = loadRunsIndex();
  res.json({ runs: index.runs, activeRun: state.activeRunNumber });
});

app.post('/api/runs/save', adminOnly, (req, res) => {
  // Don't snapshot while the pipeline is actively writing rows — that races the
  // live results array and can persist a half-written run. (A paused run is fine
  // to save; the SAVE button is shown during pause but hidden while running.)
  if (state.status === 'running') {
    return res.status(409).json({ error: 'RUN_ACTIVE', message: 'Stop or wait for the run before saving.' });
  }
  const label = req.body?.label || '';
  const num = saveCurrentRun(label);
  if (num) {
    state.activeRunNumber = num;
    broadcast('log', { msg: `💾 Saved as Test #${num}` });
    // Push fresh state so the admin SAVE button hides immediately (the run is
    // now saved → state.activeRunSaved=true flows to applyState).
    broadcastStateFresh();
    res.json({ ok: true, number: num });
  } else {
    res.json({ error: 'No results to save' });
  }
});

app.get('/api/runs/:num', adminOnly, (req, res) => {
  const num = parseInt(req.params.num);
  const data = loadRun(num);
  if (!data) return res.status(404).json({ error: `Test #${num} not found` });
  const passed = data.filter(r => r.actualMbps != null);
  const failed = data.filter(r => r.actualMbps == null);
  res.json({
    number: num,
    total: data.length,
    passed: passed.length,
    failed: failed.length,
    pass10: passed.filter(r => r.actualMbps >= 10).length,
    results: data,
  });
});

app.post('/api/runs/load/:num', adminOnly, (req, res) => {
  const num = parseInt(req.params.num);
  const data = loadRunIntoState(num);
  if (!data) return res.status(404).json({ error: `Test #${num} not found` });
  broadcastStateFresh();
  broadcast('log', { msg: `📂 Loaded Test #${num} (${data.length} results)` });
  res.json({ ok: true, number: num, total: data.length });
});

app.delete('/api/runs/:num', adminOnly, (req, res) => {
  const num = parseInt(req.params.num);
  if (!Number.isInteger(num)) return res.status(400).json({ error: 'Invalid run number' });
  // Only refuse deletion when an audit is ACTIVELY running/parked on this run —
  // yanking the dir out from under a live writer (incl. a balance/internet poll
  // loop that resumes writing) would corrupt it. A stopped / done / idle run
  // that merely happens to still be the loaded/selected run CAN be deleted: we
  // reset the live view below so nothing dangles at a gone dir.
  if (state.activeRunNumber === num && isAuditBusy()) {
    return res.status(409).json({
      error: 'RUN_ACTIVE',
      message: "Can't delete a run while it's still testing — stop it first.",
    });
  }
  const wasActive = state.activeRunNumber === num;
  // Detach the active run's raw log first so deleteRun is free to remove it
  // (deleteRun otherwise preserves the currently-active run's log file).
  if (wasActive) state.auditLogPath = null;
  const ok = deleteRun(num);
  if (!ok) return res.status(404).json({ error: `Test #${num} not found` });
  if (wasActive) {
    clearActiveRunView();
    // Don't strand the admin on a blank view — fall back to the latest remaining
    // saved run (if any) so they keep seeing a real run. Only truly empty (no
    // saved runs left) stays cleared.
    const latest = latestRunNumber();
    // Guard on the load actually succeeding (a stale index entry could point at a
    // missing snapshot dir) — mirrors the boot branch. If it fails, stay cleared.
    if (latest != null && loadRunIntoState(latest)) {
      // clearActiveRunView already flushed a snapshot with activeRunNumber=null;
      // re-flush now that we've loaded the latest run so the reserved state is
      // durable across a bounce.
      try { flushStateSnapshot(); } catch (e) { console.error('[deleteRun] snapshot flush after fallback failed:', e.message); }
    }
    broadcastStateFresh();
  }
  broadcast('log', { msg: `🗑 Deleted Test #${num}` });
  res.json({ ok: true, number: num, clearedActive: wasActive });
});

// ─── SDK Toggle ─────────────────────────────────────────────────────────────
app.post('/api/sdk', adminOnly, (req, res) => {
  const { sdk } = req.body;
  // Solana has one client (dvpnd); every SDK choice maps onto it.
  const SDK_LABELS = { js: 'dvpnd', csharp: 'dvpnd', tkd: 'dvpnd', dvpnd: 'dvpnd' };
  if (!SDK_LABELS[sdk]) {
    return res.status(400).json({ error: 'Invalid client. Solana has one client: "dvpnd"' });
  }
  // Refuse SDK swaps mid-run — the pipeline reads state.activeSDK on every
  // node, so a switch would silently split a single audit across two SDK
  // implementations and contaminate the result-row sdk tag. Stop the run
  // first, then switch.
  if (isAuditBusy()) {
    return res.status(409).json({
      error: 'RUN_ACTIVE',
      message: 'Cannot switch SDK while an audit is running or paused. Stop first.',
    });
  }
  const changed = false;
  state.activeSDK = 'dvpnd';
  if (changed) {
    broadcast('state', { state });
    broadcast('log', { msg: `SDK switched to ${SDK_LABELS[sdk]}` });
  }
  res.json({ ok: true, sdk: 'dvpnd' });
});

app.get('/api/sdk', adminOnly, (req, res) => {
  res.json({ sdk: state.activeSDK });
});

// ─── Health Check (prelaunch validation for AI/automation) ─────────────────
app.get('/api/health', adminOnly, async (req, res) => {
  let checkV2Ray;
  if (process.platform === 'win32') {
    ({ checkV2Ray } = await import('./platforms/windows/v2ray.js'));
  } else if (process.platform === 'linux') {
    ({ checkV2Ray } = await import('./platforms/linux/v2ray.js'));
  } else if (process.platform === 'darwin') {
    ({ checkV2Ray } = await import('./platforms/macos/v2ray.js'));
  } else {
    checkV2Ray = async () => false;
  }
  const v2ray = await checkV2Ray();
  const issues = [];
  if (!MNEMONIC) issues.push('TEST_KEYFILE not set in .env — point it at a funded solana-keygen JSON key file');
  // Solana: no tunnel ever runs on the host, so admin rights, WireGuard and V2Ray are
  // not needed. Every session runs the dvpnd client in a container: Docker + the image.
  const docker = await dockerStatus();
  if (!docker.ok) issues.push(`Docker unavailable — every paid session runs in a client container (${docker.error})`);
  else if (!(await imagePresent(DVPND_IMAGE)).ok) issues.push(`client image ${DVPND_IMAGE} missing — load it before a paid run`);
  res.json({
    status: issues.length === 0 ? 'ready' : 'issues',
    platform: process.platform,
    admin: IS_ADMIN,
    mnemonic: MNEMONIC ? 'set' : 'missing',
    wireguard: WG_AVAILABLE,
    v2ray,
    sdk: state.activeSDK,
    balance: state.balance || 'unknown',
    issues,
  });
});

// ─── Cross-SDK Comparison Data ─────────────────────────────────────────────
app.get('/api/cross-sdk', adminOnly, (req, res) => {
  // Build a map of nodeAddress → { sdk: { passed, speed, error, run, date } } from all saved runs
  const map = {};
  const idx = loadRunsIndex();
  for (const run of (idx.runs || [])) {
    const runDir = path.join(RUNS_DIR, `test-${String(run.number).padStart(3, '0')}`);
    const rFile = path.join(runDir, 'results.json');
    if (!existsSync(rFile)) continue;
    let results;
    try { results = JSON.parse(_rfs(rFile, 'utf8')); } catch { continue; }
    const sdk = run.sdk || 'js';
    const runDate = run.date || '';
    const runNum = run.number;
    for (const r of results) {
      if (!r.address) continue;
      if (!map[r.address]) map[r.address] = {};
      const passed = r.actualMbps != null && r.actualMbps > 0;
      if (!map[r.address][sdk] || (passed && !map[r.address][sdk].passed)) {
        map[r.address][sdk] = { passed, speed: r.actualMbps, error: r.error?.slice(0, 60) || null, run: runNum, date: runDate };
      }
    }
  }
  // Also include current live results
  const currentResults = getResults();
  const currentSdk = state.activeSDK || 'js';
  const now = new Date().toISOString();
  for (const r of currentResults) {
    if (!r.address) continue;
    if (!map[r.address]) map[r.address] = {};
    const passed = r.actualMbps != null && r.actualMbps > 0;
    if (!map[r.address][currentSdk] || (passed && !map[r.address][currentSdk].passed)) {
      map[r.address][currentSdk] = { passed, speed: r.actualMbps, error: r.error?.slice(0, 60) || null, run: state.activeRunNumber, date: now };
    }
  }
  res.json(map);
});

// ─── DNS Configuration ──────────────────────────────────────────────────────
app.get('/api/dns', adminOnly, (req, res) => {
  res.json({ servers: ACTIVE_DNS, presets: Object.keys(DNS_PRESETS) });
});

app.post('/api/dns', adminOnly, (req, res) => {
  const { preset, servers } = req.body || {};
  if (preset && DNS_PRESETS[preset]) {
    setActiveDns([...DNS_PRESETS[preset]]);
    broadcast('log', { msg: `🔧 DNS changed to ${preset}: ${DNS_PRESETS[preset].join(', ')}` });
    return res.json({ ok: true, servers: DNS_PRESETS[preset], preset });
  }
  if (servers && Array.isArray(servers) && servers.length > 0) {
    setActiveDns(servers);
    broadcast('log', { msg: `🔧 DNS changed to custom: ${servers.join(', ')}` });
    return res.json({ ok: true, servers });
  }
  res.status(400).json({ error: 'Provide preset (default|hns|cloudflare|google) or servers array' });
});

// ─── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Server Startup ─────────────────────────────────────────────────────────
// LISTEN_HOST controls bind address. Defaults to 127.0.0.1 (localhost-only) so
// a fresh install never accidentally exposes the admin panel to the LAN/internet.
// Set LISTEN_HOST=0.0.0.0 explicitly when fronting with a reverse proxy / firewall.
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';

// ─── Open-admin network-exposure guard ──────────────────────────────────────
// When ADMIN_TOKEN is unset, adminOnly opens EVERY admin route (start/stop,
// wallet-spending audits, settings). That's fine for a localhost-only single-
// user setup, but binding to a non-loopback host would silently expose the
// fully-open admin surface to the LAN/internet. Mirror the PUBLIC_MODE guard
// above: refuse to bind and exit with a clear fatal message.
{
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!ADMIN_TOKEN && !LOOPBACK_HOSTS.has(LISTEN_HOST)) {
    console.error('');
    console.error(`ERROR: refusing to bind admin surface to non-loopback host "${LISTEN_HOST}" without ADMIN_TOKEN.`);
    console.error('  With ADMIN_TOKEN unset, all admin routes (start/stop, wallet-spending audits,');
    console.error('  settings) are open — binding to the network would expose them to anyone.');
    console.error('  Fix: either set ADMIN_TOKEN=<value> in your .env, or keep LISTEN_HOST=127.0.0.1.');
    console.error('  Generate a token:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    console.error('');
    process.exit(1);
  }
}

// ─── Solana additions: doctor, test channels + sweep, single-node probe ───────
app.use(solanaRoutes({ state, broadcast, isAuditBusy }));

app.listen(PORT, LISTEN_HOST, async () => {
  console.log(`\nSentinel Node Audit Dashboard (Solana) → http://${LISTEN_HOST === '0.0.0.0' ? 'localhost' : LISTEN_HOST}:${PORT}  (bound to ${LISTEN_HOST})\n`);
  // Deferred WG safety sweep — non-blocking, runs after the port is bound so
  // a slow Service Control Manager can never gate startup.
  setImmediate(() => {
    try { emergencyCleanupSync(); }
    catch (e) { console.error('[boot] emergencyCleanupSync failed:', e.message); }
  });
  {
    {
      console.log(`✓  Sessions run the dvpnd client in containers (${DVPND_IMAGE}); nothing tunnels on this host.\n`);
    }
  }

  if (!MNEMONIC) {
    console.log('┌──────────────────────────────────────────────────────────────┐');
    console.log('│  No TEST_KEYFILE configured — dashboard is view-only.       │');
    console.log('│                                                              │');
    console.log('│  To run audits:                                              │');
    console.log('│    1. Copy .env.example to .env                              │');
    console.log('│    2. Set TEST_KEYFILE to a funded solana-keygen key file    │');
    console.log('│    3. Restart the server                                     │');
    console.log('└──────────────────────────────────────────────────────────────┘');
  }

  // Close any orphaned batch / run rows from a previous boot so a /live or
  // admin refresh doesn't hydrate from a phantom run that never got its
  // batch:end / loop:stopped event.
  try {
    const { getDb } = await import('./core/db.js');
    const db = getDb();
    const orphans = db.prepare(
      `SELECT id FROM batches WHERE finished_at IS NULL`,
    ).all();
    for (const o of orphans) {
      const { results } = getBatchResults(o.id, { limit: 100000 });
      let passed = 0, failed = 0;
      for (const r of results) {
        if (r.actual_mbps != null && r.actual_mbps > 0 && !r.error) passed++;
        else failed++;
      }
      updateBatchOnFinish(o.id, { finished_at: Date.now(), passed, failed });
    }
    if (orphans.length > 0) {
      console.log(`✓  Closed ${orphans.length} orphaned batch(es) from previous boot.`);
    }
    const orphanRuns = db.prepare(
      `SELECT id FROM runs WHERE finished_at IS NULL`,
    ).all();
    for (const r of orphanRuns) {
      const stat = db.prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN actual_mbps > 0 AND error_message IS NULL THEN 1 ELSE 0 END) AS p FROM results WHERE run_id = ?`,
      ).get(r.id);
      updateRunOnFinish(r.id, {
        finished_at: Date.now(),
        node_count: stat?.n || 0,
        pass_count: stat?.p || 0,
      });
    }
    if (orphanRuns.length > 0) {
      console.log(`✓  Closed ${orphanRuns.length} orphaned run(s) in results table.`);
    }
  } catch (err) {
    console.error('Orphan-batch cleanup error:', err.message);
  }

  // ─── Auto-resume continuous loop from last-persisted config ───────────────
  // If the loop was running when the server was stopped/killed, pick it up
  // again on boot so a perpetual public test survives restarts.
  if (MNEMONIC) {
    try {
      const r = await continuous.resumeFromPersisted();
      if (r.resumed) {
        console.log(`✓  Auto-resumed continuous loop in mode "${r.mode}" from persisted config.`);
      } else if (r.reason && r.reason !== 'no-config-or-stopped') {
        console.warn(`⚠  Auto-resume attempted but failed: ${r.reason}`);
      }
    } catch (err) {
      console.error('Auto-resume error:', err.message);
    }
  }

  if (MNEMONIC) {
    try {
      const bal = await tokenBalanceBase();
      state.walletAddress = bal.address;
      state.balanceUdvpn = parseInt(bal.amount || '0', 10);
      state.spentUdvpn = 0; // Real chain balance is the truth — reset estimate
      state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} ${TOKEN_LABEL}`;
      state.estimatedTotalCost = `0 ${TOKEN_LABEL}`;
      console.log(`Wallet: ${bal.address} | Balance: ${state.balance} (${bal.sol} SOL)`);
      // Broadcast fresh balance to any SSE clients that connected before chain query finished
      broadcast('state', { state });
    } catch (err) {
      console.error('Failed to fetch initial balance:', err.message);
    }
  }

  // ─── Periodic balance refresh (runs even when idle) ────────────────────────
  if (MNEMONIC) {
    setInterval(async () => {
      // Whether this refresher may zero spentUdvpn. It must NOT while a run is
      // in-progress OR resumable: the tester is an on-chain spend oracle, and a
      // paused_internet/'paused' or 'stopped'-but-resumable run still has
      // cumulative spend that a later Resume must report. Zeroing it here makes
      // the resumed run under-report. Only when truly idle ('idle'/'done') is
      // the live chain balance the sole truth and spentUdvpn safe to reset.
      const spendLocked = isPipelineBusy() || state.status === 'stopped';
      // Skip entirely while the pipeline does its OWN balance refresh (actively
      // testing, or parked in the insufficient-funds poll loop).
      if (state.status === 'running' || state.status === 'paused_balance') return;
      try {
        const bal = await tokenBalanceBase();
        const fresh = parseInt(bal.amount || '0', 10);
        if (fresh !== state.balanceUdvpn) {
          state.balanceUdvpn = fresh;
          // Only reset the spend estimate when truly idle — never on a paused or
          // stopped-but-resumable run (see spendLocked above).
          if (!spendLocked) state.spentUdvpn = 0;
          state.balance = `${(fresh / 1_000_000).toFixed(4)} ${TOKEN_LABEL}`;
          broadcast('state', { state });
        }
      } catch (e) { console.error('[balance-refresh] periodic refresh failed:', e.message); }
    }, 2 * 60_000); // Every 2 minutes
  }
});
