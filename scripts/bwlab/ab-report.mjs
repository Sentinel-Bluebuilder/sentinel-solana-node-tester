#!/usr/bin/env node
// ─── Client A/B report (Q0429) ───────────────────────────────────────────────
//   node scripts/bwlab/ab-report.mjs <state.json> <label> [<other-state.json> <other-label>]
// Per session: protocol, channel, Mbps, bytes through the tunnel (curl), the client's own
// usage report (rx/tx, spent), whether its final usage sample failed, and the stop outcome.
// With two runs it prints them side by side. The node's own count is read separately on the
// node (`sentinel-dvpn node sessions`, see memory/evidence/1b-s10-chanread-1108.txt).
import { readFileSync } from 'node:fs';

const FINAL_SAMPLE_FAILED = /sampling final session usage failed/i;

export function rows(state) {
  return (state.results || []).map((r) => {
    const d = r.diag || {};
    const log = String(d.clientLog || '');
    return {
      protocol: r.protocol,
      channel: r.channel || null,
      mbps: r.actualMbps,
      tunnelBytes: r.downloadedBytes ?? null,
      clientRx: d.clientRxBytes ?? null,
      clientTx: d.clientTxBytes ?? null,
      spent: r.spentBase ?? null,
      finalSampleFailed: FINAL_SAMPLE_FAILED.test(log),
      stopRc: d.stopRc ?? null,
      routesLeft: d.routesLeft ?? null,
      clientRxAfterStop: d.clientRxAfterStop ?? null,
      error: r.error || null,
    };
  });
}

/** Client rx within 10 % of the bytes curl pulled through the tunnel (headers + TLS add a little). */
export function usageOk(row, rx = row.clientRx) {
  if (!row.tunnelBytes || rx == null) return false;
  return rx >= row.tunnelBytes * 0.9 && rx <= row.tunnelBytes * 1.5;
}

function table(label, list) {
  const out = [`== ${label}`, 'protocol   channel   Mbps     tunnel_B   client_rx  spent  final_sample_failed  stop  routes_left  usage_ok  rx_after_stop  ok_after_stop'];
  for (const r of list) {
    out.push([
      String(r.protocol).padEnd(10), String(r.channel || '-').slice(0, 8).padEnd(9), String(r.mbps).padEnd(8),
      String(r.tunnelBytes).padEnd(10), String(r.clientRx).padEnd(10), String(r.spent).padEnd(6),
      String(r.finalSampleFailed).padEnd(20), String(r.stopRc).padEnd(5), String(r.routesLeft).padEnd(12), (usageOk(r) ? 'yes' : 'NO').padEnd(9),
      String(r.clientRxAfterStop).padEnd(14), r.clientRxAfterStop == null ? '-' : usageOk(r, r.clientRxAfterStop) ? 'yes' : 'NO',
    ].join(' ') + (r.error ? `  ERR ${r.error.slice(0, 120)}` : ''));
  }
  const ok = list.filter(usageOk).length;
  const okAfter = list.filter((r) => r.clientRxAfterStop != null && usageOk(r, r.clientRxAfterStop)).length;
  out.push(`usage right on ${ok} of ${list.length} before stop, ${okAfter} of ${list.length} after stop`);
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('ab-report.mjs')) {
  const [a, la, b, lb] = process.argv.slice(2);
  if (!a || !la) { console.error('usage: ab-report.mjs <state.json> <label> [<state.json> <label>]'); process.exit(2); }
  console.log(table(la, rows(JSON.parse(readFileSync(a, 'utf8')))));
  if (b && lb) console.log('\n' + table(lb, rows(JSON.parse(readFileSync(b, 'utf8')))));
}
