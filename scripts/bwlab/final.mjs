#!/usr/bin/env node
// ─── Bandwidth lab: the before/after table from the final matrix ───
// Every session ran the shipped steady method AND the classic 10 MB download, so "old" and
// "new" are measured on the same node, in the same session, under the same condition.
//   node scripts/bwlab/final.mjs <sessions.jsonl> [--prefix F] [--md]
// Truth on a capped link = the cap (line rate). The payload share below it is the protocol's
// overhead, which users really lose; the line-rate figure should sit at ~97–98 % of the cap.
//   --secret-file <f>   re-analyze each session from its raw transcript (found next to the JSONL)
//                       with the current analyzer; the classic reading is kept as recorded.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { steadyResult } from '../../lib/speed-method.js';

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const file = args.find((a, i) => !a.startsWith('--') && !['--prefix', '--secret-file'].includes(args[i - 1]));
const prefix = opt('--prefix') || 'F';
const md = args.includes('--md');
const secretFile = opt('--secret-file');
const secret = secretFile ? readFileSync(secretFile, 'utf8').trim() : null;
let reanalyzed = 0;
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
  try { return [JSON.parse(l)]; } catch (err) { console.error(`skipped a bad line: ${err.message}`); return []; }
}).filter((j) => String(j.label || '').startsWith(`${prefix}-`)).map((j) => {
  const raw = j.raw ? join(dirname(file), basename(j.raw)) : null;
  if (!secret || !raw || !existsSync(raw) || !j.tester?.speedMethod) return j;
  const fresh = steadyResult(readFileSync(raw, 'utf8'), { secret });
  if (fresh.method && fresh.reason !== 'the steady block did not run') {
    reanalyzed++;
    const old = j.tester.speedMethod;
    j.tester.speedMethod = { ...fresh, classicMbps: old.classicMbps };
  }
  return j;
});
if (secret) console.error(`re-analyzed ${reanalyzed} of ${rows.length} sessions from raw transcripts`);

const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const cv = (a) => { const s = a.filter(Number.isFinite); if (s.length < 2) return null; const m = s.reduce((x, y) => x + y, 0) / s.length; return m ? (Math.sqrt(s.reduce((x, y) => x + (y - m) ** 2, 0) / s.length) / m) * 100 : null; };
const f1 = (x) => (x == null ? '—' : x >= 100 ? x.toFixed(0) : x.toFixed(1));
const pc = (x, t) => (x == null || !t ? '' : ` (${Math.round((x / t) * 100)} %)`);

const PROTOS = ['wg', 'awg', 'v2ray', 'xray', 'ovpn', 'hy2'];
const NAMES = { wg: 'WireGuard', awg: 'AmneziaWG', v2ray: 'V2Ray', xray: 'Xray', ovpn: 'OpenVPN', hy2: 'Hysteria2' };
const conds = [...new Set(rows.map((j) => j.label.split('-')[1]))];
const out = [];
for (const c of conds) {
  const cap = /^cap(\d+)$/.exec(c)?.[1];
  const truth = cap ? Number(cap) : null;
  out.push(md ? `\n### ${c}${truth ? ` (truth: ${truth} Mbit line rate)` : ''}\n\n| Protocol | Old (classic) | New payload | New line rate | New CV | Sessions ok / failed | Verified |\n| --- | --- | --- | --- | --- | --- | --- |` : `\n== ${c}`);
  for (const p of PROTOS) {
    const rs = rows.filter((j) => j.label.split('-')[1] === c && j.label.split('-')[2] === p);
    if (!rs.length) continue;
    const okRows = rs.filter((j) => j.tester?.speedMethod?.ok);
    const sm = okRows.map((j) => j.tester.speedMethod);
    const oldV = median(sm.map((s) => s.classicMbps));
    const newV = median(sm.map((s) => s.mbps));
    const lineV = median(sm.map((s) => s.lineMbps));
    const cvV = cv(sm.map((s) => s.mbps));
    const failed = rs.length - okRows.length;
    const ver = sm.every((s) => s.verified === true) ? 'all' : `${sm.filter((s) => s.verified === true).length}/${sm.length}`;
    const cells = [NAMES[p], `${f1(oldV)}${pc(oldV, truth)}`, `${f1(newV)}${pc(newV, truth)}`, `${f1(lineV)}${pc(lineV, truth)}`, cvV == null ? '—' : `${cvV.toFixed(1)} %`, `${okRows.length} / ${failed}`, ver];
    out.push(md ? `| ${cells.join(' | ')} |` : cells.join('  '));
  }
}
console.log(out.join('\n'));
