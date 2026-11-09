// ─── Fill `undefined` rent recipients in a reclaim list, without rescanning ───
// READ-ONLY. For each row whose command holds `undefined`, reads that one account
// (getMultipleAccountsInfo, 100 per call), takes its stored rent payer, and writes it in.
//
//   node scripts/ops/reclaim-fill-rent.mjs RECLAIM-final.md > RECLAIM-fixed.md
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { rpcCall } from '../../lib/solana/rpc.js';
import { decodeAccount } from '../../lib/solana/accounts.js';

const log = (...a) => process.stderr.write(`[fill-rent] ${a.join(' ')}\n`);
const lines = readFileSync(process.argv[2], 'utf8').split('\n');
const ROW = /^\| \d+ \| [^|]+\| (\w+) \| `([1-9A-HJ-NP-Za-km-z]{32,44})` \|/;
const want = [];
lines.forEach((l, i) => {
  const m = ROW.exec(l);
  if (m && l.includes('undefined')) want.push({ i, kind: m[1], address: m[2] });
});
log(want.length, 'rows to fill');

for (let k = 0; k < want.length; k += 100) {
  const batch = want.slice(k, k + 100);
  const infos = await rpcCall(
    (c) => c.getMultipleAccountsInfo(batch.map((w) => new PublicKey(w.address)), 'confirmed'),
    { label: 'fill-rent', timeoutMs: 30_000 },
  );
  batch.forEach((w, j) => {
    const info = infos[j];
    if (!info) { lines[w.i] = lines[w.i].replace(/\| (reclaim|after final[^|]*) \|/, '| gone (closed since the scan) |').replaceAll('undefined', '-'); return; }
    const payer = decodeAccount(w.kind, info.data).rentRecipient;
    if (!payer) throw new Error(`${w.kind} ${w.address}: no rentRecipient after decode`);
    lines[w.i] = lines[w.i].replaceAll('undefined', payer);
  });
  log('filled', Math.min(k + 100, want.length), '/', want.length);
  await new Promise((r) => setTimeout(r, 8000)); // the gate caps each token
}
const left = lines.filter((l) => ROW.test(l) && l.includes('undefined')).length;
if (left) throw new Error(`${left} rows still hold undefined`);
process.stdout.write(lines.join('\n'));
