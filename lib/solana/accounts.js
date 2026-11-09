// ─── Account readers ─────────────────────────────────────────────────────────
// Chain is the node directory. Every reader is `getProgramAccounts` with an
// explicit DEPLOYED dataSize + discriminator memcmp (+ caller memcmps), decoded
// by Anchor's coder under the network's IDL, then normalised to plain JSON:
// pubkeys as base58, u64 as base-unit strings, ids as hex, byte strings as utf8.
//
// Never `program.account.X.all()`: that path can inject the SOURCE size and
// return [] on devnet with HTTP 200 (sentinel-solana docs/14 divergence 2).
import { PublicKey } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
import { rpcCall } from './rpc.js';
import { coder, pda, fetchConfig, PROGRAM_ID } from './program.js';
import { DEPLOYED_SIZES, discriminator, OFFSETS, protocolNames, TOKEN_DECIMALS } from './idl.js';

const { BN } = anchorPkg;
const bs58 = anchorPkg.utils.bytes.bs58;

export function accountSize(name) {
  return DEPLOYED_SIZES ? DEPLOYED_SIZES[name] : coder().size(name);
}

function norm(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof PublicKey) return v.toBase58();
  if (BN.isBN(v)) return v.toString(10);
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (Array.isArray(v)) return v.every((x) => typeof x === 'number') ? Buffer.from(v).toString('hex') : v.map(norm);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = norm(x);
    return out;
  }
  return v;
}

export function tdvpn(baseUnits) {
  const n = BigInt(String(baseUnits ?? '0'));
  const whole = n / 10n ** BigInt(TOKEN_DECIMALS);
  const frac = (n % 10n ** BigInt(TOKEN_DECIMALS)).toString().padStart(TOKEN_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function decodeTyped(name, data) {
  const raw = coder().decode(name, data);
  const out = norm(raw);
  if (name === 'node') {
    out.uri = Buffer.from(raw.uri.slice(0, raw.uriLen)).toString('utf8');
    delete out.uriLen;
    out.country = Buffer.from(raw.country).toString('utf8').replace(/\0+$/, '');
    out.protocolNames = protocolNames(raw.protocols);
  }
  delete out.reserved;
  return out;
}

export function decodeAccount(name, data) {
  return decodeTyped(name, data);
}

export async function fetchOne(name, address, { label } = {}) {
  const addr = new PublicKey(address);
  const info = await rpcCall((c) => c.getAccountInfo(addr, 'confirmed'), { label: label || `${name}:${addr.toBase58().slice(0, 6)}` });
  if (!info) return null;
  if (!info.owner.equals(PROGRAM_ID)) return null;
  const wrongType = () => {
    const e = new Error(`${addr.toBase58()} is not a ${name} account`);
    e.status = 400; e.errorCode = 'wrong-account-type';
    return e;
  };
  if (info.data.length !== accountSize(name)) throw wrongType();
  if (!Buffer.from(info.data.subarray(0, 8)).equals(Buffer.from(discriminator(name)))) throw wrongType();
  return { address: addr.toBase58(), ...decodeTyped(name, info.data) };
}

export async function fetchMany(name, memcmps = [], { label } = {}) {
  const filters = [
    { dataSize: accountSize(name) },
    { memcmp: { offset: 0, bytes: bs58.encode(discriminator(name)) } },
    ...memcmps.map(({ offset, pubkey }) => ({ memcmp: { offset, bytes: new PublicKey(pubkey).toBase58() } })),
  ];
  const rows = await rpcCall(
    (c) => c.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed', filters }),
    { label: label || `${name}:list`, timeoutMs: 30_000 },
  );
  return rows.map((r) => ({ address: r.pubkey.toBase58(), ...decodeTyped(name, r.account.data) }));
}

// ─── typed readers ───────────────────────────────────────────────────────────
export async function getConfig() {
  const c = await fetchConfig();
  return norm({ ...c, address: c.address });
}

export const allNodes = () => fetchMany('node', [], { label: 'nodes:all' });
export const nodeByPda = (addr) => fetchOne('node', addr);
export const nodesByOwner = (owner) => fetchMany('node', [{ offset: OFFSETS.node.owner, pubkey: owner }], { label: 'nodes:owner' });

export const channelsByOwner = (owner) => fetchMany('channel', [{ offset: OFFSETS.channel.owner, pubkey: owner }], { label: 'channels:owner' });
export const channelByPda = (addr) => fetchOne('channel', addr);

export const userByOwner = (owner) => fetchOne('user', pda.user(owner));

export { pda, PROGRAM_ID };
