// ─── Reclaim list: every dvpn account a fleet wallet still holds, with its close command ───
// READ-ONLY, no signing. One getProgramAccounts per account type (whole program, dataSize +
// discriminator), then filtered here by the wallet set, so the cost is ~11 calls, not one per
// wallet. Plus one getAccountInfo for Config (mint, vault, grace and unbonding windows).
//
//   node scripts/ops/reclaim-cb33.mjs --wallets WALLETS-cb33.txt --funder <pubkey> \
//     [--after-final <prefix,…>] [--only <kind,…>] [--gap-ms 4000] > RECLAIM-cb33.md
//
// RPC: SOLANA_RPC_URLS (the #28b gate); rpcCall paces every call.
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, ata, pda } from '../../lib/solana/program.js';
import { fetchMany, getConfig } from '../../lib/solana/accounts.js';

// ─── Args ───
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) {
    if (dflt !== undefined) return dflt;
    throw new Error(`missing ${name}`);
  }
  return args[i + 1];
};
const FUNDER = new PublicKey(opt('--funder')).toBase58();
const ONLY = opt('--only', '').split(',').filter(Boolean);
const GAP_MS = Number(opt('--gap-ms', '4000'));
const AFTER_FINAL = opt('--after-final', '').split(',').map((s) => s.trim()).filter(Boolean);
const labels = new Map([[FUNDER, 'funder']]);
for (const line of readFileSync(opt('--wallets'), 'utf8').split('\n')) {
  const m = /^([1-9A-HJ-NP-Za-km-z]{32,44})\s.*\s(\S+)\s*$/.exec(line.trim());
  if (m && !labels.has(m[1])) labels.set(new PublicKey(m[1]).toBase58(), m[2]);
}

const log = (...a) => process.stderr.write(`[reclaim] ${a.join(' ')}\n`);
const short = (s) => (s ? `${s.slice(0, 8)}…` : '');
const iso = (t) => (Number(t) > 0 ? new Date(Number(t) * 1000).toISOString().replace('.000', '') : '-');
const NOW = Math.floor(Date.now() / 1000);
const C = 'sentinel-dvpn';

// ─── Scan ───
const cfg = await getConfig();
const MINT = cfg.mint;
const VAULT = cfg.vault;
const CH_GRACE = Number(cfg.channelCloseGraceSeconds);
const LE_GRACE = Number(cfg.leaseCloseGraceSeconds);
const UNBOND = Number(cfg.unbondingSeconds);
log('config', `mint ${short(MINT)} vault ${short(VAULT)} grace ${CH_GRACE}/${LE_GRACE} unbond ${UNBOND}`);

const all = {};
for (const kind of ['provider', 'node', 'plan', 'lease', 'subscription', 'channel', 'user', 'nodeUnbonding', 'providerUnbonding', 'grant']) {
  if (ONLY.length && !ONLY.includes(kind)) continue;
  if (Object.keys(all).length) await new Promise((r) => setTimeout(r, GAP_MS)); // the gate caps each token
  try {
    all[kind] = await fetchMany(kind, [], { label: `reclaim:${kind}` });
    log(kind, all[kind].length, 'accounts on the program');
  } catch (err) {
    all[kind] = null;
    log(kind, 'QUERY FAILED', err.message.slice(0, 160));
  }
}

// Providers owned by a fleet wallet: their plans and leases count as that wallet's.
const providers = new Map((all.provider || []).filter((p) => labels.has(p.owner)).map((p) => [p.address, p]));
const nodesByAddr = new Map((all.node || []).map((n) => [n.address, n]));

const rows = [];
const add = (r) => rows.push(r);
const afterFinal = (addr, openedAt, listed) => {
  if (AFTER_FINAL.some((p) => addr.startsWith(p))) return 'after final (named live)';
  if (Number(openedAt) > NOW - 3600) return 'after final (opened < 1 h ago)';
  if (listed) return 'after final (still listed; confirm with owner)';
  return 'reclaim';
};

// ─── Channels (owner signs) ───
for (const c of all.channel || []) {
  if (!labels.has(c.owner)) continue;
  const user = pda.user(c.owner).toBase58();
  const close = `${C} channel close-channel --channel ${c.address} --node ${c.node} --user ${user} --rent-recipient ${c.rentRecipient}`;
  const voucher = Number(c.mode) === 0;
  const closing = Number(c.closeStartedAt) > 0;
  let cmd;
  let state;
  if (!voucher) { cmd = close; state = 'stream, open (bills until closed)'; } else if (!closing) {
    cmd = `${C} channel start-close-channel --channel ${c.address}  →  after ${CH_GRACE} s: ${close}`;
    state = 'voucher, open';
  } else {
    const ready = Number(c.closeStartedAt) + CH_GRACE;
    cmd = close;
    state = ready <= NOW ? 'voucher, grace over: close now' : `voucher, closing; close after ${iso(ready)}`;
  }
  add({ wallet: c.owner, kind: 'channel', address: c.address, state, money: `escrow ${c.escrow}, redeemed ${c.redeemed} → User.balance`, cmd, tag: afterFinal(c.address, c.openedAt, false) });
}

// ─── Leases (provider owner signs) ───
for (const l of all.lease || []) {
  const p = providers.get(l.provider);
  if (!p) continue;
  const close = `${C} lease close-lease --lease ${l.address} --node ${l.node} --provider ${l.provider} --rent-recipient ${l.rentRecipient}`;
  const voucher = Number(l.mode) === 0;
  const closing = Number(l.closeStartedAt) > 0 || Number(l.status) === 1;
  const cmd = voucher && !closing ? `${C} lease start-close-lease --lease ${l.address} --provider ${l.provider}  →  after ${LE_GRACE} s: ${close}` : close;
  const state = `${voucher ? 'voucher' : 'stream'}, ${closing ? `closing since ${iso(l.closeStartedAt)}` : 'open'}`;
  add({ wallet: p.owner, kind: 'lease', address: l.address, state, money: `escrow ${l.escrow} → Provider.balance`, cmd, tag: afterFinal(l.address, l.openedAt, false) });
}

// ─── Subscriptions (owner signs; may close early) ───
for (const s of all.subscription || []) {
  if (!labels.has(s.owner)) continue;
  const expired = Number(s.expiresAt) <= NOW;
  add({
    wallet: s.owner, kind: 'subscription', address: s.address,
    state: expired ? `expired ${iso(s.expiresAt)}` : `active until ${iso(s.expiresAt)}`,
    money: 'no refund; rent → stored payer',
    cmd: `${C} subscription close-subscription --subscription ${s.address} --provider ${s.provider} --rent-recipient ${s.rentRecipient}`,
    tag: afterFinal(s.address, s.openedAt, false),
  });
}

// ─── Plans (provider owner signs; delist then close) ───
for (const pl of all.plan || []) {
  const p = providers.get(pl.provider);
  if (!p) continue;
  const listed = Number(pl.status) === 1;
  const close = `${C} plan close-plan --plan ${pl.address} --provider ${pl.provider} --rent-recipient ${pl.rentRecipient}`;
  add({
    wallet: p.owner, kind: 'plan', address: pl.address, state: listed ? 'listed' : 'delisted',
    money: 'rent → stored payer',
    cmd: listed ? `${C} plan delist-plan --plan ${pl.address} --provider ${pl.provider}  →  ${close}` : close,
    tag: afterFinal(pl.address, 0, listed),
  });
}

// ─── Nodes (owner signs; close, unbond, withdraw bond) ───
for (const n of all.node || []) {
  if (!labels.has(n.owner)) continue;
  const nu = pda.nodeUnbonding(n.owner, Buffer.from(n.nodeId, 'hex')).toBase58();
  const tok = ata(n.owner).toBase58();
  const steps = [];
  if (BigInt(n.revenue) > 0n) steps.push(`${C} node withdraw-node-revenue --node ${n.address} --amount ${n.revenue} --owner ${n.owner} --owner-token ${tok} --mint ${MINT} --vault ${VAULT}`);
  steps.push(`${C} node close-node --node ${n.address} --node-unbonding ${nu} --node-unbonding-rent-recipient ${n.rentRecipient} --owner ${n.owner} --owner-token ${tok} --mint ${MINT}`);
  steps.push(`after ${UNBOND} s: ${C} node withdraw-node-bond --node-unbonding ${nu} --owner ${n.owner} --owner-token ${tok} --vault ${VAULT} --mint ${MINT} --rent-recipient ${n.rentRecipient}`);
  const listed = Number(n.status) === 1;
  add({ wallet: n.owner, kind: 'node', address: n.address, state: `${listed ? 'listed' : 'delisted'}, uri ${n.uri || '-'}`, money: `bond ${n.bond}, revenue ${n.revenue} → owner`, cmd: steps.join('  →  '), tag: afterFinal(n.address, n.openedAt, listed) });
}

// ─── Providers (owner signs; 0 plans + 0 leases first) ───
for (const p of providers.values()) {
  const pu = PublicKey.findProgramAddressSync([Buffer.from('provider_unbonding'), new PublicKey(p.owner).toBuffer(), Buffer.from(p.providerId, 'hex')], PROGRAM_ID)[0].toBase58();
  const tok = ata(p.owner).toBase58();
  const steps = [];
  if (BigInt(p.revenue) > 0n) steps.push(`${C} provider withdraw-provider-revenue --provider ${p.address} --amount ${p.revenue} --owner ${p.owner} --owner-token ${tok} --mint ${MINT} --vault ${VAULT}`);
  if (BigInt(p.balance) > 0n) steps.push(`${C} provider withdraw-provider-balance --provider ${p.address} --owner ${p.owner} --owner-token ${tok} --mint ${MINT} --vault ${VAULT}`);
  steps.push(`${C} provider close-provider --provider ${p.address} --provider-unbonding ${pu} --provider-unbonding-rent-recipient ${p.rentRecipient} --owner ${p.owner} --owner-token ${tok} --mint ${MINT}`);
  steps.push(`after ${UNBOND} s: ${C} provider withdraw-provider-bond --provider-unbonding ${pu} --owner ${p.owner} --owner-token ${tok} --vault ${VAULT} --mint ${MINT} --rent-recipient ${p.rentRecipient}`);
  const listed = Number(p.status) === 1;
  add({ wallet: p.owner, kind: 'provider', address: p.address, state: `${listed ? 'listed' : 'delisted'}, ${p.openPlans} plans, ${p.openLeases} leases open`, money: `bond ${p.bond}, revenue ${p.revenue}, balance ${p.balance} → owner`, cmd: steps.join('  →  '), tag: afterFinal(p.address, p.openedAt, listed) });
}

// ─── Unbonding bonds waiting to be withdrawn ───
for (const [kind, sub] of [['nodeUnbonding', 'node withdraw-node-bond --node-unbonding'], ['providerUnbonding', 'provider withdraw-provider-bond --provider-unbonding']]) {
  for (const u of all[kind] || []) {
    if (!labels.has(u.owner)) continue;
    const ready = Number(u.closedAt) + UNBOND;
    add({
      wallet: u.owner, kind, address: u.address, state: ready <= NOW ? 'unbonded: withdraw now' : `unbonding until ${iso(ready)}`,
      money: `bond ${u.bond} → owner`,
      cmd: `${C} ${sub} ${u.address} --owner ${u.owner} --owner-token ${ata(u.owner).toBase58()} --vault ${VAULT} --mint ${MINT} --rent-recipient ${u.rentRecipient}`,
      tag: 'reclaim',
    });
  }
}

// ─── User balances (last: closes credit them) ───
for (const u of all.user || []) {
  if (!labels.has(u.owner)) continue;
  const bal = BigInt(u.balance);
  add({
    wallet: u.owner, kind: 'user', address: u.address, state: `balance ${u.balance}, ${u.openChannels} channels open`,
    money: `${u.balance} → owner ATA (plus whatever the channel closes credit)`,
    cmd: bal > 0n || Number(u.openChannels) > 0 ? `${C} user withdraw-user-balance  (as ${labels.get(u.owner)}, after its channels close)` : '(nothing to withdraw; no close instruction for the User account)',
    tag: 'reclaim',
  });
}

// Grants are listed for completeness; the CLI has no close command for them in this table.
const grants = (all.grant || []).filter((g) => labels.has(g.granter));

// ─── Report ───
const ORDER = ['channel', 'lease', 'subscription', 'plan', 'node', 'provider', 'nodeUnbonding', 'providerUnbonding', 'user'];
rows.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (labels.get(a.wallet) || '').localeCompare(labels.get(b.wallet) || ''));
const md = [];
md.push('## Reclaim list (read-only)', '',
  `Generated ${new Date().toISOString()} by #1b (\`scripts/ops/reclaim-cb33.mjs\`, through the #28b RPC gate). ` +
  `${labels.size} wallets (WALLETS-cb33.txt + funder). Program ${PROGRAM_ID.toBase58()}, mint ${MINT}, vault ${VAULT}. ` +
  `Windows from Config: channel grace ${CH_GRACE} s, lease grace ${LE_GRACE} s, unbonding ${UNBOND} s.`,
  `Scan cost: ${Object.keys(all).length} getProgramAccounts + 1 Config read. Failed scans: ${Object.entries(all).filter(([, v]) => v === null).map(([k]) => k).join(', ') || 'none'}.`, '',
  'Signers: each command runs as the `wallet` shown (provider owner for leases and plans). Rent recipients, node, mint and vault come from the accounts (the program pins them). Run in table order.', '');
const counts = {};
for (const r of rows) counts[`${r.kind}|${r.tag.startsWith('after') ? 'after' : 'now'}`] = (counts[`${r.kind}|${r.tag.startsWith('after') ? 'after' : 'now'}`] || 0) + 1;
md.push('| kind | reclaim now | after final |', '|---|---|---|');
for (const k of ORDER) if (counts[`${k}|now`] || counts[`${k}|after`]) md.push(`| ${k} | ${counts[`${k}|now`] || 0} | ${counts[`${k}|after`] || 0} |`);
// One runnable command per cell: the first step, then the later steps (each labelled with its wait).
const cells = (cmd) => {
  const [now, ...later] = cmd.split('  →  ');
  const then = later.map((s) => `\`${s.replace(/^after (\d+) s: /, '')}\`${/^after \d+ s: /.test(s) ? ` (after ${s.match(/^after (\d+) s/)[1]} s)` : ''}`).join(' ; ');
  return `\`${now}\` | ${then || '-'}`;
};
md.push('', '| # | wallet | kind | account | state | money | tag | run now | then, in order (each after its wait) |', '|---|---|---|---|---|---|---|---|---|');
rows.forEach((r, i) => md.push(`| ${i + 1} | ${labels.get(r.wallet)} \`${short(r.wallet)}\` | ${r.kind} | \`${r.address}\` | ${r.state} | ${r.money} | ${r.tag} | ${cells(r.cmd)} |`));
if (grants.length) {
  md.push('', `Grants held (no close command in the table; listed only): ${grants.map((g) => `\`${short(g.address)}\` ${labels.get(g.granter)}→${short(g.grantee)} exp ${iso(g.expiresAt)}`).join('; ')}`);
}
process.stdout.write(md.join('\n') + '\n');
log('rows', rows.length, 'grants', grants.length);
