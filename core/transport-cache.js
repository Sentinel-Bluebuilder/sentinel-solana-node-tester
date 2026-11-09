/**
 * Sentinel Node Tester (Solana) — transport cache.
 * The Cosmos tester learned which V2Ray transport/port worked per node. The
 * Solana client daemon picks the transport from the node's signed metadata,
 * so there is nothing to learn; the admin endpoint reports an empty cache.
 */

export function loadTransportCache() {}
export function saveTransportCache() {}
export function getCacheStats() {
  return { nodesCached: 0, transportStats: [], note: 'Solana: the dvpnd client selects the transport from signed node metadata' };
}
