// ─── Node discovery + probe ──────────────────────────────────────────────────
// Discovery is on-chain and nothing else: `getProgramAccounts` over Node
// accounts (sentinel-solana docs/11 "Discover nodes — Chain, not HTTP"). A
// listing is a fact about the chain, not about the daemon: it stays valid for
// node_listing_ttl_seconds after the last heartbeat, so "listed" is split into
// `listed` (status bit) and `listingFresh` (TTL not lapsed — what a real client
// sees). The probe then asks the daemon itself: /v1/metadata, signature checked
// against the on-chain owner, claims matched to the account, TLS pin recorded.
import { createHash } from 'node:crypto';
import net from 'node:net';
import { allNodes, nodeByPda, getConfig } from './solana/accounts.js';
import { PROGRAM_ID } from './solana/idl.js';
import { httpsRequest, verifyDomain, DOMAIN_NODE_METADATA, LEGACY_DOMAIN_NODE_METADATA } from './nodeapi.js';
import { cached, cacheInvalidate } from './cache.js';
import { countryNameToCode as countryCode, countryCodeToName as countryName } from '../core/countries.js';
import { STATUS_LISTED } from './constants.js';

const NODES_TTL_MS = 60_000;

function enrich(n, ttlSeconds, now) {
  const listedAt = Number(n.listedAt || 0);
  const expiresAt = listedAt ? listedAt + ttlSeconds : 0;
  const listed = Number(n.status) === STATUS_LISTED;
  return {
    address: n.address,
    owner: n.owner,
    nodeId: n.nodeId,
    status: Number(n.status),
    listed,
    listedAt,
    expiresAt,
    listingFresh: listed && expiresAt > now,
    uri: n.uri,
    countryCode: countryCode(n.country),
    country: countryName(n.country),
    protocols: Number(n.protocols),
    protocolNames: n.protocolNames,
    protocol: n.protocolNames[0] || null,
    pricePerGb: n.channelPricePerGb,
    pricePerHour: n.channelPricePerHour,
    leasePricePerHour: n.leasePricePerHour,
    bond: n.bond,
    revenue: n.revenue,
    openedAt: Number(n.openedAt || 0),
    rentRecipient: n.rentRecipient,
  };
}

/** Every Node account, enriched. Cached 60 s; `fresh` bypasses the cache. */
export async function discoverNodes({ fresh = false } = {}) {
  if (fresh) cacheInvalidate('nodes:all');
  return cached('nodes:all', NODES_TTL_MS, async () => {
    const [nodes, cfg] = await Promise.all([allNodes(), getConfig()]);
    const ttl = Number(cfg.nodeListingTtlSeconds);
    const now = Math.floor(Date.now() / 1000);
    return nodes.map((n) => enrich(n, ttl, now)).sort((a, b) => b.listedAt - a.listedAt);
  });
}

export async function discoverNode(address) {
  const [n, cfg] = await Promise.all([nodeByPda(address), getConfig()]);
  if (!n) return null;
  return enrich(n, Number(cfg.nodeListingTtlSeconds), Math.floor(Date.now() / 1000));
}

// ─── Probe ───────────────────────────────────────────────────────────────────
export function parseUri(uri) {
  try {
    const u = new URL(uri);
    return { host: u.hostname, port: Number(u.port) || 443, origin: `https://${u.hostname}:${Number(u.port) || 443}` };
  } catch (err) {
    return null;
  }
}

export function tcpReachable(host, port, timeoutMs = 6_000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Extract the raw `payload` JSON text (byte-exact) from a SignedMessage body. */
export function rawPayload(text) {
  const key = '"payload"';
  const k = text.indexOf(key);
  if (k < 0) return null;
  let i = text.indexOf(':', k + key.length);
  if (i < 0) return null;
  i += 1;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (text[i] !== '{') return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return text.slice(i, j + 1); }
  }
  return null;
}

/** Verify a SignedMessage body: ed25519(domain32 ‖ sha256(payload bytes)). Node metadata unless `dom` says otherwise. */
export function verifySignedMetadata(text, json, dom = DOMAIN_NODE_METADATA) {
  const raw = rawPayload(text);
  if (!raw || !json || !json.signature || !json.signer) return false;
  const digest = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest();
  try {
    return verifyDomain(json.signer, dom, digest, Buffer.from(json.signature, 'base64'));
  } catch (err) {
    return false;
  }
}

/**
 * Ask the daemon what it is. Never throws; returns a flat probe record the
 * pipeline folds into the result. `reachable` = TLS handshake + HTTP answer.
 */
export async function probeNode(node, { timeoutMs = 8_000, overrideOrigin = null } = {}) {
  const out = {
    reachable: false, httpStatus: null, latencyMs: null, tcpOpen: null,
    signatureValid: null, claimsMatch: null, signerIsOwner: null, metadataExpired: null,
    tlsSha256: null, tlsPinMatch: null, peers: null, maxPeers: null,
    reportedDownloadMbps: null, reportedUploadMbps: null, city: null, countryName: null,
    serviceType: null, sdkVersion: null, settlement: null, handshakeDns: null, legacyDaemon: null, error: null,
  };
  const target = overrideOrigin ? parseUri(overrideOrigin) : parseUri(node.uri);
  if (!target) { out.error = `node uri is not a URL: ${node.uri}`; return out; }
  out.tcpOpen = await tcpReachable(target.host, target.port, Math.min(timeoutMs, 6_000));
  if (!out.tcpOpen) { out.error = `TCP ${target.host}:${target.port} closed or filtered`; return out; }
  let res;
  try {
    res = await httpsRequest(`${target.origin}/v1/metadata`, { timeoutMs, captureCert: true });
  } catch (err) {
    out.error = `metadata request failed: ${err.message}`;
    return out;
  }
  out.httpStatus = res.status;
  out.latencyMs = res.latencyMs;
  out.tlsSha256 = res.certSha256;
  if (res.status !== 200 || !res.json) { out.error = `metadata HTTP ${res.status}`; return out; }
  out.reachable = true;
  const m = res.json.payload || {};
  out.signatureValid = verifySignedMetadata(res.text, res.json);
  // A daemon older than the program on chain (pre-cf4c372) signs under the old zero-padded
  // domain. Its signature is still invalid for this client; say why instead of "bad signature".
  out.legacyDaemon = !out.signatureValid && verifySignedMetadata(res.text, res.json, LEGACY_DOMAIN_NODE_METADATA);
  out.signerIsOwner = res.json.signer === node.owner;
  out.claimsMatch = m.node === node.address && m.owner === node.owner && m.program_id === PROGRAM_ID.toBase58();
  const now = Math.floor(Date.now() / 1000);
  out.metadataExpired = Number(m.expires_at || 0) > 0 && now >= Number(m.expires_at);
  const pin = m.api && m.api.tls_sha256 ? String(m.api.tls_sha256).toLowerCase() : null;
  out.tlsPinMatch = pin && out.tlsSha256 ? pin === out.tlsSha256.toLowerCase() : null;
  out.peers = m.peers ? Number(m.peers.current) : null;
  out.maxPeers = m.peers ? Number(m.peers.max) : null;
  if (m.bandwidth) {
    // bytes per second: cf4c372 names them *_bytes_per_second (older daemons: download / upload).
    const down = m.bandwidth.download_bytes_per_second ?? m.bandwidth.download ?? 0;
    const up = m.bandwidth.upload_bytes_per_second ?? m.bandwidth.upload ?? 0;
    out.reportedDownloadMbps = Math.round((Number(down) * 8 / 1e6) * 100) / 100;
    out.reportedUploadMbps = Math.round((Number(up) * 8 / 1e6) * 100) / 100;
  }
  if (m.location) {
    out.city = m.location.city || null;
    out.countryName = m.location.country ? countryName(m.location.country) : null;
  }
  out.serviceType = m.service && m.service.type ? String(m.service.type) : null;
  out.sdkVersion = m.sdk_version || null;
  out.handshakeDns = m.handshake_dns ?? null;
  out.settlement = m.settlement || null;
  if (out.legacyDaemon) out.error = 'node runs a dvpnd older than the program on chain (metadata signed under the pre-cf4c372 domain); this client cannot use it';
  else if (!out.signatureValid) out.error = 'metadata signature does not verify against the signer';
  else if (!out.claimsMatch) out.error = 'metadata claims do not match the on-chain node account';
  else if (out.tlsPinMatch === false) out.error = 'TLS certificate does not match the tls_sha256 pin in the signed metadata';
  else if (out.metadataExpired) out.error = 'metadata is expired';
  return out;
}
