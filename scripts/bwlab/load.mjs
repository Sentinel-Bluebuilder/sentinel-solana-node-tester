#!/usr/bin/env node
// ─── Load lab: N real users on one node, ramped, with the tester's own test at each step ───
// docs/LOAD-TEST-PLAN.md. Every user is a real paid session in its own client container
// (audit/session-runner.js `load` option, profile in audit/load-profile.js). At each step the
// production test (audit/node-test.js testNode, steady method) runs as user N+1, so the
// report can compare "do the users still get 10 Mbps" with "would the tester cut this node".
//
//   node scripts/bwlab/load.mjs --node <addr> --origin https://<ip>[:port] --pin 'sha256//…'
//        --steps 1,2,5,10 [--step-seconds 120] [--profile stream10|browse|bulk|mix]
//        [--gigabytes] [--no-tester] --out test/bwlab/<date>/load.jsonl [--label txt]
//
// Pricing is per hour by default: a stream channel has no byte cap, so a long ramp never
// makes a client top up mid-step (--gigabytes for the billing check; keep it short).
// Chain txs stay ≥ 8 s apart: users join one at a time, and stream channels are closed one
// at a time after the users stop. Every channel is recorded for the sweep the moment the
// daemon prints it. Never run it beside a tester server that is testing: a run start removes
// every client container (audit/pipeline.js clientPreflight).
import 'dotenv/config';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cachedWalletSetup } from '../../core/wallet.js';
import { getAllNodes } from '../../core/chain.js';
import { nodeStatusV3 } from '../../protocol/v3protocol.js';
import { testNode, parseOverrides, probeOrigin } from '../../audit/node-test.js';
import { runSessionTest } from '../../audit/session-runner.js';
import { closeStreamChannel } from '../../audit/channels.js';
import { probeClientCapabilities } from '../../audit/docker.js';
import { recordChannel } from '../../lib/db.js';
import { rpcCandidates } from '../../lib/solana/rpc.js';
import { DVPND_IMAGE, DEFAULT_ESCROW_BASE } from '../../lib/constants.js';
import { newSeed } from '../../lib/speed-content.js';
import { parseLoad } from '../../audit/load-profile.js';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(name);
const need = (name) => { const v = opt(name); if (!v) throw new Error(`${name} is required`); return v; };

const NODE = need('--node');
const ORIGIN = need('--origin').replace(/\/$/, '');
const PIN = need('--pin');
const STEPS = need('--steps').split(',').map(Number);
const STEP_SECONDS = Number(opt('--step-seconds', '120'));
const PROFILE = opt('--profile', 'stream10');
const PRICING = flag('--gigabytes') ? 'gigabytes' : 'hours';
const TESTER = !flag('--no-tester');
const OUT = need('--out');
const LABEL = opt('--label', '');
const JOIN_GAP_MS = 8_000;
const MAX_USERS = 60;
if (!STEPS.length || STEPS.some((n, i) => !(n >= 1) || (i && n <= STEPS[i - 1]))) throw new Error('--steps must be increasing positive counts');
if (STEPS[STEPS.length - 1] > MAX_USERS) throw new Error(`at most ${MAX_USERS} users`);
if (!/^(stream10|browse|bulk|mix)$/.test(PROFILE)) throw new Error(`unknown --profile ${PROFILE}`);
if (!(STEP_SECONDS >= 30)) throw new Error('--step-seconds must be ≥ 30');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[load ${new Date().toISOString().slice(11, 19)}] ${m}`);
/** Mixed population (docs/LOAD-TEST-PLAN.md): 60 % browse, 30 % stream10, 10 % … and user 1 is the greedy one. */
export function profileFor(i, profile) {
  if (profile !== 'mix') return profile;
  if (i === 1) return 'bulk';
  return i % 10 < 6 ? 'browse' : 'stream10';
}

// ─── Setup (as scripts/bwlab/session.mjs) ───
const { keypair } = await cachedWalletSetup();
const nodes = await getAllNodes(() => {});
const node = nodes.find((n) => n.address === NODE);
if (!node) throw new Error(`node ${NODE} is not listed on chain`);
const overrides = parseOverrides();
const status = await nodeStatusV3(node._sol, { overrideOrigin: probeOrigin(overrides.get(NODE)) });
const probe = status?._probe || null;
const caps = await probeClientCapabilities(DVPND_IMAGE);
if (!caps.ok) throw new Error(`client container cannot run here: ${caps.output.slice(-200)}`);
const rpcUrl = rpcCandidates()[0];
const totalSeconds = STEPS.length * (STEP_SECONDS + 60) + STEPS[STEPS.length - 1] * (JOIN_GAP_MS / 1000) + 600;
const settings = {
  testBytes: Math.max(1, Number(process.env.TEST_MB || 10)) * 1_000_000,
  prepayBytes: 1_000_000_000,
  escrowBase: DEFAULT_ESCROW_BASE,
  clientTimeoutSec: totalSeconds + 300,
  skipUnsupportedProtocols: true,
};
const override = overrides.get(NODE) || null;

// ─── Chain-touching steps one at a time, ≥ 8 s apart ───
let chainQueue = Promise.resolve();
const chainStep = (fn) => {
  const next = chainQueue.then(fn).finally(() => sleep(JOIN_GAP_MS));
  chainQueue = next.catch(() => {});
  return next;
};

// ─── Users ───
const users = [];
function addUser(i) {
  const u = { i, profile: profileFor(i, PROFILE), hostDir: null, channel: null, joinedAt: Date.now(), connectedAt: null, failLine: null, result: null, error: null, close: null };
  const seed = newSeed().slice(0, 16);
  u.done = runSessionTest({
    node: node._sol, probe, keypair, rpcUrl, settings, pricing: PRICING,
    override: override ? { host: override.host, port: override.port || 443 } : null,
    load: { profile: u.profile, origin: ORIGIN, pin: PIN, seed, maxSeconds: totalSeconds },
    onStart: ({ hostDir }) => { u.hostDir = hostDir; },
    onLine: (line) => {
      if (/^SID /.test(line) && !u.connectedAt) { u.connectedAt = Date.now(); log(`user ${i} (${u.profile}) connected`); }
      if (/^FAIL/.test(line)) u.failLine = line.trim();
    },
    onChannel: (address, escrow) => {
      u.channel = address;
      recordChannel({ address, node_addr: NODE, run_id: null, escrow_base: Number(escrow) });
    },
  }).then((r) => { u.result = r; }, (err) => { u.error = err.message; })
    .then(async () => {
      if (PRICING === 'hours' && u.channel) {
        // A stream channel bills until closed: close it now (the sweep is the fallback).
        await chainStep(async () => {
          try { u.close = await closeStreamChannel(keypair, u.channel, { log: () => {} }); } catch (err) { u.close = { error: err.message }; }
        });
      }
    });
  users.push(u);
  return u;
}

async function waitConnected(list, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && list.some((u) => !u.connectedAt && !u.result && !u.error && !u.failLine)) await sleep(1000);
}

const steps = [];
const t0 = new Date();
log(`node ${NODE.slice(0, 8)} (${status?.type || node._sol?.protocol}), ${PRICING}, profile ${PROFILE}, steps ${STEPS.join('→')} × ${STEP_SECONDS} s`);
try {
  for (const n of STEPS) {
    const joining = [];
    while (users.length < n) {
      const i = users.length + 1;
      await chainStep(async () => { joining.push(addUser(i)); });
    }
    await waitConnected(joining);
    const live = users.filter((u) => u.connectedAt && !u.result && !u.error).length;
    const step = { n, live, start: Date.now(), end: null, tester: null };
    log(`step ${n} users: ${live} live — holding ${STEP_SECONDS} s`);
    if (TESTER) {
      // The production test as user N+1, in the second half of the step.
      await sleep(Math.max(0, STEP_SECONDS - 60) * 1000);
      const ctx = { keypair, rpcUrl, settings: { ...settings, clientTimeoutSec: 420 }, caps, testRun: false, runId: null, overrides, state: {}, baselineMbps: null, pricingMode: PRICING, broadcast: () => {} };
      const tStart = Date.now();
      try {
        const r = await chainStep(() => testNode(node, status, ctx));
        const sm = r.diag?.speedMethod || {};
        step.tester = { start: tStart, end: Date.now(), mbps: r.actualMbps, lineMbps: sm.lineMbps ?? null, verified: sm.verified ?? null, basis: sm.basis ?? null, latencyMs: r.latencyMs, loadedMs: sm.loadedLatency?.medianMs ?? null, channel: r.channel, pass10: r.pass10mbps };
      } catch (err) {
        step.tester = { start: tStart, end: Date.now(), error: err.message, errorCode: err.errorCode || null };
      }
      log(`step ${n}: tester read ${step.tester.mbps ?? step.tester.errorCode ?? step.tester.error} Mbps`);
    }
    const left = step.start + STEP_SECONDS * 1000 - Date.now();
    if (left > 0) await sleep(left);
    step.end = Date.now();
    steps.push(step);
  }
} finally {
  // Stop users one at a time (their stream channels close one at a time behind them).
  for (const u of users) {
    if (u.hostDir) { try { writeFileSync(join(u.hostDir, 'stop'), ''); } catch (err) { log(`user ${u.i}: stop file failed: ${err.message}`); } }
  }
  await Promise.all(users.map((u) => u.done));
  await chainQueue;
}

// ─── Record ───
mkdirSync(join(dirname(OUT), 'load-raw'), { recursive: true });
const stamp = t0.toISOString().replace(/[:.]/g, '-');
const userLines = users.map((u) => {
  const raw = u.result?.loadOutput || u.result?.transcript || '';
  const rawFile = join(dirname(OUT), 'load-raw', `${stamp}-${NODE.slice(0, 8)}-u${u.i}.txt`);
  writeFileSync(rawFile, raw);
  return {
    i: u.i, profile: u.profile, channel: u.channel, joinedAt: u.joinedAt, connectedAt: u.connectedAt,
    error: u.error || u.failLine || (u.result && !u.result.sessionId ? u.result.error || 'no session' : null),
    clientRxBytes: u.result?.clientRxBytes ?? null, clientTxBytes: u.result?.clientTxBytes ?? null, spentBase: u.result?.spentBase ?? null,
    closeRedeemed: u.close?.redeemedBase ?? null, closeError: u.close?.error ?? null,
    load: parseLoad(raw), raw: rawFile,
  };
});
const line = { ts: t0.toISOString(), label: LABEL, node: NODE, protocol: status?.type || node._sol?.protocol, pricing: PRICING, profile: PROFILE, origin: ORIGIN, stepSeconds: STEP_SECONDS, steps, users: userLines };
appendFileSync(OUT, JSON.stringify(line) + '\n');
log(`done: ${users.length} users, ${userLines.filter((u) => u.error).length} with errors → ${OUT}`);
process.exit(0);
