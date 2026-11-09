// ─── IDL + network identity ──────────────────────────────────────────────────
// The single place that knows which network we talk to, which IDL describes it,
// and the ACCOUNT SIZES THE CHAIN ACTUALLY HOLDS.
//
// devnet: since 2026-11-02 the program runs upstream cb33092e (= public 26de5240);
// chain/idl/dvpn.devnet.json is that IDL with the devnet address (`scripts/patch-idl.mjs`).
// cb33 only renamed rent_payer → rent_recipient (same type and position), so the sizes below,
// checked against live accounts at cf4c372, still hold; a wrong size makes a dataSize filter
// return nothing SILENTLY, so they stay pinned here.
//
// Anchor keys accounts by camelCase name in its coder ('lease', 'grant'),
// while the IDL lists them PascalCase. Everything in this module speaks camelCase.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PublicKey } from '@solana/web3.js';

const here = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  devnet: {
    programId: 'J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs',
    mint: 'Hen2LVP6KooGaXEvdSyCHWghsEY4gLLn7wix8z6zHFSa',
    idl: 'dvpn.devnet.json',
    explorerCluster: 'devnet',
  },
  mainnet: {
    programId: '',
    mint: '',
    idl: 'dvpn.source.json',
    explorerCluster: '',
  },
};

export const NETWORK = (process.env.SOLANA_NETWORK || 'devnet').toLowerCase();
if (!DEFAULTS[NETWORK]) throw new Error(`SOLANA_NETWORK must be devnet or mainnet, got "${NETWORK}"`);

const programIdStr = process.env.DVPN_PROGRAM_ID || DEFAULTS[NETWORK].programId;
const mintStr = process.env.DVPN_MINT || DEFAULTS[NETWORK].mint;
if (!programIdStr || !mintStr) {
  throw new Error(`DVPN_PROGRAM_ID and DVPN_MINT must be set for network "${NETWORK}" (fails closed, like dvpnd's link-time identity)`);
}

export const PROGRAM_ID = new PublicKey(programIdStr);
export const MINT = new PublicKey(mintStr);
export const EXPLORER_CLUSTER = DEFAULTS[NETWORK].explorerCluster;
export const TOKEN_DECIMALS = 6;

let _idl = null;
export function loadIdl() {
  if (_idl) return _idl;
  const path = join(here, '..', '..', 'chain', 'idl', DEFAULTS[NETWORK].idl);
  const idl = JSON.parse(readFileSync(path, 'utf8'));
  idl.address = PROGRAM_ID.toBase58();
  _idl = idl;
  return idl;
}

/** camelCase account name → bytes the chain holds for that account (incl. 8-byte discriminator). */
export const DEPLOYED_SIZES = NETWORK === 'devnet'
  ? {
    channel: 299,
    config: 277,
    grant: 201,
    lease: 331,
    node: 337,
    nodeUnbonding: 153,
    plan: 155,
    provider: 313,
    providerUnbonding: 153,
    subscription: 198,
    user: 117,
  }
  : null; // mainnet: sizes come from the source IDL via coder.size()

const PASCAL = {
  channel: 'Channel',
  config: 'Config',
  grant: 'Grant',
  lease: 'Lease',
  node: 'Node',
  nodeUnbonding: 'NodeUnbonding',
  plan: 'Plan',
  provider: 'Provider',
  providerUnbonding: 'ProviderUnbonding',
  subscription: 'Subscription',
  user: 'User',
};

export const ACCOUNT_NAMES = Object.keys(PASCAL);

/** 8-byte Anchor discriminator for a camelCase account name. */
export function discriminator(name) {
  const pascal = PASCAL[name];
  if (!pascal) throw new Error(`unknown account ${name}`);
  const acc = loadIdl().accounts.find((a) => a.name === pascal);
  if (!acc) throw new Error(`IDL has no account ${pascal}`);
  return Buffer.from(acc.discriminator);
}

// ─── Byte offsets used by memcmp filters (8-byte discriminator included) ────
export const OFFSETS = {
  plan: { provider: 40 },
  provider: { owner: 40 },
  providerUnbonding: { owner: 40 },
  subscription: { owner: 8, plan: 40, provider: 72 },
  lease: { provider: 40, node: 72 },
  node: { owner: 40 },
  nodeUnbonding: { owner: 40 },
  // Channel: disc 8 + channel_id 32 → owner 40, node 72, opener 104
  channel: { owner: 40, node: 72, opener: 104 },
  user: { owner: 8 },
  // Grant: disc 8 → granter 8, grantee 40
  grant: { granter: 8, grantee: 40 },
};

// ─── Program constants (docs/03-PROGRAM-REFERENCE.md) ───────────────────────
export const STATUS_LISTED = 1;
export const STATUS_DELISTED = 0;
export const LEASE_STATUS_OPEN = 0;
export const LEASE_STATUS_CLOSING = 1;
export const MODE_VOUCHER = 0;
export const MODE_STREAM = 1;
export const ROLE_PROVIDER = 1;
export const ROLE_USER = 2;
// cb33092e bit per protocol (sentinel-go-sdk <protocol>/<protocol>.go `protocolBit`). The
// pre-cb33 table was xray 4, openvpn 8, hysteria2 16, amneziawg 32: decoding cb33 bits with it
// names 4 of the 6 protocols wrong (wg and v2ray happen to keep their bits).
export const PROTOCOL_BITS = [
  [1, 'wireguard'],
  [2, 'v2ray'],
  [4, 'openvpn'],
  [8, 'amneziawg'],
  [16, 'xray'],
  [32, 'hysteria2'],
];

export function protocolNames(mask) {
  return PROTOCOL_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name);
}
