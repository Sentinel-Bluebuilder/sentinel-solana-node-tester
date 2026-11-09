// ─── Tester wallet ───────────────────────────────────────────────────────────
// One keypair, loaded from TEST_KEYFILE (solana-keygen JSON, 64 bytes). It pays
// every voucher channel the client containers open, receives the refunds, and
// signs the on-chain report memos. The secret never leaves this process except
// into a client container's scratch home for the duration of one session
// (see audit/session-runner.js), mirroring Node Manager's self-test.
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { rpcCall } from './solana/rpc.js';
import { ata } from './solana/program.js';
import { userByOwner, tdvpn } from './solana/accounts.js';

let _keypair = null;

export function keypairFromJson(text) {
  const arr = JSON.parse(String(text));
  if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('key file must be a JSON array of bytes');
  const bytes = Uint8Array.from(arr);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`key file must hold 64 (or 32) bytes, got ${bytes.length}`);
}

export function keypairToJson(kp) {
  return JSON.stringify(Array.from(kp.secretKey));
}

export function walletConfigured() {
  return !!(process.env.TEST_KEYFILE && process.env.TEST_KEYFILE.trim());
}

/** The tester keypair; throws a 503-shaped error when TEST_KEYFILE is unset or unreadable. */
export function getKeypair() {
  if (_keypair) return _keypair;
  const file = (process.env.TEST_KEYFILE || '').trim();
  if (!file) {
    const e = new Error('TEST_KEYFILE is not set — the tester has no wallet to pay sessions with');
    e.status = 503; e.errorCode = 'wallet-not-configured';
    throw e;
  }
  try {
    _keypair = keypairFromJson(readFileSync(file, 'utf8'));
  } catch (err) {
    const e = new Error(`TEST_KEYFILE ${file} could not be loaded: ${err.message}`);
    e.status = 503; e.errorCode = 'wallet-unreadable';
    throw e;
  }
  return _keypair;
}

export function walletAddress() {
  try { return getKeypair().publicKey.toBase58(); } catch (err) { return null; }
}

/** SOL + tDVPN (ATA) + program User balance, all as strings. */
export async function walletBalances() {
  const kp = getKeypair();
  const owner = kp.publicKey;
  const lamports = await rpcCall((c) => c.getBalance(owner, 'confirmed'), { label: 'wallet:sol' });
  let tokenBase = '0';
  try {
    const bal = await rpcCall((c) => c.getTokenAccountBalance(ata(owner), 'confirmed'), { label: 'wallet:ata', attempts: 2 });
    tokenBase = bal.value.amount;
  } catch (err) {
    // No ATA yet is a normal state for a wallet that has never held tDVPN.
    if (!/could not find account|Invalid param|TokenAccountNotFound/i.test(err.message)) throw err;
  }
  let userBalanceBase = '0';
  let openChannels = 0;
  const user = await userByOwner(owner.toBase58());
  if (user) { userBalanceBase = user.balance; openChannels = Number(user.openChannels || 0); }
  return {
    address: owner.toBase58(),
    ata: ata(owner).toBase58(),
    lamports,
    sol: (lamports / 1e9).toFixed(4),
    tokenBase,
    token: tdvpn(tokenBase),
    userBalanceBase,
    userBalance: tdvpn(userBalanceBase),
    openChannels,
  };
}

export { PublicKey };
