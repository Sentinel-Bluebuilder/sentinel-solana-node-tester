// ─── Plans, subscriptions and plan rosters ───────────────────────────────────
// The Solana side of the Cosmos tester's "Subscription Plan" mode.
//
// On Cosmos a plan run starts each session with a subscription-allocated
// MsgStartSession (gas fee-granted by the plan owner). On Solana a plan belongs
// to a PROVIDER; a subscriber holds a Subscription account and starts each
// session with an off-chain access ticket: the client signs a ticket request,
// the node forwards it to the provider, the provider checks the subscription
// and its roster and signs a ticket. No transaction and no gas per session.
// (sentinel-solana docs/21-COSMOS-PARITY.md, "MsgStartSession (subscription)".)
//
// Field mapping onto the Cosmos UI (which stays byte-identical):
//   planId          → Plan PDA
//   subscriptionId  → Subscription PDA (one per owner + plan)
//   granter         → Provider PDA (the ticket issuer — nobody grants gas)
//
// Which nodes a plan covers is the provider's ROSTER, served by the provider's
// public API (GET /v1/plans/{plan}/nodes). The provider's address comes from
// its on-chain account; its metadata signature, owner and TLS pin are checked
// before the roster is trusted.
import { fetchMany, fetchOne } from './solana/accounts.js';
import { OFFSETS, STATUS_LISTED } from './solana/idl.js';
import { httpsRequest, DOMAIN_PROVIDER_METADATA, LEGACY_DOMAIN_PROVIDER_METADATA } from './nodeapi.js';
import { verifySignedMetadata, parseUri } from './discovery.js';

/** PROVIDER_API_OVERRIDES=<providerPda>=https://host:port,… — lab providers whose advertised URI is not routable from here. */
export function parseProviderOverrides(raw = process.env.PROVIDER_API_OVERRIDES || '') {
  const map = new Map();
  for (const part of String(raw).split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const pda = part.slice(0, eq).trim();
    const url = part.slice(eq + 1).trim();
    if (pda && /^https?:\/\//.test(url)) map.set(pda, url.replace(/\/+$/, ''));
  }
  return map;
}

function providerUri(p) {
  const bytes = Buffer.from(p.uri, 'hex');
  return bytes.subarray(0, Number(p.uriLen)).toString('utf8');
}

export async function providerAccount(address) {
  const p = await fetchOne('provider', address);
  if (!p) return null;
  return { ...p, uri: providerUri(p), listed: Number(p.status) === STATUS_LISTED };
}

export const planAccount = (address) => fetchOne('plan', address);
export const subscriptionAccount = (address) => fetchOne('subscription', address);

/** Every listed plan on chain (Cosmos `discoverPlans` shape). */
export async function listedPlans() {
  const plans = await fetchMany('plan', [], { label: 'plans:all' });
  return plans.filter((p) => Number(p.status) === STATUS_LISTED);
}

/** Subscriptions owned by `owner`, newest first, with `active` = not yet expired. */
export async function subscriptionsOf(owner, now = Math.floor(Date.now() / 1000)) {
  const subs = await fetchMany('subscription', [{ offset: OFFSETS.subscription.owner, pubkey: owner }], { label: 'subs:owner' });
  return subs
    .map((s) => ({ ...s, active: Number(s.expiresAt) > now }))
    .sort((a, b) => Number(b.openedAt) - Number(a.openedAt));
}

/**
 * The provider's verified API origin. Reads its signed /v1/metadata and checks:
 * the signature verifies, the signer is the provider's owner or its declared
 * operator, the owner matches the chain, and the TLS certificate is the one the
 * metadata pins. Returns { origin, tlsSha256, metadata }.
 */
export async function providerApi(providerPda, { overrides = parseProviderOverrides(), timeoutMs = 8_000 } = {}) {
  const p = await providerAccount(providerPda);
  if (!p) throw Object.assign(new Error(`provider ${providerPda} not found on chain`), { errorCode: 'PROVIDER_NOT_FOUND' });
  const origin = overrides.get(providerPda) || parseUri(p.uri)?.origin;
  if (!origin) throw Object.assign(new Error(`provider ${providerPda} advertises no usable URI ("${p.uri}")`), { errorCode: 'PROVIDER_NO_URI' });
  const res = await httpsRequest(`${origin}/v1/metadata`, { timeoutMs, captureCert: true });
  if (res.status !== 200 || !res.json?.payload) throw Object.assign(new Error(`provider metadata HTTP ${res.status} from ${origin}`), { errorCode: 'PROVIDER_UNREACHABLE' });
  const m = res.json.payload;
  const signer = res.json.signer;
  const problems = [];
  if (!verifySignedMetadata(res.text, res.json, DOMAIN_PROVIDER_METADATA)) {
    problems.push(verifySignedMetadata(res.text, res.json, LEGACY_DOMAIN_PROVIDER_METADATA)
      ? 'provider runs a dvpnd older than the program on chain (metadata signed under the pre-cf4c372 domain)'
      : 'signature does not verify');
  }
  if (m.owner !== p.owner) problems.push(`owner ${m.owner} ≠ on-chain owner ${p.owner}`);
  if (signer !== p.owner && signer !== m.operator) problems.push(`signer ${signer} is neither the owner nor the declared operator`);
  const pin = m.api?.tls_sha256 ? String(m.api.tls_sha256).toLowerCase() : null;
  if (!pin || !res.certSha256 || pin !== res.certSha256.toLowerCase()) problems.push('TLS certificate does not match the pinned tls_sha256');
  if (problems.length) throw Object.assign(new Error(`provider ${providerPda} metadata rejected: ${problems.join('; ')}`), { errorCode: 'PROVIDER_METADATA_INVALID' });
  return { origin, tlsSha256: pin, metadata: m, provider: p };
}

/**
 * Why did a node answer `ticket_invalid`? The node flattens every provider refusal
 * into that one code, so ask the provider ourselves (pinned TLS) with the same
 * subscription and node:
 *   409 → 'connection-limit'  every plan connection is held by a live ticket (tickets
 *                              live up to the provider's max TTL, 24 h by default)
 *   402 → 'credit-exhausted'   the subscription's data allowance is used up
 *   4xx → 'refused'            the provider's verdict (node not on the roster, subscription invalid …)
 *   200 → 'node'               the provider DOES issue tickets for this node, so the node rejected it
 *                              (this diagnostic ticket then holds one connection until it expires)
 * Returns { verdict, status, reason }.
 */
export async function diagnoseTicketRefusal(keypair, { provider, subscription, node }, deps = {}) {
  const api = deps.api || await providerApi(provider);
  const request = deps.requestTicket || (await import('./nodeapi.js')).requestTicket;
  try {
    await request(keypair, api.origin, { subscription, node, provider }, { pinSha256: api.tlsSha256 });
    return { verdict: 'node', status: 200, reason: 'the provider issues tickets for this node' };
  } catch (err) {
    const raw = err.providerResponse;
    const reason = typeof raw === 'object' && raw ? JSON.stringify(raw.error ?? raw).slice(0, 200) : String(raw || err.message).slice(0, 200);
    const status = Number(err.status) || null;
    // Provider error codes (sentinel-go-sdk api/error.go): peer_limit_reached = 409, credit_exhausted = 402.
    if (/peer_limit_reached/i.test(reason) || status === 409) return { verdict: 'connection-limit', status, reason };
    if (/credit_exhausted/i.test(reason)) return { verdict: 'credit-exhausted', status, reason };
    if (err.errorCode === 'ticket-refused' || err.errorCode === 'ticket-unauthenticated') return { verdict: 'refused', status, reason };
    return { verdict: 'unknown', status, reason: `${err.message}`.slice(0, 200) };
  }
}

/** Roster of one plan: [{ node, live, probedAt, lease }]. Read over the pinned TLS connection. */
export async function planRoster(providerPda, planPda, opts = {}) {
  const api = opts.api || await providerApi(providerPda, opts);
  const res = await httpsRequest(`${api.origin}/v1/plans/${planPda}/nodes`, { timeoutMs: opts.timeoutMs || 8_000, pinSha256: api.tlsSha256 });
  if (res.status !== 200 || !Array.isArray(res.json?.nodes)) {
    throw Object.assign(new Error(`provider roster for plan ${planPda}: HTTP ${res.status} ${String(res.text || '').slice(0, 160)}`), { errorCode: 'PROVIDER_ROSTER_FAILED' });
  }
  return res.json.nodes.map((n) => ({ node: String(n.node), live: !!n.live, probedAt: Number(n.probed_at || 0), lease: n.lease || null }));
}
