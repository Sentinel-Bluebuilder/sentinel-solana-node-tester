/**
 * Sentinel Node Tester (Solana) — Audit Pipeline
 *
 * Same exports, state fields, broadcast events and persistence as the Cosmos
 * tester's audit/pipeline.js, so the shared server.js, continuous.js and the
 * dashboards work unchanged. What changed is the chain engine:
 *   - wallet       TEST_KEYFILE keypair (core/wallet.js), balance in tDVPN base units
 *   - node list    getProgramAccounts over Node accounts, live listings only (core/chain.js)
 *   - online scan  signed /v1/metadata probe (protocol/v3protocol.js)
 *   - payment      no batch payment: each test's client daemon opens its own voucher channel
 *   - session      throwaway dvpnd client container (audit/node-test.js → session-runner.js)
 *   - cancel       autoCancelAfterTest → start_close every channel the run opened (audit/channels.js)
 *   - reports      SNTR1 v3 SPL Memo signed by the tester wallet
 * Zero-skip system: every node ends as PASS or FAIL.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import path from 'path';

import {
  MNEMONIC, DENOM, TEST_MB, MAX_NODES, NODE_DELAY, RESULTS_DIR, RESULTS_FILE, FAILURE_LOG, PROJECT_ROOT, explorerUrl,
} from '../core/constants.js';
import { gigsRT, autoCancelRT, maxPriceUdvpnRT, onchainEnabledRT, onchainBatchSizeRT, onchainRegionRT } from '../core/settings.js';
import { resultToRecord, packBatch, commitBatch as commitOnchainBatch } from '../core/onchain-report.js';
import { cachedWalletSetup, createFreshClient } from '../core/wallet.js';
import { walletAddress as solanaWalletAddress } from '../lib/wallet.js';
import { getAllNodes } from '../core/chain.js';
import { nodeStatusV3, protocolDisplayName } from '../protocol/v3protocol.js';
import { speedtestDirect } from '../protocol/speedtest.js';
import { testNode, parseOverrides, baseFields, probeOrigin } from './node-test.js';
export { probeOrigin };
import { sweepTestChannels } from './channels.js';
import { dockerStatus, imagePresent, probeClientCapabilities, removeStaleClients, removeStaleClientDirs } from './docker.js';
import { insertResult as _dbInsertResult, insertErrorLog as _dbInsertErrorLog } from '../core/db.js';
import { insertReport } from '../lib/db.js';
import { rpcCandidates, rpcCounters } from '../lib/solana/rpc.js';
import { planRoster, planAccount, subscriptionAccount } from '../lib/plans.js';
import { ix, pda } from '../lib/solana/program.js';
import { sendIxs } from '../lib/solana/tx.js';
import { DVPND_IMAGE, ERR, DEFAULT_ESCROW_BASE, TOKEN_LABEL } from '../lib/constants.js';

// ─── Stop-aware sleep ────────────────────────────────────────────────────────
const _stopWaiters = new Set();
let _pipelineStopFlag = false;
function sleep(ms) {
  if (_pipelineStopFlag) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { _stopWaiters.delete(wake); resolve(); }, ms);
    const wake = () => { clearTimeout(timer); _stopWaiters.delete(wake); resolve(); };
    _stopWaiters.add(wake);
  });
}
export function triggerPipelineStop() {
  _pipelineStopFlag = true;
  for (const w of _stopWaiters) w();
  _stopWaiters.clear();
}
export function resetPipelineStop() {
  _pipelineStopFlag = false;
}
export function isStopSignal(state, error) {
  if (state?.stopRequested) return true;
  if (error?._stopRequested) return true;
  const msg = error?.message ?? error;
  return typeof msg === 'string' && msg === 'Stop requested';
}

// ─── Internet health ─────────────────────────────────────────────────────────
// INTERNET_CHECK_URLS (comma-separated) overrides the targets — tests point it at a blackhole to
// force the internet-down pause without cutting a real network.
const internetCheckTargets = () => (process.env.INTERNET_CHECK_URLS || 'https://www.google.com,https://1.1.1.1,https://www.cloudflare.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
async function checkInternet() {
  for (const url of internetCheckTargets()) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok || res.status < 500) return true;
    } catch (err) {
      console.warn(`[pipeline] internet probe ${url} failed: ${err.message}`);
    }
  }
  return false;
}
function isInternetError(err) {
  return /ENETUNREACH|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|fetch failed|socket hang up/i.test(err?.message || '');
}
// Called before a failure is recorded. Returns null (record it), 'retry' (the tester was
// offline — nothing recorded, connectivity is back, test the same node again) or 'stop'.
// Failures that say nothing about the node: recorded as skips, never counted against it.
//   PROTOCOL_UNSUPPORTED      this machine cannot run that client (AmneziaWG on Docker Desktop)
//   PLAN_CONNECTION_LIMIT     the subscription has no free connection / allowance left
//   SPEED_SOURCE_UNAVAILABLE  the tunnel works; every speed host refused the download
//   CLIENT_EXITED             the client container died mid-session (already retried once)
//   DOCKER_UNAVAILABLE        the client container could not start at all
const NOT_NODE_FAULTS = new Set([
  ERR.PROTOCOL_UNSUPPORTED, ERR.PLAN_CONNECTION_LIMIT, ERR.SPEED_SOURCE_UNAVAILABLE,
  ERR.CLIENT_EXITED, ERR.DOCKER_UNAVAILABLE,
]);
export function isNodeFault(errorCode) {
  return !NOT_NODE_FAULTS.has(errorCode);
}

async function outageBeforeRecording(node, error, state, broadcast) {
  if (state.testRun || state.stopRequested || await checkInternet()) return null;
  broadcast('log', { msg: `🌐 [${node.address.slice(0, 20)}…] not recorded — the tester has no internet (${error?.errorCode || 'error'}); it is retested once connectivity returns` });
  return (await waitForInternet(broadcast, state)) ? 'retry' : 'stop';
}
async function waitForInternet(broadcast, state) {
  state.status = 'paused_internet';
  state.pauseReason = 'Internet down — checking with backoff';
  broadcast('state', { state });
  broadcast('log', { msg: '🌐 Internet appears down. Pausing audit...' });
  const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000];
  let attempt = 0;
  while (!state.stopRequested) {
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    for (let i = 0; i < Math.ceil(delay / 2000); i++) { if (state.stopRequested) return false; await sleep(2000); }
    if (state.stopRequested) return false;
    broadcast('log', { msg: '🌐 Checking internet connectivity...' });
    if (await checkInternet()) {
      broadcast('log', { msg: '🌐 ✓ Internet restored! Resuming audit...' });
      state.status = 'running';
      state.pauseReason = null;
      broadcast('state', { state });
      return true;
    }
    broadcast('log', { msg: `🌐 ✗ Still down. Next check in ${Math.round(BACKOFF_MS[Math.min(attempt + 1, BACKOFF_MS.length - 1)] / 1000)}s...` });
    attempt++;
  }
  return false;
}

// ─── Results & state ─────────────────────────────────────────────────────────
mkdirSync(RESULTS_DIR, { recursive: true });

let results = [];
if (existsSync(RESULTS_FILE)) {
  try { results = JSON.parse(readFileSync(RESULTS_FILE, 'utf8')); } catch (err) { console.error('[pipeline] results.json unreadable, starting empty:', err.message); }
}

export function getResults() { return results; }

export function seedResults(rows) {
  if (!Array.isArray(rows)) return 0;
  let added = 0;
  for (const r of rows) {
    if (!r || !r.address) continue;
    const idx = results.findIndex(x => x.address === r.address);
    if (idx !== -1) results[idx] = r;
    else { results.push(r); added++; }
  }
  return added;
}

export function saveResults(state) {
  const data = JSON.stringify(results, null, 2);
  const tmpFile = RESULTS_FILE + '.tmp';
  writeFileSync(tmpFile, data, 'utf8');
  try { renameSync(tmpFile, RESULTS_FILE); } catch (err) { writeFileSync(RESULTS_FILE, data, 'utf8'); }
  const runDir = state && state.activeRunDir;
  if (runDir) {
    const runFile = path.join(runDir, 'results.json');
    try {
      writeFileSync(runFile + '.tmp', data, 'utf8');
      try { renameSync(runFile + '.tmp', runFile); } catch (err) { writeFileSync(runFile, data, 'utf8'); }
    } catch (err) { console.warn('[pipeline] run-dir results copy failed:', err.message); }
  }
}

export function logFailure(nodeAddr, error, context = {}) {
  appendFileSync(FAILURE_LOG, JSON.stringify({ ts: new Date().toISOString(), node: nodeAddr, error, ...context }) + '\n', 'utf8');
}

// Snippets never carry key material, auth headers or RPC API keys.
const _AUTH_LINE_RE = /^.*(?:BEARER\s|Authorization:).*/gim;
const _KEY_ARRAY_RE = /\[(?:\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]/g;
const _API_KEY_RE = /(api[-_]?key=)[^&\s'"]+/gi;
const _MAX_SNIPPET = 16384;
function _sanitizeSnippet(raw) {
  if (!raw) return null;
  let s = String(raw).replace(_AUTH_LINE_RE, '[auth-redacted]').replace(_KEY_ARRAY_RE, '[key]').replace(_API_KEY_RE, '$1[redacted]');
  // Failure logs are public (/api/public errors): the tester wallet never appears in them.
  const w = solanaWalletAddress();
  if (w) s = s.split(w).join('[wallet]');
  return s.length > _MAX_SNIPPET ? s.slice(-_MAX_SNIPPET) : s;
}

function upsertResult(state, result, logSnippet = null) {
  const idx = results.findIndex(r => r.address === result.address);
  if (idx !== -1) results[idx] = result;
  else results.push(result);
  try { _bufferOnchainRecord(result); } catch (e) { console.warn('[onchain] buffer failed:', e.message); }
  // Every recorded failure goes to failures.jsonl (probe, session and retest paths alike);
  // it used to be written by the session path only, so unreachable nodes never appeared.
  if (result.actualMbps == null && result.errorCode !== 'TEST_RUN_SKIP') {
    try {
      logFailure(result.address, _sanitizeSnippet(String(result.error || result.errorCode || 'unknown failure')).slice(0, 2048), { errorCode: result.errorCode, stage: result.stage });
    } catch (e) { console.error('[pipeline] failures.jsonl append failed:', e.message); }
  }
  const dbRunId = state && state.activeDbRunId;
  if (dbRunId != null) {
    try {
      const resultId = _dbInsertResult(dbRunId, result);
      const isFailed = result.actualMbps == null || !!result.error || !!result.errorCode;
      if (isFailed && resultId && result.errorCode !== 'TEST_RUN_SKIP') {
        try {
          _dbInsertErrorLog({
            result_id: Number(resultId),
            stage: result.stage || 'other',
            error_code: result.errorCode || 'UNKNOWN',
            error_message: _sanitizeSnippet(String(result.error || result.errorCode || 'unknown failure')).slice(0, 2048),
            log_snippet: _sanitizeSnippet(logSnippet),
          });
        } catch (elErr) { console.error(`[db] insertErrorLog failed: ${elErr.message}`); }
      }
    } catch (dbErr) { console.error(`[db] insertResult failed: ${dbErr.message}`); }
  }
}

export function createState() {
  return {
    status: 'idle',
    totalNodes: 0,
    testedNodes: 0,
    failedNodes: 0,
    skippedNodes: 0,
    retryCount: 0,
    passed15: 0,
    passed10: 0,
    passedBaseline: 0,
    baselineMbps: null,
    baselineHistory: [],
    nodeSpeedHistory: [],
    currentNode: null,
    currentType: null,
    currentLocation: null,
    walletAddress: null,
    balance: null,
    balanceUdvpn: 0,
    estimatedTotalCost: null,
    spentUdvpn: 0,
    runSpentUdvpn: 0,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    stopRequested: false,
    lowBalanceWarning: false,
    pauseReason: null,
    activeBatchId: 0,
    resumeHeadAddr: null,
    activeRunDir: null,
    activeDbRunId: null,
  };
}

function recomputeCounters(state) {
  state.testedNodes = results.filter(r => r.actualMbps != null).length;
  state.failedNodes = results.filter(r => r.actualMbps == null && !r.skipped && r.errorCode !== 'TEST_RUN_SKIP').length;
  state.skippedNodes = results.filter(r => r.skipped || r.errorCode === 'TEST_RUN_SKIP').length;
  state.passed15 = results.filter(r => r.baselineAtTest >= 30 && r.actualMbps >= 15).length;
  state.passed10 = results.filter(r => r.actualMbps >= 10).length;
  state.passedBaseline = results.filter(r => {
    const thresh = r.dynamicThreshold != null ? r.dynamicThreshold : (r.baselineAtTest != null ? r.baselineAtTest * 0.5 : null);
    return thresh != null && r.actualMbps >= thresh;
  }).length;
}

export function classifyProbeError(err) {
  const msg = (err?.message || String(err || '')).toLowerCase();
  const code = err?.code || '';
  if (code === 'METADATA_INVALID') return 'METADATA_INVALID';
  if (msg.includes('timeout') || msg.includes('timed out') || code === 'ETIMEDOUT') return 'TIMEOUT';
  if (code === 'ENOTFOUND' || msg.includes('enotfound') || msg.includes('getaddrinfo')) return 'DNS_FAIL';
  if (msg.includes('closed or filtered') || code === 'ECONNREFUSED' || msg.includes('econnrefused')) return 'TCP_REFUSED';
  if (msg.includes('econnreset')) return 'TCP_RESET';
  if (msg.includes('ehostunreach')) return 'HOST_UNREACH';
  if (msg.includes('cert') || msg.includes('tls') || msg.includes('ssl')) return 'TLS_FAIL';
  if (msg.includes('http')) return 'HTTP_ERROR';
  return 'OTHER';
}

/** Scan nodes for online status in parallel (signed metadata probe). */
export async function scanNodesParallel(nodes, concurrency, broadcast, state, overrides = new Map()) {
  const online = [];
  const offline = [];
  const errorBuckets = Object.create(null);
  let idx = 0;
  let scanned = 0;
  const worker = async () => {
    for (;;) {
      const i = idx++;
      if (i >= nodes.length) break;
      const node = nodes[i];
      const o = overrides.get(node.address);
      const overrideOrigin = probeOrigin(o);
      try {
        const status = await nodeStatusV3(node._sol, { overrideOrigin, timeoutMs: 8000 });
        online.push({ node, status });
      } catch (err) {
        const bucket = classifyProbeError(err);
        errorBuckets[bucket] = (errorBuckets[bucket] || 0) + 1;
        offline.push({ node, error: err });
      }
      scanned++;
      if (scanned % 100 === 0 || scanned === nodes.length) {
        let tail = '';
        if (scanned === nodes.length) {
          const s = Object.entries(errorBuckets).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}:${v}`).join(' ');
          if (s) tail = ` [${s}]`;
        }
        if (broadcast) broadcast('log', { msg: `  Scanned ${scanned}/${nodes.length} — ${online.length} online${tail}` });
        if (broadcast) broadcast('state', { state });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, nodes.length) }, worker));
  if (state) state.lastScanErrorBuckets = errorBuckets;
  online.errorBuckets = errorBuckets;
  online.offline = offline;
  return online;
}

function buildFailResult(node, status, state, errMsg, extra = {}) {
  const bl = state.baselineMbps;
  const prev = results.find(r => r.address === node.address);
  const sol = node._sol || {};
  return {
    timestamp: new Date().toISOString(),
    address: node.address,
    type: protocolDisplayName(status?.type || sol.protocol) || prev?.type || null,
    moniker: status?.moniker || prev?.moniker || `${node.address.slice(0, 6)}…${node.address.slice(-4)}`,
    country: status?.location?.country || prev?.country || sol.country || '',
    countryCode: status?.location?.country_code || prev?.countryCode || sol.countryCode || '',
    city: status?.location?.city || prev?.city || '',
    // What the node advertised at test time (Cosmos records 0 here, which hides it in the error popup).
    reportedDownloadMbps: status?.bandwidth?.download ? parseFloat(((status.bandwidth.download * 8) / 1_000_000).toFixed(2)) : (prev?.reportedDownloadMbps || 0),
    actualMbps: null,
    baselineAtTest: bl ?? null,
    ispBottleneck: false,
    baselineViable: bl != null && bl >= 30,
    dynamicThreshold: bl != null ? parseFloat((bl * 0.5).toFixed(2)) : null,
    slaApplicable: bl != null && bl >= 30,
    pass15mbps: false,
    pass10mbps: false,
    passBaseline: false,
    peers: status?.peers ?? prev?.peers ?? null,
    maxPeers: status?.qos?.max_peers ?? prev?.maxPeers ?? null,
    gigabytePrices: node.gigabyte_prices || [],
    inPlan: false,
    planIds: [],
    googleAccessible: null,
    googleLatencyMs: null,
    sdk: 'dvpnd',
    os: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
    protocol: sol.protocol || null,
    uri: sol.uri || node.remoteUrl,
    error: errMsg,
    errorCode: extra.errorCode || classifyProbeError({ message: errMsg, code: extra.diag?.code }),
    stage: extra.stage || 'other',
    timedOut: /timeout|timed out/i.test(errMsg),
    channel: extra.diag?.channel || null,
    sessionId: extra.diag?.sessionId || null,
    spentBase: extra.diag?.spentBase || null,
    diag: extra.diag || {},
  };
}

// ─── On-chain reporter (per run) ─────────────────────────────────────────────
let _onchainReporter = null;

function _initOnchainReporter(account, state, broadcast) {
  _onchainReporter = null;
  if (!onchainEnabledRT()) {
    broadcast('log', { msg: '📡 On-chain reporting: OFF (toggle in admin → settings to enable)' });
    return;
  }
  if (!account) {
    broadcast('log', { msg: '⚠ On-chain reporting: ENABLED but no wallet — staying OFF for this run' });
    return;
  }
  _onchainReporter = {
    batchSize: onchainBatchSizeRT(),
    region: onchainRegionRT() || '',
    baselineMbps: Math.round(state.baselineMbps || 0),
    startedAt: state.startedAt ? new Date(state.startedAt) : new Date(),
    signerAddress: account.address,
    runId: state.activeDbRunId,
    broadcast,
    buffer: [],
    committed: 0,
    lastTxhash: null,
  };
  broadcast('log', { msg: `📡 On-chain reporting: ON — every ${_onchainReporter.batchSize} nodes (region=${_onchainReporter.region || 'auto'}, baseline=${_onchainReporter.baselineMbps}Mbps, signer=${account.address.slice(0, 16)}…)` });
}

async function _flushOnchainBatch(force = false) {
  const r = _onchainReporter;
  if (!r || r.buffer.length === 0) return;
  if (!force && r.buffer.length < r.batchSize) return;
  let memo; let packed;
  try {
    ({ memo, packed } = packBatch({ region: r.region, baselineMbps: r.baselineMbps, startedAt: r.startedAt }, r.buffer.slice(0, r.batchSize)));
  } catch (e) {
    r.broadcast('log', { msg: `⚠ On-chain pack failed (non-fatal, dropping 1 record): ${e.message}` });
    r.buffer.shift();
    return;
  }
  const batch = r.buffer.splice(0, packed);
  try {
    const res = await commitOnchainBatch(null, r.signerAddress, memo);
    r.committed += batch.length;
    r.lastTxhash = res.txhash;
    insertReport({ signature: res.txhash, slot: res.height, run_id: r.runId, record_count: batch.length, memo });
    r.broadcast('log', { msg: `📡 On-chain report posted: ${batch.length} nodes (${batch.filter(b => b.ok).length} ok), ${res.memoBytes} chars @ slot ${res.height} → ${explorerUrl('tx', res.txhash)}` });
  } catch (e) {
    r.broadcast('log', { msg: `⚠ On-chain report failed (non-fatal): ${e.message}` });
  }
}

function _bufferOnchainRecord(result) {
  const r = _onchainReporter;
  if (!r) return;
  if (result?.errorCode === 'TEST_RUN_SKIP' || result?.skipped) return;
  const rec = resultToRecord(result);
  if (!rec) return;
  r.buffer.push(rec);
  _queueOnchainFlush(r, false);
}

// Report posts run one at a time (chain writes stay sequential) and the run's final
// summary waits for the queue — otherwise a post still in flight is counted as "0 posted".
function _queueOnchainFlush(r, force) {
  r.queue = (r.queue || Promise.resolve())
    .then(() => (_onchainReporter === r ? _flushOnchainBatch(force) : null))
    .catch(err => console.error(`[pipeline] _flushOnchainBatch failed: ${err?.message || err}`));
  return r.queue;
}

async function _finalizeOnchainReporter() {
  if (!_onchainReporter) return;
  const r = _onchainReporter;
  await _queueOnchainFlush(r, true);
  // More than one batch left (e.g. after a stop): post the rest, ≥ 7 s apart.
  while (r.buffer.length) {
    const before = r.buffer.length;
    await sleep(7_000);
    await _queueOnchainFlush(r, true);
    if (r.buffer.length >= before) break;
  }
  r.broadcast('log', { msg: `📡 On-chain reporting done — ${r.committed} nodes posted (${r.lastTxhash ? `last TX ${explorerUrl('tx', r.lastTxhash)}` : 'no TXs broadcast'}).` });
  _onchainReporter = null;
}

// ─── Client preflight (Docker + image + what this kernel can run) ────────────
let _capsCache = null;
async function clientPreflight(broadcast) {
  const d = await dockerStatus();
  if (!d.ok) throw new Error(`Docker is not available: ${d.error}`);
  const img = await imagePresent(DVPND_IMAGE);
  if (!img.ok) throw new Error(`Client image ${DVPND_IMAGE} is missing — build it with 'npm run build-client-image' (docker/client.Dockerfile, a cb33092e sentinel-dvpnd)`);
  if (!_capsCache) _capsCache = await probeClientCapabilities(DVPND_IMAGE);
  if (!_capsCache.ok) throw new Error(`Client container cannot run dvpnd here: ${_capsCache.output.slice(-200)}`);
  broadcast('log', { msg: `WireGuard: ✓ available (client container, Docker ${d.version})` });
  broadcast('log', { msg: `V2Ray:     ✓ available (client container)` });
  broadcast('log', { msg: `Admin:     ✓ client containers run with NET_ADMIN` });
  if (!_capsCache.nftFibIpv6) broadcast('log', { msg: '⚠ AmneziaWG: this kernel lacks nft_fib_ipv6 — AmneziaWG nodes will be marked unsupported' });
  const stale = await removeStaleClients();
  if (stale) broadcast('log', { msg: `⚠ Removed ${stale} client container(s) left by an earlier crash` });
  const staleDirs = removeStaleClientDirs();
  if (staleDirs) console.warn(`[pipeline] removed ${staleDirs} client session dir(s) left by an earlier crash`);
  return _capsCache;
}

export function cachedCaps() { return _capsCache; }

function sessionSettings() {
  return {
    testBytes: Math.max(1, TEST_MB) * 1_000_000,
    prepayBytes: gigsRT() * 1_000_000_000,
    escrowBase: DEFAULT_ESCROW_BASE,
    clientTimeoutSec: Math.max(120, parseInt(process.env.CLIENT_TIMEOUT_SEC || '360', 10)),
    skipUnsupportedProtocols: true,
  };
}

async function refreshBalance(client, state) {
  const bal = await client.getBalance(state.walletAddress, DENOM);
  state.balanceUdvpn = parseInt(bal?.amount || '0', 10);
  state.balance = `${(state.balanceUdvpn / 1_000_000).toFixed(4)} ${TOKEN_LABEL}`;
  if (bal?.lamports != null) state.walletLamports = bal.lamports;
}

/**
 * Can the wallet open one more channel? Reads the chain (each open locks escrow and
 * channel rent, which the committed-spend estimate does not see).
 */
async function canAffordNextChannel(client, state) {
  try { await refreshBalance(client, state); state.spentUdvpn = 0; } catch (err) { console.warn('[pipeline] balance refresh failed, using the estimate:', err.message); }
  // MIN_CHANNEL_BALANCE_BASE (default: one escrow) — also lets the e2e force the live pause.
  const minTokens = Number(process.env.MIN_CHANNEL_BALANCE_BASE || DEFAULT_ESCROW_BASE);
  const tokensOk = Math.max(0, state.balanceUdvpn - state.spentUdvpn) >= minTokens;
  const solOk = state.walletLamports == null || state.walletLamports >= 10_000_000;
  return { ok: tokensOk && solOk, tokensOk, solOk };
}

/** Test one node, capturing its log lines for the failure snippet. One retry when the client daemon never came up (no channel was opened). */
async function runOne(node, status, ctx, broadcast) {
  const lines = [];
  const capturing = (type, data) => {
    broadcast(type, data);
    if (type === 'log' && data?.msg) { lines.push(String(data.msg)); if (lines.length > 5000) lines.shift(); }
  };
  let attempt = 0;
  for (;;) {
    try {
      const result = await testNode(node, status, { ...ctx, broadcast: capturing });
      return { result, snippet: null };
    } catch (error) {
      if (error.errorCode === ERR.DAEMON_NOT_READY && attempt === 0 && !ctx.state.stopRequested) {
        attempt++;
        ctx.state.retryCount = (ctx.state.retryCount || 0) + 1;
        capturing('log', { msg: '  🔄 Client daemon did not start — retrying once in 10s (nothing was paid)' });
        await sleep(10_000);
        continue;
      }
      // A client container that died mid-session says nothing about the node: one retry on a
      // fresh container (the dead session's channel stays tracked for the refund sweep).
      if (error.errorCode === ERR.CLIENT_EXITED && attempt === 0 && !ctx.state.stopRequested) {
        attempt++;
        ctx.state.retryCount = (ctx.state.retryCount || 0) + 1;
        capturing('log', { msg: '  🔄 Client container exited mid-session — retrying once in 10s on a fresh container' });
        await sleep(10_000);
        continue;
      }
      const tail = [
        lines.join('\n'),
        `✖ ERROR: ${(error.message || String(error)).split('\n').slice(0, 6).join(' | ')}`,
        error.errorCode ? `  code: ${error.errorCode}` : '',
        error.stage ? `  stage: ${error.stage}` : '',
        error.diag?.clientLog ? `\n--- client daemon log ---\n${error.diag.clientLog}` : '',
        error.diag?.transcript ? `\n--- client container transcript (tail) ---\n${String(error.diag.transcript).slice(-6000)}` : '',
      ].filter(Boolean).join('\n');
      return { error, snippet: tail };
    }
  }
}

/** What the progress line shows ("[WireGuard] <node>") before the session itself starts. */
function setCurrentLabel(state, node, status) {
  try {
    const b = baseFields(node, status, { state });
    state.currentType = b.type;
    state.currentLocation = [b.city, b.country].filter(Boolean).join(', ') || b.countryCode || '';
  } catch (err) { console.warn('[pipeline] current-node label failed:', err.message); }
}

/** Direct-connection speed now; updates state.baselineMbps. Returns the sample or null. */
async function refreshBaselineSample(state, broadcast) {
  try {
    const bl = await speedtestDirect();
    state.baselineMbps = bl.mbps;
    broadcast('state', { state });
    return { mbps: bl.mbps, ts: new Date().toLocaleTimeString('en-US', { hour12: false }) };
  } catch (err) {
    console.warn('[pipeline] per-node baseline failed, keeping the last one:', err.message);
    return null;
  }
}

// At most one sample per node: an outage retry tests the same node again (Cosmos dedupes the same way).
let _lastBaselineAddr = null;
function commitBaselineSample(state, sample, addr) {
  if (!sample || (addr && addr === _lastBaselineAddr)) return;
  state.baselineHistory = [...(state.baselineHistory || []), sample].slice(-10);
  _lastBaselineAddr = addr || null;
}

function recordPass(state, node, result, broadcast, label) {
  state.testedNodes++;
  if (result.slaApplicable && result.pass15mbps) state.passed15++;
  if (result.pass10mbps) state.passed10++;
  if (result.passBaseline) state.passedBaseline++;
  upsertResult(state, result);
  state.resumeHeadAddr = null;
  saveResults(state);
  broadcast('result', { result, state });
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  state.nodeSpeedHistory = [...state.nodeSpeedHistory, { mbps: result.actualMbps, addr: node.address.slice(0, 14), ts }].slice(-10);
  broadcast('state', { state });
  broadcast('log', { msg: `✓ ${label} ${result.actualMbps} Mbps | baseline ${state.baselineMbps != null ? state.baselineMbps + ' Mbps' : '--'}` });
}

function addSpend(state, base) {
  const n = Number(base) || 0;
  if (!n) return;
  state.spentUdvpn += n;
  state.runSpentUdvpn = (state.runSpentUdvpn || 0) + n;
  state.balance = `${(Math.max(0, state.balanceUdvpn - state.spentUdvpn) / 1_000_000).toFixed(4)} ${TOKEN_LABEL} (est. remaining)`;
  state.estimatedTotalCost = `${(state.runSpentUdvpn / 1_000_000).toFixed(4)} ${TOKEN_LABEL}`;
}

async function sweepAfterRun(keypair, state, broadcast) {
  // A stopped run hands its channels to the background sweep so Stop unwinds fast.
  if (state.testRun || !autoCancelRT() || state.stopRequested) return;
  try {
    const sw = await sweepTestChannels(keypair, { log: (m) => broadcast('log', { msg: `  ${m}` }) });
    if (sw.startedClose.length || sw.closed.length) {
      broadcast('log', { msg: `💸 Channels: ${sw.startedClose.length} closing · ${sw.closed.length} closed · ${sw.withdrawnBase} base units refunded · ${sw.pending.length} waiting for the close grace` });
    }
    if (sw.errors.length) broadcast('log', { msg: `  ⚠ Channel sweep: ${sw.errors.join(' · ').slice(0, 300)}` });
  } catch (err) {
    broadcast('log', { msg: `  ⚠ Channel sweep raised: ${_sanitizeSnippet(err.message)}. Channels stay tracked for the next sweep.` });
  }
}

// ─── Main Audit ─────────────────────────────────────────────────────────────
async function _runAudit(resume, state, broadcast, preloadedNodes = null, opts = {}) {
  resetPipelineStop();
  rpcCounters({ reset: true }); // per-run request / 429 counts (RPC-PLAN rule 6)
  _lastBaselineAddr = null;
  state.status = 'running';
  state.scanning = false;
  if (!resume || !state.startedAt) state.startedAt = new Date().toISOString();
  state.errorMessage = null;
  state.retryCount = 0;
  state.retestMode = false;
  state.retestPassed = null;
  state.retestFailed = null;
  // TEST RUN state pinned at the top so a prior run can never leak into this one.
  // A plan run (opts.plan, from runSubPlanTest) is never a test run.
  const plan = opts.plan || null;
  state.testRun = plan ? false : !!opts.testRun;
  state.runMode = plan ? 'subscription' : state.testRun ? 'test' : 'p2p';
  state.runPlanId = plan ? plan.planId : null;
  state.runSubscriptionId = plan ? plan.subscriptionId : null;
  state.runGranter = plan ? plan.provider : null;
  // Per-hour = stream channels; plan runs use tickets and ignore it (Cosmos forces GB there too).
  const pricingMode = plan ? 'gigabytes' : (opts.pricingMode || state.pricingMode) === 'hours' ? 'hours' : 'gigabytes';
  broadcast('state', { state });

  let auditLogPath;
  if (resume && state.auditLogPath && existsSync(state.auditLogPath)) {
    auditLogPath = state.auditLogPath;
  } else {
    const logTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    auditLogPath = path.join(PROJECT_ROOT, 'results', `audit-${logTs}.log`);
    state.auditLogPath = auditLogPath;
  }
  const logLine = (msg) => { try { appendFileSync(auditLogPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8'); } catch (err) { console.warn('[pipeline] audit log write failed:', err.message); } };
  if (resume) { logLine('='.repeat(32)); logLine(`RESUMED: ${new Date().toISOString()}`); logLine('='.repeat(32)); }
  else { logLine('Sentinel Node Tester (Solana) — Full Audit Log'); logLine(`Started: ${state.startedAt} | Resume: ${resume}`); logLine('='.repeat(32)); }
  const origBroadcast = broadcast;
  broadcast = (type, data) => {
    origBroadcast(type, data);
    if (type === 'log' && data?.msg && data.cat !== 'events') logLine(data.msg);
  };
  broadcast('log', { msg: `📝 Log file: results/${path.basename(auditLogPath)}${resume ? ' (resumed — appending)' : ''}` });

  // ─── Wallet ───
  let account = null; let client = null; let keypair = null;
  if (!state.testRun || MNEMONIC) {
    broadcast('log', { msg: '🔑 Setting up wallet...' });
    ({ account, keypair } = await cachedWalletSetup());
    state.walletAddress = account.address;
    // '🔑' files the line under operator events: the admin log shows it, the public /live
    // stream does not (Cosmos sent it to /live as a plain line; public logs never name the wallet).
    broadcast('log', { msg: `🔑 Wallet: ${account.address}` });
    client = await createFreshClient();
    await refreshBalance(client, state);
  }
  state.spentUdvpn = 0;
  if (!resume) state.runSpentUdvpn = 0;

  if (resume) {
    broadcast('log', { msg: `Resuming audit with ${results.length} existing results...` });
    recomputeCounters(state);
  } else {
    results.length = 0;
    state.testedNodes = 0; state.failedNodes = 0; state.skippedNodes = 0;
    state.passed15 = 0; state.passed10 = 0; state.passedBaseline = 0;
    state.nodeSpeedHistory = []; state.baselineHistory = [];
    state.totalNodes = 0;
    saveResults(state);
  }
  if (state.balance) broadcast('log', { msg: `Balance: ${state.balance}` });
  broadcast('state', { state });

  // ─── Client containers (paid runs only) ───
  let caps = _capsCache;
  if (!state.testRun) caps = await clientPreflight(broadcast);

  // ─── Baseline ───
  broadcast('log', { msg: '📡 Running baseline speed test (direct connection)...' });
  try {
    const baseline = await speedtestDirect();
    state.baselineMbps = baseline.mbps;
    broadcast('log', { msg: `Baseline speed: ${baseline.mbps} Mbps (${baseline.adaptive})` });
    broadcast('state', { state });
  } catch (e) {
    broadcast('log', { msg: `Baseline speed test failed: ${_sanitizeSnippet(e.message)}` });
  }

  if (!state.testRun) _initOnchainReporter(account, state, broadcast);
  else _onchainReporter = null;

  // ─── Phase 1: node list ───
  let allNodes;
  if (Array.isArray(preloadedNodes) && preloadedNodes.length > 0) {
    broadcast('log', { msg: `🔒 Using frozen snapshot (${preloadedNodes.length} nodes).` });
    allNodes = preloadedNodes;
  } else {
    broadcast('log', { msg: '🔍 Fetching node list...' });
    allNodes = await Promise.race([
      getAllNodes(broadcast),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Node list fetch timeout (60s)')), 60_000)),
    ]);
  }
  if (plan) {
    // The plan's node set is the provider's roster (verified provider API, pinned TLS).
    const roster = await planRoster(plan.provider, plan.planId);
    const want = new Set(roster.map((r) => r.node));
    const listed = new Set(allNodes.map((n) => n.address));
    const unlisted = roster.filter((r) => !listed.has(r.node));
    broadcast('log', { msg: `📋 Plan ${plan.planId.slice(0, 8)}… roster: ${roster.length} node(s), ${roster.filter((r) => r.live).length} live per the provider${unlisted.length ? ` · ${unlisted.length} without a live chain listing (not testable)` : ''}` });
    allNodes = allNodes.filter(n => want.has(n.address));
  }
  if (Array.isArray(opts.addresses) && opts.addresses.length) {
    const want = new Set(opts.addresses);
    allNodes = allNodes.filter(n => want.has(n.address));
  }
  const nodesToTest = MAX_NODES > 0 ? allNodes.slice(0, MAX_NODES) : allNodes;
  broadcast('log', { msg: `Fetched ${nodesToTest.length} nodes total.` });
  state.scanning = true;
  broadcast('state', { state });

  // ─── Phase 2: online scan ───
  const overrides = parseOverrides();
  broadcast('log', { msg: `🔍 Phase 2: Scanning ${nodesToTest.length} nodes in parallel (30 concurrent)...` });
  let onlineNodes;
  try {
    onlineNodes = await scanNodesParallel(nodesToTest, 30, broadcast, state, overrides);
  } finally {
    state.scanning = false;
  }
  broadcast('log', { msg: `Scan complete: ${onlineNodes.length}/${nodesToTest.length} online.` });

  const maxPrice = maxPriceUdvpnRT();
  let viableNodes;
  if (plan) {
    viableNodes = onlineNodes; // the subscription already paid; node prices do not apply
  } else if (pricingMode === 'hours') {
    // Same as Cosmos: a node with no hourly price is not offered per hour, so it is not tested.
    viableNodes = onlineNodes.filter(({ node }) => BigInt(String(node._sol?.pricePerHour || '0')) > 0n);
    if (viableNodes.length < onlineNodes.length) broadcast('log', { msg: `Skipping ${onlineNodes.length - viableNodes.length} nodes with no per-hour price` });
  } else {
    viableNodes = onlineNodes.filter(({ node }) => !(maxPrice > 0 && Number(node._sol?.pricePerGb || 0) > maxPrice));
    if (maxPrice > 0 && viableNodes.length < onlineNodes.length) broadcast('log', { msg: `Skipping ${onlineNodes.length - viableNodes.length} nodes priced above ${maxPrice} base units/GB` });
  }

  if (resume) {
    const testedAddrs = new Set(results.map(r => r.address));
    const before = viableNodes.length;
    const filtered = viableNodes.filter(({ node }) => !testedAddrs.has(node.address));
    const hi = state.resumeHeadAddr ? filtered.findIndex(({ node }) => node.address === state.resumeHeadAddr) : -1;
    if (hi > 0) { const [head] = filtered.splice(hi, 1); filtered.unshift(head); }
    if (hi >= 0) broadcast('log', { msg: `Resume: starting with interrupted node ${state.resumeHeadAddr.slice(0, 20)}…` });
    viableNodes.length = 0;
    viableNodes.push(...filtered);
    broadcast('log', { msg: `Resume: skipping ${before - viableNodes.length} already-tested, ${viableNodes.length} remaining.` });
  }

  state.totalNodes = (resume ? results.length : 0) + viableNodes.length;
  const gigs = gigsRT();
  state.estimatedTotalCost = `0.0000 ${TOKEN_LABEL}`;
  if (plan) {
    broadcast('log', { msg: `${viableNodes.length} testable plan nodes. Each session uses an access ticket from the provider — no channel, no per-node spend.` });
  } else {
    const hours = pricingMode === 'hours';
    const estCost = viableNodes.reduce((s, { node }) => s + Number((hours ? node._sol?.pricePerHour : node._sol?.pricePerGb) || 0) * (hours ? 1 : gigs), 0);
    broadcast('log', { msg: `${viableNodes.length} testable nodes. ~${(viableNodes.length ? estCost / viableNodes.length / 1e6 : 0).toFixed(6)} ${TOKEN_LABEL}/node avg, ~${(estCost / 1e6).toFixed(6)} ${TOKEN_LABEL} total est. (each node: ${hours ? 'one stream channel, 1 hour escrowed, closed right after the test — only the elapsed time is paid' : `one voucher channel, ${gigs} GB prepaid`})` });
  }
  broadcast('state', { state });

  const ctx = {
    keypair, rpcUrl: rpcCandidates()[0], settings: sessionSettings(), caps, testRun: state.testRun,
    runId: state.activeDbRunId, overrides, state, pricingMode,
    ticket: plan ? { provider: plan.provider, subscription: plan.subscriptionId, plan: plan.planId } : null,
  };

  // ─── Phase 3: sequential paid sessions ───
  for (let j = 0; j < viableNodes.length; j++) {
    if (state.stopRequested) { broadcast('log', { msg: '⏹ Stop requested.' }); break; }
    const { node, status } = viableNodes[j];
    const nodeNum = j + 1;
    state.currentNode = node.address;
    state.resumeHeadAddr = node.address;
    broadcast('state', { state });
    broadcast('log', { msg: `[${nodeNum}/${viableNodes.length}] Testing ${node.address.slice(0, 20)}…` });

    // Plan sessions open no channel, so the wallet balance does not gate them.
    const afford = !state.testRun && !plan && client ? await canAffordNextChannel(client, state) : { ok: true };
    if (!afford.ok) {
      broadcast('log', { msg: afford.tokensOk ? '💰 Insufficient SOL for channel rent and fees — pausing audit. Top up wallet and balance will be checked every 5 minutes.' : `💰 Insufficient ${TOKEN_LABEL} balance — pausing audit. Top up wallet and balance will be checked every 5 minutes.` });
      state.status = 'paused_balance';
      state.pauseReason = `Insufficient ${TOKEN_LABEL} balance (${(Math.max(0, state.balanceUdvpn - state.spentUdvpn) / 1_000_000).toFixed(2)} ${TOKEN_LABEL} remaining)`;
      broadcast('state', { state });
      let restored = false;
      while (!state.stopRequested) {
        await sleep(5 * 60_000);
        if (state.stopRequested) break;
        try {
          await refreshBalance(client, state);
          state.spentUdvpn = 0;
          broadcast('log', { msg: `💰 Balance check: ${state.balance}` });
          if ((await canAffordNextChannel(client, state)).ok) { restored = true; state.status = 'running'; state.pauseReason = null; broadcast('state', { state }); break; }
        } catch (balErr) { broadcast('log', { msg: `💰 Balance check failed: ${_sanitizeSnippet(balErr.message)} — retrying in 5 min` }); }
      }
      if (!restored) break;
    }

    // Cosmos: a fresh direct baseline before each node; one history sample per node that
    // records a result (the "Last 10 baseline readings" panel and the header average).
    setCurrentLabel(state, node, status);
    const baselineSample = state.testRun ? null : await refreshBaselineSample(state, broadcast);
    ctx.baselineMbps = state.baselineMbps;
    const { result, error, snippet } = await runOne(node, status, ctx, broadcast);
    if (result || !isStopSignal(state, error)) commitBaselineSample(state, baselineSample, node.address);
    if (result) {
      if (result.actualMbps != null) {
        addSpend(state, result.spentBase);
        recordPass(state, node, result, broadcast, `[${nodeNum}/${viableNodes.length}]`);
      } else {
        state.skippedNodes++;
        upsertResult(state, result);
        state.resumeHeadAddr = null;
        saveResults(state);
        broadcast('result', { result, state });
      }
    } else {
      if (isStopSignal(state, error)) { broadcast('log', { msg: `⏸ Node ${node.address.slice(0, 20)}… interrupted — will retry on resume` }); break; }
      // An outage on the tester's side must never be recorded against the node. With the
      // internet down the client daemon cannot reach the chain (DAEMON_NOT_READY), downloads
      // fail, etc. — none of it says anything about the node. Confirm our own connectivity
      // BEFORE recording; if it is down, pause and test the same node again afterwards.
      // (Found on the real-server e2e: two healthy nodes were recorded as failed.)
      const outage = await outageBeforeRecording(node, error, state, broadcast);
      if (outage === 'stop') break;
      if (outage === 'retry') { j--; continue; }
      const failResult = buildFailResult(node, status, state, error.message || 'Unknown error', { errorCode: error.errorCode, stage: error.stage, diag: error.diag });
      if (plan) { failResult.inPlan = true; failResult.planIds = [plan.planId]; }
      if (!isNodeFault(error.errorCode)) { failResult.skipped = true; state.skippedNodes++; }
      else state.failedNodes++;
      addSpend(state, error.diag?.spentBase);
      upsertResult(state, failResult, snippet);
      state.resumeHeadAddr = null;
      saveResults(state);
      broadcast('result', { result: failResult, state });
      broadcast('log', { msg: `${/timeout/i.test(failResult.error) ? '⏱ Timeout' : 'FAIL'} [${node.address.slice(0, 20)}…]: ${failResult.error}` });
    }
    if (j < viableNodes.length - 1 && NODE_DELAY > 0 && !state.testRun) await sleep(NODE_DELAY);
  }

  // Same as the Cosmos tester: nodes that fail the online scan are not recorded
  // (they never reach a paid test); the scan summary line counts them.

  await _finalizeOnchainReporter();
  if (keypair) {
    await sleep(7_000); // chain writes ≥ 7 s apart
    await sweepAfterRun(keypair, state, broadcast);
    try { await refreshBalance(client, state); state.spentUdvpn = 0; } catch (err) { console.warn('[pipeline] final balance refresh failed:', err.message); }
  }
  recomputeCounters(state);
  if (state.stopRequested) {
    state.status = 'stopped';
  } else {
    state.status = 'done';
    state.completedAt = new Date().toISOString();
  }
  state.currentNode = null;
  broadcast('state', { state });
  const finalFailed = results.filter(r => r.actualMbps == null && r.error && !r.skipped).length;
  broadcast('log', { msg: `✅ Audit complete. Tested ${state.testedNodes}, Failed ${finalFailed}. ${state.retryCount} retries total.` });
  const rc = rpcCounters();
  console.log(`[rpc] run totals (tester process; client containers not counted): ${rc.requests} requests, ${rc.rateLimited} × 429, ${rc.transportErrors} other transport errors`);
}

// ─── Retest previously-failed nodes ──────────────────────────────────────────
async function _runRetestSkips(skipAddrs, state, broadcast) {
  resetPipelineStop();
  _lastBaselineAddr = null;
  state.status = 'running';
  state.startedAt = new Date().toISOString();
  state.errorMessage = null;
  state.retryCount = 0;
  state.retestMode = true;
  state.retestTotal = skipAddrs.length;
  state.retestTested = 0;
  state.retestPassed = 0;
  state.retestFailed = 0;
  state.runSpentUdvpn = 0;
  state.spentUdvpn = 0;
  const testRun = !!state.testRun;
  broadcast('state', { state });
  broadcast('log', { msg: `🔄 Retesting ${skipAddrs.length} failed nodes...` });

  let keypair = null; let client = null;
  if (!testRun) {
    ({ keypair } = await cachedWalletSetup());
    client = await createFreshClient();
    state.walletAddress = keypair.publicKey.toBase58();
    await refreshBalance(client, state);
  }
  const caps = testRun ? _capsCache : await clientPreflight(broadcast);
  try {
    const b = await speedtestDirect();
    state.baselineMbps = b.mbps;
  } catch (e) { broadcast('log', { msg: `Baseline speed test failed: ${_sanitizeSnippet(e.message)}` }); }
  if (!testRun) _initOnchainReporter(keypair ? { address: keypair.publicKey.toBase58() } : null, state, broadcast);

  const all = await getAllNodes(broadcast);
  const want = new Set(skipAddrs);
  const nodes = all.filter(n => want.has(n.address));
  const missing = skipAddrs.filter(a => !nodes.some(n => n.address === a));
  if (missing.length) broadcast('log', { msg: `  ${missing.length} of the retest nodes no longer have a live listing — kept as failed` });
  const overrides = parseOverrides();
  // A retest keeps the run's payment route: plan runs retest with tickets, per-hour runs with stream channels.
  const planRetest = state.runMode === 'subscription' && state.runSubscriptionId && state.runGranter
    ? { provider: state.runGranter, subscription: state.runSubscriptionId, plan: state.runPlanId } : null;
  const ctx = {
    keypair, rpcUrl: rpcCandidates()[0], settings: sessionSettings(), caps, testRun, runId: state.activeDbRunId, overrides, state, baselineMbps: state.baselineMbps,
    pricingMode: planRetest ? 'gigabytes' : state.pricingMode === 'hours' ? 'hours' : 'gigabytes', ticket: planRetest,
  };

  for (let i = 0; i < nodes.length; i++) {
    if (state.stopRequested) break;
    const node = nodes[i];
    state.currentNode = node.address;
    broadcast('state', { state });
    broadcast('log', { msg: `🔄 [${i + 1}/${nodes.length}] Retesting ${node.address.slice(0, 20)}…` });
    const o = overrides.get(node.address);
    let status = null;
    try {
      status = await nodeStatusV3(node._sol, { overrideOrigin: probeOrigin(o) });
    } catch (err) {
      const outage = await outageBeforeRecording(node, err, state, broadcast);
      if (outage === 'stop') break;
      if (outage === 'retry') { i--; continue; }
      const failResult = buildFailResult(node, null, state, `Node unreachable: ${err.message}`, { errorCode: 'UNREACHABLE', stage: 'probe' });
      upsertResult(state, failResult, err.message);
      state.retestTested++; state.retestFailed++;
      saveResults(state);
      broadcast('result', { result: failResult, state });
      broadcast('log', { msg: `  ✗ Retest FAIL: ${failResult.error.slice(0, 80)}` });
      continue;
    }
    setCurrentLabel(state, node, status);
    const baselineSample = testRun ? null : await refreshBaselineSample(state, broadcast);
    ctx.baselineMbps = state.baselineMbps;
    const { result, error, snippet } = await runOne(node, status, ctx, broadcast);
    if (result || !isStopSignal(state, error)) commitBaselineSample(state, baselineSample, node.address);
    if (!result && !isStopSignal(state, error)) {
      const outage = await outageBeforeRecording(node, error, state, broadcast);
      if (outage === 'stop') break;
      if (outage === 'retry') { i--; continue; }
    }
    state.retestTested++;
    if (result && result.actualMbps != null) {
      addSpend(state, result.spentBase);
      state.retestPassed++;
      upsertResult(state, result);
      recomputeCounters(state);
      saveResults(state);
      broadcast('result', { result, state });
      broadcast('log', { msg: `  ✓ Retest PASS: ${result.actualMbps} Mbps` });
    } else if (result) {
      upsertResult(state, result);
      saveResults(state);
      broadcast('result', { result, state });
    } else {
      if (isStopSignal(state, error)) break;
      state.retestFailed++;
      const failResult = buildFailResult(node, status, state, error.message || 'Unknown', { errorCode: error.errorCode, stage: error.stage, diag: error.diag });
      if (planRetest) { failResult.inPlan = true; failResult.planIds = [planRetest.plan]; }
      addSpend(state, error.diag?.spentBase);
      upsertResult(state, failResult, snippet);
      saveResults(state);
      broadcast('result', { result: failResult, state });
      broadcast('log', { msg: `  ✗ Retest FAIL: ${failResult.error.slice(0, 80)}` });
    }
    if (i < nodes.length - 1 && NODE_DELAY > 0 && !testRun) await sleep(NODE_DELAY);
  }

  await _finalizeOnchainReporter();
  if (keypair) { await sleep(7_000); await sweepAfterRun(keypair, state, broadcast); }
  recomputeCounters(state);
  state.retestMode = false;
  state.status = state.stopRequested ? 'stopped' : 'done';
  state.completedAt = new Date().toISOString();
  state.currentNode = null;
  broadcast('state', { state });
  broadcast('log', { msg: `✅ Retest complete. ${state.retestPassed} passed, ${state.retestFailed} failed.` });
}

// ─── Plan / subscription runs ────────────────────────────────────────────────
// Cosmos: sessions are subscription-allocated MsgStartSession txs (gas fee-granted
// by the plan owner). Solana: each session starts with an access ticket — the
// client signs a ticket request, the node forwards it to the plan's provider,
// the provider checks the subscription + its roster and signs. No channel, no
// spend, no tx per session. Mapping: planId = Plan PDA, subscriptionId =
// Subscription PDA, granter = Provider PDA (lib/plans.js).

function planRunError(state, broadcast, msg) {
  state.status = 'error';
  state.errorMessage = msg;
  broadcast('log', { msg: `✗ ${msg}` });
  broadcast('state', { state });
  return new Error(msg);
}

/** Check that `subscriptionId` is an active subscription of `owner` to `planId`; returns the plan run descriptor. */
export async function resolvePlanRun(owner, planId, subscriptionId, granter, { now = Math.floor(Date.now() / 1000), fetchSub = subscriptionAccount } = {}) {
  const sub = await fetchSub(subscriptionId);
  if (!sub) throw new Error(`subscription ${subscriptionId} not found on chain`);
  if (sub.owner !== owner) throw new Error(`subscription ${subscriptionId} belongs to ${sub.owner}, not the tester wallet ${owner}`);
  if (sub.plan !== planId) throw new Error(`subscription ${subscriptionId} is for plan ${sub.plan}, not ${planId}`);
  if (Number(sub.expiresAt) <= now) throw new Error(`subscription ${subscriptionId} expired at ${new Date(Number(sub.expiresAt) * 1000).toISOString()}`);
  if (granter && granter !== sub.provider) throw new Error(`provider ${granter} does not run this plan (its provider is ${sub.provider})`);
  return { planId, subscriptionId, provider: sub.provider, expiresAt: Number(sub.expiresAt), dataCapGb: Number(sub.dataCapGb) };
}

/**
 * Plan runs do chain work (subscription check / subscribe) before _runAudit takes over, so
 * they claim the run at once — as the Cosmos plan runners do — or the server would see an
 * idle tester and accept a second start, and `wait` would return before the run began.
 */
function claimPlanRun(state, broadcast) {
  resetPipelineStop();
  state.status = 'running';
  state.errorMessage = null;
  state.startedAt = new Date().toISOString();
  broadcast('state', { state });
}

async function _runSubPlanTest(planId, subscriptionId, granter, state, broadcast, opts = {}) {
  if (state.status !== 'running') claimPlanRun(state, broadcast);
  state.testRun = false;
  state.runMode = 'subscription';
  state.runPlanId = String(planId);
  state.runSubscriptionId = String(subscriptionId);
  state.runGranter = String(granter || '');
  broadcast('log', { msg: `📋 Sub. Plan ${String(planId).slice(0, 8)}… — subscription ${String(subscriptionId).slice(0, 8)}… — provider ${String(granter || '?').slice(0, 8)}…` });
  const { account } = await cachedWalletSetup();
  let plan;
  try {
    plan = await resolvePlanRun(account.address, String(planId), String(subscriptionId), granter ? String(granter) : null);
  } catch (err) {
    throw planRunError(state, broadcast, `Plan run refused: ${err.message}`);
  }
  broadcast('log', { msg: `  ✓ Subscription active until ${new Date(plan.expiresAt * 1000).toISOString()}${plan.dataCapGb ? ` · ${plan.dataCapGb} GB cap` : ''} · sessions use access tickets (no transaction, no channel)` });
  // state.planAddresses: optional roster subset from /api/test-plan|test-sub-plan (a provider limits live tickets).
  const addresses = Array.isArray(state.planAddresses) && state.planAddresses.length ? state.planAddresses : null;
  if (addresses) broadcast('log', { msg: `  Roster limited to ${addresses.length} node(s): ${addresses.map((x) => x.slice(0, 8)).join(', ')}` });
  return _runAudit(!!opts.resume, state, broadcast, null, { plan, addresses });
}

/**
 * Cosmos "Test Plan": subscribe to the plan (or reuse an active subscription), then
 * run it like a Sub. Plan test. An EXPIRED subscription of ours to the same plan
 * occupies the PDA, so it is closed first (the owner may always close its own).
 */
async function _runPlanTest(planId, state, broadcast) {
  planId = String(planId);
  claimPlanRun(state, broadcast);
  state.testRun = false;
  state.runMode = 'subscription';
  state.runPlanId = planId;
  broadcast('log', { msg: `📋 Plan ${planId.slice(0, 8)}… — subscribing and testing connectivity...` });
  const { account, keypair } = await cachedWalletSetup();
  const planAcct = await planAccount(planId);
  if (!planAcct) throw planRunError(state, broadcast, `Plan ${planId} not found on chain`);
  if (Number(planAcct.status) !== 1) throw planRunError(state, broadcast, `Plan ${planId} is not listed`);
  const subAddr = pda.subscription(account.address, planId).toBase58();
  const existing = await subscriptionAccount(subAddr);
  const now = Math.floor(Date.now() / 1000);
  if (existing && Number(existing.expiresAt) > now) {
    broadcast('log', { msg: `  ♻ Already subscribed — subscription ${subAddr} (FREE)` });
  } else {
    try {
      if (existing) {
        const c = await sendIxs(keypair, [await ix.closeSubscription({ signer: keypair.publicKey, subscription: subAddr, subAcct: existing })], 'close_subscription');
        broadcast('log', { msg: `  Closed our expired subscription ${subAddr.slice(0, 8)}… (rent back) — tx ${c.txHash}` });
        await sleep(7_000);
      }
      broadcast('log', { msg: `  Subscribing to plan ${planId} (${planAcct.price} base units, ${planAcct.durationSeconds}s, ${planAcct.dataCapGb} GB cap)...` });
      const r = await sendIxs(keypair, [await ix.openSubscription({ signer: keypair.publicKey, plan: planId, planAcct })], 'open_subscription');
      state.spentUdvpn = (state.spentUdvpn || 0) + Number(planAcct.price);
      state.runSpentUdvpn = (state.runSpentUdvpn || 0) + Number(planAcct.price);
      broadcast('log', { msg: `  ✓ Subscribed — subscription_id=${subAddr} tx=${r.txHash}` });
      await sleep(7_000);
    } catch (err) {
      throw planRunError(state, broadcast, `Plan subscribe failed: ${_sanitizeSnippet(err.message)}`);
    }
  }
  const spent = state.runSpentUdvpn || 0;
  await _runSubPlanTest(planId, subAddr, planAcct.provider, state, broadcast);
  // _runAudit resets the per-pass spend; the subscription bought here is part of this run.
  state.runSpentUdvpn = (state.runSpentUdvpn || 0) + spent;
}

// ─── One pipeline at a time ──────────────────────────────────────────────────
// /api/stop flips the status to 'stopped' at once, so the server will accept a
// new start while the stopped pipeline is still unwinding (report flush, final
// balance read). Two pipelines would share `state`/`results` and the new run's
// preflight would remove the old run's container. Each run therefore waits for
// the previous one to finish before it touches anything.
let _activeRun = Promise.resolve();
function serialized(name, fn) {
  return async (...args) => {
    const prev = _activeRun;
    let release;
    _activeRun = new Promise((r) => { release = r; });
    try {
      let waited = false;
      const t = setTimeout(() => { waited = true; console.log(`[pipeline] ${name}: waiting for the previous run to finish unwinding`); }, 500);
      await prev.catch((err) => console.warn('[pipeline] previous run ended with error:', err?.message));
      clearTimeout(t);
      if (waited) console.log(`[pipeline] ${name}: previous run finished, starting`);
      return await fn(...args);
    } finally {
      release();
    }
  };
}

export const runAudit = serialized('runAudit', _runAudit);
export const runRetestSkips = serialized('runRetestSkips', _runRetestSkips);
export const runSubPlanTest = serialized('runSubPlanTest', _runSubPlanTest);
export const runPlanTest = serialized('runPlanTest', _runPlanTest);

// Exported for the unit suite (decision functions of the pause paths).
export { canAffordNextChannel, isInternetError, outageBeforeRecording };
