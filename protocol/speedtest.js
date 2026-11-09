/**
 * Sentinel Node Tester (Solana) — speed test helpers used by the shared code.
 * speedtestDirect() is the tester's own baseline (direct, no tunnel); per-node
 * speed is measured INSIDE the client container (audit/session-runner.js).
 */

import { measureBaseline } from '../lib/speed.js';
import { steadyConfig, measureSteadyBaseline } from '../lib/speed-method.js';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let _steadyBaseline = null;
// Recent fresh steady baselines (Mbps). A reading under half their median means the tester's
// own path or the origin is degraded, not the nodes: on 2026-10-21 a CPU-starved origin gave a
// 51 Mbps baseline (usual 730–970) and every node read low behind it, with no warning.
let _recentBaselines = [];
let _lowStreak = [];
const DEGRADED_RATIO = 0.5;
// Three low readings in a row = the tester's line really changed: accept the new level.
const ACCEPT_AFTER = 3;

/** Forget the cached steady baseline (CLI `speed-test`, tests). */
export function resetSteadyBaseline() {
  _steadyBaseline = null;
}

/** Tests: forget the recent-baseline history too. */
export function resetBaselineHistory() {
  _recentBaselines = [];
  _lowStreak = [];
  _steadyBaseline = null;
}

/**
 * Compares a fresh baseline with the recent ones. Returns null when it is normal, or
 * { medianMbps } when it is under half the median of at least 3 earlier readings.
 */
export function baselineDegraded(mbps, recent) {
  if (!(mbps > 0) || recent.length < 3) return null;
  const sorted = [...recent].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return mbps < median * DEGRADED_RATIO ? { medianMbps: Math.round(median * 100) / 100 } : null;
}

/**
 * Records a fresh steady baseline and decides what to do with it:
 *   'normal'   — keep it (history + cache)
 *   'degraded' — under half the recent median: flag it, do not cache, keep it out of the history
 *   'accepted' — the ACCEPT_AFTER-th low reading in a row: the line changed, the low level is the new normal
 */
export function noteBaseline(mbps) {
  const degraded = baselineDegraded(mbps, _recentBaselines);
  if (!degraded) {
    _lowStreak = [];
    _recentBaselines = [..._recentBaselines, mbps].slice(-10);
    return { action: 'normal' };
  }
  _lowStreak = [..._lowStreak, mbps];
  if (_lowStreak.length >= ACCEPT_AFTER) {
    const streak = _lowStreak;
    _recentBaselines = [...streak];
    _lowStreak = [];
    return { action: 'accepted', medianMbps: degraded.medianMbps, streak };
  }
  return { action: 'degraded', medianMbps: degraded.medianMbps };
}

export async function speedtestDirect() {
  // The baseline must use the node test's method, or a node reading is clipped by a weaker baseline.
  let steady = null;
  try {
    steady = steadyConfig();
  } catch (err) {
    console.warn(`[speed] ${err.message}`);
  }
  if (steady) {
    // The shared pipeline asks for a baseline before EVERY node. A steady baseline moves up to
    // SPEED_BUDGET_MB from our origin (paid egress, and the origin's per-IP daily cap), so a
    // recent one is reused: the tester's own link changes slowly.
    const ttlMs = Math.max(0, Number(process.env.SPEED_BASELINE_TTL_SEC ?? 1800)) * 1000;
    if (_steadyBaseline && Date.now() - _steadyBaseline.at < ttlMs) {
      const ageMin = Math.round((Date.now() - _steadyBaseline.at) / 60_000);
      return { ..._steadyBaseline.result, adaptive: `${_steadyBaseline.result.adaptive} (measured ${ageMin} min ago)`, cached: true };
    }
    try {
      const b = await measureSteadyBaseline(steady);
      const result = { mbps: b.mbps, chunks: b.streams, adaptive: `${b.method}: ${(b.bytes / 1e6).toFixed(0)} MB, ${b.streams} streams in ${b.ms} ms`, bytes: b.bytes, ms: b.ms, method: b.method };
      const verdict = noteBaseline(b.mbps);
      if (verdict.action === 'degraded') {
        // Flag it and do not cache it: the next node re-measures instead of reusing a bad baseline
        // for SPEED_BASELINE_TTL_SEC.
        result.degraded = true;
        result.adaptive += ` ⚠ under half the recent median ${verdict.medianMbps} Mbps: the tester's path or the speed origin is degraded, node readings now may be low`;
        console.warn(`[speed] baseline ${b.mbps} Mbps is under half the recent median ${verdict.medianMbps} Mbps`);
        _steadyBaseline = null;
        return result;
      }
      if (verdict.action === 'accepted') {
        console.warn(`[speed] ${verdict.streak.length} low baselines in a row (${verdict.streak.join(', ')} Mbps): accepted as the new level`);
        result.adaptive += ` (new level accepted after ${verdict.streak.length} low readings in a row; was ${verdict.medianMbps} Mbps)`;
      }
      _steadyBaseline = { at: Date.now(), result };
      return result;
    } catch (err) {
      console.warn(`[speed] ${err.message} — classic baseline used`);
    }
  }
  const r = await measureBaseline(10_000_000);
  return { mbps: r.mbps, chunks: 1, adaptive: `${(r.bytes / 1e6).toFixed(0)} MB in ${r.ms} ms`, bytes: r.bytes, ms: r.ms };
}

export async function resolveCfHost() {
  return null;
}

export async function checkGoogleDirect() {
  return { googleAccessible: null, googleLatencyMs: null };
}
