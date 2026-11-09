#!/usr/bin/env node
// ─── Bandwidth-lab origin: HTTPS server for truth-checked speed tests ───
// Serves per-test unpredictable bytes (lib/speed-content.js) and logs, per request, the
// bytes it really put on the socket and how long that took — the origin side of the truth.
//
//   LAB_SECRET=<hex> node scripts/bwlab/origin.mjs --port 8443 --cert c.pem --key k.pem --log origin.jsonl [--lab]
//   Without --lab (a long-lived origin): every request names n ≤ ORIGIN_MAX_REQUEST_BYTES (1e9),
//   and each IP / the whole origin get ORIGIN_DAILY_BYTES_PER_IP (10e9) / ORIGIN_DAILY_BYTES (30e9, ≈ $3.6 of cloud egress) a day.
//
//   GET /d/<any>.bin?s=<seed>&n=<bytes>   content bytes (n omitted = stream until the client stops)
//   GET /p                                  204, for latency probes
// Paths look like ordinary assets on purpose: a node should not be able to spot a speed test.
import https from 'node:https';
import { readFileSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { contentChunks } from '../../lib/speed-content.js';
import { createEgressGuard } from '../../lib/egress-guard.js';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const PORT = Number(opt('--port', '8443'));
const LOG = opt('--log', 'origin.jsonl');
const SECRET = process.env.LAB_SECRET;
// ─── Egress guard (lib/egress-guard.js) ───
// Every request must name its size (n). It is reserved up front against a per-IP and a global
// daily allowance and settled to the bytes really sent when it ends; past either allowance the
// origin answers 429. `--lab` lifts the guard (lab VMs, short-lived).
const LAB = args.includes('--lab');
const MAX_BYTES = LAB ? 4 * 1024 ** 3 : Number(process.env.ORIGIN_MAX_REQUEST_BYTES || 1e9);
const DAY_PER_IP = Number(process.env.ORIGIN_DAILY_BYTES_PER_IP || 10e9);
const DAY_TOTAL = Number(process.env.ORIGIN_DAILY_BYTES || 30e9);
const LOG_MAX_BYTES = 50 * 1024 ** 2;
if (!SECRET || SECRET.trim().length < 32) throw new Error('LAB_SECRET (>= 32 hex chars) is required');

const guard = createEgressGuard({ perIp: DAY_PER_IP, total: DAY_TOTAL });

function record(entry) {
  try {
    // Keep the log bounded on a long-lived origin: one previous file is kept.
    try { if (statSync(LOG).size > LOG_MAX_BYTES) renameSync(LOG, `${LOG}.1`); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    appendFileSync(LOG, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error(`[origin] log write failed: ${err.message}`);
  }
}

const server = https.createServer({ cert: readFileSync(opt('--cert')), key: readFileSync(opt('--key')) }, (req, res) => {
  const t0 = process.hrtime.bigint();
  const url = new URL(req.url, 'https://origin');
  const peer = req.socket.remoteAddress;
  if (url.pathname === '/p') {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const seed = url.searchParams.get('s');
  const nParam = url.searchParams.get('n');
  const n = nParam == null ? Infinity : Number(nParam);
  if (!url.pathname.startsWith('/d/') || !seed || !/^[0-9a-f]{8,64}$/.test(seed) || !((n === Infinity && LAB) || (Number.isInteger(n) && n > 0 && n <= MAX_BYTES))) {
    res.writeHead(404);
    res.end();
    return;
  }
  const reservation = LAB ? null : guard.reserve(peer, n);
  if (!LAB && !reservation) {
    record({ ts: new Date().toISOString(), seed, peer, requested: n, end: 'refused-daily-cap' });
    res.writeHead(429, { 'Retry-After': '3600' });
    res.end();
    return;
  }
  const startWritten = req.socket.bytesWritten;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store, no-transform',
    ...(n === Infinity ? {} : { 'Content-Length': String(n) }),
  });
  const gen = contentChunks(SECRET, seed, n);
  let body = 0;
  let closed = false;
  const finish = (how) => {
    if (closed) return;
    closed = true;
    const sent = req.socket.bytesWritten - startWritten;
    guard.settle(reservation, sent);
    record({
      ts: new Date().toISOString(), seed, peer, requested: n === Infinity ? null : n, bodyBytes: body,
      socketBytes: sent, ms: Number(process.hrtime.bigint() - t0) / 1e6, end: how,
    });
  };
  const pump = () => {
    for (;;) {
      const { value, done } = gen.next();
      if (done) { res.end(() => finish('complete')); return; }
      body += value.length;
      if (!res.write(value)) { res.once('drain', pump); return; }
    }
  };
  res.on('close', () => finish(res.writableFinished ? 'complete' : 'client-closed'));
  pump();
});
server.keepAliveTimeout = 5_000;
server.listen(PORT, '0.0.0.0', () => console.log(`[origin] https on :${PORT}, log ${LOG}`));
