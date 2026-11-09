/**
 * Sentinel Node Tester (Solana) — chain adapter.
 * Same names the shared server.js / continuous.js import from the Cosmos
 * core/chain.js. Discovery is `getProgramAccounts` over Node accounts
 * (lib/discovery.js); nodes are returned in the Cosmos node shape the pipeline
 * and dashboards expect: { address, remoteUrl, gigabyte_prices, hourly_prices, planIds }.
 */

import { discoverNodes } from '../lib/discovery.js';

const PROTO_TYPE = { wireguard: 1, v2ray: 2, xray: 3, openvpn: 4, hysteria2: 5, amneziawg: 6 };

/** Solana node (lib/discovery.js) → Cosmos-shaped node row. */
export function toCosmosNode(n) {
  return {
    address: n.address,
    remoteUrl: n.uri,
    remote_url: n.uri,
    remoteAddrs: [n.uri],
    gigabyte_prices: [{ denom: 'tdvpn', base_value: String(n.pricePerGb || '0'), quote_value: String(n.pricePerGb || '0') }],
    hourly_prices: [{ denom: 'tdvpn', base_value: String(n.pricePerHour || '0'), quote_value: String(n.pricePerHour || '0') }],
    planIds: [],
    status: n.listingFresh ? 'active' : 'inactive',
    type: PROTO_TYPE[n.protocol] || null,
    // Solana-native fields ride along for the pipeline's node test.
    _sol: n,
  };
}

/**
 * Every node a client could discover right now: listed AND listing not lapsed.
 * Delisted / expired nodes are invisible to real clients, exactly like an
 * inactive node on Cosmos.
 */
export async function getAllNodes(broadcast) {
  const nodes = await discoverNodes({ fresh: true });
  const live = nodes.filter((n) => n.listingFresh);
  if (typeof broadcast === 'function') {
    broadcast('log', { msg: `🔍 Chain: ${nodes.length} node accounts · ${nodes.filter((n) => n.listed).length} listed · ${live.length} with a live listing` });
  }
  return live.map(toCosmosNode);
}

/** All node accounts (incl. expired / delisted), Cosmos-shaped. */
export async function getAllNodeAccounts() {
  return (await discoverNodes({ fresh: true })).map(toCosmosNode);
}

// LCD/RPC lifecycle hooks the Cosmos server calls — no-ops on Solana (the RPC pool self-heals).
export async function ensureLcd() { return null; }
export function getActiveLcd() { return null; }
export function cleanupRpc() {}
export async function withFreshRpc(fn) { return fn(null); }

// ─── Subscription plans (lib/plans.js has the Cosmos → Solana mapping) ──────
// planId = Plan PDA · subscriptionId = Subscription PDA · granter = Provider PDA.

/** Listed plans, Cosmos shape { id, provAddress, status }. */
export async function discoverPlans() {
  const { listedPlans } = await import('../lib/plans.js');
  return (await listedPlans()).map((p) => ({ id: p.address, provAddress: p.provider, status: 'active', price: p.price, durationSeconds: p.durationSeconds, dataCapGb: p.dataCapGb, maxConnections: p.maxConnections, subscribers: 0 }));
}

/** The wallet's subscriptions, Cosmos shape { id, plan_id, status, expiry, ownerAddress }. */
export async function querySubscriptions(walletAddress) {
  if (!walletAddress) return [];
  const { subscriptionsOf } = await import('../lib/plans.js');
  return (await subscriptionsOf(walletAddress)).map((s) => ({
    id: s.address, plan_id: s.plan, status: s.active ? 'active' : 'inactive',
    expiry: new Date(Number(s.expiresAt) * 1000).toISOString(), ownerAddress: s.owner,
    provider: s.provider, dataCapGb: s.dataCapGb, maxConnections: s.maxConnections,
  }));
}

/**
 * Active subscriptions with what the Sub. Plan picker shows. Ticket sessions need
 * no gas, so the "can test" gate is the provider being listed with a verified API:
 * feeGrantActive carries that, selfGranter = the wallet owns the provider.
 */
export async function querySubscriberPlansEnriched(walletAddress) {
  if (!walletAddress) return [];
  const { subscriptionsOf, providerApi, planRoster } = await import('../lib/plans.js');
  const subs = (await subscriptionsOf(walletAddress)).filter((s) => s.active);
  const out = [];
  for (const s of subs) {
    let nodeCount = 0; let providerOk = false; let providerOwner = null; let rosterError = null;
    try {
      const api = await providerApi(s.provider);
      providerOk = api.provider.listed;
      providerOwner = api.provider.owner;
      nodeCount = (await planRoster(s.provider, s.plan, { api })).filter((n) => n.live).length;
    } catch (err) {
      rosterError = err.message;
      console.warn(`[sub-plans] provider ${s.provider} for plan ${s.plan}: ${err.message}`);
    }
    out.push({
      subscriptionId: s.address,
      planId: s.plan,
      ownerSentAddr: s.provider,
      expiry: new Date(Number(s.expiresAt) * 1000).toISOString(),
      feeGrantActive: providerOk,
      feeGrantCheckFailed: !!rosterError,
      selfGranter: providerOk && providerOwner === walletAddress,
      nodeCount,
      viaAllocation: false,
      grantedBytes: s.dataCapGb ? String(BigInt(s.dataCapGb) * 1_000_000_000n) : null,
      subOwnerAddress: s.owner,
      rosterError,
    });
  }
  return out;
}

/**
 * The loop's "fee grant" gate for subscription mode. Solana ticket sessions cost no
 * gas; what has to hold instead is that the granter (the provider) exists, is listed
 * and serves a verified API. Returns a truthy record, or null.
 */
export async function queryFeeGrantRpcFirst(_client, _lcd, granter) {
  const { providerApi } = await import('../lib/plans.js');
  try {
    const api = await providerApi(granter);
    return api.provider.listed ? { exists: true, ticketed: true, provider: granter } : null;
  } catch (err) {
    console.warn(`[chain] provider ${granter} check failed: ${err.message}`);
    return null;
  }
}

export async function fetchPlanMembership() { return new Map(); }
