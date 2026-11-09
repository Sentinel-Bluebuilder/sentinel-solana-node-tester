/**
 * Sentinel Node Tester (Solana) — Single Node Test
 *
 * Same contract as the Cosmos tester's audit/node-test.js: returns a TestResult
 * (Cosmos shape, so every dashboard renders it unchanged) or THROWS an Error
 * carrying `.diag`, `.errorCode` and `.stage` for a failure; the pipeline turns
 * a throw into a FAIL row with a copyable failure log.
 *
 * Flow: (status already probed by the scan) → TEST RUN short-circuit → paid
 * session in a throwaway dvpnd client container (audit/session-runner.js) →
 * score against the tester baseline.
 */

import { runSessionTest } from './session-runner.js';
import { closeStreamChannel } from './channels.js';
import { diagnoseTicketRefusal } from '../lib/plans.js';

/** Session-start errors that may be a provider refusal of the plan ticket (then the provider is asked). */
export const TICKET_REFUSAL_RE = /ticket_invalid|ticket is not valid|peer_limit_reached|credit_exhausted/i;
import { recordChannel } from '../lib/db.js';
import { parseUri } from '../lib/discovery.js';
import { protocolDisplayName } from '../protocol/v3protocol.js';
import { ERR } from '../lib/constants.js';
import { steadyConfig, steadyLab, steadyResult, originReachable } from '../lib/speed-method.js';

/** Protocols the client container can run here. AmneziaWG needs nft fib for IPv6. */
export function clientSupports(protocol, caps) {
  if (!protocol) return false;
  if (protocol === 'amneziawg') return !!caps?.nftFibIpv6;
  return ['wireguard', 'v2ray', 'xray', 'openvpn', 'hysteria2'].includes(protocol);
}

/** NODE_URI_OVERRIDES=<pda>=<host>[:port],… → Map(pda → { host, port }). */
export function parseOverrides(raw = process.env.NODE_URI_OVERRIDES || '') {
  const map = new Map();
  for (const part of String(raw).split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const pda = part.slice(0, eq).trim();
    const [host, port] = part.slice(eq + 1).trim().split(':');
    if (pda && host) map.set(pda, { host, port: port ? Number(port) : null });
  }
  return map;
}

// Where the laptop itself reaches an overridden node. Containers use the override
// host as given; "host.docker.internal" means "this machine", so the laptop dials
// 127.0.0.1 on the same port (WSL rig node, or an SSH tunnel to a remote box).
export function probeOrigin(o) {
  if (!o) return null;
  const host = o.host === 'host.docker.internal' ? '127.0.0.1' : o.host;
  return `https://${host}:${o.port || 443}`;
}

function osName() {
  return process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
}

export function baseFields(node, status, ctx) {
  const sol = node._sol || {};
  const proto = status?.type || sol.protocol;
  return {
    timestamp: new Date().toISOString(),
    address: node.address,
    type: protocolDisplayName(proto),
    moniker: status?.moniker || '',
    country: status?.location?.country || sol.country || '',
    countryCode: status?.location?.country_code || sol.countryCode || '',
    city: status?.location?.city || '',
    reportedDownloadMbps: status?.bandwidth ? parseFloat(((status.bandwidth.download * 8) / 1_000_000).toFixed(2)) : 0,
    peers: status?.peers ?? null,
    maxPeers: status?.qos?.max_peers ?? null,
    gigabytePrices: node.gigabyte_prices || [],
    sdk: 'dvpnd',
    os: osName(),
    inPlan: false,
    planIds: [],
    protocol: proto,
    uri: sol.uri || node.remoteUrl,
    owner: sol.owner || null,
    baselineAtTest: ctx.baselineMbps ?? null,
  };
}

function fail(message, { errorCode, stage, diag = {} }) {
  const e = new Error(message);
  e.errorCode = errorCode;
  e.stage = stage;
  e.diag = diag;
  return e;
}

/**
 * @param {object} node    Cosmos-shaped node from core/chain.js (Solana node on node._sol)
 * @param {object} status  Cosmos-shaped status from protocol/v3protocol.js (probe on status._probe)
 * @param {object} ctx     { keypair, rpcUrl, settings, caps, baselineMbps, testRun, runId, overrides, broadcast, state }
 */
export async function testNode(node, status, ctx) {
  const broadcast = ctx.broadcast || (() => {});
  const sol = node._sol;
  const probe = status?._probe || null;
  const protocol = status?.type || sol?.protocol;
  const base = baseFields(node, status, ctx);
  const t0 = Date.now();

  ctx.state.currentType = base.type;
  ctx.state.currentLocation = [base.city, base.country].filter(Boolean).join(', ') || base.countryCode || '';
  broadcast('progress', { state: ctx.state });

  // ─── TEST RUN: skip-only demo. Never touches chain, never spends. ───
  if (ctx.testRun) {
    broadcast('log', { msg: '  🧪 TEST RUN — skipping payment + handshake + speedtest.' });
    return {
      ...base,
      actualMbps: null,
      skipped: true,
      error: 'TEST_RUN_SKIP',
      errorCode: 'TEST_RUN_SKIP',
      ispBottleneck: false,
      baselineViable: ctx.baselineMbps != null && ctx.baselineMbps >= 30,
      dynamicThreshold: null,
      slaApplicable: false,
      pass15mbps: false,
      pass10mbps: false,
      passBaseline: false,
      googleAccessible: null,
      googleLatencyMs: null,
    };
  }

  if (!clientSupports(protocol, ctx.caps)) {
    throw fail(`${protocolDisplayName(protocol) || 'Unknown protocol'} client cannot run on this machine${protocol === 'amneziawg' ? ' (kernel lacks nft_fib_ipv6, needed by the AmneziaWG kill switch)' : ''}`,
      { errorCode: ERR.PROTOCOL_UNSUPPORTED, stage: 'client', diag: { protocol } });
  }

  const override = ctx.overrides?.get(node.address) || null;
  // How this session pays: ticket (plan run), stream channel (per hour) or voucher channel (per GB).
  const pricing = ctx.ticket ? 'ticket' : ctx.pricingMode === 'hours' ? 'hours' : 'gigabytes';
  const costLabel = pricing === 'ticket' ? `plan ticket (subscription ${ctx.ticket.subscription.slice(0, 8)}…)`
    : pricing === 'hours' ? `${sol?.pricePerHour ?? 0} base/hour` : `${sol?.pricePerGb ?? 0} base/GB`;
  broadcast('log', { msg: `→ ${base.type} | ${base.city ? base.city + ', ' : ''}${base.country || base.countryCode || '—'} | ${base.reportedDownloadMbps.toFixed(1)} Mbps | Cost: ${costLabel}` });
  if (ctx.ticket) { base.inPlan = true; base.planIds = [ctx.ticket.plan]; }

  // Steady speed method (lib/speed-method.js): opt-in, and never on top of a lab session.
  let steady = null;
  if (!ctx.lab) {
    try {
      steady = steadyConfig();
    } catch (err) {
      // A tester misconfiguration must never count against the node: keep the classic method.
      broadcast('log', { msg: `  ⚠ ${err.message} — classic speed method used` });
    }
  }
  const prepayForTest = pricing === 'gigabytes'
    ? Math.min(ctx.settings?.prepayBytes || 1e9, probe?.settlement?.prepay_limits?.max_bytes ? Number(probe.settlement.prepay_limits.max_bytes) : Infinity)
    : null;
  let s;
  try {
    s = await runSessionTest({
      node: sol,
      probe,
      keypair: ctx.keypair,
      rpcUrl: ctx.rpcUrl,
      // The steady block adds ~10 latency probes + the timed download: give the container that time.
      settings: steady ? { ...ctx.settings, clientTimeoutSec: (ctx.settings?.clientTimeoutSec || 360) + steady.seconds + 30 } : ctx.settings,
      pricing,
      ticket: ctx.ticket || null,
      // Bandwidth lab only (scripts/bwlab): extra measurements inside the same session.
      lab: ctx.lab || (steady ? steadyLab(steady, { prepayBytes: prepayForTest }) : null),
      override: override ? { host: override.host, port: override.port || parseUri(sol.uri)?.port || 443 } : null,
      onLine: (line) => {
        if (/^(STEP|REACH|SID|PROXY|DL_TRY|DOWNLOAD|CONNECTIVITY|FAIL|UNSUPPORTED)/.test(line)) broadcast('log', { msg: `  ${line.trim()}` });
      },
      onChannel: (address, escrow) => {
        recordChannel({ address, node_addr: node.address, run_id: ctx.runId, escrow_base: Number(escrow) });
        broadcast('log', { msg: `  Channel ${address} opened (escrow ${escrow})` });
      },
    });
  } catch (err) {
    throw fail(`client container could not run: ${err.message}`, { errorCode: ERR.DOCKER_UNAVAILABLE, stage: 'client' });
  }
  if (s.channel) recordChannel({ address: s.channel, node_addr: node.address, run_id: ctx.runId, escrow_base: Number(s.escrowBase) });

  // A stream channel bills until it is closed: close it now, pass or fail, and
  // book what the elapsed time actually cost. A failed close stays tracked and
  // the sweep closes it later.
  if (pricing === 'hours' && s.channel && ctx.keypair) {
    try {
      const c = await closeStreamChannel(ctx.keypair, s.channel, { log: (m) => broadcast('log', { msg: `  ${m}` }) });
      if (c.redeemedBase != null) s.spentBase = c.redeemedBase;
      s.streamClose = c;
    } catch (err) {
      broadcast('log', { msg: `  ⚠ closing stream channel ${s.channel} failed: ${err.message} — the sweep closes it` });
    }
  }

  const diag = {
    remoteUrl: sol.uri,
    latencyMs: s.rttMs || s.connectivityMs || s.ttfbMs,
    handshakeOk: !!s.sessionId,
    sessionId: s.sessionId,
    channel: s.channel,
    steps: s.steps,
    reachMs: s.reachMs,
    attempts: s.attempts,
    ttfbMs: s.ttfbMs,
    totalMs: s.totalMs,
    clientRxBytes: s.clientRxBytes,
    clientTxBytes: s.clientTxBytes,
    stopRc: s.stopRc ?? null,
    stopError: s.stopError || null,
    afterStop: s.afterStop || null,
    routesLeft: s.routesLeft ?? null,
    clientRxAfterStop: s.clientRxAfterStop ?? null,
    clientTxAfterStop: s.clientTxAfterStop ?? null,
    uploadedBytes: s.uploadedBytes ?? null,
    escrowBase: s.escrowBase,
    prepayBytes: s.prepayBytes,
    committedBase: s.committedBase,
    pricing: s.pricing,
    ticketHash: s.ticketHash || null,
    ticketReused: s.ticketReused || null,
    ticketReuseFailed: s.ticketReuseFailed || false,
    streamCloseTx: s.streamClose?.txHash || null,
    proxy: s.proxy,
    probe: probe ? { tlsPinMatch: probe.tlsPinMatch, signatureValid: probe.signatureValid, claimsMatch: probe.claimsMatch, sdkVersion: probe.sdkVersion } : null,
    // The client config the session ran with (prepay_bytes, dns_servers, kill_switch …).
    clientConfig: s.cfg || {},
    clientLog: s.log,
    transcript: s.transcript,
    ...(s.labOutput && ctx.lab ? { labOutput: s.labOutput } : {}),
  };
  // The steady method's reading replaces the classic one when it verified; a content mismatch
  // fails the node (it changed the bytes); a method that could not run keeps the classic reading.
  // A classic download that failed on the third-party host does not fail a node whose verified
  // steady download worked (lab round 4: Hetzner crawled at 1 Mbps while the tunnel did 22).
  const classicSourceFailed = s.errorCode === ERR.SPEED_SOURCE_UNAVAILABLE || s.errorCode === ERR.TUNNEL_NO_TRAFFIC;
  if (steady && s.labOutput && (s.ok || classicSourceFailed)) {
    const st = steadyResult(s.labOutput || '', steady);
    diag.speedMethod = { ...st, classicMbps: s.mbps, classicLatencyMs: s.rttMs || s.connectivityMs || s.ttfbMs };
    if (st.verified === false) {
      s.ok = false;
      s.stage = 'download';
      s.errorCode = ERR.SPEED_CONTENT_TAMPERED;
      s.error = `the speed test through this node was tampered with: ${st.tamper} — the bytes or the TLS key that reached the client are not our origin's`;
    } else if (st.ok) {
      if (!s.ok) {
        diag.speedMethod.classicError = { errorCode: s.errorCode, error: s.error };
        Object.assign(s, { ok: true, stage: 'done', errorCode: null, error: null, downloadedBytes: st.payloadBytes });
      }
      s.mbps = st.mbps;
      if (st.idleLatency?.medianMs != null) s.rttMs = Math.round(st.idleLatency.medianMs);
      broadcast('log', { msg: `  Steady method: ${st.mbps} Mbps payload, ${st.lineMbps ?? '—'} Mbps line (${st.streams} streams, p90 ${st.p90Mbps}, classic ${diag.speedMethod.classicMbps}) · idle latency ${st.idleLatency?.medianMs} ms${st.falling ? ' · ⚠ falling trend' : ''}` });
    } else {
      // Nothing usable came through the node. If our origin answers directly from here, the node
      // blocked it (lab round 8: blocking it falls back to the classic reading, which a burst-
      // then-throttle node fools). Flagged on the result; whether it fails the node is the owner's call.
      if (st.verified == null) diag.speedMethod.originBlocked = await originReachable(steady);
      broadcast('log', { msg: `  Steady method unavailable (${st.reason})${diag.speedMethod.originBlocked ? ' — ⚠ our speed origin answers directly but not through this node (blocked)' : ''} — classic reading kept` });
    }
  }
  // Plan sessions: older nodes report every provider refusal as `ticket_invalid`; cb33 nodes
  // pass the provider's code through (`peer_limit_reached`, `credit_exhausted`). Either way,
  // ask the provider why before blaming anyone — a full connection allowance or a used-up
  // data cap is the subscription's state, not a node fault.
  if (!s.ok && pricing === 'ticket' && s.errorCode === ERR.SESSION_START_FAIL && TICKET_REFUSAL_RE.test(s.error || '')) {
    try {
      const d = await diagnoseTicketRefusal(ctx.keypair, { provider: ctx.ticket.provider, subscription: ctx.ticket.subscription, node: node.address });
      diag.ticketDiagnosis = d;
      broadcast('log', { msg: `  🔎 Provider check: ${d.verdict} (HTTP ${d.status ?? '—'}) ${d.reason}` });
      if (d.verdict === 'connection-limit') {
        s.errorCode = ERR.PLAN_CONNECTION_LIMIT;
        s.error = `the plan's connection allowance is in use: every connection of this subscription is held by a live ticket (a ticket lasts until the provider's ticket limit, 24 h by default, or the subscription's expiry) — not a node fault (provider: ${d.reason})`;
      } else if (d.verdict === 'credit-exhausted') {
        s.errorCode = ERR.PLAN_CONNECTION_LIMIT;
        s.error = `the subscription's data allowance is used up — not a node fault (provider: ${d.reason})`;
      } else if (d.verdict === 'refused') {
        s.errorCode = ERR.TICKET_REFUSED;
        s.error = `the plan's provider refuses tickets for this node: ${d.reason}`;
      } else if (d.verdict === 'node') {
        s.error = `${s.error} — the provider DOES issue tickets for this node, so the node rejected a valid ticket`;
      }
    } catch (err) {
      broadcast('log', { msg: `  ⚠ provider check failed: ${err.message}` });
    }
  }

  if (!s.ok) throw fail(s.error || 'session failed', { errorCode: s.errorCode || ERR.UNKNOWN, stage: s.stage, diag: { ...diag, spentBase: s.spentBase } });

  let actualMbps = s.mbps;
  const bl = ctx.baselineMbps;
  if (actualMbps != null && bl != null && actualMbps > bl) actualMbps = parseFloat((bl * 0.97).toFixed(2));
  const dynamicThreshold = bl != null ? bl * 0.5 : null;
  broadcast('log', { msg: `  Speed: ${actualMbps} Mbps · ${s.downloadedBytes} B through the tunnel · channel ${s.channel || '—'}` });
  broadcast('log', { msg: `  Google: ${s.connectivityOk ? `✓ reachable (${s.connectivityMs}ms)` : '✗ blocked (node may restrict Google — not a failure)'}` });

  return {
    ...base,
    actualMbps,
    ispBottleneck: actualMbps != null && bl != null && bl > 0 && actualMbps / bl >= 0.85,
    baselineViable: bl != null && bl >= 30,
    dynamicThreshold: dynamicThreshold != null ? parseFloat(dynamicThreshold.toFixed(2)) : null,
    slaApplicable: bl != null && bl >= 30,
    pass15mbps: actualMbps != null && actualMbps >= 15,
    pass10mbps: actualMbps != null && actualMbps >= 10,
    passBaseline: actualMbps != null && dynamicThreshold != null && actualMbps >= dynamicThreshold,
    googleAccessible: s.connectivityOk,
    googleLatencyMs: s.connectivityMs,
    latencyMs: s.rttMs || s.connectivityMs || s.ttfbMs,
    downloadedBytes: s.downloadedBytes,
    channel: s.channel,
    sessionId: s.sessionId,
    spentBase: s.spentBase,
    durationMs: Date.now() - t0,
    diag,
  };
}
