#!/usr/bin/env node
// ─── Bandwidth lab: tables from raw session lines ───
// Every number comes from sessions.jsonl files (scripts/bwlab/session.mjs), so rerunning this
// reproduces the report exactly.
//
//   node scripts/bwlab/report.mjs <sessions.jsonl …> [--prefix R2] [--json] [--reanalyze --secret-file f]
//
// --reanalyze recomputes each session from its raw transcript (when the file is here) with the
// current analyzer, so a method change applies to old data too.
//
// A cell is a label without its trailing "-rN". Per cell and method: n, median, CV (stdev /
// mean), share of streams whose content verified. "best" = the highest median of the verified
// lab methods in that cell; the tester's error is reported against it.
import { readFileSync, existsSync } from 'node:fs';
import { parseLab, analyzeLab } from '../../audit/speed-lab.js';

const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith('--') && !['--prefix', '--secret-file'].includes(args[i - 1]));
const secret = args.includes('--secret-file') ? readFileSync(args[args.indexOf('--secret-file') + 1], 'utf8').trim() : null;
const reanalyze = args.includes('--reanalyze');
const prefix = args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : '';
const asJson = args.includes('--json');

const rows = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .filter((r) => !prefix || String(r.label).startsWith(prefix))
  .map((r) => (reanalyze && r.raw && existsSync(r.raw) ? { ...r, lab: analyzeLab(parseLab(readFileSync(r.raw, 'utf8')), { secret }) } : r));

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const cv = (a) => {
  if (a.length < 2) return null;
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / (a.length - 1));
  return mean > 0 ? sd / mean : null;
};
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

const cells = new Map();
for (const r of rows) {
  const cell = String(r.label).replace(/-r\d+$/, '');
  if (!cells.has(cell)) cells.set(cell, { cell, sessions: 0, errors: [], tester: [], idle: [], methods: new Map() });
  const c = cells.get(cell);
  c.sessions++;
  if (r.error) c.errors.push(r.error.errorCode || r.error.message);
  if (r.tester?.actualMbps != null) c.tester.push(r.tester.actualMbps);
  if (r.lab?.idleLatency?.medianMs != null) c.idle.push(r.lab.idleLatency.medianMs);
  for (const m of r.lab?.methods || []) {
    if (m.id === 'TESTER') continue;
    if (!c.methods.has(m.id)) c.methods.set(m.id, { id: m.id, streams: m.streams, steady: [], naive: [], loaded: [], verified: 0, checked: 0, failed: 0 });
    const x = c.methods.get(m.id);
    if (m.verified != null) { x.checked++; if (m.verified) x.verified++; }
    if (!m.payloadBytes) { x.failed++; continue; }
    if (m.steadyMbps != null) x.steady.push(m.steadyMbps);
    if (m.naiveMbps != null) x.naive.push(m.naiveMbps);
    if (m.loadedLatency?.medianMs != null) x.loaded.push(m.loadedLatency.medianMs);
  }
}

const out = [...cells.values()].map((c) => {
  const methods = [...c.methods.values()].map((m) => ({
    id: m.id, streams: m.streams, n: m.steady.length, failed: m.failed,
    steadyMedian: r1(median(m.steady)), steadyCv: r1(cv(m.steady) == null ? null : cv(m.steady) * 100),
    naiveMedian: r1(median(m.naive)), loadedMs: r1(median(m.loaded)),
    verified: m.checked ? `${m.verified}/${m.checked}` : 'n/a',
  }));
  const verifiedOnly = methods.filter((m) => m.verified !== 'n/a' && m.steadyMedian != null);
  const best = verifiedOnly.reduce((b, m) => (b == null || m.steadyMedian > b.steadyMedian ? m : b), null);
  const tester = median(c.tester);
  return {
    cell: c.cell, sessions: c.sessions, errors: c.errors,
    testerMedian: r1(tester), testerCv: r1(cv(c.tester) == null ? null : cv(c.tester) * 100),
    idleMs: r1(median(c.idle)), best: best ? `${best.id} ${best.steadyMedian}` : null,
    testerShareOfBest: best && tester != null ? `${Math.round((tester / best.steadyMedian) * 100)} %` : null,
    methods,
  };
});

if (asJson) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
for (const c of out) {
  console.log(`\n${c.cell}  (${c.sessions} sessions${c.errors.length ? `, errors: ${c.errors.join(', ')}` : ''})`);
  console.log(`  tester today: median ${c.testerMedian} Mbps, CV ${c.testerCv ?? '—'} %; idle RTT ${c.idleMs} ms; best verified ${c.best} → tester = ${c.testerShareOfBest ?? '—'} of it`);
  for (const m of c.methods) {
    console.log(`  ${m.id.padEnd(5)} x${String(m.streams).padEnd(2)} steady ${String(m.steadyMedian).padStart(7)} Mbps  CV ${String(m.steadyCv ?? '—').padStart(5)} %  naive ${String(m.naiveMedian).padStart(7)}  loaded ${m.loadedMs} ms  n ${m.n}${m.failed ? ` (${m.failed} failed)` : ''}  verified ${m.verified}`);
  }
}
