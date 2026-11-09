// ─── On-chain node test report — encoder, decoder, broadcaster, querier ──────
// The tester is a performance oracle: every N finished nodes it posts an SPL
// Memo signed by the tester wallet, so any consumer can ingest results with a
// plain `getSignaturesForAddress(testerWallet)` — the memo text rides on the
// signature list itself, no transaction fetch, no off-chain API.
//
// Wire format v3 (plain ASCII CSV; successor of the Cosmos tester's v2):
//
//   Line 1 (header):  SNTR1|v3|<net>|<region>|b=<baselineMbps>|t=<unixSeconds>
//     net         devnet | mainnet
//     region      tester's 2-letter ISO country, "--" if unknown
//     baseline    tester's own direct-download Mbps, one decimal
//   Lines 2..N (one per node):  <nodePda>|<ok>|<mbps>|<peers>|<lat>|<proto>|<cc>
//     ok          1 = session carried traffic, 0 = failed
//     mbps        measured through the tunnel, one decimal; empty if ok=0
//     peers       concurrent users the node reported at test time
//     lat         ms for one request round trip through the tunnel (after the TLS
//                 handshake); empty if not measured
//     proto       protocol short code (wg, awg, v2, xr, ovpn, hy2)
//     cc          node's on-chain country
//
// A memo is ONE instruction in a v0 tx; the whole tx must fit 1232 bytes, so
// the memo is capped at MEMO_CHAR_LIMIT and the packer fits as many records as
// that allows (≤ MAX_RECORDS).
import { PublicKey } from '@solana/web3.js';
import { rpcCall } from './solana/rpc.js';
import { ix } from './solana/program.js';
import { sendIxs } from './solana/tx.js';
import { NETWORK } from './solana/idl.js';

const MAGIC = 'SNTR1';
const VERSION = 3;
const MAX_RECORDS = 12;
const MEMO_CHAR_LIMIT = 900;
const SEP = '|';
const NL = '\n';

const PROTO_CODE = { wireguard: 'wg', amneziawg: 'awg', v2ray: 'v2', xray: 'xr', openvpn: 'ovpn', hysteria2: 'hy2' };
const CODE_PROTO = Object.fromEntries(Object.entries(PROTO_CODE).map(([k, v]) => [v, k]));

function clampU16(n) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(0xffff, Math.round(n));
}

function fmtMbps(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  return (Math.round(n * 10) / 10).toFixed(1);
}

function fmtRegion(region) {
  const r = String(region || '').slice(0, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(r) ? r : '--';
}

function isPubkey(s) {
  try { new PublicKey(s); return typeof s === 'string' && s.length >= 32 && s.length <= 44; } catch (err) { return false; }
}

/** Per-node result row → record, or null when the row cannot be reported (skipped / malformed). */
export function resultToRecord(result) {
  if (!result || !isPubkey(result.address) || result.skipped) return null;
  const ok = result.actualMbps != null && !result.error;
  return {
    address: result.address,
    ok: ok ? 1 : 0,
    mbps: ok ? Number(result.actualMbps) : null,
    peers: clampU16(result.peers ?? 0),
    lat: clampU16(result.latencyMs ?? 0),
    proto: PROTO_CODE[result.protocol] || '',
    cc: fmtRegion(result.countryCode) === '--' ? '' : fmtRegion(result.countryCode),
  };
}

function buildHeader(ctx) {
  const t = ctx.startedAt instanceof Date ? Math.floor(ctx.startedAt.getTime() / 1000)
    : typeof ctx.startedAt === 'number' ? Math.floor(ctx.startedAt / 1000) : Math.floor(Date.now() / 1000);
  return [MAGIC, `v${VERSION}`, ctx.network || NETWORK, fmtRegion(ctx.region), `b=${fmtMbps(Number(ctx.baselineMbps) || 0)}`, `t=${t}`].join(SEP);
}

function buildRecordLine(rec) {
  return [rec.address, rec.ok ? '1' : '0', rec.ok && Number.isFinite(rec.mbps) ? fmtMbps(rec.mbps) : '', String(clampU16(rec.peers)), rec.lat ? String(clampU16(rec.lat)) : '', rec.proto || '', rec.cc || ''].join(SEP);
}

/** Greedy packer: as many records as fit under MEMO_CHAR_LIMIT (≤ MAX_RECORDS). */
export function packBatch(ctx, records) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('packBatch: need at least one record');
  const header = buildHeader(ctx);
  const lines = [header];
  let total = header.length;
  let packed = 0;
  for (let i = 0; i < Math.min(records.length, MAX_RECORDS); i++) {
    const line = buildRecordLine(records[i]);
    if (total + 1 + line.length > MEMO_CHAR_LIMIT) break;
    lines.push(line);
    total += 1 + line.length;
    packed++;
  }
  if (packed === 0) throw new Error(`packBatch: first record overflows the memo (header ${header.length} chars, limit ${MEMO_CHAR_LIMIT})`);
  return { memo: lines.join(NL), packed };
}

export function decodeMemo(memo) {
  if (typeof memo !== 'string' || !memo.startsWith(`${MAGIC}${SEP}v`)) return null;
  const lines = memo.split(NL);
  const h = lines[0].split(SEP);
  if (h[0] !== MAGIC || h[1] !== `v${VERSION}`) return null;
  const network = h[2] || null;
  const region = h[3] && h[3] !== '--' ? h[3] : null;
  let baselineMbps = 0;
  let startedAt = 0;
  for (const part of h.slice(4)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq); const v = part.slice(eq + 1);
    if (k === 'b') baselineMbps = Number(v) || 0;
    else if (k === 't') startedAt = Number(v) || 0;
  }
  const records = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const p = line.split(SEP);
    if (p.length < 5 || !isPubkey(p[0])) continue;
    const ok = p[1] === '1';
    records.push({
      address: p[0],
      ok,
      mbps: ok && p[2] !== '' ? Number(p[2]) : null,
      peers: Number(p[3]) || 0,
      latencyMs: p[4] !== '' ? (Number(p[4]) || 0) : null,
      protocol: CODE_PROTO[p[5] || ''] || null,
      countryCode: p[6] || null,
    });
  }
  return {
    version: VERSION, network, region, baselineMbps, startedAt,
    startedAtIso: startedAt ? new Date(startedAt * 1000).toISOString() : null,
    count: records.length, records,
  };
}

// ─── Broadcaster ─────────────────────────────────────────────────────────────
/** Post `memo` as an SPL Memo signed by the tester wallet. Returns { signature, slot, memoChars }. */
export async function commitBatch(keypair, memo) {
  if (typeof memo !== 'string' || !memo.length) throw new Error('commitBatch: memo must be a non-empty string');
  if (memo.length > MEMO_CHAR_LIMIT) throw new Error(`commitBatch: memo ${memo.length} chars exceeds limit ${MEMO_CHAR_LIMIT}`);
  const r = await sendIxs(keypair, [ix.memo({ signer: keypair.publicKey, text: memo })], 'report');
  return { signature: r.txHash, slot: r.slot, memoChars: memo.length };
}

// ─── Querier ─────────────────────────────────────────────────────────────────
/** Strip the "[len] " prefix RPC puts in front of a memo in signature listings. */
export function memoFromSignatureInfo(memoField) {
  if (typeof memoField !== 'string') return null;
  return memoField.replace(/^\[\d+\]\s*/, '');
}

/**
 * Past reports posted by `address` (default: any wallet), newest first.
 * Reads only the signature list — one RPC call per page, no transaction fetches.
 */
export async function queryReports(address, { limit = 20, before = undefined } = {}) {
  const pk = new PublicKey(address);
  const out = [];
  let cursor = before;
  for (let page = 0; page < 5 && out.length < limit; page++) {
    const sigs = await rpcCall((c) => c.getSignaturesForAddress(pk, { limit: 100, before: cursor }, 'confirmed'), { label: 'reports:sigs', timeoutMs: 20_000 });
    if (!sigs.length) break;
    for (const s of sigs) {
      const memo = memoFromSignatureInfo(s.memo);
      if (!memo) continue;
      const payload = decodeMemo(memo);
      if (!payload) continue;
      out.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime || null, err: s.err || null, payload });
      if (out.length >= limit) break;
    }
    cursor = sigs[sigs.length - 1].signature;
    if (sigs.length < 100) break;
  }
  return out;
}

export const SCHEMA = Object.freeze({ MAGIC, VERSION, MAX_RECORDS, MEMO_CHAR_LIMIT, SEP, PROTO_CODE });
