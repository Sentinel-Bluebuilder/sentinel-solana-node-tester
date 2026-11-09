#!/usr/bin/env node
// ─── Bandwidth lab: one measured session against one node ───
// Runs the production session path (audit/node-test.js testNode: channel recorded for the
// sweep, stream channels closed right after) with the lab block mounted in the client
// container (audit/speed-lab.js). Appends one JSON line per session; the raw transcript
// goes next to it so every number can be recomputed.
//
//   node scripts/bwlab/session.mjs --node <addr> --origin https://<ip>:8443 --pin 'sha256//…' \
//        --secret-file secret.txt --plan M2:1:10,M3a:4:10,M3b:8:10 [--hours] [--gigabytes 2] \
//        --out test/bwlab/<date>/sessions.jsonl [--label txt] [--server http://127.0.0.1:3011]
//        [--lab-opts nosample,noprobe]   drop the lab's background traffic
//        [--lab-first]   run the lab block before the tester's own download
//        [--steady]      no lab block: the tester's own steady speed method (lib/speed-method.js)
//                        runs against --origin, exactly as production would with SPEED_METHOD=steady
//        [--classic]     no lab block and no steady method: today's production session, unchanged
//        [--extra-url <third-party file>]   methods named X* download it instead of our origin
//
// Never run it while the tester server runs a test: a run start removes every client
// container and session dir (audit/pipeline.js clientPreflight), this one included.
import 'dotenv/config';
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cachedWalletSetup } from '../../core/wallet.js';
import { getAllNodes } from '../../core/chain.js';
import { nodeStatusV3 } from '../../protocol/v3protocol.js';
import { testNode, parseOverrides, probeOrigin } from '../../audit/node-test.js';
import { probeClientCapabilities } from '../../audit/docker.js';
import { rpcCandidates } from '../../lib/solana/rpc.js';
import { DVPND_IMAGE, DEFAULT_ESCROW_BASE } from '../../lib/constants.js';
import { newSeed } from '../../lib/speed-content.js';
import { parseLab, analyzeLab, labPlan } from '../../audit/speed-lab.js';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(name);
const need = (name) => { const v = opt(name); if (!v) throw new Error(`${name} is required`); return v; };

const NODE = need('--node');
const ORIGIN = need('--origin').replace(/\/$/, '');
const PIN = need('--pin');
const SECRET = readFileSync(need('--secret-file'), 'utf8').trim();
const PLAN = need('--plan').split(',').map((s) => { const [id, streams, seconds] = s.split(':'); return { id, streams: Number(streams), seconds: Number(seconds) }; });
const OUT = need('--out');
const SERVER = opt('--server', 'http://127.0.0.1:3011');
const PRICING = flag('--hours') ? 'hours' : 'gigabytes';
const GIGABYTES = Number(opt('--gigabytes', '2'));
const LABEL = opt('--label', '');
const STEADY = flag('--steady');
const CLASSIC = flag('--classic');
if (CLASSIC) process.env.SPEED_METHOD = 'classic';
if (STEADY) Object.assign(process.env, { SPEED_METHOD: 'steady', SPEED_ORIGIN: ORIGIN, SPEED_PIN: PIN, SPEED_SECRET: SECRET });

// ─── Refuse while the tester server is testing ───
try {
  const st = await fetch(`${SERVER}/api/stats`).then((r) => r.json());
  if (st?.state?.status === 'running') throw new Error(`the tester at ${SERVER} is running a test — wait for it`);
} catch (err) {
  if (/running a test/.test(err.message)) throw err;
  console.warn(`[bwlab] tester at ${SERVER} not reachable (${err.message}) — continuing`);
}

const { keypair } = await cachedWalletSetup();
const nodes = await getAllNodes(() => {});
const node = nodes.find((n) => n.address === NODE);
if (!node) throw new Error(`node ${NODE} is not listed on chain`);
const overrides = parseOverrides();
const o = overrides.get(NODE);
const status = await nodeStatusV3(node._sol, { overrideOrigin: probeOrigin(o) });
const caps = await probeClientCapabilities(DVPND_IMAGE);
if (!caps.ok) throw new Error(`client container cannot run here: ${caps.output.slice(-200)}`);

const seedBase = newSeed().slice(0, 16);
const labSeconds = PLAN.reduce((a, m) => a + m.seconds + 3, 0) + 30;
const ctx = {
  keypair,
  rpcUrl: rpcCandidates()[0],
  settings: {
    testBytes: Math.max(1, Number(process.env.TEST_MB || 10)) * 1_000_000,
    prepayBytes: GIGABYTES * 1_000_000_000,
    escrowBase: DEFAULT_ESCROW_BASE,
    clientTimeoutSec: 360 + labSeconds,
    skipUnsupportedProtocols: true,
  },
  caps,
  testRun: false,
  runId: null,
  overrides,
  state: {},
  baselineMbps: null,
  pricingMode: PRICING,
  broadcast: (ev, d) => { if (d?.msg) console.log(d.msg); },
  lab: STEADY || CLASSIC ? null : { origin: ORIGIN, pin: PIN, plan: labPlan(PLAN), seedBase, idleN: 20, extraUrl: opt('--extra-url', ''), first: flag('--lab-first'), opts: opt('--lab-opts', '') },
};

const t0 = new Date();
let result = null;
let error = null;
try {
  result = await testNode(node, status, ctx);
} catch (err) {
  error = { message: err.message, errorCode: err.errorCode || null, stage: err.stage || null };
  result = { diag: err.diag || {} };
}
const labOut = STEADY || CLASSIC ? '' : result?.diag?.labOutput || '';
const analysis = labOut ? analyzeLab(parseLab(labOut), { secret: SECRET }) : null;

mkdirSync(dirname(OUT), { recursive: true });
const rawFile = join(dirname(OUT), `raw-${t0.toISOString().replace(/[:.]/g, '-')}-${NODE.slice(0, 8)}.txt`);
writeFileSync(rawFile, labOut || result?.diag?.transcript || '');
const line = {
  ts: t0.toISOString(), label: LABEL, node: NODE, protocol: status?.type || node._sol?.protocol, pricing: PRICING, gigabytes: GIGABYTES,
  origin: ORIGIN, plan: labPlan(PLAN), seedBase,
  tester: error ? null : {
    actualMbps: result.actualMbps, latencyMs: result.latencyMs, downloadedBytes: result.downloadedBytes,
    totalMs: result.diag?.totalMs, ttfbMs: result.diag?.ttfbMs, spentBase: result.spentBase, channel: result.channel,
    speedMethod: result.diag?.speedMethod || null,
    clientRxBytes: result.diag?.clientRxBytes, clientTxBytes: result.diag?.clientTxBytes, committedBase: result.diag?.committedBase,
  },
  error,
  speedMethod: error ? result?.diag?.speedMethod || null : undefined,
  channel: result?.channel || result?.diag?.channel || null,
  lab: analysis,
  raw: rawFile,
};
appendFileSync(OUT, JSON.stringify(line) + '\n');
console.log(JSON.stringify({ node: NODE.slice(0, 8), protocol: line.protocol, error: error?.errorCode, tester: line.tester?.actualMbps, steady: line.tester?.speedMethod ? `${line.tester.speedMethod.basis} ${line.tester.speedMethod.mbps} (classic ${line.tester.speedMethod.classicMbps}) verified ${line.tester.speedMethod.verified}` : undefined, lab: analysis?.methods?.map((m) => `${m.id}x${m.streams}: naive ${m.naiveMbps} steady ${m.steadyMbps} verified ${m.verified}`), idleMs: analysis?.idleLatency?.medianMs }, null, 1));
process.exit(0);
