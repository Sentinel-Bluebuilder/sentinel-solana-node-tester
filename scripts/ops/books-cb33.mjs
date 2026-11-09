// ─── Books: devnet wallet tx reconciliation + open-account inventory (PLAN §12.7b) ───
// READ-ONLY. For every wallet: tx signatures since --since, each tx classified from its
// dvpn program logs and its SOL / tDVPN balance change; top-ups matched to the sol-topup
// ledger lines (signature prefixes); then every dvpn account the wallet still holds.
//
//   node scripts/ops/books-cb33.mjs --wallets WALLETS-cb33.txt --ledger gcp-ledger.md \
//     --funder <pubkey> --since 2026-11-07T00:00:00Z > BOOKS-cb33.md
//
// RPC: SOLANA_RPC_URLS (lane a); every call goes through rpcCall, paced ≤ 5 req/s.
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { rpcCall } from '../../lib/solana/rpc.js';
import { PROGRAM_ID, ata } from '../../lib/solana/program.js';
import { MINT, OFFSETS } from '../../lib/solana/idl.js';
import { fetchMany, tdvpn } from '../../lib/solana/accounts.js';

// ─── Args ───
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) throw new Error(`missing ${name}`);
  return args[i + 1];
};
const SINCE = Math.floor(Date.parse(opt('--since')) / 1000);
const FUNDER = new PublicKey(opt('--funder')).toBase58();
const wallets = [{ pubkey: FUNDER, label: 'funder' }];
for (const line of readFileSync(opt('--wallets'), 'utf8').split('\n')) {
  const m = /^([1-9A-HJ-NP-Za-km-z]{32,44})\s.*\s(\S+)\s*$/.exec(line.trim());
  if (m && m[1] !== FUNDER) wallets.push({ pubkey: new PublicKey(m[1]).toBase58(), label: m[2] });
}
const ledger = [];
for (const line of readFileSync(opt('--ledger'), 'utf8').split('\n')) {
  const m = /^- (\S+Z) \S+ sol-topup: (\S+) ([1-9A-HJ-NP-Za-km-z]{32,44})\s+(.*)$/.exec(line);
  if (!m || Date.parse(m[1]) / 1000 < SINCE) continue;
  for (const p of m[4].matchAll(/\+([\d.]+) (SOL|tDVPN) ([1-9A-HJ-NP-Za-km-z]{6,})/g)) {
    ledger.push({ at: m[1], label: m[2], wallet: m[3], amount: p[1], unit: p[2], prefix: p[3], matched: null });
  }
}

const log = (...a) => process.stderr.write(`[books] ${a.join(' ')}\n`);
const short = (s) => (s ? `${s.slice(0, 8)}…` : '');
const iso = (t) => (t ? new Date(t * 1000).toISOString().replace('.000', '') : '?');

// ─── Signatures since SINCE (newest first, paged) ───
async function signaturesSince(pubkey) {
  const out = [];
  let before;
  for (;;) {
    const page = await rpcCall((c) => c.getSignaturesForAddress(new PublicKey(pubkey), { before, limit: 1000 }, 'confirmed'), { label: 'books:sigs' });
    if (!page.length) break;
    for (const s of page) {
      if (s.blockTime && s.blockTime < SINCE) return out;
      out.push(s);
    }
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  return out;
}

// ─── Classification ───
const DVPN = PROGRAM_ID.toBase58();
function dvpnInstructions(logs = []) {
  const stack = [];
  const names = [];
  for (const l of logs) {
    let m;
    if ((m = /^Program (\S+) invoke \[\d+\]$/.exec(l))) stack.push(m[1]);
    else if (/^Program \S+ (success|failed)/.test(l)) stack.pop();
    else if ((m = /^Program log: Instruction: (\w+)$/.exec(l)) && stack[stack.length - 1] === DVPN) {
      names.push(m[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
    }
  }
  return names;
}

// A plain transfer is a top-up only when the funder is on the other side; any other wallet
// moving SOL/tDVPN to or from us is transfer-in / transfer-out.
function category(names, inbound, outbound, peers, me) {
  if (names.length) {
    const n = names.join(' ');
    if (/redeem_/.test(n)) return 'redeem';
    if (/withdraw_user_balance/.test(n)) return 'refund';
    if (/(^| )(start_close_|close_)/.test(n)) return 'close';
    if (/(^| )(open_|fund_|list_)/.test(n)) return 'open';
    return 'other';
  }
  if (me === FUNDER && outbound) return 'top-up';
  if (inbound && peers.includes(FUNDER)) return 'top-up';
  if (inbound) return 'transfer-in';
  if (outbound) return 'transfer-out';
  return 'other';
}

// Raw getTransaction: web3.js's getParsedTransaction rejects transaction version 1.
async function fetchTx(signature) {
  const req = (encoding) => rpcCall(async (c) => {
    const res = await c._rpcRequest('getTransaction', [signature, { encoding, maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    if (res.error) throw Object.assign(new Error(`getTransaction ${encoding}: ${res.error.message}`), { rpcError: true });
    return res.result;
  }, { label: 'books:tx' });
  try {
    return await req('jsonParsed');
  } catch (err) {
    if (!err.rpcError) throw err;
    log('jsonParsed refused for', short(signature), '-', err.message.slice(0, 100), '- retrying as json');
    return req('json');
  }
}

async function classify(sig, me) {
  let tx;
  try {
    tx = await fetchTx(sig.signature);
  } catch (err) {
    log('tx fetch failed', short(sig.signature), err.message.slice(0, 120));
    return { sig: sig.signature, at: sig.blockTime, cat: 'other', names: [`(fetch failed: ${err.message.slice(0, 60)})`], err: sig.err, fetchFailed: true };
  }
  if (!tx) return { sig: sig.signature, at: sig.blockTime, cat: 'other', names: ['(tx not found)'], err: sig.err };
  const msg = tx.transaction.message;
  const keys = [
    ...(msg.accountKeys || []).map((k) => (typeof k === 'string' ? k : String(k.pubkey))),
    ...(tx.meta.loadedAddresses?.writable || []),
    ...(tx.meta.loadedAddresses?.readonly || []),
  ];
  const feePayer = keys[0];
  // SOL change per key (the fee payer's fee added back, so a fee alone is not a transfer).
  const sol = new Map();
  keys.forEach((k, j) => {
    const d = (tx.meta.postBalances[j] ?? 0) - (tx.meta.preBalances[j] ?? 0) + (j === 0 ? tx.meta.fee : 0);
    sol.set(k, (sol.get(k) || 0) + d);
  });
  // tDVPN change per token-account OWNER.
  const tok = new Map();
  const addTok = (arr, sign) => {
    for (const b of arr || []) if (b.mint === MINT.toBase58() && b.owner) tok.set(b.owner, (tok.get(b.owner) || 0) + sign * Number(b.uiTokenAmount.amount));
  };
  addTok(tx.meta.postTokenBalances, 1);
  addTok(tx.meta.preTokenBalances, -1);
  const solDelta = (sol.get(me) || 0) / 1e9;
  const tokDelta = (tok.get(me) || 0) / 1e6;
  // Dust (< 0.00001 SOL) is rent-exempt rounding, not a transfer.
  const inbound = solDelta > 1e-5 || tokDelta > 0;
  const outbound = solDelta < -1e-5 || tokDelta < 0;
  // Peers: the wallets on the other side of my movement (opposite sign), else the fee payer.
  const peers = new Set();
  const opposite = (d) => (inbound ? d < 0 : d > 0);
  if (inbound || outbound) {
    for (const [k, d] of tok) if (k !== me && d !== 0 && opposite(d)) peers.add(k);
    for (const [k, d] of sol) if (k !== me && Math.abs(d) > 1e4 && opposite(d) && k !== PROGRAM_ID.toBase58()) peers.add(k);
  }
  if (feePayer !== me) peers.add(feePayer);
  const names = dvpnInstructions(tx.meta.logMessages);
  return {
    sig: sig.signature, at: tx.blockTime, feePayer, solDelta, tokDelta, names, err: tx.meta.err,
    cat: tx.meta.err ? 'failed' : category(names, inbound, outbound, [...peers], me),
    others: [...peers],
  };
}

// ─── Open accounts ───
const compact = (row) => Object.entries(row)
  .filter(([k]) => k !== 'address')
  .map(([k, v]) => {
    if (v && typeof v === 'object') return null;
    const s = String(v);
    return `${k}=${/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) ? short(s) : s.length > 20 ? `${s.slice(0, 20)}…` : s}`;
  })
  .filter(Boolean).join(' ');

async function openAccounts(me) {
  const out = [];
  const get = async (name, offset, key) => {
    try {
      for (const r of await fetchMany(name, [{ offset, pubkey: key }], { label: `books:${name}` })) out.push({ kind: name, ...r });
    } catch (err) {
      out.push({ kind: name, address: '(query failed)', error: err.message.slice(0, 120) });
    }
  };
  await get('channel', OFFSETS.channel.owner, me);
  await get('subscription', OFFSETS.subscription.owner, me);
  await get('user', OFFSETS.user.owner, me);
  await get('node', OFFSETS.node.owner, me);
  await get('nodeUnbonding', OFFSETS.nodeUnbonding.owner, me);
  await get('provider', OFFSETS.provider.owner, me);
  await get('providerUnbonding', OFFSETS.providerUnbonding.owner, me);
  await get('grant', OFFSETS.grant.granter, me);
  // Plans / leases / grants are keyed by the provider PDA (or the owner, depending on the field).
  const providerKeys = [me, ...out.filter((r) => r.kind === 'provider').map((r) => r.address)];
  for (const k of new Set(providerKeys)) {
    await get('plan', OFFSETS.plan.provider, k);
    await get('lease', OFFSETS.lease.provider, k);
    if (k !== me) await get('grant', OFFSETS.grant.granter, k);
  }
  // A provider PDA can match both keys; drop duplicate rows.
  const seen = new Set();
  return out.filter((r) => (r.address === '(query failed)' || !seen.has(r.kind + r.address)) && seen.add(r.kind + r.address));
}

// ─── Main ───
const md = [];
const flags = [];
const counts = {};
md.push(`# BOOKS-cb33 — devnet wallet reconciliation`, '',
  `Generated ${new Date().toISOString()} by #1b (\`scripts/ops/books-cb33.mjs\`, read-only, lane a ≤ 5 req/s).`,
  `Window: since ${iso(SINCE)}. Program ${DVPN}. Mint ${MINT.toBase58()}.`,
  `Ledger: ${ledger.length} sol-topup transfers in window (the --ledger file, matched by signature prefix).`, '');

const perWallet = [];
for (const w of wallets) {
  log('wallet', w.label, w.pubkey);
  // A tDVPN transfer into an existing token account does not list the owner wallet, so the
  // wallet's token account is scanned too.
  const own = await signaturesSince(w.pubkey);
  const viaAta = await signaturesSince(ata(w.pubkey).toBase58());
  const bySig = new Map([...own, ...viaAta].map((s) => [s.signature, s]));
  const sigs = [...bySig.values()].sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0));
  log(' ', own.length, 'wallet +', viaAta.length, 'token-account =', sigs.length, 'signatures');
  const rows = [];
  for (const s of sigs) rows.push(await classify(s, w.pubkey));
  const accounts = await openAccounts(w.pubkey);
  perWallet.push({ ...w, rows, accounts });
}

const walletByKey = new Map(wallets.map((w) => [w.pubkey, w.label]));
for (const w of perWallet) {
  for (const r of w.rows) {
    const l = ledger.find((e) => r.sig.startsWith(e.prefix) && (e.wallet === w.pubkey || w.pubkey === FUNDER));
    if (l) { r.ledger = `${l.at} ${l.label} +${l.amount} ${l.unit}`; l.matched = l.matched || r.sig; }
  }
}

const CATS = ['top-up', 'transfer-in', 'transfer-out', 'open', 'redeem', 'close', 'refund', 'failed', 'other'];
md.push('## Summary', '', `| wallet | label | txs | ${CATS.join(' | ')} | open accounts |`, `|${'---|'.repeat(CATS.length + 4)}`);
for (const w of perWallet) {
  const c = Object.fromEntries(CATS.map((k) => [k, 0]));
  for (const r of w.rows) c[r.cat]++;
  const acc = {};
  for (const a of w.accounts) if (a.address !== '(query failed)' && a.kind !== 'user') acc[a.kind] = (acc[a.kind] || 0) + 1;
  md.push(`| \`${short(w.pubkey)}\` | ${w.label} | ${w.rows.length} | ${CATS.map((k) => c[k]).join(' | ')} | ${Object.entries(acc).map(([k, v]) => `${k} ${v}`).join(', ') || '—'} |`);
  for (const k of CATS) counts[k] = (counts[k] || 0) + c[k];
}
md.push('', 'Classes: **top-up** = a plain transfer with the funder on the other side; **transfer-in/out** = a plain transfer with any other wallet; open/redeem/close/refund = the dvpn instruction in the tx (`close` includes start_close; `refund` = withdraw_user_balance). A tx between two of our wallets appears under both.', '');

// ─── Flags ───
const peerText = (r) => r.others.filter((o) => o !== FUNDER || r.cat !== 'top-up').map((o) => `${short(o)}${walletByKey.has(o) ? ` [${walletByKey.get(o)}]` : ' [NOT-A-LANE-WALLET]'}`).join(', ') || '(no peer found)';
const amounts = (r) => `SOL ${r.solDelta >= 0 ? '+' : ''}${r.solDelta.toFixed(4)}, tDVPN ${r.tokDelta >= 0 ? '+' : ''}${r.tokDelta}`;
const unledgered = [];
for (const w of perWallet) {
  for (const r of w.rows) {
    if (r.cat === 'top-up' && w.pubkey === FUNDER && !r.ledger) flags.push(`funder → ${peerText(r)}: ${short(r.sig)} ${iso(r.at)} ${amounts(r)} — NO LEDGER LINE`);
    else if (r.cat === 'top-up' && w.pubkey !== FUNDER && !r.ledger) flags.push(`${w.label} ← funder: ${short(r.sig)} ${iso(r.at)} ${amounts(r)} — NO LEDGER LINE`);
    else if ((r.cat === 'transfer-in' || r.cat === 'transfer-out') && w.pubkey !== FUNDER) unledgered.push(`${w.label} ${r.cat === 'transfer-in' ? '←' : '→'} ${peerText(r)}: ${short(r.sig)} ${iso(r.at)} ${amounts(r)}`);
  }
  for (const r of w.rows) if (r.fetchFailed) flags.push(`${w.label} tx ${short(r.sig)} ${iso(r.at)} could not be fetched: ${r.names[0]}`);
  for (const a of w.accounts) if (a.address === '(query failed)') flags.push(`${w.label} ${a.kind} query failed: ${a.error}`);
}
for (const l of ledger) if (!l.matched) flags.push(`ledger line with no matching tx: ${l.at} ${l.label} +${l.amount} ${l.unit} ${l.prefix}`);
md.push(`## Flags (${flags.length})`, '', 'Funder transfers with no sol-topup ledger line, ledger lines with no tx, and failed queries.', '',
  ...(flags.length ? flags.map((f) => `- ⚠ ${f}`) : ['- none']), '');
md.push(`## Transfers not involving the funder (${unledgered.length})`, '', 'Plain SOL/tDVPN transfers between a lane wallet and some other wallet. They are not top-ups, so the ledger does not cover them; listed so each owner can confirm them.', '',
  ...(unledgered.length ? unledgered.map((f) => `- ${f}`) : ['- none']), '');

md.push('## Ledger match', '', '| ledger line | tx |', '|---|---|');
for (const l of ledger) md.push(`| ${l.at} ${l.label} +${l.amount} ${l.unit} \`${l.prefix}\` | ${l.matched ? `\`${short(l.matched)}\` ✓` : '**unmatched**'} |`);
md.push('');

md.push('## Open accounts (phase-7 reclaim list)', '');
for (const w of perWallet) {
  const rows = w.accounts.filter((a) => a.address !== '(query failed)');
  md.push(`### ${w.label} \`${w.pubkey}\` — ${rows.length} account(s)`, '');
  for (const a of rows) md.push(`- **${a.kind}** \`${a.address}\` ${compact(a)}`);
  md.push('');
}

md.push('## Transactions', '');
for (const w of perWallet) {
  md.push(`### ${w.label} \`${w.pubkey}\` — ${w.rows.length} tx`, '', '| time | sig | class | dvpn ix | SOL Δ | tDVPN Δ | ledger |', '|---|---|---|---|---|---|---|');
  for (const r of w.rows) {
    md.push(`| ${iso(r.at)} | \`${r.sig.slice(0, 10)}\` | ${r.cat} | ${r.names.join(' ') || '—'} | ${(r.solDelta || 0).toFixed(5)} | ${r.tokDelta || 0} | ${r.ledger || ''} |`);
  }
  md.push('');
}
md.push(`Totals: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
process.stdout.write(md.join('\n') + '\n');
log('done', perWallet.reduce((s, w) => s + w.rows.length, 0), 'txs,', flags.length, 'flags');
void tdvpn;
