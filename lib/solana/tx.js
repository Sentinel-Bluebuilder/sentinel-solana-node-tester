// ─── Transaction build / simulate / send ─────────────────────────────────────
// ONE write path: `await sendIxs(keypair, ixs, 'label')`. Every tx is simulated
// before signing so a program error reaches the caller as a decoded
// ProgramError, then confirmed by polling through the RPC pool (web3's
// confirmTransaction is bound to one connection with retries disabled; a
// single 429 while polling would turn a landed tx into a failure).
//
// Sends are serialised through one queue: the tester has ONE wallet, and two
// concurrent signers on the same blockhash window race.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { rpcCall, isTransportError, COMMITMENT } from './rpc.js';
import { ProgramError } from './errors.js';

const CU_MARGIN = 1.2;
const CU_FLOOR = 20_000;
const CU_CEIL = 1_400_000;
const MAX_PRIORITY_FEE = 100_000;
const CONFIRM_TIMEOUT_MS = 60_000;

async function priorityFee(ixs) {
  const writable = [...new Set(ixs.flatMap((i) => i.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())))]
    .slice(0, 128).map((k) => new PublicKey(k));
  try {
    const fees = await rpcCall((c) => c.getRecentPrioritizationFees({ lockedWritableAccounts: writable }), { label: 'priorityFee', attempts: 1, timeoutMs: 5000 });
    const vals = fees.map((f) => f.prioritizationFee).filter((n) => n > 0).sort((a, b) => a - b);
    if (!vals.length) return 0;
    return Math.min(MAX_PRIORITY_FEE, vals[Math.floor(vals.length / 2)]);
  } catch (err) {
    console.warn(`[tx] priority fee lookup failed, using 0: ${err.message}`);
    return 0;
  }
}

export async function buildTx(ixs, feePayer, { label = 'tx' } = {}) {
  if (!ixs.length) throw new Error(`${label}: no instructions`);
  const payer = new PublicKey(feePayer);
  const { blockhash, lastValidBlockHeight } = await rpcCall((c) => c.getLatestBlockhash(COMMITMENT), { label: `${label}:blockhash` });
  const probe = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const sim = await rpcCall((c) => c.simulateTransaction(probe, { sigVerify: false, replaceRecentBlockhash: true, commitment: COMMITMENT }), { label: `${label}:simulate` });
  if (sim.value.err) throw new ProgramError({ err: sim.value.err, logs: sim.value.logs }, { logs: sim.value.logs });
  const units = Math.min(CU_CEIL, Math.max(CU_FLOOR, Math.ceil((sim.value.unitsConsumed || CU_FLOOR) * CU_MARGIN)));
  const fee = await priorityFee(ixs);
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (fee > 0) budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }));
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [...budget, ...ixs] }).compileToV0Message());
  return { tx, blockhash, lastValidBlockHeight, unitsConsumed: sim.value.unitsConsumed, priorityFee: fee, logs: sim.value.logs };
}

export async function sendSigned(tx, { lastValidBlockHeight, label = 'tx' } = {}) {
  const raw = tx.serialize();
  const expected = bs58.encode(tx.signatures[0]);
  let signature;
  try {
    signature = await rpcCall((c) => c.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: COMMITMENT, maxRetries: 3 }), { label: `${label}:send`, timeoutMs: 30_000 });
  } catch (err) {
    if (/already been processed|AlreadyProcessed/i.test(String(err?.message || ''))) signature = expected;
    else if (isTransportError(err)) throw err;
    else throw new ProgramError(err, { logs: err.logs });
  }
  return confirmSignature(signature, { lastValidBlockHeight, label });
}

/** Confirmed status of `signature`, or null while it has not landed. Throws if it landed and failed. */
async function landedStatus(signature, label) {
  const st = await rpcCall((c) => c.getSignatureStatuses([signature], { searchTransactionHistory: true }), { label: `${label}:status`, attempts: 2, timeoutMs: 8000 });
  const v = st.value[0];
  if (!v || !(v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) return null;
  if (v.err) throw new ProgramError({ err: v.err, message: `transaction ${signature} failed` });
  return { ok: true, txHash: signature, slot: v.slot };
}

async function confirmSignature(signature, { lastValidBlockHeight, label }) {
  const started = Date.now();
  while (Date.now() - started < CONFIRM_TIMEOUT_MS) {
    try {
      const landed = await landedStatus(signature, label);
      if (landed) return landed;
      const height = await rpcCall((c) => c.getBlockHeight(COMMITMENT), { label: `${label}:height`, attempts: 2, timeoutMs: 8000 });
      if (height > lastValidBlockHeight) {
        // It may have landed between the status read and the height read: look once more.
        const late = await landedStatus(signature, label);
        if (late) return late;
        throw new Error(`${label}: transaction ${signature} expired (block height exceeded) before confirmation`);
      }
    } catch (err) {
      // An RPC hiccup while polling says nothing about the tx: keep polling until the deadline.
      if (!isTransportError(err) && !/all RPC endpoints failed/.test(err.message)) throw err;
      console.warn(`[tx] ${label}: polling ${signature} hit ${err.message.split('\n')[0]} — retrying`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: confirmation timed out after ${CONFIRM_TIMEOUT_MS / 1000}s (signature ${signature})`);
}

let _queue = Promise.resolve();

/** Build, simulate, sign with `keypair`, send, confirm. Serialised per process. */
export function sendIxs(keypair, ixs, label = 'tx') {
  const run = async () => {
    const built = await buildTx(ixs, keypair.publicKey, { label });
    built.tx.sign([keypair]);
    const result = await sendSigned(built.tx, { lastValidBlockHeight: built.lastValidBlockHeight, label });
    return { ...result, unitsConsumed: built.unitsConsumed, label };
  };
  const p = _queue.then(run, run);
  _queue = p.catch(() => {});
  return p;
}
