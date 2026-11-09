/**
 * Sentinel Node Tester (Solana) — node status in the Cosmos `nodeStatusV3` shape.
 * Source: GET /v1/metadata, signature verified against the signer and claims
 * matched to the on-chain account (lib/discovery.js probeNode). Throws when the
 * node is unreachable or its metadata is invalid — same contract as Cosmos.
 */

import { probeNode, discoverNode, discoverNodes } from '../lib/discovery.js';

const DISPLAY = { wireguard: 'WireGuard', amneziawg: 'AmneziaWG', v2ray: 'V2Ray', xray: 'Xray', openvpn: 'OpenVPN', hysteria2: 'Hysteria2' };
export function protocolDisplayName(p) { return DISPLAY[p] || p || null; }

/** Short readable label for a node PDA (Solana nodes carry no moniker). */
export function nodeLabel(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
}

/** Probe record + Solana node → Cosmos status object. */
export function statusFromProbe(node, probe) {
  return {
    address: node.address,
    type: probe.serviceType || node.protocol,
    moniker: nodeLabel(node.address),
    peers: probe.peers ?? 0,
    bandwidth: {
      download: Math.round(((probe.reportedDownloadMbps || 0) * 1e6) / 8),
      upload: Math.round(((probe.reportedUploadMbps || 0) * 1e6) / 8),
    },
    location: {
      city: probe.city || '',
      country: probe.countryName || node.country || '',
      country_code: node.countryCode || '',
    },
    qos: { max_peers: probe.maxPeers ?? null },
    clockDriftSec: null,
    gigabyte_prices: [{ denom: 'tdvpn', quote_value: String(node.pricePerGb || '0') }],
    _probe: probe,
  };
}

/**
 * Why a reachable node's metadata cannot be trusted, or null. A TLS pin mismatch
 * (served certificate ≠ the one the node signed) is refused by the client at
 * session start — catching it here saves opening a channel for a doomed session.
 */
export function metadataProblem(probe) {
  if (probe.signatureValid === false) return probe.error || 'metadata signature does not verify against the signer';
  if (probe.claimsMatch === false) return probe.error || 'metadata claims do not match the on-chain node account';
  if (probe.tlsPinMatch === false) return 'TLS certificate does not match the tls_sha256 pin in the signed metadata';
  return null;
}

/** `remoteUrl` (Cosmos signature) or a Solana node object. */
export async function nodeStatusV3(target, opts = {}) {
  let node = target && typeof target === 'object' ? target : null;
  if (!node) {
    node = (await discoverNodes()).find((n) => n.uri === target) || null;
    if (!node) throw new Error(`no node on chain advertises ${target}`);
  } else if (!node.owner) {
    node = await discoverNode(node.address);
  }
  const probe = await probeNode(node, opts);
  if (!probe.reachable) throw new Error(probe.error || 'node unreachable');
  const problem = metadataProblem(probe);
  if (problem) {
    const e = new Error(problem);
    e.code = 'METADATA_INVALID';
    throw e;
  }
  return statusFromProbe(node, probe);
}
