/**
 * Sentinel Node Tester — Continuous Loop Runner
 * Singleton controller that runs repeated audit passes (p2p or subscription)
 * with a configurable inter-pass delay, interruptible stop, and SSE events.
 *
 * Events emitted (use .on()):
 *   'loop:started'        { mode, minDelayMs, iteration: 0 }
 *   'loop:stopping'       {}
 *   'loop:stopped'        { iterations, reason }
 *   'loop:error'          { error: string, iteration }
 *   'iteration:start'     { iteration, mode }
 *   'iteration:end'       { iteration, mode, durationMs, passed, failed }
 *
 * Batch-model events (each full node-sweep is one batch):
 *   'batch:start'         { batchId, snapshotSize, mode, startedAt }
 *   'batch:node:result'   { batchId, address, moniker, country, city, type,
 *                           actualMbps, peers, maxPeers, error, errorCode, testedAt }
 *   'batch:end'           { batchId, passed, failed, durationMs }
 *   'batch:gap'           { gapMs, nextBatchAt }
 */

import { EventEmitter } from 'events';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createState, triggerPipelineStop } from './pipeline.js';
import { sleep } from '../protocol/speedtest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOOP_CONFIG_PATH = path.join(__dirname, '..', 'results', '.loop-config.json');

/**
 * Persist the current loop-config so a server restart can auto-resume.
 * Writes `{ running, mode, planId, subscriptionId, subscriptionGranter, minDelayMs, updatedAt }`.
 * Non-fatal on I/O failure — perpetual availability > durability here.
 */
function _persistLoopConfig() {
  try {
    const dir = path.dirname(LOOP_CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cfg = {
      running: !!_ctrl.running,
      mode: _ctrl.mode,
      planId: _ctrl.planId,
      subscriptionId: _ctrl.subscriptionId,
      subscriptionGranter: _ctrl.subscriptionGranter,
      minDelayMs: _ctrl.minDelayMs,
      paused: !!_ctrl.paused,
      pausedBatch: _ctrl.pausedBatch || null,
      updatedAt: Date.now(),
    };
    writeFileSync(LOOP_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    // Non-fatal: persistence is best-effort. Loop continues; auto-resume on
    // restart simply won't trigger if write failed (acceptable degradation).
    console.error(`[continuous] _persistLoopConfig failed: ${err.message}`);
  }
}

/**
 * Read the persisted loop config if present. Returns null when no file exists
 * or the file is unreadable/invalid.
 *
 * @returns {null | { running: boolean, mode: string|null, planId: string|null,
 *   subscriptionId: string|null, subscriptionGranter: string|null,
 *   minDelayMs: number, updatedAt: number }}
 */
export function readPersistedLoopConfig() {
  try {
    if (!existsSync(LOOP_CONFIG_PATH)) return null;
    const raw = readFileSync(LOOP_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[continuous] readPersistedLoopConfig failed: ${err.message}`);
    return null;
  }
}

/**
 * If the last-known config had running:true, restart the loop on server boot.
 * Returns `{ resumed: true, mode }` on success, `{ resumed: false, reason }` otherwise.
 * Safe to call unconditionally — no-op when no config exists or running was false.
 *
 * @returns {Promise<{ resumed: boolean, mode?: string, reason?: string }>}
 */
export async function resumeFromPersisted() {
  const cfg = readPersistedLoopConfig();
  if (!cfg || !cfg.running) return { resumed: false, reason: 'no-config-or-stopped' };

  // If the persisted state was paused, hydrate _ctrl and wait for an explicit resume() call.
  if (cfg.paused && cfg.pausedBatch) {
    _ctrl.paused = true;
    _ctrl.pausedBatch = cfg.pausedBatch;
    _ctrl.mode = cfg.mode || 'p2p';
    _ctrl.planId = cfg.planId || null;
    _ctrl.subscriptionId = cfg.subscriptionId || null;
    _ctrl.subscriptionGranter = cfg.subscriptionGranter || null;
    _ctrl.minDelayMs = typeof cfg.minDelayMs === 'number' ? cfg.minDelayMs : MIN_DELAY_MS;
    // Do NOT auto-start — wait for an explicit resume() call.
    return { resumed: false, reason: 'paused-awaiting-resume', paused: true };
  }

  try {
    const r = await start({
      mode: cfg.mode || 'p2p',
      planId: cfg.planId || undefined,
      subscriptionId: cfg.subscriptionId || undefined,
      subscriptionGranter: cfg.subscriptionGranter || undefined,
      minDelayMs: cfg.minDelayMs,
    });
    if (!r.ok) return { resumed: false, reason: r.error };
    return { resumed: true, mode: cfg.mode || 'p2p' };
  } catch (err) {
    return { resumed: false, reason: err.message };
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MIN_DELAY_MS = 0;            // No inter-batch delay — snapshot → test → next snapshot is immediate
const SLEEP_TICK_MS = 1_000;       // Interruptible-sleep check interval
const SAFETY_MAX_ITERATIONS = 100_000; // Absolute loop-iteration ceiling

// ─── Internal State ───────────────────────────────────────────────────────────

const _emitter = new EventEmitter();
_emitter.setMaxListeners(50);

function _emitScoped(name, payload) {
  _emitter.emit(name, { ...(payload || {}) });
}

const _ctrl = {
  running: false,
  stopRequested: false,
  iteration: 0,
  mode: null,
  planId: null,
  minDelayMs: MIN_DELAY_MS,
  subscriptionGranter: null,
  startedAt: null,
  lastError: null,
  // ─── Pause / Resume ───────────────────────────────────────────────────────
  paused: false,
  pausedBatch: null, // { batchId, mode, planId, subscriptionId, subscriptionGranter, frozenNodes, testedAddrs }
  resumeIntent: null, // { batchId, frozenNodes, testedAddrs } — set by resume(), consumed by _runLoop
  // The pipeline state object for the currently in-flight pass. Held so pause()/stop()
  // can raise its stopRequested flag and abort the running runAudit/runSubPlanTest sweep
  // promptly, instead of letting the whole pass (and its payments) finish first.
  loopState: null,
};

// Injected pipeline runner (overridable in tests)
let _runnerFn = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sleep for `ms` milliseconds but check `_ctrl.stopRequested` every SLEEP_TICK_MS.
 * Returns true if interrupted early, false if the full duration elapsed.
 *
 * @param {number} ms
 * @returns {Promise<boolean>} true if stopped early
 */
async function sleepInterruptible(ms) {
  // Always yield at least one turn so a stop() from another task has a chance
  // to set stopRequested before the next iteration starts, even when ms=0.
  await sleep(0);
  if (_ctrl.stopRequested) return true;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (_ctrl.stopRequested) return true;
    const remaining = end - Date.now();
    await sleep(Math.min(SLEEP_TICK_MS, remaining > 0 ? remaining : 0));
  }
  return _ctrl.stopRequested;
}

/**
 * Verify that a fee-grant allowance is active for subscription mode.
 * Uses `queryFeeGrant` from core/chain.js.
 *
 * @param {string} granterAddr   - Plan owner's sent1... address
 * @param {string} granteeAddr   - Tester wallet's sent1... address
 * @returns {Promise<void>} Throws if no active allowance found.
 */
async function verifyFeeGrant(granterAddr, granteeAddr) {
  const { queryFeeGrantRpcFirst, withFreshRpc, ensureLcd } = await import('../core/chain.js');
  const lcd = await ensureLcd();
  const grant = await withFreshRpc(
    (client) => queryFeeGrantRpcFirst(client, lcd, granterAddr, granteeAddr),
    'verifyFeeGrant',
  );
  if (!grant) {
    throw new Error(
      `Provider ${granterAddr} is not listed or its signed metadata does not verify (tester ${granteeAddr}). ` +
      'Subscription mode needs a live provider to issue access tickets.',
    );
  }
}

// ─── Batch State ──────────────────────────────────────────────────────────────

/** Incremented each time a new batch starts. Module-scoped for export via status(). */
let _batchId = 0;

/**
 * Build a sanitized `batch:node:result` payload from a raw pipeline result.
 * Strips wallet, SDK, OS, baseline, inPlan, diag fields — public-safe only.
 *
 * @param {object} result - Raw pipeline result object
 * @param {number} batchId
 * @returns {object}
 */
function _sanitizeBatchNodeResult(result, batchId) {
  return {
    batchId,
    address:     result.address   || '',
    moniker:     result.moniker   || null,
    country:     result.country   || null,
    countryCode: result.countryCode || null,
    city:        result.city      || null,
    // Renamed from `type` to avoid clobbering the SSE dispatch type in broadcast().
    serviceType: result.type      || null,
    actualMbps:  result.actualMbps ?? null,
    baselineMbps: result.baselineAtTest ?? null,
    peers:       result.peers     ?? null,
    maxPeers:    result.maxPeers  ?? null,
    error:       result.error     ? String(result.error).slice(0, 200) : null,
    errorCode:   result.errorCode || null,
    testedAt:    Date.now(),
  };
}

// Map a persisted batch_results row (snake_case) back into the camelCase result
// shape the in-memory results array and /live snapshot expect. Used only by the
// cross-process resume seed (see the resume-intent branch in _runLoop).
function _batchRowToResult(row) {
  return {
    address:        row.node_address,
    moniker:        row.moniker || '',
    country:        row.country || '',
    countryCode:    row.country_code || '',
    city:           row.city || '',
    type:           row.type || null,
    actualMbps:     row.actual_mbps,
    baselineAtTest: row.baseline_mbps,
    peers:          row.peers,
    maxPeers:       row.max_peers,
    error:          row.error || null,
    errorCode:      row.error_code || null,
    skipped:        row.error_code === 'TEST_RUN_SKIP',
    testedAt:       row.tested_at,
  };
}

// ─── Core Loop ────────────────────────────────────────────────────────────────

/**
 * Run one audit pass (p2p or subscription) and return summary counts.
 * During the pass, each node result is captured and emitted as `batch:node:result`
 * and persisted to the `batch_results` DB table.
 *
 * @param {object} loopState - Pipeline state object (created fresh per iteration)
 * @param {number} batchId   - Current batch DB id
 * @param {Array|null} frozenNodes - Pre-resolved node snapshot; p2p runAudit uses it instead of re-querying
 * @returns {Promise<{ passed: number, failed: number }>}
 */
async function _runOnePass(loopState, batchId, frozenNodes = null, resume = false) {
  // Build a broadcast intercept that captures 'result' events for batch tracking.
  // All other broadcast types (log, state) are silently dropped (noop) —
  // the continuous loop emits its own high-level events instead.
  let _dbModule = null;
  const _getDb = async () => {
    if (!_dbModule && !_runnerFn) {
      try { _dbModule = await import('../core/db.js'); }
      catch (err) { console.error(`[continuous] db.js import failed: ${err.message}`); }
    }
    return _dbModule;
  };

  function batchBroadcast(type, data) {
    // Forward live log lines + state snapshots through the scoped emitter so
    // the admin dashboard AND /live (when broadcastLive=true) see real-time
    // activity during continuous-loop runs — not just batch checkpoints.
    if (type === 'log') {
      _emitScoped('log', data || {});
      return;
    }
    if (type === 'state') {
      _emitScoped('state', data || {});
      return;
    }
    if (type === 'progress') {
      _emitScoped('progress', data || {});
      return;
    }
    if (type !== 'result') return; // only care about per-node results
    const raw = data?.result;
    if (!raw) return;
    // Forward the full per-node result to the global stream so the live
    // dashboard upserts rows identically to admin. Public SSE will sanitize.
    _emitScoped('result', { result: raw, batchId });
    const payload = _sanitizeBatchNodeResult(raw, batchId);
    _emitScoped('batch:node:result', payload);
    // ETA staleness fix: the pipeline only emits a per-node `state` event on
    // SUCCESS (it gates that broadcast on actualMbps != null — pipeline.js:978),
    // and batchBroadcast forwards that success `state` via the type==='state'
    // branch above. During a failing streak no `state` reaches the bus and the
    // server's windowed ETA (etaRemainingMs) never refreshes — clients tick
    // their anchor down to 0 and sit there. So forward the loop's current state
    // (carried on the result payload, with up-to-date counters) as a lightweight
    // `state` event ONLY for nodes the pipeline skipped its state emit on
    // (actualMbps == null: failures + skips). Successful nodes already got their
    // state above; emitting again here would double every success frame. Net:
    // exactly one `state` per completed node, pass/fail alike — and the server
    // recomputes etaRemainingMs each time. No new fields, no public-payload bloat.
    if (data.state && typeof data.state === 'object' && raw.actualMbps == null) {
      _emitScoped('state', { state: data.state });
    }
    // Persist to batch_results (non-blocking, non-fatal). Guard on batchId > 0:
    // if insertBatch failed upstream (logged, non-fatal) currentBatchId stays 0,
    // and writing insertBatchResult(0, …) would violate the FK to a non-existent
    // batch row (foreign_keys=ON) and spam errors for every node in the pass.
    if (batchId > 0) {
      _getDb().then(db => {
        if (db) {
          try { db.insertBatchResult(batchId, payload); }
          catch (err) { console.error(`[continuous] insertBatchResult failed (batch ${batchId}, ${payload?.address}): ${err.message}`); }
        }
      }).catch(err => console.error(`[continuous] _getDb failed (batch ${batchId}): ${err?.message || err}`));
    }
  }

  // Use injected mock runner if provided (test path), otherwise resolve real pipeline.
  // ES module imports are cached by Node so repeated imports are near-zero cost.
  let runner = _runnerFn;
  if (!runner) {
    const pipeline = await import('./pipeline.js');
    runner = _ctrl.mode === 'subscription'
      ? (st) => pipeline.runSubPlanTest(
          _ctrl.planId,
          _ctrl.subscriptionId,
          _ctrl.subscriptionGranter,
          st,
          batchBroadcast,
          // On resume, opts.resume=true keeps the sub-plan run from resetting
          // counters/startedAt and makes its totalNodes math include the already-
          // tested nodes instead of just the remainder.
          { resume },
        )
      : (st) => {
          // The continuous loop persists per-node to batch_results separately;
          // null this loop-state's run dir + db id so runAudit's results-table /
          // run-dir writes stay out of the runs/results tables. `st` is the loop's
          // own createState() instance, isolated from any direct run's state —
          // no restore needed (nothing else reads these fields off loopState).
          st.activeDbRunId = null;
          st.activeRunDir = null;
          // resume=true on the resume-intent pass: pipeline preserves the
          // in-memory results array (no wipe) and sets totalNodes =
          // results.length + remaining, so getResults() — which /live's snapshot
          // mirrors — reflects the FULL batch, not just the post-resume tail.
          return pipeline.runAudit(resume, st, batchBroadcast, frozenNodes, {
            testRun:     !!_ctrl.testRun,
            pricingMode: _ctrl.pricingMode || null,
          });
        };
  }

  await runner(loopState);

  // Count outcomes from pipeline state
  const passed = loopState.testedNodes || 0;
  const failed  = loopState.failedNodes  || 0;
  return { passed, failed };
}

/**
 * Resolve the node snapshot for this batch. Returns the frozen array plus its
 * address list for persistence. Throws on failure so the caller can skip the
 * iteration rather than testing an empty/partial set.
 *
 * @returns {Promise<{ nodes: Array, addresses: string[] }>}
 */
async function _resolveSnapshot() {
  const { getAllNodes, ensureLcd } = await import('../core/chain.js');
  await ensureLcd();
  const nodes = await getAllNodes(() => {});
  if (!Array.isArray(nodes)) throw new Error('getAllNodes returned non-array');
  const addresses = nodes.map(n => n?.address).filter(Boolean);
  return { nodes, addresses };
}

/**
 * Main loop body — runs until stopRequested or unrecoverable error.
 */
async function _runLoop() {
  // _ctrl.running is set synchronously in start() before this is fire-and-forget
  // invoked, so a second start() call cannot race past the `if (_ctrl.running)`
  // guard while we're still on the microtask queue.
  _ctrl.stopRequested = false;
  _ctrl.startedAt = Date.now();
  _ctrl.iteration = 0;
  _persistLoopConfig();

  let stopReason = 'requested';

  try {
    while (!_ctrl.stopRequested) {
      // Absolute ceiling: no real operator wants 100K iterations; if we hit
      // this, the sleep/yield logic has failed and we must bail.
      if (_ctrl.iteration >= SAFETY_MAX_ITERATIONS) {
        stopReason = 'safety-max-iterations';
        _ctrl.lastError = `continuous loop exceeded ${SAFETY_MAX_ITERATIONS} iterations — aborting`;
        break;
      }

      _ctrl.iteration += 1;
      const iterStart = Date.now();

      _emitScoped('iteration:start', {
        iteration: _ctrl.iteration,
        mode: _ctrl.mode,
      });

      // Fresh pipeline state per iteration so counters reset cleanly.
      // Inherit SDK / pricingMode / runMode from _ctrl so per-node failure
      // rows record the correct sdk and pipeline branches the right way —
      // without this, every continuous-loop result fell back to sdk:'js'.
      const loopState = createState();
      loopState.stopRequested = false;
      // Expose the in-flight state so pause()/stop() can abort the running pipeline.
      _ctrl.loopState = loopState;
      if (_ctrl.activeSDK)   loopState.activeSDK   = _ctrl.activeSDK;
      if (_ctrl.pricingMode) loopState.pricingMode = _ctrl.pricingMode;
      loopState.runMode             = _ctrl.mode || 'p2p';
      loopState.runPlanId           = _ctrl.planId || null;
      loopState.runSubscriptionId   = _ctrl.subscriptionId || null;
      loopState.runGranter          = _ctrl.subscriptionGranter || null;
      loopState.testRun             = !!_ctrl.testRun;

      let currentBatchId = 0;
      let frozenNodes = null;
      let passed = 0;
      let failed = 0;
      let iterErr = null;

      // ─── Resume Intent: reuse a paused batch instead of opening a new one ─
      if (_ctrl.resumeIntent) {
        const intent = _ctrl.resumeIntent;
        _ctrl.resumeIntent = null;
        currentBatchId = intent.batchId;
        _batchId = currentBatchId;

        // Build filtered node list — exclude already-tested addresses.
        const testedSet = new Set(intent.testedAddrs || []);
        const allNodes = intent.frozenNodes || [];
        const viableNodes = allNodes.filter(n => n?.address && !testedSet.has(n.address));
        frozenNodes = viableNodes;

        // Cross-process resume: after a server restart the in-memory results
        // array is empty, but the reused batch already has its tested nodes in
        // batch_results. Re-seed them so getResults() — the sole source for
        // /live's snapshot — and the pipeline's resume totalNodes math reflect
        // the FULL batch, not just the remainder we're about to test. No-op in
        // the same-process case (the array still holds them) and under an
        // injected runner (test path persists nothing).
        if (!_runnerFn) {
          try {
            const pipeline = await import('./pipeline.js');
            if (pipeline.getResults().length === 0 && currentBatchId > 0) {
              const { getBatchResults } = await import('../core/db.js');
              const { results: priorRows } = getBatchResults(currentBatchId, { limit: 100000 }, 'real');
              const restored = pipeline.seedResults((priorRows || []).map(_batchRowToResult));
              if (restored > 0) {
                _emitScoped('log', { msg: `↩ Resume: restored ${restored} already-tested node(s) from batch ${currentBatchId}` });
              }
            }
          } catch (err) {
            console.error(`[continuous] resume seed failed (batch ${currentBatchId}): ${err.message}`);
          }
        }

        _emitScoped('batch:start', {
          batchId:      currentBatchId,
          // Full batch size (tested + remaining), not just the remainder — so
          // /live's "X / Y" denominator shows the whole batch on resume.
          snapshotSize: allNodes.length || viableNodes.length,
          mode:         _ctrl.mode,
          startedAt:    iterStart,
          iteration:    _ctrl.iteration,
          resumed:      true,
        });

        try {
          // resume=true: preserve the in-memory results (seeded above) and make
          // the pipeline's totalNodes include the already-tested nodes.
          ({ passed, failed } = await _runOnePass(loopState, currentBatchId, frozenNodes, true));
        } catch (err) {
          iterErr = err;
          _ctrl.lastError = err.message || String(err);
          _emitScoped('loop:error', { error: _ctrl.lastError, iteration: _ctrl.iteration });
        }

        // ─── Post-pipeline pause detection (resume path) ─────────────────
        if (_ctrl.paused) {
          let testedAddrs = [];
          if (!_runnerFn) {
            try {
              const { getDb } = await import('../core/db.js');
              const scoped = getDb('real');
              const rows = scoped.prepare('SELECT node_address FROM batch_results WHERE batch_id = ?').all(currentBatchId);
              testedAddrs = rows.map(r => r.node_address).filter(Boolean);
            } catch (err) {
              console.error(`[continuous] tested-addrs query failed (batch ${currentBatchId}): ${err.message}`);
            }
          }
          _ctrl.pausedBatch = {
            batchId:              currentBatchId,
            mode:                 _ctrl.mode,
            planId:               _ctrl.planId,
            subscriptionId:       _ctrl.subscriptionId,
            subscriptionGranter:  _ctrl.subscriptionGranter,
            frozenNodes:          intent.frozenNodes, // full original snapshot
            testedAddrs,
          };
          _persistLoopConfig();
          _emitScoped('iteration:paused', { batchId: currentBatchId, testedCount: testedAddrs.length });
          stopReason = 'paused';
          break;
        }

      } else {
        // ─── Normal path: open new run + batch records ───────────────────

        // ─── Batch: resolve frozen snapshot + open a batch record ──────
        let snapshotSize = 0;
        let snapshotAddresses = null;

        if (!_runnerFn && _ctrl.mode !== 'subscription') {
          try {
            const snap = await _resolveSnapshot();
            frozenNodes = snap.nodes;
            snapshotAddresses = snap.addresses;
            snapshotSize = snap.nodes.length;
          } catch (snapErr) {
            _ctrl.lastError = `snapshot resolve failed: ${snapErr.message}`;
            _emitScoped('loop:error', { error: _ctrl.lastError, iteration: _ctrl.iteration });
            if (_ctrl.stopRequested) { stopReason = 'requested'; break; }
            const delayMs = _delayOverride !== null ? _delayOverride : _ctrl.minDelayMs;
            const interrupted = await sleepInterruptible(Math.max(delayMs, 2000));
            if (interrupted) { stopReason = 'requested'; break; }
            continue;
          }
        }

        if (!_runnerFn) {
          try {
            const { insertBatch } = await import('../core/db.js');
            currentBatchId = insertBatch({
              started_at:         iterStart,
              snapshot_size:      snapshotSize,
              mode:               _ctrl.testRun ? 'test' : (_ctrl.mode || 'p2p'),
              snapshot_addresses: snapshotAddresses,
            }, 'real');
            _batchId = currentBatchId;
          } catch (dbErr) {
            console.error(`[continuous] insertBatch failed: ${dbErr.message}`);
          }
        }

        // ─── Pre-pipeline: seed pausedBatch so status() returns batchId even
        //     while the pipeline is still running and paused=true is already set.
        //     testedAddrs starts empty; the post-pipeline block updates it.
        _ctrl.pausedBatch = {
          batchId:              currentBatchId,
          mode:                 _ctrl.mode,
          planId:               _ctrl.planId,
          subscriptionId:       _ctrl.subscriptionId,
          subscriptionGranter:  _ctrl.subscriptionGranter,
          frozenNodes:          frozenNodes,
          testedAddrs:          [],
        };

        _emitScoped('batch:start', {
          batchId:      currentBatchId,
          snapshotSize,
          mode:         _ctrl.mode,
          startedAt:    iterStart,
          iteration:    _ctrl.iteration,
        });

        try {
          ({ passed, failed } = await _runOnePass(loopState, currentBatchId, frozenNodes));
        } catch (err) {
          iterErr = err;
          _ctrl.lastError = err.message || String(err);
          _emitScoped('loop:error', { error: _ctrl.lastError, iteration: _ctrl.iteration });
        }

        // ─── Post-pipeline pause detection (normal path) ─────────────────
        if (_ctrl.paused) {
          let testedAddrs = [];
          if (!_runnerFn) {
            try {
              const { getDb } = await import('../core/db.js');
              const scoped = getDb('real');
              const rows = scoped.prepare('SELECT node_address FROM batch_results WHERE batch_id = ?').all(currentBatchId);
              testedAddrs = rows.map(r => r.node_address).filter(Boolean);
            } catch (err) {
              console.error(`[continuous] tested-addrs query failed (batch ${currentBatchId}): ${err.message}`);
            }
          }
          // Update testedAddrs now that the pipeline has settled; batchId + rest
          // were already seeded above so status() returned the correct batchId
          // even while the pipeline was in-flight.
          _ctrl.pausedBatch = {
            batchId:              currentBatchId,
            mode:                 _ctrl.mode,
            planId:               _ctrl.planId,
            subscriptionId:       _ctrl.subscriptionId,
            subscriptionGranter:  _ctrl.subscriptionGranter,
            frozenNodes:          frozenNodes,
            testedAddrs,
          };
          _persistLoopConfig();
          _emitScoped('iteration:paused', { batchId: currentBatchId, testedCount: testedAddrs.length });
          stopReason = 'paused';
          break;
        }

        // Not paused — clear the pre-pipeline seed so stale paused-state is
        // never left on a successfully completed (non-paused) iteration.
        _ctrl.pausedBatch = null;

      } // end normal-path else

      const durationMs = Date.now() - iterStart;

      // ─── Batch: close the batch record ──────────────────────────────────
      if (!_runnerFn && currentBatchId > 0) {
        try {
          const { updateBatchOnFinish } = await import('../core/db.js');
          updateBatchOnFinish(currentBatchId, {
            finished_at: Date.now(),
            passed,
            failed,
          }, 'real');

          // Bound batch_results growth: every iteration re-tests every node and
          // writes a full row set, so the table grows unbounded without pruning.
          // This is the safe spot — the just-finished batch is now the
          // last-finished (kept), and the next iteration's batch hasn't started,
          // so nothing in-flight is at risk. Pruning is housekeeping: a failure
          // must NOT abort the audit, so it gets its own try/catch.
          try {
            const { pruneBatchResults } = await import('../core/db.js');
            const { DEFAULT_BATCH_RETENTION } = await import('../core/constants.js');
            pruneBatchResults({ keepBatches: DEFAULT_BATCH_RETENTION }, 'real');
          } catch (e) {
            console.error('[continuous] batch_results prune failed:', e.message);
          }
        } catch (dbErr) {
          console.error(`[continuous] updateBatchOnFinish failed: ${dbErr.message}`);
        }
      }

      _emitScoped('batch:end', {
        batchId:   currentBatchId,
        passed,
        failed,
        durationMs,
        iteration: _ctrl.iteration,
      });

      _emitScoped('iteration:end', {
        iteration: _ctrl.iteration,
        mode: _ctrl.mode,
        durationMs,
        passed,
        failed,
        error: iterErr ? iterErr.message : null,
      });

      // Honor stop request that arrived during the pass
      if (_ctrl.stopRequested) {
        stopReason = 'requested';
        break;
      }

      // Interruptible delay before the next iteration
      const delayMs = _delayOverride !== null ? _delayOverride : _ctrl.minDelayMs;
      const nextBatchAt = Date.now() + delayMs;

      _emitScoped('batch:gap', {
        gapMs:       delayMs,
        nextBatchAt,
        iteration:   _ctrl.iteration,
      });

      const interrupted = await sleepInterruptible(delayMs);
      if (interrupted) {
        stopReason = 'requested';
        break;
      }
    }
  } catch (outerErr) {
    stopReason = 'error';
    _ctrl.lastError = outerErr.message || String(outerErr);
    _emitScoped('loop:error', {
      error: _ctrl.lastError,
      iteration: _ctrl.iteration,
    });
  } finally {
    _ctrl.running = false;
    _ctrl.stopRequested = false;
    _ctrl.loopState = null; // no in-flight pass anymore
    _persistLoopConfig();
    _emitScoped('loop:stopped', {
      iterations: _ctrl.iteration,
      reason: stopReason,
    });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the continuous loop.
 *
 * @param {{
 *   mode?: 'p2p' | 'subscription',
 *   planId?: string,
 *   subscriptionId?: string,
 *   minDelayMs?: number,
 *   subscriptionGranter?: string,
 * }} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function start(opts = {}) {
  if (_ctrl.running) {
    return { ok: false, error: 'Loop already running' };
  }
  if (_ctrl.paused) {
    return { ok: false, error: 'paused — call resume() instead' };
  }

  const mode = opts.mode || 'p2p';

  // ─── Validate mode ────────────────────────────────────────────────────────
  if (mode !== 'p2p' && mode !== 'subscription') {
    return { ok: false, error: `Invalid mode "${mode}". Must be "p2p" or "subscription"` };
  }

  // ─── Wallet safety check ──────────────────────────────────────────────────
  // Solana: the tester wallet is the TEST_KEYFILE key file (read live from env so
  // tests can override it). Cosmos read process.env.MNEMONIC here.
  const keyfile = process.env.TEST_KEYFILE;
  if (!keyfile || !keyfile.trim()) {
    return {
      ok: false,
      error: 'TEST_KEYFILE not set in .env — cannot pay sessions',
    };
  }

  // ─── Subscription-mode prerequisites ─────────────────────────────────────
  if (mode === 'subscription') {
    if (!opts.planId) {
      return { ok: false, error: 'planId required for subscription mode' };
    }
    if (!opts.subscriptionId) {
      return { ok: false, error: 'subscriptionId required for subscription mode' };
    }
    if (!opts.subscriptionGranter) {
      return { ok: false, error: 'subscriptionGranter (Provider PDA of the plan) required for subscription mode' };
    }

    // Verify fee-grant before we spend any tokens
    try {
      const { cachedWalletSetup } = await import('../core/wallet.js');
      const { address } = await cachedWalletSetup();
      await verifyFeeGrant(opts.subscriptionGranter, address);
    } catch (fgErr) {
      return { ok: false, error: `Provider check failed: ${fgErr.message}` };
    }
  }

  // ─── Clamp delay to minimum ───────────────────────────────────────────────
  const minDelayMs = Math.max(
    MIN_DELAY_MS,
    typeof opts.minDelayMs === 'number' ? opts.minDelayMs : MIN_DELAY_MS,
  );

  // ─── Store config ─────────────────────────────────────────────────────────
  _ctrl.mode               = mode;
  _ctrl.planId             = opts.planId || null;
  _ctrl.subscriptionId     = opts.subscriptionId || null;
  _ctrl.subscriptionGranter = opts.subscriptionGranter || null;
  _ctrl.minDelayMs         = minDelayMs;
  _ctrl.lastError          = null;
  _ctrl.iteration          = 0;
  _ctrl.activeSDK          = 'dvpnd'; // Solana: one client (dvpnd)
  _ctrl.pricingMode        = opts.pricingMode || _ctrl.pricingMode || null;
  _ctrl.testRun            = !!opts.testRun;
  // Mark running synchronously BEFORE the fire-and-forget so a second
  // start() call cannot slip through the `if (_ctrl.running)` guard while
  // _runLoop is still on the microtask queue (the C-2 race window).
  _ctrl.running            = true;

  _emitScoped('loop:started', {
    mode,
    minDelayMs,
    iteration: 0,
    planId: _ctrl.planId,
  });

  // Fire-and-forget — loop runs in background
  _runLoop().catch(err => {
    // Should be caught internally, but belt-and-suspenders
    console.error(`[continuous] _runLoop unhandled: ${err.message}`);
  });

  return { ok: true, mode, minDelayMs };
}

/**
 * Request the loop to stop. Returns immediately; loop stops within SLEEP_TICK_MS.
 *
 * @returns {{ ok: boolean }}
 */
export function stop() {
  if (!_ctrl.running) return { ok: true, alreadyStopped: true };
  _ctrl.stopRequested = true;
  // Propagate to the in-flight pipeline so the running runAudit/runSubPlanTest sweep
  // (and its payments) returns promptly instead of completing the whole pass first.
  if (_ctrl.loopState) _ctrl.loopState.stopRequested = true;
  triggerPipelineStop();
  _emitScoped('loop:stopping', {});
  return { ok: true };
}

/**
 * Pause the in-progress batch mid-run. The pipeline's stopRequested flag is
 * raised so the in-flight runAudit returns promptly. _runLoop then captures
 * the already-tested addresses into _ctrl.pausedBatch before breaking out.
 *
 * @returns {{ ok: boolean, error?: string }}
 */
export function pause() {
  if (!_ctrl.running) return { ok: false, error: 'not running' };
  if (_ctrl.paused) return { ok: false, error: 'already paused' };
  // Raise stopRequested so the in-flight pipeline returns.
  _ctrl.stopRequested = true;
  // Propagate to the in-flight pipeline state + wake its stop-aware sleeps so the
  // running sweep aborts promptly, rather than finishing the full pass (and its
  // payments) before the pause takes effect — matching this function's docstring.
  if (_ctrl.loopState) _ctrl.loopState.stopRequested = true;
  triggerPipelineStop();
  // Sentinel for _runLoop: break out without clearing state.
  _ctrl.paused = true;
  _emitScoped('loop:stopping', {});
  return { ok: true };
}

/**
 * Resume a paused batch. Reattaches _ctrl from pausedBatch, sets a
 * resumeIntent so _runLoop skips re-opening a new batch, and re-kicks the loop.
 *
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function resume() {
  if (!_ctrl.paused || !_ctrl.pausedBatch) {
    return { ok: false, error: 'no paused run' };
  }

  const pb = _ctrl.pausedBatch;

  // Restore all loop flags from pausedBatch.
  _ctrl.mode                = pb.mode;
  _ctrl.planId              = pb.planId;
  _ctrl.subscriptionId      = pb.subscriptionId;
  _ctrl.subscriptionGranter = pb.subscriptionGranter;

  // Build the resume intent so _runLoop reuses the existing batch row.
  _ctrl.resumeIntent = {
    batchId:      pb.batchId,
    frozenNodes:  pb.frozenNodes,
    testedAddrs:  pb.testedAddrs || [],
  };

  // Transition back to running state.
  _ctrl.paused        = false;
  _ctrl.pausedBatch   = null;
  _ctrl.stopRequested = false;
  _ctrl.running       = true;

  _persistLoopConfig();

  _emitScoped('iteration:resumed', {
    batchId:   _ctrl.resumeIntent.batchId,
    remaining: (_ctrl.resumeIntent.frozenNodes || []).filter(
      n => !_ctrl.resumeIntent.testedAddrs.includes(n?.address),
    ).length,
  });

  // Re-kick the loop in the background.
  _runLoop().catch(err => {
    console.error(`[continuous] _runLoop (resumed) unhandled: ${err.message}`);
  });

  return { ok: true };
}

/**
 * Current loop status snapshot.
 *
 * @returns {{
 *   running: boolean,
 *   iteration: number,
 *   mode: string|null,
 *   planId: string|null,
 *   minDelayMs: number,
 *   startedAt: number|null,
 *   lastError: string|null,
 *   uptime: number|null,
 *   paused: boolean,
 *   pausedBatchId: number|null,
 * }}
 */
export function status() {
  return {
    running:        _ctrl.running,
    iteration:      _ctrl.iteration,
    mode:           _ctrl.mode,
    planId:         _ctrl.planId,
    minDelayMs:     _ctrl.minDelayMs,
    startedAt:      _ctrl.startedAt,
    lastError:      _ctrl.lastError,
    uptime:         _ctrl.startedAt ? Date.now() - _ctrl.startedAt : null,
    batchId:        _batchId,
    paused:         !!_ctrl.paused,
    pausedBatchId:  _ctrl.pausedBatch?.batchId || null,
  };
}

/**
 * Register an event listener.
 *
 * @param {string} event
 * @param {Function} handler
 * @returns {EventEmitter}
 */
export function on(event, handler) {
  return _emitter.on(event, handler);
}

/**
 * Remove an event listener.
 *
 * @param {string} event
 * @param {Function} handler
 * @returns {EventEmitter}
 */
export function off(event, handler) {
  return _emitter.off(event, handler);
}

// ─── Test Injection (test use only) ──────────────────────────────────────────

/**
 * Replace the pipeline runner with a mock function.
 * MUST be called before start(). Reset to null to restore real pipeline.
 *
 * The injected function receives the loopState object and must return
 * a Promise that resolves when the "pass" is complete. Set
 * `loopState.testedNodes` and `loopState.failedNodes` to control counts.
 *
 * @param {Function|null} fn
 */
export function _injectRunnerFn(fn) {
  _runnerFn = fn;
}

/**
 * Override the inter-pass delay for tests. Pass null to restore production value.
 * Has no effect on the minimum; only the value used in sleepInterruptible() is changed.
 *
 * @param {number|null} ms
 */
export function _setDelayOverride(ms) {
  // Guard: only tests may drop below the production floor. Opening this to
  // prod callers would defeat MIN_DELAY_MS and the insert-rate fuse together.
  if (ms !== null && ms < MIN_DELAY_MS) {
    const isTest = process.env.NODE_ENV === 'test'
      || /\.test\.m?js/.test(process.argv.join(' '));
    if (!isTest) {
      throw new Error(
        `_setDelayOverride(${ms}) refused: sub-floor values are test-only. ` +
        `Set NODE_ENV=test or invoke from a *.test.js process.`
      );
    }
  }
  _delayOverride = ms;
}

// Internal: test-only delay override (bypasses MIN_DELAY_MS for speed)
let _delayOverride = null;
