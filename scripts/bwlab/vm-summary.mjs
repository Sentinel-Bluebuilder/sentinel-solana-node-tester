#!/usr/bin/env node
// ─── Summarise the current run of a tester server: one line per node ───
//   node scripts/bwlab/vm-summary.mjs [baseUrl]
// Reads /api/stats and the run's results.json (full rows incl. diag) — read-only.
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 3001}`;
const headers = process.env.ADMIN_TOKEN ? { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` } : {};
const stats = await (await fetch(`${base}/api/stats`, { headers })).json();
const st = stats.state || stats;
console.log(`run: ${st.status} | tested ${st.testedNodes}/${st.totalNodes} | spent ${st.runSpentBase ?? st.spentBase} base | baseline ${st.baselineMbps ?? '-'} Mbps`);

const file = join('results', 'results.json');
const rows = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
for (const r of Array.isArray(rows) ? rows : (rows.results || [])) {
  const d = r.diag || {};
  const sm = d.speedMethod || {};
  const out = {
    node: String(r.address || '').slice(0, 8),
    svc: r.type ?? r.serviceType ?? d.service,
    pass: r.pass ?? r.ok,
    err: r.errorCode || null,
    mbps: r.actualMbps,
    lat: r.latencyMs,
    steady: sm.method ? { ok: sm.ok, verified: sm.verified, basis: sm.basis, mbps: sm.mbps, line: sm.lineMbps, classic: sm.classicMbps, MB: Math.round((sm.payloadBytes || 0) / 1e6), idle: sm.idleLatency?.medianMs, loaded: sm.loadedLatency?.medianMs, reason: sm.reason || null } : null,
    spent: d.spentBase ?? r.spentBase,
    channel: d.channel || r.channel || null,
    cfg: d.clientConfig ? { esc: d.clientConfig.escrow_base_units, dns: d.clientConfig.dns_backend, ks: d.clientConfig.kill_switch, prepay: d.clientConfig.prepay_bytes } : null,
  };
  if (r.error && !r.pass) out.error = String(r.error).slice(0, 220);
  console.log(JSON.stringify(out));
}
