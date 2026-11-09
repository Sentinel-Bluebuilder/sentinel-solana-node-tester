#!/usr/bin/env node
// ─── Bandwidth lab: move devnet SOL / tDVPN between the test wallet and a lab key ───
// Lab nodes run under their own fresh key, so the shared test wallet's key never lands on a
// cloud VM. This funds that key (bond + fees) and sends what is left back at teardown.
//
//   node scripts/bwlab/fund.mjs --to <pubkey> --sol 0.3 --tdvpn 2            test wallet → lab key
//   node scripts/bwlab/fund.mjs --from-keyfile lab.json --to-test-wallet --all   lab key → test wallet
//   node scripts/bwlab/fund.mjs --balance <pubkey>
//
// Devnet only: refuses when the RPC URL does not look like devnet.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { getKeypair } from '../../lib/wallet.js';
import { MINT } from '../../lib/solana/idl.js';
import { ata } from '../../lib/solana/program.js';
import { sendIxs } from '../../lib/solana/tx.js';
import { sendConnection, rpcCandidates } from '../../lib/solana/rpc.js';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(name);

if (!rpcCandidates().every((u) => /devnet/i.test(u))) throw new Error('fund.mjs runs on devnet only (SOLANA_RPC_URLS must be devnet endpoints)');
const conn = sendConnection();
const mint = await getMint(conn, MINT, 'confirmed', TOKEN_2022_PROGRAM_ID);

async function balances(owner) {
  const lamports = await conn.getBalance(owner, 'confirmed');
  let base = 0n;
  try {
    base = BigInt((await conn.getTokenAccountBalance(ata(owner), 'confirmed')).value.amount);
  } catch (err) {
    if (!/could not find account|Invalid param/i.test(err.message)) throw err;
  }
  return { sol: lamports / LAMPORTS_PER_SOL, lamports, tdvpnBase: base };
}

if (opt('--balance')) {
  const b = await balances(new PublicKey(opt('--balance')));
  console.log(JSON.stringify({ sol: b.sol, tdvpnBase: String(b.tdvpnBase) }));
  process.exit(0);
}

const from = opt('--from-keyfile')
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(opt('--from-keyfile'), 'utf8'))))
  : getKeypair();
const to = flag('--to-test-wallet') ? getKeypair().publicKey : new PublicKey(opt('--to'));
if (from.publicKey.equals(to)) throw new Error('from and to are the same key');

const have = await balances(from.publicKey);
const FEE_RESERVE = 10_000; // lamports kept back for this transaction's fee
let base = flag('--all') ? have.tdvpnBase : BigInt(Math.round(Number(opt('--tdvpn', '0')) * 10 ** mint.decimals));
let lamports = flag('--all') ? null : Math.round(Number(opt('--sol', '0')) * LAMPORTS_PER_SOL);

const ixs = [];
if (base > 0n) {
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(from.publicKey, ata(to), to, MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
  ixs.push(createTransferCheckedInstruction(ata(from.publicKey), MINT, ata(to), from.publicKey, base, mint.decimals, [], TOKEN_2022_PROGRAM_ID));
}
if (lamports == null) {
  // --all: the token transfer above may create the destination account (rent paid by `from`).
  const rent = base > 0n ? 2_100_000 : 0;
  // A system account may hold 0 or at least the rent-exempt minimum, never in between.
  // The fee varies with the priority fee, so draining to exactly 0 can't be planned;
  // keep the minimum instead (~0.0009 SOL) so the transfer never fails on rent.
  const RENT_MIN = await conn.getMinimumBalanceForRentExemption(0);
  lamports = Math.max(0, have.lamports - FEE_RESERVE - rent - RENT_MIN);
}
if (lamports > 0) ixs.push(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
if (!ixs.length) { console.log('nothing to send'); process.exit(0); }

const r = await sendIxs(from, ixs, 'bwlab-fund');
console.log(JSON.stringify({ from: from.publicKey.toBase58(), to: to.toBase58(), sol: lamports / LAMPORTS_PER_SOL, tdvpnBase: String(base), signature: r.signature || r.txHash || null }));
