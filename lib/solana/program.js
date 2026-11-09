// ─── Anchor program + PDA helpers + instruction builders ─────────────────────
// Thin layer over @coral-xyz/anchor's Program. Every PDA that depends on an
// on-chain account is passed EXPLICITLY so building an instruction never
// triggers a hidden RPC fetch. The tester only ever signs as the wallet owner,
// so the optional `grant` account (cf4c372: a delegate signing for an owner) is always null.
//
// The tester's write surface is deliberately small: the client DAEMON opens
// channels (open_channel is part of `session start --new-channel`); this layer
// only needs the cleanup half — start_close_channel, close_channel,
// withdraw_user_balance — plus the SPL Memo for on-chain reports, and for plan
// runs open_subscription / close_subscription (the Cosmos plan test subscribes
// too: MsgStartSubscription).
import anchorPkg from '@coral-xyz/anchor';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { loadIdl, PROGRAM_ID, MINT } from './idl.js';
import { sendConnection, rpcCall } from './rpc.js';

const { Program, AnchorProvider, BN } = anchorPkg;
export { BN };

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const READ_ONLY_WALLET = {
  publicKey: PublicKey.default,
  signTransaction: async (t) => t,
  signAllTransactions: async (t) => t,
};

let _program = null;
/** Program bound to the current preferred RPC connection; only used to build ixs and decode. */
export function getProgram() {
  if (_program) return _program;
  const provider = new AnchorProvider(sendConnection(), READ_ONLY_WALLET, { commitment: 'confirmed' });
  _program = new Program(loadIdl(), provider);
  return _program;
}

export function coder() {
  return getProgram().coder.accounts;
}

// ─── PDAs ────────────────────────────────────────────────────────────────────
const enc = (s) => Buffer.from(s, 'utf8');
const key = (k) => (k instanceof PublicKey ? k : new PublicKey(k));
const id32 = (b) => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (buf.length !== 32) throw new Error(`id must be 32 bytes, got ${buf.length}`);
  return buf;
};

function find(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

export const pda = {
  config: () => find([enc('config')]),
  node: (owner, nodeId) => find([enc('node'), key(owner).toBuffer(), id32(nodeId)]),
  nodeUnbonding: (owner, nodeId) => find([enc('node_unbonding'), key(owner).toBuffer(), id32(nodeId)]),
  channel: (owner, channelId) => find([enc('channel'), key(owner).toBuffer(), id32(channelId)]),
  user: (owner) => find([enc('user'), key(owner).toBuffer()]),
  subscription: (owner, plan) => find([enc('subscription'), key(owner).toBuffer(), key(plan).toBuffer()]),
};

/** Token-2022 associated token account for `owner` on the dVPN mint. */
export function ata(owner) {
  return getAssociatedTokenAddressSync(MINT, key(owner), true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

// ─── Config (vault/treasury/params) — cached, it only changes by governance ──
let _config = null;
let _configAt = 0;
export async function fetchConfig({ maxAgeMs = 10 * 60_000 } = {}) {
  if (_config && Date.now() - _configAt < maxAgeMs) return _config;
  const addr = pda.config();
  const info = await rpcCall((c) => c.getAccountInfo(addr, 'confirmed'), { label: 'config' });
  if (!info) throw new Error(`Config account ${addr.toBase58()} not found on ${PROGRAM_ID.toBase58()}`);
  _config = coder().decode('config', info.data);
  _config.address = addr;
  _configAt = Date.now();
  return _config;
}

// ─── Instruction builders ────────────────────────────────────────────────────
export const ix = {
  /** Voucher channel: starts the close grace window (channel.close_started_at = now). */
  async startCloseChannel({ signer, channel }) {
    return getProgram().methods.startCloseChannel().accounts({
      signer: key(signer), config: pda.config(), channel: key(channel), grant: null,
    }).instruction();
  },
  /** `channelAcct` = decoded Channel (owner, node, rentRecipient). Credits escrow − redeemed to User.balance; rent goes back to rent_recipient. */
  async closeChannel({ signer, channel, channelAcct }) {
    return getProgram().methods.closeChannel().accounts({
      signer: key(signer),
      config: pda.config(),
      channel: key(channel),
      user: pda.user(channelAcct.owner),
      grant: null,
      node: key(channelAcct.node),
      rentRecipient: key(channelAcct.rentRecipient),
    }).instruction();
  },
  /** `userAcct` = decoded User (rentRecipient). Moves User.balance to the signer's token account (owner == signer). */
  async withdrawUserBalance({ signer, userAcct }) {
    const cfg = await fetchConfig();
    return getProgram().methods.withdrawUserBalance().accounts({
      signer: key(signer),
      config: pda.config(),
      owner: key(signer),
      grant: null,
      user: pda.user(signer),
      rentRecipient: key(userAcct.rentRecipient),
      ownerToken: ata(signer),
      vault: cfg.vault,
      mint: MINT,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    }).instruction();
  },
  /**
   * Buy a plan for `signer` (owner == signer). `planAcct` = decoded Plan: its terms are
   * passed back as the expected terms, so the program refuses the purchase if the
   * provider changed the plan in between (PlanTermsChanged). Priced plans pay from the
   * signer's token account into the vault; free plans omit the token accounts.
   * cb33092e: the last arg names who gets the subscription's rent back on close (the signer).
   */
  async openSubscription({ signer, plan, planAcct }) {
    const priced = BigInt(String(planAcct.price)) > 0n;
    const cfg = priced ? await fetchConfig() : null;
    return getProgram().methods.openSubscription(
      new BN(String(planAcct.price)), Number(planAcct.durationSeconds), Number(planAcct.dataCapGb), Number(planAcct.maxConnections),
      key(signer),
    ).accounts({
      signer: key(signer),
      rentPayer: key(signer),
      owner: key(signer),
      plan: key(plan),
      provider: key(planAcct.provider),
      config: pda.config(),
      subscription: pda.subscription(signer, plan),
      grant: null,
      ownerToken: priced ? ata(signer) : null,
      vault: priced ? cfg.vault : null,
      mint: priced ? MINT : null,
      tokenProgram: priced ? TOKEN_2022_PROGRAM_ID : null,
      systemProgram: SystemProgram.programId,
    }).instruction();
  },
  /** Owner closes its own subscription (any time; after expiry anyone may). Rent goes back to rent_recipient. */
  async closeSubscription({ signer, subscription, subAcct }) {
    return getProgram().methods.closeSubscription().accounts({
      signer: key(signer),
      subscription: key(subscription),
      rentRecipient: key(subAcct.rentRecipient),
      provider: null,
      grant: null,
    }).instruction();
  },
  /** SPL Memo v2 signed by `signer` (so getSignaturesForAddress(signer) finds it). */
  memo({ signer, text }) {
    return new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: key(signer), isSigner: true, isWritable: false }],
      data: Buffer.from(String(text), 'utf8'),
    });
  },
};

export { PROGRAM_ID, MINT, SystemProgram };
