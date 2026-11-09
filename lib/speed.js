// ─── Tester baseline ─────────────────────────────────────────────────────────
// The tester's own direct download speed, measured before a run from the host,
// against the same endpoint the client containers pull from. A node can never
// score above it, and a tester on a slow link cannot call a node slow — every
// result carries `baselineAtTest` and the pass flags derive from it (same
// rules as the Cosmos tester: 15 Mbps, 10 Mbps, ≥ 50 % of baseline).
import { SPEED_URL_TEMPLATE, BASELINE_MIN_MBPS } from './constants.js';

/**
 * Download sources, tried in order. Cloudflare sizes the body by query; the
 * others are large static files read with an HTTP Range of exactly `bytes`.
 * Cloudflare rate-limits (HTTP 429) after many runs from one IP, so a single
 * source would turn a rate limit into "node carried no traffic".
 */
export function speedSources(bytes) {
  const extra = (process.env.SPEED_FALLBACK_URLS || 'https://proof.ovh.net/files/100Mb.dat,http://speedtest.tele2.net/100MB.zip')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return [SPEED_URL_TEMPLATE.replace('{bytes}', String(bytes)), ...extra];
}

export function speedUrl(bytes) {
  return speedSources(bytes)[0];
}

async function downloadOnce(url, bytes, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  let got = 0;
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store', headers: { Range: `bytes=0-${bytes - 1}` } });
    if (!(res.status === 200 || res.status === 206) || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (got >= bytes) { await reader.cancel(); break; }
    }
  } finally {
    clearTimeout(timer);
  }
  const ms = Math.max(1, Date.now() - started);
  if (got < bytes * 0.9) throw new Error(`short download: ${got} of ${bytes} bytes`);
  return { mbps: Math.round(((got * 8) / (ms / 1000) / 1e6) * 100) / 100, bytes: got, ms, url };
}

/** Download `bytes` directly (no tunnel) from the first source that answers. Throws when every source fails. */
export async function measureBaseline(bytes = 10_000_000, { timeoutMs = 60_000 } = {}) {
  const errors = [];
  for (const url of speedSources(bytes)) {
    try {
      return await downloadOnce(url, bytes, timeoutMs);
    } catch (err) {
      errors.push(`${new URL(url).host}: ${err.message}`);
    }
  }
  throw new Error(`every speed source failed (${errors.join('; ')})`);
}

/** Pass flags shared by the pipeline and the unit tests. */
export function scoreResult(actualMbps, baselineMbps) {
  let capped = actualMbps;
  if (capped != null && baselineMbps != null && capped > baselineMbps) capped = Math.round(baselineMbps * 0.97 * 100) / 100;
  const dynamicThreshold = baselineMbps != null ? Math.round(baselineMbps * 0.5 * 100) / 100 : null;
  return {
    actualMbps: capped,
    baselineAtTest: baselineMbps,
    baselineViable: baselineMbps != null && baselineMbps >= BASELINE_MIN_MBPS,
    slaApplicable: baselineMbps != null && baselineMbps >= BASELINE_MIN_MBPS,
    dynamicThreshold,
    passBaseline: capped != null && dynamicThreshold != null && capped >= dynamicThreshold,
    pass15mbps: capped != null && capped >= 15,
    pass10mbps: capped != null && capped >= 10,
    ispBottleneck: capped != null && baselineMbps != null && baselineMbps > 0 && capped / baselineMbps >= 0.85,
  };
}
