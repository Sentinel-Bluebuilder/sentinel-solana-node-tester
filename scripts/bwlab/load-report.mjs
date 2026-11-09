#!/usr/bin/env node
// ─── Load lab report: knee, cut point, limits, fairness (docs/LOAD-TEST-PLAN.md) ───
//   node scripts/bwlab/load-report.mjs --load test/bwlab/<date>/load.jsonl [--sampler sampler.jsonl …] [--out report.md]
// Everything is computed from the raw lines, so rerunning gives the same file.
//   - A stream10 user keeps up in a step when ≥ 95 % of its chunks that started in the step
//     finished within the chunk period (the player would not stall).
//   - Knee = the largest user count where ≥ 95 % of stream10 users kept up, p95 loaded RTT <
//     idle + 100 ms (idle = step 1's median), and no user failed. null = even step 1 failed.
//   - Cut point = the smallest user count where the tester's own reading was < 10 Mbps (or
//     the test failed). null = never cut.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const med = (xs) => pct(xs, 50);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/** Per-step metrics for one load run (one JSON line of load.mjs) + sampler lines for its node. */
export function stepMetrics(run, samples = [], { period = 4, sla = 10 } = {}) {
  const out = [];
  for (const st of run.steps) {
    const inStep = (t) => t != null && t >= st.start && t < st.end;
    const users = run.users.filter((u) => u.connectedAt && u.connectedAt < st.end);
    const stream = [];
    const chunkMbps = [];
    const rtts = [];
    let failed = 0;
    for (const u of users) {
      const f = u.load.fetches.filter((x) => inStep(x.at));
      if (u.profile === 'stream10') {
        const chunks = f.filter((x) => x.kind === 'chunk');
        if (chunks.length) {
          const onTime = chunks.filter((c) => c.code === '200' && c.seconds > 0 && c.seconds <= period).length;
          stream.push(onTime / chunks.length);
          for (const c of chunks) if (c.code === '200' && c.seconds > 0) chunkMbps.push((c.bytes * 8) / c.seconds / 1e6);
        }
      }
      for (const p of u.load.probes) if (inStep(p.at) && p.rttMs != null) rtts.push(p.rttMs);
      if (u.error && (!u.load.end || u.load.end.at == null || u.load.end.at < st.end)) failed++;
    }
    const s = samples.filter((x) => inStep(x.ts));
    const procCpu = {};
    for (const x of s) for (const [k, v] of Object.entries(x.procs || {})) (procCpu[k] ??= []).push(v.cpu);
    out.push({
      n: st.n, live: st.live,
      streamUsers: stream.length,
      keptUp: stream.length ? r1((100 * stream.filter((x) => x >= 0.95).length) / stream.length) : null,
      chunkMbpsP10: r1(pct(chunkMbps, 10)), chunkMbpsMedian: r1(med(chunkMbps)),
      rttMedianMs: r1(med(rtts)), rttP95Ms: r1(pct(rtts, 95)),
      failed,
      tester: st.tester ? { mbps: st.tester.mbps ?? null, verified: st.tester.verified ?? null, error: st.tester.errorCode || st.tester.error || null, cut: !(st.tester.mbps >= sla) } : null,
      node: s.length ? {
        cpuBusyP95: r1(pct(s.map((x) => x.cpu?.busy ?? 0), 95)),
        hottestCoreP95: r1(pct(s.map((x) => Math.max(0, ...Object.values(x.cores || {}).map((c) => c.busy))), 95)),
        softirqP95: r1(pct(s.map((x) => x.cpu?.softirq ?? 0), 95)),
        procCpuP95: Object.fromEntries(Object.entries(procCpu).map(([k, v]) => [k, r1(pct(v, 95))])),
        memAvailMinMB: Math.round(Math.min(...s.map((x) => x.memAvail ?? Infinity)) / 1e6),
        conntrackMax: Math.max(...s.map((x) => x.conntrack ?? 0)),
        txMbpsMedian: r1(med(s.map((x) => ((x.nic?.tx_bytes || 0) * 8) / 1e6))),
        dropsMax: Math.max(...s.map((x) => (x.nic?.rx_dropped || 0) + (x.nic?.tx_dropped || 0))),
      } : null,
    });
  }
  return out;
}

/** Knee and cut point from stepMetrics(). */
export function kneeAndCut(metrics) {
  const idle = metrics[0]?.rttMedianMs;
  const ok = (m) => m.failed === 0 && (m.keptUp == null || m.keptUp >= 95) && (idle == null || m.rttP95Ms == null || m.rttP95Ms < idle + 100);
  let knee = null;
  for (const m of metrics) { if (ok(m)) knee = m.n; else break; }
  const cutStep = metrics.find((m) => m.tester && m.tester.cut);
  const cut = cutStep ? cutStep.n : null;
  let verdict;
  if (cut == null) verdict = knee == null ? 'users suffered from the first step and the tester never cut the node: unfair to users' : 'never cut within the steps tested';
  else if (knee == null || cut > knee) verdict = 'cut AFTER users already suffered: unfair to users';
  else if (cut < knee) verdict = 'cut BEFORE users suffered: unfair to the operator';
  else verdict = 'cut at the knee: fair';
  return { knee, cut, idleRttMs: idle ?? null, verdict };
}

function main() {
  const args = process.argv.slice(2);
  const opts = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
  const loads = opts('--load');
  if (!loads.length) { console.error('usage: load-report.mjs --load load.jsonl [--sampler s.jsonl …] [--out report.md]'); process.exit(2); }
  const samples = opts('--sampler').flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const runs = loads.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const lines = ['# Load lab report', '', `Generated from ${loads.join(', ')}${samples.length ? ` + ${samples.length} sampler lines` : ''}.`, ''];
  for (const run of runs) {
    const m = stepMetrics(run, samples);
    const kc = kneeAndCut(m);
    lines.push(`## ${run.protocol} — ${run.label || run.node.slice(0, 8)} (${run.pricing}, ${run.profile}, ${run.ts})`, '',
      `Knee **${kc.knee ?? 'none'}** users · tester cut at **${kc.cut ?? 'never'}** · idle RTT ${kc.idleRttMs ?? '?'} ms · ${kc.verdict}`, '',
      '| users | live | stream kept up % | chunk Mbps p10 / median | RTT median / p95 ms | failed | tester Mbps | node CPU p95 % | hottest core p95 % | softirq p95 % | top process CPU p95 | mem free MB | conntrack | node tx Mbps |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const x of m) {
      const top = x.node ? Object.entries(x.node.procCpuP95).sort((a, b) => b[1] - a[1])[0] : null;
      lines.push(`| ${x.n} | ${x.live} | ${x.keptUp ?? '–'} | ${x.chunkMbpsP10 ?? '–'} / ${x.chunkMbpsMedian ?? '–'} | ${x.rttMedianMs ?? '–'} / ${x.rttP95Ms ?? '–'} | ${x.failed} | ${x.tester ? (x.tester.mbps ?? x.tester.error) : '–'} | ${x.node?.cpuBusyP95 ?? '–'} | ${x.node?.hottestCoreP95 ?? '–'} | ${x.node?.softirqP95 ?? '–'} | ${top ? `${top[0]} ${top[1]}` : '–'} | ${x.node?.memAvailMinMB ?? '–'} | ${x.node?.conntrackMax ?? '–'} | ${x.node?.txMbpsMedian ?? '–'} |`);
    }
    lines.push('');
  }
  const text = lines.join('\n') + '\n';
  const out = opts('--out')[0];
  if (out) writeFileSync(out, text); else process.stdout.write(text);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
