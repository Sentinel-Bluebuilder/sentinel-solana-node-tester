// ─── Reclaim the tester wallet's own rows (TEST_KEYFILE signs) ───
// For each address: re-read the account and take the next close step for its CURRENT state.
//   channel  voucher open → start_close_channel; voucher grace over or stream → close_channel
//   sub      close_subscription (owner may close any time; refunds nothing)
// Then withdraw_user_balance if User.balance > 0. Txs sequential, ≥ 7 s apart.
//
//   node scripts/ops/reclaim-own.mjs --channels a,b --subs c,d [--key-stdin] [--no-withdraw] [--dry-run]
import { ix, fetchConfig, pda } from '../../lib/solana/program.js';
import { fetchOne } from '../../lib/solana/accounts.js';
import { sendIxs } from '../../lib/solana/tx.js';
import { getKeypair, keypairFromJson } from '../../lib/wallet.js';

const args = process.argv.slice(2);
const list = (name) => {
  const i = args.indexOf(name);
  return i < 0 || !args[i + 1] ? [] : args[i + 1].split(',').filter(Boolean);
};
const DRY = args.includes('--dry-run');
const NO_WITHDRAW = args.includes('--no-withdraw'); // hold User.balance (withdraw in a later run)
// --key-stdin: the key JSON comes on stdin (piped over ssh), so it never lands on this box's disk.
async function stdinKey() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return keypairFromJson(Buffer.concat(chunks).toString('utf8'));
}
const kp = args.includes('--key-stdin') ? await stdinKey() : getKeypair();
const me = kp.publicKey.toBase58();
const log = (...a) => process.stdout.write(`[reclaim-own] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = () => Math.floor(Date.now() / 1000);
const cfg = await fetchConfig();
const GRACE = Number(cfg.channelCloseGraceSeconds);
log('wallet', me, DRY ? '(dry run)' : '', `grace ${GRACE} s`);

let sent = 0;
async function send(label, ixs) {
  if (DRY) { log('would send', label); return; }
  if (sent++) await sleep(7000);
  try {
    const r = await sendIxs(kp, ixs, label);
    log('OK', label, r.signature || '');
  } catch (err) {
    log('FAIL', label, String(err.message || err).slice(0, 200));
  }
}

// ─── Channels ───
for (const addr of list('--channels')) {
  const c = await fetchOne('channel', addr).catch((err) => { log('read failed', addr, err.message); return undefined; });
  if (!c) { log('gone', addr); continue; }
  if (c.owner !== me) { log('skip (not mine)', addr); continue; }
  const voucher = Number(c.mode) === 0;
  const started = Number(c.closeStartedAt);
  if (voucher && !started) {
    await send(`start-close ${addr.slice(0, 8)}`, [await ix.startCloseChannel({ signer: kp.publicKey, channel: addr })]);
  } else if (!voucher || started + GRACE <= NOW()) {
    await send(`close ${addr.slice(0, 8)}`, [await ix.closeChannel({ signer: kp.publicKey, channel: addr, channelAcct: c })]);
  } else {
    log('closing, grace until', new Date((started + GRACE) * 1000).toISOString(), addr);
  }
}

// ─── Subscriptions ───
for (const addr of list('--subs')) {
  const s = await fetchOne('subscription', addr).catch((err) => { log('read failed', addr, err.message); return undefined; });
  if (!s) { log('gone', addr); continue; }
  if (s.owner !== me) { log('skip (not mine)', addr); continue; }
  await send(`close-sub ${addr.slice(0, 8)}`, [await ix.closeSubscription({ signer: kp.publicKey, subscription: addr, subAcct: s })]);
}

// ─── User balance (last) ───
const u = await fetchOne('user', pda.user(me)).catch(() => undefined);
if (NO_WITHDRAW) log('withdraw skipped (--no-withdraw); User.balance', u ? u.balance : '(no account)');
else if (u && BigInt(u.balance) > 0n) await send(`withdraw ${u.balance}`, [await ix.withdrawUserBalance({ signer: kp.publicKey, userAcct: u })]);
else log('User.balance', u ? u.balance : '(no account)', `open channels ${u ? u.openChannels : '-'}`);
