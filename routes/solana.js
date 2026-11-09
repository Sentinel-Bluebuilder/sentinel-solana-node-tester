// ─── Solana-only routes ──────────────────────────────────────────────────────
// Added beside the shared Cosmos API (server.js). Nothing here is used by the
// dashboards; they are operator/CLI tools for what has no Cosmos equivalent.
//   GET  /api/solana/info                  network, program, mint, tester wallet (public)
//   GET  /api/solana/doctor                Docker, client image, client caps, wallet, RPC (admin)
//   GET  /api/solana/channels              test channels tracked by the tester (+ ?chain=1) (admin)
//   POST /api/solana/channels/sweep        start-close / close / withdraw test channels (admin)
//   POST /api/solana/node/:addr/probe      signed-metadata probe of one node, never spends (admin)
//   GET  /api/solana/reports               report memos this tester posted (admin)
//   GET  /api/solana/config                every setting: runtime (CLI-changeable) + env (restart) (admin)
//   GET  /api/solana/speed                 speed method in use + origin check (admin)
//   POST /api/solana/speed/baseline        run the tester's direct baseline with that method (admin)
import { Router } from 'express';
import { speedMethodStatus } from '../lib/speed-method.js';
import { speedtestDirect, resetSteadyBaseline } from '../protocol/speedtest.js';
import { PublicKey } from '@solana/web3.js';
import { adminOnly } from '../core/auth.js';
import { NETWORK, PROGRAM_ID, MINT } from '../lib/solana/idl.js';
import { getRpcState, rpcCandidates, redactUrl } from '../lib/solana/rpc.js';
import { getSettings } from '../core/settings.js';
import { ACTIVE_DNS, TEST_MB, MAX_NODES, NODE_DELAY } from '../core/constants.js';
import { DVPND_IMAGE, PORT, LISTEN_HOST, CONNECTIVITY_URL, DEFAULT_ESCROW_BASE } from '../lib/constants.js';
import { speedSources } from '../lib/speed.js';
import { channelsByOwner, getConfig } from '../lib/solana/accounts.js';
import { discoverNode, probeNode } from '../lib/discovery.js';
import { walletAddress, walletBalances, walletConfigured, getKeypair } from '../lib/wallet.js';
import { dockerStatus, imagePresent, probeClientCapabilities, removeStaleClientDirs } from '../audit/docker.js';
import { sweepTestChannels } from '../audit/channels.js';
import { parseOverrides, probeOrigin } from '../audit/node-test.js';
import { cachedCaps } from '../audit/pipeline.js';
import { listChannels, listReports } from '../lib/db.js';
import { EXPLORER_CLUSTER } from '../core/constants.js';

function pubkey(s) {
  try { return new PublicKey(String(s || '').trim()).toBase58(); } catch (err) { return null; }
}

function wrap(fn) {
  return async (req, res) => {
    try { await fn(req, res); } catch (err) {
      const status = Number.isInteger(err.status) ? err.status : 500;
      if (status >= 500) console.error(`[solana] ${req.method} ${req.path}:`, err.stack || err.message);
      res.status(status).json({ error: err.message, errorCode: err.errorCode || null });
    }
  };
}

export default function solanaRoutes({ state, broadcast, isAuditBusy }) {
  const r = Router();

  r.get('/api/solana/info', wrap(async (req, res) => {
    res.json({ network: NETWORK, programId: PROGRAM_ID.toBase58(), mint: MINT.toBase58(), explorerCluster: EXPLORER_CLUSTER, tester: walletAddress(), image: DVPND_IMAGE });
  }));

  r.get('/api/solana/doctor', adminOnly, wrap(async (req, res) => {
    const out = { network: NETWORK, programId: PROGRAM_ID.toBase58(), mint: MINT.toBase58(), image: DVPND_IMAGE, problems: [] };
    out.rpc = await getRpcState();
    if (!out.rpc.slot) out.problems.push('RPC unreachable');
    try {
      const cfg = await getConfig();
      out.program = { paused: Number(cfg.pausedMask), feeBps: Number(cfg.feeBps), channelCloseGraceSeconds: Number(cfg.channelCloseGraceSeconds), nodeListingTtlSeconds: Number(cfg.nodeListingTtlSeconds) };
    } catch (err) { out.problems.push(`program config unreadable: ${err.message}`); }
    out.docker = await dockerStatus();
    if (!out.docker.ok) out.problems.push(`Docker unavailable: ${out.docker.error}`);
    out.imagePresent = out.docker.ok ? await imagePresent(DVPND_IMAGE) : { ok: false };
    if (out.docker.ok && !out.imagePresent.ok) out.problems.push(`client image ${DVPND_IMAGE} missing`);
    out.clientCaps = out.imagePresent.ok ? (cachedCaps() || await probeClientCapabilities(DVPND_IMAGE)) : null;
    if (out.clientCaps && !out.clientCaps.ok) out.problems.push('client container cannot run dvpnd');
    if (!walletConfigured()) out.problems.push('TEST_KEYFILE not set');
    else {
      try {
        out.wallet = await walletBalances();
        if (out.wallet.lamports < 10_000_000) out.problems.push('wallet holds less than 0.01 SOL');
        if (BigInt(out.wallet.tokenBase) < 200_000n) out.problems.push('wallet holds less than one channel escrow of tDVPN');
      } catch (err) { out.problems.push(err.message); }
    }
    out.overrides = Object.fromEntries(parseOverrides());
    out.speed = await speedMethodStatus();
    if (out.speed.problem) out.problems.push(`speed method: ${out.speed.problem}`);
    out.ready = out.problems.length === 0;
    res.json(out);
  }));

  r.get('/api/solana/channels', adminOnly, wrap(async (req, res) => {
    const tracked = listChannels({ openOnly: req.query.open === '1' });
    let onChain = null;
    if (req.query.chain === '1' && walletConfigured()) {
      const mine = new Set(tracked.map((c) => c.address));
      onChain = (await channelsByOwner(getKeypair().publicKey.toBase58())).map((c) => ({
        address: c.address, node: c.node, status: Number(c.status), mode: Number(c.mode), escrow: c.escrow, redeemed: c.redeemed,
        closeStartedAt: Number(c.closeStartedAt), trackedByTester: mine.has(c.address),
      }));
    }
    res.json({ tracked, onChain });
  }));

  r.post('/api/solana/channels/sweep', adminOnly, wrap(async (req, res) => {
    if (isAuditBusy()) return res.status(409).json({ error: 'RUN_ACTIVE', message: 'A run is in progress — it sweeps on its own when it ends.' });
    const dryRun = req.body?.dryRun === true || req.body?.dryRun === '1';
    const out = await sweepTestChannels(getKeypair(), { dryRun });
    if (!dryRun && (out.startedClose.length || out.closed.length)) {
      broadcast('log', { msg: `💸 Channels swept: ${out.startedClose.length} closing · ${out.closed.length} closed · ${out.withdrawnBase} base units refunded` });
    }
    res.json(out);
  }));

  r.get('/api/solana/speed', adminOnly, wrap(async (req, res) => {
    res.json(await speedMethodStatus());
  }));

  // A fresh baseline: the direct (no tunnel) speed of this tester's own link, measured with the
  // method node tests use. Moves up to SPEED_BUDGET_MB from the origin; refused during a run.
  r.post('/api/solana/speed/baseline', adminOnly, wrap(async (req, res) => {
    if (isAuditBusy()) return res.status(409).json({ error: 'RUN_ACTIVE', message: 'A run is in progress — it measures its own baseline.' });
    const status = await speedMethodStatus();
    resetSteadyBaseline();
    const b = await speedtestDirect();
    res.json({ method: b.method || 'classic-10mb', mbps: b.mbps, bytes: b.bytes, ms: b.ms, detail: b.adaptive, status });
  }));

  r.post('/api/solana/node/:addr/probe', adminOnly, wrap(async (req, res) => {
    const addr = pubkey(req.params.addr);
    if (!addr) return res.status(400).json({ error: 'not a valid Solana address' });
    const node = await discoverNode(addr);
    if (!node) return res.status(404).json({ error: 'no node account at that address' });
    const o = parseOverrides().get(addr);
    const overrideOrigin = probeOrigin(o);
    res.json({ node, override: o || null, probe: await probeNode(node, { overrideOrigin }) });
  }));

  // Every setting in one place: runtime ones (changed with `settings`, `dns`, `broadcast`,
  // no restart) and env ones (.env, read at boot — restart to change). URLs are redacted.
  r.get('/api/solana/config', adminOnly, wrap(async (req, res) => {
    const s = getSettings();
    const env = (k, fallback, note) => ({ source: 'env', value: process.env[k] ?? null, effective: fallback, restart: true, ...(note ? { note } : {}) });
    // Overrides are <pda>=<host[:port]> pairs — addresses, no secrets.
    const overrides = (raw) => String(raw || '').split(',').map((x) => x.trim()).filter(Boolean);
    res.json({
      runtime: {
        gigabytes: { cli: 'gigabytes', value: s.gigabytes, effect: 'GB prepaid per per-GB session (sizes the voucher channel escrow)' },
        maxPriceUdvpn: { cli: 'maxPriceBase', value: s.maxPriceUdvpn, effect: 'skip nodes whose per-GB price (base units) is above this; 0 = no cap' },
        autoCancelAfterTest: { cli: 'autoCancelAfterTest', value: s.autoCancelAfterTest, effect: 'start-close every test channel after a run (refund after the close grace)' },
        onchainEnabled: { cli: 'onchainEnabled', value: s.onchainEnabled, effect: 'post SNTR1 v3 SPL Memo reports' },
        onchainBatchSize: { cli: 'onchainBatchSize', value: s.onchainBatchSize, effect: 'nodes per report memo' },
        onchainRegion: { cli: 'onchainRegion', value: s.onchainRegion, effect: 'region in the memo header (2-letter ISO, empty = unknown)' },
        batchSize: { cli: 'batchSize', value: s.batchSize, effect: 'none on Solana (Cosmos batch payment) — kept for the shared UI' },
        dns: { cli: 'dns', value: [...ACTIVE_DNS], effect: 'DNS servers the client container uses' },
        broadcastLive: { cli: 'broadcast', value: !!state.broadcastLive, effect: 'public /live shows the run' },
      },
      env: {
        PORT: env('PORT', PORT), LISTEN_HOST: env('LISTEN_HOST', LISTEN_HOST),
        PUBLIC_MODE: env('PUBLIC_MODE', process.env.PUBLIC_MODE === 'true'), ADMIN_TOKEN: { source: 'env', set: !!process.env.ADMIN_TOKEN, restart: true },
        ALLOW_PUBLIC_TEST: env('ALLOW_PUBLIC_TEST', process.env.ALLOW_PUBLIC_TEST === 'true'),
        SOLANA_NETWORK: env('SOLANA_NETWORK', NETWORK), SOLANA_RPC_URLS: { source: 'env', effective: rpcCandidates().map(redactUrl), restart: true },
        TEST_KEYFILE: { source: 'env', set: walletConfigured(), wallet: walletAddress(), restart: true },
        DVPND_IMAGE: env('DVPND_IMAGE', DVPND_IMAGE),
        TEST_MB: env('TEST_MB', TEST_MB, 'MB downloaded through each tunnel'),
        GIGABYTES_PER_NODE: env('GIGABYTES_PER_NODE', null, 'first-boot default for the runtime `gigabytes`'),
        MAX_NODES: env('MAX_NODES', MAX_NODES, '0 = every node'),
        NODE_DELAY_MS: env('NODE_DELAY_MS', NODE_DELAY),
        CLIENT_TIMEOUT_SEC: env('CLIENT_TIMEOUT_SEC', Math.max(120, parseInt(process.env.CLIENT_TIMEOUT_SEC || '360', 10))),
        SPEED_METHOD: env('SPEED_METHOD', (await speedMethodStatus(process.env, { probe: false })).active, 'steady (default: 4 streams × 10 s from our pinned origin, verified bytes) or classic (one 10 MB download); `speed` shows the live state'),
        SPEED_ORIGIN: env('SPEED_ORIGIN', process.env.SPEED_ORIGIN || null, 'the steady method\'s origin (scripts/bwlab/origin.mjs)'),
        SPEED_PIN: env('SPEED_PIN', process.env.SPEED_PIN || null, 'sha256// SPKI pin of the origin key'),
        SPEED_SECRET_FILE: { source: 'env', set: !!(process.env.SPEED_SECRET_FILE || process.env.SPEED_SECRET), restart: true, note: 'origin content secret (never printed)' },
        SPEED_STREAMS: env('SPEED_STREAMS', Number(process.env.SPEED_STREAMS || 4)),
        SPEED_SECONDS: env('SPEED_SECONDS', Number(process.env.SPEED_SECONDS || 10)),
        SPEED_BUDGET_MB: env('SPEED_BUDGET_MB', Number(process.env.SPEED_BUDGET_MB || 600), 'bytes cap of one steady test (also ≤ 60 % of a per-GB prepay)'),
        SPEED_BASELINE_TTL_SEC: env('SPEED_BASELINE_TTL_SEC', Number(process.env.SPEED_BASELINE_TTL_SEC ?? 1800), 'reuse a steady baseline this long (the pipeline asks before every node)'),
        SPEED_URL: { source: 'env', effective: speedSources(TEST_MB * 1_000_000).map(redactUrl), restart: true, note: 'classic method (and the classic reading kept beside steady): first = SPEED_URL, then SPEED_FALLBACK_URLS' },
        CONNECTIVITY_URL: env('CONNECTIVITY_URL', CONNECTIVITY_URL),
        INTERNET_CHECK_URLS: env('INTERNET_CHECK_URLS', null, 'empty = google, 1.1.1.1, cloudflare'),
        MIN_CHANNEL_BALANCE_BASE: env('MIN_CHANNEL_BALANCE_BASE', Number(process.env.MIN_CHANNEL_BALANCE_BASE || DEFAULT_ESCROW_BASE), 'low-balance pause threshold'),
        SWEEP_EVERY_MS: env('SWEEP_EVERY_MS', SWEEP_EVERY_MS),
        DNS_SERVERS: env('DNS_SERVERS', null, 'boot default for the runtime `dns`'),
        NODE_URI_OVERRIDES: { source: 'env', effective: overrides(process.env.NODE_URI_OVERRIDES), restart: true },
        PROVIDER_API_OVERRIDES: { source: 'env', effective: overrides(process.env.PROVIDER_API_OVERRIDES), restart: true },
      },
    });
  }));

  r.get('/api/solana/reports', adminOnly, wrap(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10) || 20, 1), 200);
    res.json({ reports: listReports({ limit }), state: { reportsWallet: state.walletAddress || walletAddress() } });
  }));

  // ─── Background refund sweep ───
  // A run's auto-cancel only STARTS the close (the node keeps a 2 h grace to redeem).
  // Every hour, while no audit is running, close the matured test channels and
  // withdraw their unspent escrow back to the wallet. Only tracked channels move.
  const SWEEP_EVERY_MS = Number(process.env.SWEEP_EVERY_MS || 60 * 60_000);
  async function backgroundSweep() {
    // No open-channel guard: the sweep returns at once when nothing is tracked, and still
    // retries a withdraw an earlier sweep could not finish (refundPending).
    if (!walletConfigured() || isAuditBusy()) return;
    try {
      const out = await sweepTestChannels(getKeypair(), {});
      if (out.closed.length || out.startedClose.length) {
        broadcast('log', { msg: `💸 Channels swept: ${out.startedClose.length} closing · ${out.closed.length} closed · ${out.withdrawnBase} base units refunded` });
      }
      if (out.errors.length) console.warn('[solana] background sweep errors:', out.errors.join(' | '));
    } catch (err) {
      console.error('[solana] background sweep failed:', err.message);
    }
  }
  setTimeout(() => { backgroundSweep(); setInterval(backgroundSweep, SWEEP_EVERY_MS).unref(); }, 90_000).unref();

  // Boot: no session is in flight yet, so any client dir is a crash leftover holding a key copy.
  const staleDirs = removeStaleClientDirs();
  if (staleDirs) console.warn(`[solana] removed ${staleDirs} client session dir(s) left by an earlier crash`);

  return r;
}
