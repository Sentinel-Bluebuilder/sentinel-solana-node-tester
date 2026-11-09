// ─── Test-channel sweep ──────────────────────────────────────────────────────
// Every voucher channel a test opens is escrow parked in the program until it
// is closed. This module returns it, touching ONLY channels recorded in the
// tester's `sol_channels` table (never anything else the shared wallet owns):
//
//   open (0)    → start_close_channel  (starts the grace window that lets the
//                 node redeem outstanding vouchers)
//   closing (1) → after close_started_at + grace: close_channel, which credits
//                 escrow − redeemed to the wallet's User balance
//   finally     → withdraw_user_balance, ONLY when this sweep closed a channel
//                 or an earlier sweep's withdraw failed (refundPending) — the
//                 wallet is shared with other projects' suites, so a balance we
//                 did not create is never moved.
//
// Stream (per-hour) channels have no grace: close_channel settles the elapsed
// time and closes in one step (start_close is refused with ModeNotVoucher). A
// stream channel keeps billing until it is closed, so the per-hour test closes
// it right after its session (closeStreamChannel); the sweep only catches ones a
// crash left open.
//
// Sequential, 7 s between txs (global rule for chain tests).
import anchorPkg from '@coral-xyz/anchor';
import { channelsByOwner, channelByPda, userByOwner, getConfig } from '../lib/solana/accounts.js';
import { ix, getProgram, PROGRAM_ID } from '../lib/solana/program.js';
import { sendIxs } from '../lib/solana/tx.js';
import { rpcCall } from '../lib/solana/rpc.js';
import { listChannels, updateChannel, kvGet, kvSet } from '../lib/db.js';
import { CHANNEL_OPEN, CHANNEL_CLOSING, MODE_VOUCHER, MODE_STREAM } from '../lib/constants.js';

const { EventParser } = anchorPkg;

const GAP_MS = 7_000;
const gap = () => new Promise((r) => setTimeout(r, GAP_MS));

function refundPending() {
  return kvGet('refundPending') === '1';
}

function setRefundPending(v) {
  kvSet('refundPending', v ? '1' : '0');
}

/** ChannelClosed event of a landed close tx → { returned, redeemed, forfeited } (strings), or null. */
export function closedEventFromLogs(logs) {
  if (!Array.isArray(logs)) return null;
  const parser = new EventParser(PROGRAM_ID, getProgram().coder);
  for (const ev of parser.parseLogs(logs)) {
    if (!/^channel_?closed$/i.test(ev.name)) continue;
    const d = ev.data || {};
    const s = (v) => (v == null ? null : String(v));
    return { returned: s(d.returned), redeemed: s(d.redeemed), forfeited: s(d.forfeited), escrow: s(d.escrow) };
  }
  return null;
}

async function closedEvent(txHash) {
  try {
    const tx = await rpcCall((c) => c.getTransaction(txHash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }), { label: 'close:tx' });
    return closedEventFromLogs(tx?.meta?.logMessages);
  } catch (err) {
    console.warn(`[channels] reading the close tx ${txHash} failed: ${err.message}`);
    return null;
  }
}

/**
 * Close one stream channel now (settles elapsed time to the node, returns the rest
 * to User.balance). Marks a refund pending so the next sweep withdraws it.
 * Returns { txHash, returnedBase, redeemedBase } — amounts from the ChannelClosed event.
 */
export async function closeStreamChannel(keypair, address, { log = () => {} } = {}) {
  const c = await channelByPda(address);
  if (!c) {
    updateChannel(address, { status: 'closed', closed_at: Date.now() });
    return { txHash: null, returnedBase: null, redeemedBase: null, gone: true };
  }
  if (Number(c.mode) !== MODE_STREAM) throw new Error(`${address} is not a stream channel (mode ${c.mode})`);
  const r = await sendIxs(keypair, [await ix.closeChannel({ signer: keypair.publicKey, channel: address, channelAcct: c })], 'close_channel');
  setRefundPending(true);
  const ev = await closedEvent(r.txHash);
  const returnedBase = ev?.returned ?? null;
  const redeemedBase = ev ? String(BigInt(ev.escrow ?? c.escrow) - BigInt(ev.returned) - BigInt(ev.forfeited || '0')) : null;
  updateChannel(address, {
    status: 'closed', closed_at: Date.now(), tx_close: r.txHash,
    redeemed_base: redeemedBase != null ? Number(redeemedBase) : Number(c.redeemed),
    refunded_base: returnedBase != null ? Number(returnedBase) : null, last_error: null,
  });
  log(`close_channel (stream) ${address.slice(0, 8)}… paid ${redeemedBase ?? '?'} · returned ${returnedBase ?? '?'} base units`);
  return { txHash: r.txHash, returnedBase, redeemedBase };
}

// ─── One sweep at a time ───
// The background timer, the after-run sweep and POST /api/solana/channels/sweep can overlap
// (e.g. the timer fires 90 s after start while the CLI sweeps). Two sweeps reading the same
// tracked list both send close_channel and the loser reports AccountNotInitialized for a
// channel that did close. Queue them: the second sweep starts from the first one's results.
export function serialized(fn) {
  let queue = Promise.resolve();
  return (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch((err) => console.warn(`[channels] queued call failed: ${err.message}`));
    return run;
  };
}

/**
 * @param {import('@solana/web3.js').Keypair} keypair tester wallet
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} opts
 */
export const sweepTestChannels = serialized(sweepOnce);

async function sweepOnce(keypair, { dryRun = false, log = () => {} } = {}) {
  const owner = keypair.publicKey.toBase58();
  const out = { dryRun, startedClose: [], closed: [], pending: [], gone: [], withdrawnBase: '0', userBalanceBase: '0', errors: [] };
  const tracked = listChannels({ openOnly: true });
  if (!tracked.length && !refundPending()) return out;
  const cfg = await getConfig();
  const grace = Number(cfg.channelCloseGraceSeconds);
  const live = new Map((await channelsByOwner(owner)).map((c) => [c.address, c]));
  const now = Math.floor(Date.now() / 1000);
  let closedAny = false;
  let closeMayHaveLanded = false;

  for (const t of tracked) {
    const c = live.get(t.address);
    if (!c) {
      // Account gone: closed by an earlier sweep whose bookkeeping did not land, or by the node.
      out.gone.push(t.address);
      if (!dryRun) updateChannel(t.address, { status: 'closed', closed_at: Date.now() });
      continue;
    }
    try {
      const status = Number(c.status);
      if (status === CHANNEL_OPEN && Number(c.mode) === MODE_STREAM) {
        // A stream channel a crash left open: no grace, close it now.
        out.closed.push(t.address);
        if (!dryRun) {
          await closeStreamChannel(keypair, t.address, { log });
          closedAny = true;
          await gap();
        }
      } else if (status === CHANNEL_OPEN && Number(c.mode) === MODE_VOUCHER) {
        out.startedClose.push(t.address);
        out.pending.push({ channel: t.address, maturesAt: new Date((now + grace) * 1000).toISOString() });
        if (!dryRun) {
          const r = await sendIxs(keypair, [await ix.startCloseChannel({ signer: keypair.publicKey, channel: t.address })], 'start_close_channel');
          updateChannel(t.address, { status: 'closing', close_started_at: Date.now(), tx_start_close: r.txHash, redeemed_base: Number(c.redeemed), last_error: null });
          log(`start_close_channel ${t.address.slice(0, 8)}… ${r.txHash.slice(0, 12)}…`);
          await gap();
        }
      } else if (status === CHANNEL_CLOSING) {
        const ready = Number(c.closeStartedAt) + grace;
        if (now < ready) {
          out.pending.push({ channel: t.address, maturesAt: new Date(ready * 1000).toISOString() });
          if (!dryRun && t.status !== 'closing') updateChannel(t.address, { status: 'closing', close_started_at: Number(c.closeStartedAt) * 1000 });
          continue;
        }
        out.closed.push(t.address);
        if (!dryRun) {
          const r = await sendIxs(keypair, [await ix.closeChannel({ signer: keypair.publicKey, channel: t.address, channelAcct: c })], 'close_channel');
          // The node can still redeem between our read and the close: book what the
          // ChannelClosed event says, and the pre-close read only when the event is unreadable.
          const ev = await closedEvent(r.txHash);
          const refunded = ev?.returned != null ? BigInt(ev.returned) : BigInt(c.escrow) - BigInt(c.redeemed);
          const redeemed = ev?.redeemed != null ? BigInt(ev.redeemed) : BigInt(c.redeemed);
          updateChannel(t.address, { status: 'closed', closed_at: Date.now(), tx_close: r.txHash, redeemed_base: Number(redeemed), refunded_base: Number(refunded), last_error: null });
          closedAny = true;
          log(`close_channel ${t.address.slice(0, 8)}… refund ${refunded} base units`);
          await gap();
        }
      } else {
        out.errors.push(`${t.address}: unexpected status ${status} mode ${c.mode}`);
      }
    } catch (err) {
      out.errors.push(`${t.address}: ${err.message}`);
      if (!dryRun) updateChannel(t.address, { last_error: err.message.slice(0, 500) });
      if (Number(c.status) === CHANNEL_CLOSING && !dryRun) closeMayHaveLanded = true;
    }
  }

  const wasPending = refundPending();
  if (closedAny || wasPending || closeMayHaveLanded) {
    try {
      const user = await userByOwner(owner);
      const bal = user ? BigInt(user.balance) : 0n;
      out.userBalanceBase = bal.toString();
      if (bal > 0n && !dryRun && (closedAny || wasPending)) {
        await sendIxs(keypair, [await ix.withdrawUserBalance({ signer: keypair.publicKey, userAcct: user })], 'withdraw_user_balance');
        out.withdrawnBase = bal.toString();
        out.userBalanceBase = '0';
        setRefundPending(false);
        log(`withdraw_user_balance ${bal} base units`);
      } else if (!dryRun && bal === 0n) {
        setRefundPending(false);
      }
    } catch (err) {
      out.errors.push(`withdraw_user_balance: ${err.message}`);
      if (!dryRun) setRefundPending(true);
    }
  }
  if (closeMayHaveLanded && !dryRun) setRefundPending(true);
  return out;
}
