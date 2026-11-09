/**
 * Sentinel Node Tester (Solana) — session helpers.
 * The Cosmos tester kept a session map, paid-node set and handshake credentials.
 * On Solana every test opens its own voucher channel inside the client
 * container, so these are no-ops kept for the shared retry/continuous code.
 */

export function clearCredential() {}
export function clearAllCredentials() {}
export function clearPoisonedSessions() {}
export function clearPaidNodes() {}
export function invalidateSessionCache() {}

/** Price in base units from a Cosmos-shaped price list ([{ denom, quote_value }]). */
export function parseNodePriceUdvpn(list) {
  const e = (list || []).find((p) => p.denom === 'tdvpn') || (list || [])[0];
  return e ? Math.round(Number(e.quote_value) || 0) : 0;
}
