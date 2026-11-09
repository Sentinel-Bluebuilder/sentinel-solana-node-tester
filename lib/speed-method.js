// ─── Steady speed method (plan Part D5) ───
// Opt-in replacement for the single 10 MB download. Chosen from the bandwidth lab
// (test/bwlab/2026-10-21/FINDINGS.md, rounds 1–5). What it does:
//   - downloads per-test content from our own origin over pinned TLS, so the bytes are verified;
//   - uses `streams` parallel, time-bounded downloads (4 × 10 s by default);
//   - reports the steady-state median after the slow-start ramp.
// Against known caps of 5–200 Mbit it read a constant 87 % (WireGuard) / 94 % (V2Ray) of the
// wire rate, which is the protocol overhead. The tester's old method drifted from ~90 % to 26 %.
// Inside the client container it runs through the same script the lab measured
// (audit/speed-lab.js LAB_SH); the baseline runs the same method directly from the host.
//
// The DEFAULT method (owner, 2026-10-21). SPEED_METHOD=classic selects the old single
// 10 MB download. Steady needs an origin:
//   SPEED_ORIGIN       https://host[:port] of a scripts/bwlab/origin.mjs instance
//   SPEED_PIN          sha256//<base64 SPKI hash> of its key (curl --pinnedpubkey format)
//   SPEED_SECRET_FILE  file holding the origin's content secret (or SPEED_SECRET)
//   SPEED_STREAMS (4)  SPEED_SECONDS (10)  SPEED_BUDGET_MB (600, total bytes of one test)
// When steady is selected but the origin settings are missing or invalid, steadyConfig throws;
// callers then use the classic method and say so (a tester fault never counts against a node).
import { readFileSync } from 'node:fs';
import { request, Agent } from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import { analyzeLab, parseLab, steadyState } from '../audit/speed-lab.js';
import { expectedSha256, newSeed } from './speed-content.js';

export const STEADY_METHOD_VERSION = 'steady-v1';

/** 'steady' (default) or 'classic'. Throws on any other value, so a typo can't pick a method. */
export function selectedSpeedMethod(env = process.env) {
  const m = String(env.SPEED_METHOD || 'steady').trim().toLowerCase();
  if (m !== 'steady' && m !== 'classic') throw new Error(`SPEED_METHOD must be "steady" or "classic", got "${env.SPEED_METHOD}"`);
  return m;
}

/** The steady method's settings; null when SPEED_METHOD=classic. Throws when steady can't run. */
export function steadyConfig(env = process.env) {
  if (selectedSpeedMethod(env) === 'classic') return null;
  const origin = String(env.SPEED_ORIGIN || '').trim().replace(/\/+$/, '');
  const pin = String(env.SPEED_PIN || '').trim();
  let secret = String(env.SPEED_SECRET || '').trim();
  if (!secret && env.SPEED_SECRET_FILE) {
    try {
      secret = readFileSync(env.SPEED_SECRET_FILE, 'utf8').trim();
    } catch (err) {
      throw new Error(`SPEED_SECRET_FILE unreadable: ${err.message}`);
    }
  }
  if (!/^https:\/\/[^/\s]+$/.test(origin) || !/^sha256\/\/[A-Za-z0-9+/=]{43,44}$/.test(pin) || secret.length < 32) {
    throw new Error('the steady speed method needs SPEED_ORIGIN (https://host[:port]), SPEED_PIN (sha256//…) and a secret of ≥ 32 characters (SPEED_SECRET_FILE); set SPEED_METHOD=classic for the old method');
  }
  const int = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
  };
  return {
    origin,
    pin,
    secret,
    streams: int(env.SPEED_STREAMS, 4, 1, 16),
    seconds: int(env.SPEED_SECONDS, 10, 3, 60),
    budgetBytes: int(env.SPEED_BUDGET_MB, 600, 10, 4000) * 1e6,
  };
}

/**
 * Byte cap per stream. A per-GB session must stay well inside its prepay: the node ends the
 * session with "credit exhausted" at the prepay (lab round 1), and its own counter runs a few %
 * above payload. So the whole test (this + the classic 10 MB download) stays under 60 % of it.
 */
export function perStreamCap(cfg, prepayBytes = null) {
  let total = cfg.budgetBytes;
  if (prepayBytes != null && prepayBytes > 0) total = Math.min(total, Math.floor(prepayBytes * 0.6) - 10_000_000);
  return Math.max(1_000_000, Math.floor(total / cfg.streams));
}

/** The `lab` option for runSessionTest that runs the steady method inside the client container. */
export function steadyLab(cfg, { prepayBytes = null } = {}) {
  return {
    origin: cfg.origin,
    pin: cfg.pin,
    plan: `S:${cfg.streams}:${cfg.seconds}:${perStreamCap(cfg, prepayBytes)}`,
    seedBase: newSeed().slice(0, 16),
    idleN: 10,
    noTrace: true,
  };
}

/**
 * Speed figures from the container transcript. `verified` false means the content did not
 * hash to what our origin sent; null figures mean the method could not run (the caller
 * falls back to the classic reading).
 */
export function steadyResult(output, cfg) {
  const lab = parseLab(output);
  const a = analyzeLab(lab, { secret: cfg.secret });
  const m = a.methods.find((x) => x.id === 'S');
  if (!m) return { method: STEADY_METHOD_VERSION, ok: false, reason: lab.started ? 'no steady block in the transcript' : 'the steady block did not run' };
  // A link so fast that the byte budget ran out before two whole windows: the whole transfer
  // (after the first byte) is the only honest figure, and it is a floor, not the capacity.
  const mbps = m.steadyMbps ?? m.transferMbps;
  return {
    method: STEADY_METHOD_VERSION,
    ok: m.verified === true && m.httpOk && mbps != null,
    tamper: m.tamper,
    reason: m.verified === false ? m.tamper : !m.httpOk || m.verified == null ? 'origin request failed' : mbps == null ? 'no steady state' : null,
    basis: m.steadyMbps != null ? 'steady' : 'transfer',
    verified: m.verified,
    mbps,
    // Line rate: the same steady window counted at the container's network interface (eth0), i.e.
    // the tunnel's outer bytes (payload + protocol overhead). On known caps it read 97–100 % of
    // the cap, while `mbps` reads the payload users get (WireGuard ~88 %, V2Ray ~94 %). Null on
    // the transfer basis.
    lineMbps: m.steadyMbps != null ? m.lineMbps : null,
    p90Mbps: m.steadyP90Mbps,
    naiveMbps: m.naiveMbps,
    rampSeconds: m.rampSeconds,
    falling: m.falling,
    streams: m.streams,
    seconds: m.seconds,
    payloadBytes: m.payloadBytes,
    wireBytes: m.wireBytes,
    retrans: m.retrans,
    idleLatency: a.idleLatency,
    loadedLatency: m.loadedLatency,
  };
}

/**
 * Is our origin reachable directly from the tester (pinned key, /p → 204)? Used when the steady
 * download got nothing through a node: reachable here means the node blocked it.
 */
export function originReachable(cfg, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const req = request(`${cfg.origin}/p`, { rejectUnauthorized: false, agent: PIN_AGENT, timeout: timeoutMs }, (res) => {
      const ok = res.statusCode === 204 && pinOk(res.socket, cfg.pin);
      res.resume();
      resolve(ok);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Which method a test would use right now, and why (CLI `speed`, `doctor`).
 * `active` is what runs: 'steady', or 'classic' (selected, or the fallback when steady can't run).
 */
export async function speedMethodStatus(env = process.env, { probe = true } = {}) {
  let selected;
  try {
    selected = selectedSpeedMethod(env);
  } catch (err) {
    return { selected: null, active: 'classic', ready: false, problem: err.message };
  }
  if (selected === 'classic') return { selected, active: 'classic', ready: true, problem: null, version: 'classic-10mb' };
  let cfg;
  try {
    cfg = steadyConfig(env);
  } catch (err) {
    return { selected, active: 'classic', ready: false, problem: `${err.message} — classic method used` };
  }
  const out = {
    selected, active: 'steady', version: STEADY_METHOD_VERSION, origin: cfg.origin, streams: cfg.streams, seconds: cfg.seconds,
    budgetMB: cfg.budgetBytes / 1e6, ready: true, problem: null,
  };
  if (probe) {
    out.originReachable = await originReachable(cfg);
    if (!out.originReachable) {
      out.ready = false;
      out.problem = `origin ${cfg.origin} unreachable or its key does not match SPEED_PIN — node tests record classic figures until it is back`;
    }
  }
  return out;
}

// ─── Baseline: the same method directly from the host ───

// Pinned requests never resume a TLS session: a resumed session carries no server certificate,
// so getPeerCertificate() is empty and every pin check after the first one would fail.
const PIN_AGENT = new Agent({ keepAlive: false, maxCachedSessions: 0 });

/** curl --pinnedpubkey semantics: SHA-256 of the certificate's DER SubjectPublicKeyInfo. */
function pinOk(socket, pin) {
  const raw = socket.getPeerCertificate?.()?.raw;
  if (!raw) return false;
  const spki = new X509Certificate(raw).publicKey.export({ type: 'spki', format: 'der' });
  return `sha256//${createHash('sha256').update(spki).digest('base64')}` === pin;
}

function streamOnce(cfg, seed, capBytes, deadline, onBytes) {
  return new Promise((resolve) => {
    const out = { seed, bytes: 0, hash: createHash('sha256'), status: 0, error: null };
    const left = Math.max(1, deadline - Date.now());
    const req = request(`${cfg.origin}/d/${seed}.bin?s=${seed}&n=${capBytes}`, { rejectUnauthorized: false, agent: PIN_AGENT, timeout: left + 2000 }, (res) => {
      out.status = res.statusCode;
      if (!pinOk(res.socket, cfg.pin)) {
        out.error = 'pin mismatch';
        res.destroy();
        return resolve(out);
      }
      res.on('data', (b) => {
        out.bytes += b.length;
        out.hash.update(b);
        onBytes(b.length);
      });
      res.on('end', () => resolve(out));
      res.on('error', () => resolve(out));
      res.on('close', () => resolve(out));
    });
    req.on('error', (err) => {
      out.error = out.error || err.message;
      resolve(out);
    });
    setTimeout(() => req.destroy(), left).unref();
    req.end();
  });
}

/** Direct (no tunnel) steady-method baseline. Throws when the origin cannot be used. */
export async function measureSteadyBaseline(cfg) {
  const cap = perStreamCap(cfg);
  const base = newSeed().slice(0, 16);
  let total = 0;
  const t0 = performance.now();
  const samples = [{ t: 0, rx: { p: 0 } }];
  const timer = setInterval(() => samples.push({ t: (performance.now() - t0) / 1000, rx: { p: total } }), 100);
  const deadline = Date.now() + cfg.seconds * 1000;
  const streams = await Promise.all(
    Array.from({ length: cfg.streams }, (_, i) => streamOnce(cfg, `${base}b${i + 1}`.replace(/[^0-9a-f]/g, 'b'), cap, deadline, (n) => { total += n; })),
  );
  clearInterval(timer);
  samples.push({ t: (performance.now() - t0) / 1000, rx: { p: total } });
  const bad = streams.find((s) => s.error || !(s.status === 200 || s.status === 206));
  if (bad) throw new Error(`steady baseline: ${bad.error || `HTTP ${bad.status}`}`);
  const verified = streams.every((s) => s.bytes > 0 && s.hash.digest('hex') === expectedSha256(cfg.secret, s.seed, s.bytes));
  if (!verified) throw new Error('steady baseline: content did not verify (wrong secret or a proxy on the tester\'s path)');
  const ss = steadyState(samples, 'p');
  const ms = Math.round(performance.now() - t0);
  const r2 = (x) => Math.round(x * 100) / 100;
  // Budget used up before two whole windows (a very fast link): the whole transfer is the figure.
  if (ss.medianBps == null) {
    if (!(total > 0 && ms > 0)) throw new Error('steady baseline: nothing arrived');
    return { mbps: r2((total * 8) / (ms / 1000) / 1e6), bytes: total, ms, method: STEADY_METHOD_VERSION, streams: cfg.streams, basis: 'transfer', p90Mbps: null };
  }
  return { mbps: r2(ss.medianBps / 1e6), bytes: total, ms, method: STEADY_METHOD_VERSION, streams: cfg.streams, basis: 'steady', p90Mbps: r2(ss.p90Bps / 1e6) };
}
