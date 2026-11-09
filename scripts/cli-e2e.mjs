#!/usr/bin/env node
// ─── CLI end-to-end ──────────────────────────────────────────────────────────
// Drives EVERY CLI command against a running server and asserts the outcome;
// paid steps are verified with an independent chain read. SPENDS a few devnet
// voucher channels (escrow comes back after the 2 h grace via `--finish`) and
// one report memo per paid node while reporting is on.
//
//   node scripts/cli-e2e.mjs [--url http://127.0.0.1:3011] [--node <pda>]
//   node scripts/cli-e2e.mjs --finish        after the grace: close + refund, verify accounts gone
//
// Needs a live, reachable node this machine's client can run (the WSL rig:
// scripts/dev/wsl-node.sh). Exit 0 = no FAIL; SKIPs state their reason.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const KNOWN = new Set(['--url', '--node', '--node2', '--plan', '--plan-node', '--only', '--all-nodes', '--plans-only', '--plan-skip', '--finish', '--help']);
for (const a of ARGS) if (a.startsWith('--') && !KNOWN.has(a.split('=')[0])) { console.error(`unknown flag ${a}`); process.exit(2); }
const flag = (n) => { const i = ARGS.indexOf(n); return i < 0 ? undefined : (ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : true); };
if (flag('--help')) { console.log('node scripts/cli-e2e.mjs [--url URL] [--node PDA] [--node2 PDA] [--plan PDA] [--plan-node PDA] [--only a,b] [--all-nodes] [--plans-only] [--plan-skip] [--finish]'); process.exit(0); }
const URL_ = flag('--url') || `http://127.0.0.1:${process.env.PORT || 3001}`;
const RIG = flag('--node') || '6AaXvhWpFDMf8FimxSb2Tb3bKcgPmbZxj4Tdtb31nP8F';
// Second address for retest-fails: a listed node expected to FAIL (Y3/Y4 assert the stored failure).
// Default: a demo node whose uri (.invalid) never resolves, so it fails at the scan and nothing
// is paid. Never a node another project runs a session on.
const NODE2 = flag('--node2') || '8WFGm9hQ7n85wztGh849e1bVguSrfBdYqobuD41Cbjmp';
// A listed plan with max_connections = 1 whose provider has RIG on its roster (#29's devnet
// provider; its provider daemon must be up, and PROVIDER_API_OVERRIDES set for a lab provider).
const PLAN = flag('--plan') || 'EK5EaGiD8Lf3n7ChHNnFv1CcxAg4SpnLRKsT3RtjdYJY';
// The node on that plan's roster (the plan checks look for it, whatever --node is).
const PLAN_NODE = flag('--plan-node') || '6AaXvhWpFDMf8FimxSb2Tb3bKcgPmbZxj4Tdtb31nP8F';

const lines = [];
// Node set for every run this suite starts (null = all listed nodes).
let SCOPE = null;
const startArgs = (...a) => ['start', ...a, ...(SCOPE ? ['--addresses', SCOPE.join(',')] : [])];
let PASS = 0; let FAIL = 0; let SKIP = 0;
function rec(kind, id, msg) {
  const line = `${kind.padEnd(4)} ${id.padEnd(5)} ${msg}`;
  lines.push(line);
  const c = kind === 'PASS' ? 32 : kind === 'FAIL' ? 31 : 33;
  console.log(`  \x1b[${c}m${line}\x1b[0m`);
  if (kind === 'PASS') PASS++; else if (kind === 'FAIL') FAIL++; else SKIP++;
}
const check = (id, cond, msg, why = '') => rec(cond ? 'PASS' : 'FAIL', id, cond ? msg : `${msg} — ${String(why).slice(0, 400)}`);

/** Run one CLI command; returns { code, json, err }. Never throws. */
function cli(...args) {
  const r = spawnSync(process.execPath, ['cli.js', ...args, '--url', URL_, '--json'], { cwd: ROOT, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 3_600_000 });
  let json = null;
  const text = (r.status === 0 ? r.stdout : r.stderr) || '';
  try { json = JSON.parse(text.trim().split('\n').filter((l) => l.trim().startsWith('{') || l.trim().startsWith('[') || l.trim().startsWith('"') || l.trim().startsWith('}')).join('\n') || text); } catch (err) { json = null; }
  if (!json) { try { json = JSON.parse(text); } catch (err) { json = { raw: text.slice(0, 500) }; } }
  return { code: r.status, json, err: r.status === 0 ? null : (json?.error || text.slice(0, 300)) };
}
const ok = (...a) => { const r = cli(...a); return r.code === 0 ? r.json : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const verifier = new Connection(process.env.E2E_VERIFY_RPC || 'https://api.devnet.solana.com', { commitment: 'confirmed', disableRetryOnRateLimit: true });
async function chain(fn) {
  let last;
  for (let i = 0; i < 6; i++) {
    try { return await fn(verifier); } catch (err) { last = err; if (!/429|Too Many|fetch failed|timed out|ECONN/i.test(err.message)) throw err; await sleep(2500 * (i + 1)); }
  }
  throw last;
}
const { decodeAccount } = await import('../lib/solana/accounts.js');
const { decodeMemo, memoFromSignatureInfo } = await import('../lib/onchain-report.js');
async function readChannel(addr) {
  const info = await chain((c) => c.getAccountInfo(new PublicKey(addr), 'confirmed'));
  return info ? decodeAccount('channel', info.data) : null;
}
// E2E_DOCKER: the docker command of the host the server runs on, e.g.
// "ssh -o BatchMode=yes <host> sudo -n docker" for a hosted instance.
const DOCKER_CMD = (process.env.E2E_DOCKER || 'docker').split(' ').filter(Boolean);
function dockerClients() {
  const r = spawnSync(DOCKER_CMD[0], [...DOCKER_CMD.slice(1), 'ps', '-aq', '--filter', 'name=^snt-client-'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ps failed (${DOCKER_CMD.join(' ')}): ${(r.stderr || '').trim().slice(0, 200)}`);
  return (r.stdout || '').split(/\s+/).filter(Boolean).length;
}

async function finish() {
  console.log('=== finish: close matured test channels ===');
  const before = ok('channels', '--open');
  if (!before?.tracked.length) { rec('SKIP', 'F1', 'no open test channels'); return; }
  const sw = cli('sweep');
  check('F1', sw.code === 0 && !sw.json.errors.length, `sweep: ${sw.json?.startedClose?.length} start-closed · ${sw.json?.closed?.length} closed · ${sw.json?.pending?.length} waiting · ${sw.json?.withdrawnBase} withdrawn`, sw.err || sw.json?.errors);
  for (const a of sw.json?.closed || []) check('F2', (await readChannel(a)) === null, `channel ${a.slice(0, 8)}… gone on chain`, 'still exists');
  const after = ok('channels');
  for (const a of sw.json?.closed || []) {
    const row = after.tracked.find((c) => c.address === a);
    check('F3', row?.status === 'closed' && row.refunded_base != null, `channel ${a.slice(0, 8)}… recorded closed, refund ${row?.refunded_base}`, JSON.stringify(row));
  }
  if (sw.json?.pending?.length) rec('SKIP', 'F4', `${sw.json.pending.length} still in grace until ${sw.json.pending.map((p) => p.maturesAt).sort().pop()} — rerun --finish`);
}

async function waitRun(id, timeout = 900) {
  const r = cli('wait', '--timeout', String(timeout));
  if (r.code !== 0) rec('FAIL', id, `wait failed: ${r.err}`);
  return r.json?.state || ok('status')?.state;
}

async function main() {
  console.log(`=== CLI e2e against ${URL_} (rig ${RIG.slice(0, 8)}…) ===`);
  if (flag('--finish')) return finish();

  // ─── preconditions ───
  // The suite asserts the default server config. With ALLOW_PUBLIC_TEST on, R39 would start the
  // public loop for real and every later test would hit "A public run is active".
  const pre = cli('test-status');
  if (pre.code === 0 && (pre.json?.allowPublicStart || pre.json?.running)) {
    check('PRE', false, 'server is in default mode (ALLOW_PUBLIC_TEST off, no loop running) — restart it without ALLOW_PUBLIC_TEST', JSON.stringify(pre.json));
    return;
  }

  // ─── read-only surface ───
  const ping = cli('ping');
  check('R1', ping.code === 0 && ping.json.status === 'ok', 'ping');
  // Speed method: steady is the default; the origin must answer with the pinned key.
  const sp = ok('speed');
  check('R1b', sp?.active === 'steady' && sp.ready === true && sp.originReachable === true && !('secret' in sp), `speed: ${sp?.version} via ${sp?.origin}, origin pinned + reachable`, JSON.stringify(sp));
  const spt = cli('speed-test');
  check('R1c', spt.code === 0 && spt.json.method === 'steady-v1' && spt.json.mbps > 0 && spt.json.bytes > 0, `speed-test: ${spt.json?.mbps} Mbps direct, ${Math.round((spt.json?.bytes || 0) / 1e6)} MB verified (${spt.json?.detail})`, spt.err || JSON.stringify(spt.json));
  const doc = ok('doctor');
  check('R2', doc?.ready === true, `doctor: Docker ${doc?.docker?.version}, image, client caps, wallet ${doc?.wallet?.sol} SOL`, doc?.problems);
  if (!doc?.ready) return;
  const wallet = doc.wallet.address;
  const health = ok('health');
  check('R3', health?.status === 'ready' && health.sdk === 'dvpnd' && health.testKeyfile === 'set' && !('mnemonic' in health), 'health ready, client dvpnd, key configured', JSON.stringify(health));
  const info = ok('info');
  check('R4', info?.tester === wallet && info.network === 'devnet', 'info: network + tester wallet', JSON.stringify(info));
  const nodes = ok('nodes');
  // Runs touch ONLY --node/--node2/--only. The shared devnet has other teams' nodes, and the
  // shared wallet also owns other projects' nodes (#28's), so "the wallet's own nodes" is not
  // a safe scope either; a "test everything" run opened per-GB channels on them (2026-10-20).
  if (!flag('--all-nodes')) {
    const extra = String(flag('--only') || '').split(',').map((x) => x.trim()).filter(Boolean);
    SCOPE = [...new Set([RIG, NODE2, ...extra])];
    console.log(`  scope: ${SCOPE.length} node(s) — --node/--node2/--only (--all-nodes to lift)`);
  }
  const rig = nodes?.results.find((n) => n.address === RIG);
  check('R5', !!rig && rig.status === 'active' && rig.gigabyte_prices[0].token === 'tdvpn', `nodes: ${nodes?.total} live, rig present, prices in tdvpn`, `rig ${!!rig}`);
  if (!rig) { rec('SKIP', 'R5b', 'rig node not live — start it with scripts/dev/wsl-node.sh'); return; }
  const pr = ok('probe', RIG);
  check('R6', pr?.probe?.reachable && pr.probe.signatureValid && pr.probe.claimsMatch && pr.probe.tlsPinMatch, 'probe: reachable, signature valid, claims match, TLS pin', JSON.stringify(pr?.probe).slice(0, 300));
  const probeBad = cli('probe', 'not-a-key');
  check('R7', probeBad.code !== 0 && /valid Solana address/.test(probeBad.err), 'probe rejects a malformed address', probeBad.err);
  const probeMissing = cli('probe', '11111111111111111111111111111112');
  check('R8', probeMissing.code !== 0 && /no node account/.test(probeMissing.err), 'probe 404s a non-node address', probeMissing.err);
  for (const [id, c] of [['R9', 'sdk-versions'], ['R10', 'sdk-verify'], ['R11', 'transport-cache'], ['R12', 'cross-sdk'], ['R13', 'sdk-info'], ['R14', 'test-status'], ['R15', 'countries'], ['R16', 'pub-runs'], ['R17', 'batches'], ['R18', 'stats'], ['R19', 'error-search'], ['R20', 'logs'], ['R21', 'live-state'], ['R22', 'failure-analysis'], ['R23', 'subscriptions'], ['R24', 'sub-plans'], ['R25', 'plans'], ['R26', 'channels'], ['R27', 'reports'], ['R28', 'pub-nodes'], ['R29', 'state'], ['R30', 'results'], ['R31', 'runs'], ['R32', 'dns'], ['R33', 'sdk'], ['R33b', 'sdk-latest'], ['R33d', 'admin-plans']]) {
    const r = cli(c);
    check(id, r.code === 0, `${c}`, r.err);
  }
  const rc = cli('runs-current');
  check('R33c', rc.code === 0 || /No active run/.test(rc.err), 'runs-current answers (404 when idle is the Cosmos contract)', rc.err);
  const sv = ok('sdk-verify', 'dvpnd');
  check('R34', sv?.ok && sv.network === 'devnet' && sv.version, `sdk-verify dvpnd: ${sv?.version}`, JSON.stringify(sv));
  const svBad = cli('sdk-verify', 'blue-js');
  check('R35', svBad.code !== 0, 'sdk-verify rejects an unknown client key', svBad.err);
  const oc = ok('onchain-reports', '--limit', '5');
  check('R36', oc && oc.address === wallet && Array.isArray(oc.reports), `onchain-reports: ${oc?.count} decoded from chain`, JSON.stringify(oc ?? null).slice(0, 200));
  const ssrf = cli('node-status', 'https://127.0.0.1:8443');
  check('R37', ssrf.code !== 0 && /private|loopback/.test(ssrf.err), 'node-status refuses loopback targets (SSRF guard)', ssrf.err);
  // A listed node whose URI can never resolve (.invalid): unreachable from any host.
  const ns = cli('node-status', 'https://node.invalid:7777');
  check('R38', ns.code !== 0 && !/private|loopback/.test(ns.err), 'node-status of an unreachable public node answers an error, not a hang', ns.err);
  const pts = cli('pub-test-start');
  check('R39', pts.code !== 0 && /disabled/.test(pts.err), 'public test start stays disabled without ALLOW_PUBLIC_TEST', pts.err);
  const ptx = cli('pub-test-stop');
  check('R40', ptx.code !== 0 && /disabled/.test(ptx.err), 'public test stop stays disabled', ptx.err);

  // ─── config writes ───
  const s0 = ok('settings').settings;
  const s1 = ok('settings', 'gigabytes=1', 'onchainEnabled=true', 'onchainBatchSize=1', 'onchainRegion=in', 'autoCancelAfterTest=true', 'maxPriceBase=0');
  check('C1', s1?.settings.onchainEnabled === true && s1.settings.onchainBatchSize === 1 && s1.settings.onchainRegion === 'IN', 'settings write: reporting on, batch 1, region IN', JSON.stringify(s1?.settings));
  const sClamp = ok('settings', 'batchSize=99', 'onchainBatchSize=99');
  check('C2', sClamp?.settings.batchSize <= 5 && sClamp.settings.onchainBatchSize <= 6, 'settings clamp out-of-range values', JSON.stringify(sClamp?.settings));
  ok('settings', 'batchSize=5', 'onchainBatchSize=1');
  const d1 = ok('dns', 'google');
  check('C3', d1?.servers?.[0] === '8.8.8.8', 'dns preset google', JSON.stringify(d1));
  const d2 = ok('dns', '--servers', '9.9.9.9,1.1.1.1');
  check('C4', d2?.servers?.join(',') === '9.9.9.9,1.1.1.1', 'dns custom servers', JSON.stringify(d2));
  const dBad = cli('dns', 'nosuchpreset');
  check('C5', dBad.code !== 0, 'dns rejects an unknown preset', dBad.err);
  ok('dns', 'cloudflare');
  const sdkSet = ok('sdk', 'tkd');
  check('C6', sdkSet?.sdk === 'dvpnd' && ok('sdk')?.sdk === 'dvpnd', 'sdk switch keeps and reports the single Solana client (dvpnd)', JSON.stringify(sdkSet));
  check('C6b', JSON.stringify(ok('sdk-latest')) === '{}', 'sdk-latest lists no npm SDKs (dvpnd is a pinned image)');
  const b0 = ok('broadcast').broadcastLive;
  const b1 = ok('broadcast', 'toggle').broadcastLive;
  const lsOn = ok('live-state');
  const b2 = ok('broadcast', 'toggle').broadcastLive;
  check('C7', b1 === !b0 && b2 === b0 && lsOn?.broadcastLive === true, 'broadcast toggles and back; live-state follows', `${b0}→${b1}→${b2}`);
  // `config` maps every setting: the runtime ones it can change, the .env ones that need a restart.
  ok('settings', 'gigabytes=2');
  const cfg = ok('config');
  ok('settings', 'gigabytes=1');
  const RUNTIME_KEYS = ['gigabytes', 'maxPriceBase', 'autoCancelAfterTest', 'onchainEnabled', 'onchainBatchSize', 'onchainRegion', 'batchSize', 'dns', 'broadcastLive'];
  const ENV_KEYS = ['PORT', 'PUBLIC_MODE', 'ALLOW_PUBLIC_TEST', 'SOLANA_RPC_URLS', 'TEST_KEYFILE', 'DVPND_IMAGE', 'TEST_MB', 'MAX_NODES', 'NODE_DELAY_MS', 'CLIENT_TIMEOUT_SEC', 'SPEED_URL', 'MIN_CHANNEL_BALANCE_BASE', 'SWEEP_EVERY_MS', 'NODE_URI_OVERRIDES', 'PROVIDER_API_OVERRIDES'];
  const missingKeys = [...RUNTIME_KEYS.filter((k) => !cfg?.runtime?.[k]?.cli), ...ENV_KEYS.filter((k) => !cfg?.env?.[k])];
  check('C8', cfg && !missingKeys.length && cfg.runtime.gigabytes.value === 2 && cfg.env.TEST_KEYFILE.wallet === wallet, `config: ${RUNTIME_KEYS.length} runtime + ${Object.keys(cfg?.env || {}).length} env settings, live values`, `missing ${missingKeys.join(',')} gigabytes=${cfg?.runtime?.gigabytes?.value}`);
  check('C9', !/api[-_]?key=[^*&"]{6}|"secretKey"|\[\d+(,\d+){31,}\]/i.test(JSON.stringify(cfg)), 'config shows no key bytes or RPC keys (URLs redacted)', 'secret-looking value in config');

  // ─── plan runs: subscription + access tickets (Cosmos "Test Plan" / "Sub. Plan") ───
  // --plan-skip: the plan's ticket allowance is used up (tickets count for 24 h), so the plan
  // section is reported as skipped instead of failing on a placeholder plan.
  if (flag('--plan-skip')) rec('SKIP', 'P*', 'plan section skipped (--plan-skip): ticket allowance in use');
  const plansList = flag('--plan-skip') ? null : ok('plans');
  const planRow = plansList?.plans?.find((p) => p.id === PLAN);
  if (!flag('--plan-skip')) {
  const planMax = Number(planRow?.maxConnections || 0);
  check('P1', !!planRow && planRow.provAddress && planMax >= 1, `plans: ${plansList?.plans?.length} listed, test plan ${PLAN.slice(0, 8)}… present (max ${planMax} connection${planMax === 1 ? '' : 's'})`, JSON.stringify(planRow));
  if (planRow) {
    const provider = planRow.provAddress;
    const chBeforePlan = ok('channels').tracked.length;
    // test-plan must start its own run: it once recorded into the current run, and the next
    // start saved the plan rows over that saved run (GCP run #79, 2026-10-20).
    const runsBeforePlan = ok('runs')?.runs || [];
    const lastSaved = runsBeforePlan[runsBeforePlan.length - 1];
    // One roster node only: a provider allows maxConnections live tickets per subscription for 24 h.
    const tp = cli('test-plan', PLAN, '--addresses', PLAN_NODE);
    check('P2', tp.code === 0 && tp.json.planId === PLAN && Number(tp.json.testNumber) > Number(lastSaved?.number ?? 0), `test-plan accepted as its own Test #${tp.json?.testNumber}`, tp.err || JSON.stringify(tp.json));
    await sleep(5000);
    const tps = await waitRun('P3');
    const tpRow = ok('state').results.find((r) => r.address === PLAN_NODE);
    // First run of the hour: a ticket session passes. Within the hour of an earlier run the
    // provider still holds that ticket → the one connection is in use → skipped, not failed.
    const passedViaTicket = tpRow && tpRow.actualMbps > 0 && !tpRow.channel && tpRow.inPlan === true;
    const limited = tpRow && tpRow.errorCode === 'PLAN_CONNECTION_LIMIT' && tpRow.skipped === true;
    check('P3', tps.status === 'done' && (passedViaTicket || limited), `test-plan done: rig ${passedViaTicket ? `passed ${tpRow.actualMbps} Mbps through a ticket session (no channel)` : limited ? 'skipped — connection allowance held by an earlier ticket' : `neither passed nor a limit skip: ${tpRow?.errorCode || 'no row'}`}`, JSON.stringify(tpRow ?? null).slice(0, 300));
    const tpRows = ok('state').results;
    check('P3b', tpRows.length === 1 && tpRows[0].address === PLAN_NODE, `test-plan --addresses kept to 1 roster node (one ticket, not one per roster node)`, `${tpRows.length} rows: ${tpRows.map((r) => r.address.slice(0, 8)).join(',')}`);
    const subs = ok('subscriptions')?.subscriptions || [];
    const sub = subs.find((s) => s.plan_id === PLAN && s.status === 'active');
    const subChain = sub ? await chain((c) => c.getAccountInfo(new PublicKey(sub.id), 'confirmed')) : null;
    const subAcct = subChain ? decodeAccount('subscription', subChain.data) : null;
    check('P4', subAcct && subAcct.owner === wallet && subAcct.plan === PLAN && Number(subAcct.expiresAt) > Date.now() / 1000, `subscription ${sub?.id?.slice(0, 8)}… active on chain (independent read), owner = tester, plan matches`, JSON.stringify(subAcct ?? null).slice(0, 200));
    check('P5', ok('channels').tracked.length === chBeforePlan, 'plan run opened no channel', `${chBeforePlan} → ${ok('channels').tracked.length}`);
    if (lastSaved) {
      const again = ok('run', String(lastSaved.number));
      check('P5b', again && again.results.length === lastSaved.total, `saved Test #${lastSaved.number} untouched by the plan run (${again?.results?.length}/${lastSaved.total} rows)`, JSON.stringify(again?.results?.map((r) => r.errorCode)));
    }
    const sp = ok('sub-plans')?.plans?.find((p) => p.planId === PLAN);
    check('P6', sp && sp.subscriptionId === sub?.id && sp.provider === provider && sp.providerVerified === true && !('feeGrantActive' in sp) && sp.nodeCount >= 1, `sub-plans: provider verified, ${sp?.nodeCount} live roster node(s)`, JSON.stringify(sp));
    if (sub) {
      // Same subscription again inside the hour: the provider refuses a second live ticket
      // (409 peer_limit_reached); the node flattens it to ticket_invalid; the tester asks the
      // provider and records a skip with the real reason — never a node failure.
      const tsp = cli('test-sub-plan', PLAN, sub.id, provider, '--addresses', PLAN_NODE);
      check('P7', tsp.code === 0 && tsp.json.subscriptionId === sub.id, 'test-sub-plan accepted', tsp.err);
      await sleep(5000);
      const tss = await waitRun('P8');
      const tsRow = ok('state').results.find((r) => r.address === PLAN_NODE);
      const tsLimited = tsRow?.errorCode === 'PLAN_CONNECTION_LIMIT' && tsRow.skipped === true && /peer_limit_reached/.test(tsRow.error);
      const tsPassed = tsRow?.actualMbps > 0 && !tsRow.channel && tsRow.inPlan === true;
      // max 1: the first ticket still holds the only connection → must be a skip with the provider's
      // reason. max > 1: a second connection is allowed, so a pass is right too. Never a failure.
      check('P8', tss.status === 'done' && tss.failedNodes === 0 && (planMax === 1 ? tsLimited : (tsLimited || tsPassed)),
        planMax === 1 ? 'second ticket inside the hour → PLAN_CONNECTION_LIMIT, skipped, 0 failed, provider reason kept'
          : `second ticket inside the hour (allowance ${planMax}) → ${tsPassed ? `passed ${tsRow.actualMbps} Mbps` : 'skipped at the limit'}, 0 failed`,
        JSON.stringify(tsRow ?? null).slice(0, 300));
      const wrongProv = cli('test-sub-plan', PLAN, sub.id, wallet);
      await sleep(4000);
      const wp = ok('status').state;
      check('P9', wrongProv.code === 0 && wp.status === 'error' && /does not run this plan/.test(wp.errorMessage || ''), 'test-sub-plan with a provider that does not run the plan → refused, nothing run', `${wp.status} ${wp.errorMessage}`);
    } else rec('SKIP', 'P7', 'no active subscription — cannot run test-sub-plan');
  }
  }
  const tspBad = cli('test-sub-plan', '1');
  check('P10', tspBad.code !== 0 && /missing|required/.test(tspBad.err), 'test-sub-plan validates its arguments', tspBad.err);
  // --plans-only: the plan section alone (a provider's ticket allowance is scarce; no channels opened).
  if (flag('--plans-only')) return finishChecks(s0);

  // ─── P2P per hour: stream channel, closed right after the session ───
  const hs = cli(...startArgs('--hours'));
  check('H1', hs.code === 0 && hs.json.pricingMode === 'hours', `start --hours → Test #${hs.json?.testNumber}`, hs.err);
  await sleep(5000);
  const hst = await waitRun('H2');
  const hRow = ok('state').results.find((r) => r.address === RIG);
  check('H2', hst.status === 'done' && hRow?.actualMbps > 0 && hRow.channel, `per-hour run: rig ${hRow?.actualMbps} Mbps on channel ${hRow?.channel?.slice(0, 8)}…`, JSON.stringify(hRow ?? null).slice(0, 300));
  if (hRow?.channel) {
    const hCh = ok('channels').tracked.find((c) => c.address === hRow.channel);
    check('H3', hCh?.status === 'closed' && hCh.tx_close && hCh.refunded_base > 0, `stream channel closed right after the session, ${hCh?.redeemed_base} paid · ${hCh?.refunded_base} returned`, JSON.stringify(hCh));
    check('H4', (await readChannel(hRow.channel)) === null, 'stream channel gone on chain (independent read)', 'still exists');
    check('H5', Number(hRow.spentBase) < Number(hCh?.escrow_base || 0), `paid only the elapsed time: ${hRow.spentBase} of ${hCh?.escrow_base} escrowed`, JSON.stringify(hRow.spentBase));
  }

  // ─── price cap (maxPriceBase) — proven with TEST RUNs, nothing spent ───
  const rigPrice = Number(rig.gigabyte_prices[0].base_value);
  ok('settings', `maxPriceBase=${rigPrice - 1}`);
  const capRun = cli(...startArgs('--test-run'));
  await sleep(3000);
  const capState = await waitRun('E1');
  const capRig = ok('state').results.some((r) => r.address === RIG);
  check('E1', capRun.code === 0 && capState.status === 'done' && !capRig, `price cap ${rigPrice - 1} base/GB < rig price ${rigPrice}: rig not tested`, `rig tested=${capRig} status=${capState?.status}`);
  ok('settings', `maxPriceBase=${rigPrice}`);
  await sleep(2000);
  cli(...startArgs('--test-run'));
  await sleep(3000);
  await waitRun('E2');
  check('E2', ok('state').results.some((r) => r.address === RIG), `price cap ${rigPrice} = rig price: rig tested`, 'rig missing');
  ok('settings', 'maxPriceBase=0');

  // ─── TEST RUN ───
  const chBefore = ok('channels').tracked.length;
  const repBefore = ok('reports').reports.length;
  const st = cli(...startArgs('--test-run'));
  check('T1', st.code === 0 && st.json.testRun === true, `start --test-run → Test #${st.json?.testNumber}`, st.err);
  const again = cli(...startArgs());
  check('T2', again.code !== 0 && /Already running/.test(again.err), 'a second start while running is refused', again.err);
  const ts = await waitRun('T3');
  const tres = ok('state').results;
  check('T3', ts.status === 'done' && tres.length >= 1 && tres.every((r) => r.errorCode === 'TEST_RUN_SKIP' && r.actualMbps == null), `TEST RUN done: ${tres.length} rows, all TEST_RUN_SKIP`, JSON.stringify(tres.map((r) => r.errorCode)));
  check('T4', ok('channels').tracked.length === chBefore && ok('reports').reports.length === repBefore && Number(ts.runSpentBase) === 0, 'TEST RUN opened no channel, posted no memo, spent nothing', `ch ${chBefore}→${ok('channels').tracked.length}`);
  const testNum = st.json.testNumber;

  // ─── runs: save / load / resume guard / delete ───
  const save = cli('run-save', '--label', 'cli-e2e test run');
  check('S1', save.code === 0 || /No results/.test(save.err), `run-save → #${save.json?.number}`, save.err);
  const runs1 = ok('runs');
  check('S2', runs1?.runs.some((r) => r.number === testNum), `runs lists Test #${testNum}`, JSON.stringify(runs1?.runs.map((r) => r.number)));
  const one = ok('run', String(testNum));
  check('S3', one?.number === testNum && one.results.length === tres.length, `run ${testNum} returns its results`, JSON.stringify(one ?? null).slice(0, 200));
  const load = cli('run-load', String(testNum));
  check('S4', load.code === 0 && ok('status').state.loadedReadonly === true, `run-load ${testNum} → read-only view`, load.err);
  const resumeRO = cli('resume');
  check('S5', resumeRO.code !== 0 && /loaded past run|RUN_COMPLETE|LOADED_RUN_READONLY|nothing to resume/i.test(resumeRO.err), 'resume refuses a loaded / complete run', resumeRO.err);
  const missing = cli('run', '99999');
  check('S6', missing.code !== 0, 'run of a missing test → 404', missing.err);

  // ─── PAID run with on-chain reporting ───
  await sleep(7000);
  // This run also proves GB per node and DNS reach the client container's config.
  ok('settings', 'gigabytes=2');
  ok('dns', 'google');
  const paid = cli(...startArgs());
  check('M1', paid.code === 0 && paid.json.testRun === false, `start (paid) → Test #${paid.json?.testNumber}`, paid.err);
  const ps = await waitRun('M2');
  const pres = ok('state').results;
  const rr = pres.find((r) => r.address === RIG);
  check('M2', ps.status === 'done' && rr && rr.actualMbps > 0 && rr.channel, `paid session: ${rr?.actualMbps} Mbps, channel ${rr?.channel?.slice(0, 8)}…, committed ${rr?.spentBase}`, JSON.stringify(rr && { e: rr.errorCode, m: rr.error }));
  // The figure is the steady method's: verified bytes from our origin, not the classic download.
  const sm = rr?.diag?.speedMethod;
  check('M2b', sm?.method === 'steady-v1' && sm.ok === true && sm.verified === true && sm.streams === 4 && sm.payloadBytes > 0 && rr.actualMbps <= sm.mbps + 0.01,
    `steady figure: ${sm?.mbps} Mbps payload / ${sm?.lineMbps} line, ${Math.round((sm?.payloadBytes || 0) / 1e6)} MB verified (classic read ${sm?.classicMbps})`, JSON.stringify(sm ?? null).slice(0, 300));
  check('M3', Number(ps.runSpentBase) > 0 && /^[\d.]+ t?DVPN$/.test(ps.estimatedTotalCost || ''), `run spend recorded: ${ps.runSpentBase} base units (${ps.estimatedTotalCost})`, JSON.stringify(ps.runSpentBase));
  const paidNum = paid.json.testNumber;
  ok('settings', 'gigabytes=1');
  ok('dns', 'cloudflare');
  const ccfg = rr?.diag?.clientConfig || {};
  check('E3', rr?.diag?.prepayBytes === 2_000_000_000 && Number(ccfg.prepay_bytes) === 2_000_000_000, `gigabytes=2 → client prepay ${ccfg.prepay_bytes} bytes`, JSON.stringify({ prepay: rr?.diag?.prepayBytes, ccfg }));
  check('E4', /8\.8\.8\.8/.test(ccfg.dns_servers || ''), `dns google → client dns_servers ${ccfg.dns_servers}`, JSON.stringify(ccfg));
  if (rr?.channel) {
    const ch = await readChannel(rr.channel);
    check('M4', ch && ch.owner === wallet && ch.node === RIG && Number(ch.mode) === 0 && Number(ch.status) === 1, `channel on chain: owner wallet, node rig, voucher, closing (auto-cancel)`, JSON.stringify(ch && { o: ch.owner, n: ch.node, s: ch.status }));
    const tr = ok('channels').tracked.find((c) => c.address === rr.channel);
    check('M5', tr?.status === 'closing' && tr.tx_start_close && tr.run_id != null, 'channel tracked with its start_close tx', JSON.stringify(tr));
  }
  const reps = ok('reports').reports;
  // With several nodes and batch size 1 every node gets its own memo: pick the memo of this
  // run that carries the main node, not simply the newest one.
  const runReps = reps.filter((r) => r.created_at > Date.parse(ps.startedAt));
  const decodedRecent = ok('onchain-reports', '--limit', '30')?.reports || [];
  const rigSigs = new Set(decodedRecent.filter((x) => x.payload?.records?.some((rec) => rec.address === RIG)).map((x) => x.txhash));
  const myRep = runReps.find((r) => rigSigs.has(r.signature)) || runReps[0];
  check('M6', !!myRep, `report memo recorded: ${myRep?.signature?.slice(0, 12)}… (${runReps.length} memos this run)`, `${reps.length} reports`);
  if (myRep) {
    const sigs = await chain((c) => c.getSignaturesForAddress(new PublicKey(wallet), { limit: 50 }, 'confirmed'));
    const hit = sigs.find((s) => s.signature === myRep.signature);
    const payload = hit ? decodeMemo(memoFromSignatureInfo(hit.memo)) : null;
    const recd = payload?.records.find((x) => x.address === RIG);
    check('M7', recd?.ok && payload.region === 'IN' && Math.abs(recd.mbps - rr.actualMbps) <= 0.1, `memo decodes from chain: ${recd?.mbps} Mbps, region ${payload?.region}`, JSON.stringify(payload ?? null).slice(0, 300));
    const viaApi = ok('onchain-reports', '--limit', '10')?.reports.find((x) => x.txhash === myRep.signature);
    check('M8', !!viaApi && viaApi.payload.records.some((x) => x.address === RIG), 'onchain-reports returns the same memo, decoded', 'missing');
  }
  const pn = ok('pub-node', RIG);
  check('M9', pn?.node?.actual_mbps > 0 && pn.node.latency_ms > 0, `pub-node: ${pn?.node?.actual_mbps} Mbps, latency ${pn?.node?.latency_ms} ms`, JSON.stringify(pn?.node).slice(0, 200));
  const bw = ok('bandwidth', RIG);
  check('M10', bw?.history?.length >= 1, `bandwidth history: ${bw?.history?.length} points`, JSON.stringify(bw ?? null).slice(0, 200));
  const last = ok('runs-last');
  check('M11', last?.nodes?.some((n) => n.address === RIG && n.actualMbps > 0), `runs-last: batch #${last?.id} carries the result`, JSON.stringify(last ?? null).slice(0, 200));
  const batch = ok('batch', String(last?.id));
  check('M12', batch?.results?.length >= 1, `batch ${last?.id}: ${batch?.results?.length} rows`, JSON.stringify(batch ?? null).slice(0, 200));
  check('M13', dockerClients() === 0, 'no client container left behind', `${dockerClients()} snt-client containers`);

  // ─── stop mid-run, then resume ───
  await sleep(7000);
  ok('settings', 'onchainEnabled=false');
  const p2 = cli(...startArgs());
  check('X1', p2.code === 0, `start (paid) → Test #${p2.json?.testNumber}`, p2.err);
  // Stop once the client container is actually up (the session is in flight).
  let saw = false;
  for (let i = 0; i < 90; i++) { if (dockerClients() > 0) { saw = true; break; } await sleep(1000); }
  await sleep(6000);
  const chBeforeStop = ok('channels').tracked.map((c) => c.address);
  const stop = cli('stop');
  check('X2', saw && stop.code === 0 && ok('status').state.status === 'stopped', 'stop while a client container is in flight → status stopped', stop.err || `container seen ${saw}`);
  let gone = false;
  for (let i = 0; i < 10; i++) { if (dockerClients() === 0) { gone = true; break; } await sleep(1000); }
  check('X3', gone, 'Stop removes the in-flight client container within 10 s', `${dockerClients()} left`);
  await sleep(4000);
  const afterStop = ok('state');
  check('X4', !afterStop.results.some((r) => r.address === RIG), 'the interrupted node is NOT recorded (retried on resume, as in the Cosmos tester)', JSON.stringify(afterStop.results.map((r) => [r.address.slice(0, 6), r.errorCode])));
  const newCh = ok('channels').tracked.filter((c) => !chBeforeStop.includes(c.address));
  check('X5', newCh.length <= 1, `a channel opened before the stop stays tracked for the refund sweep (${newCh.length})`, JSON.stringify(newCh));
  const res2 = cli('resume');
  if (afterStop.results.length === 0) {
    check('X6', res2.code !== 0 && /No results to resume/.test(res2.err), 'resume with no recorded node says so (Cosmos rule: use Start)', res2.err);
  } else {
    check('X6', res2.code === 0, 'resume continues the stopped test', res2.err);
    const rs = await waitRun('X7');
    check('X7', rs.status === 'done', `resumed test completed: ${rs.testedNodes} pass ${rs.failedNodes} fail`, rs.status);
  }
  // This run also proves autoCancelAfterTest=false leaves the channel open for the sweep.
  ok('settings', 'autoCancelAfterTest=false');
  const st2 = cli(...startArgs());
  check('X8', st2.code === 0, 'a new start right after a stop is accepted (runs are serialised)', st2.err);
  const s8 = await waitRun('X8b');
  ok('settings', 'autoCancelAfterTest=true');
  const r8 = ok('state').results.find((r) => r.address === RIG);
  check('X9', s8.status === 'done' && r8 && r8.actualMbps > 0, `run after the stop tests the node cleanly: ${r8?.actualMbps} Mbps`, JSON.stringify(r8 && [r8.errorCode, r8.error]));
  const keptOpen = r8?.channel ? await readChannel(r8.channel) : null;
  check('E5', keptOpen && Number(keptOpen.status) === 0 && ok('channels').tracked.find((c) => c.address === r8.channel)?.status === 'open', `autoCancelAfterTest=false: channel ${r8?.channel?.slice(0, 8)}… still open on chain after the run`, JSON.stringify(keptOpen && { s: keptOpen.status }));
  check('X10', dockerClients() === 0, 'no client container left after the restart', `${dockerClients()} left`);

  // ─── retests ───
  await sleep(7000);
  const rf = cli('retest-fails', '--addresses', `${RIG},${NODE2}`);
  check('Y1', rf.code === 0 && rf.json.retesting === 2, 'retest-fails with explicit addresses', rf.err);
  const ys = await waitRun('Y2');
  const yres = ok('state').results;
  const amn = yres.find((r) => r.address === NODE2);
  check('Y2', ys.status === 'done' && yres.some((r) => r.address === RIG && r.actualMbps > 0), 'retest: rig passes again', JSON.stringify(yres.map((r) => [r.address.slice(0, 6), r.actualMbps, r.errorCode])));
  const amnLive = (nodes.results || []).some((n) => n.address === NODE2);
  if (amnLive) {
    check('Y3', amn && amn.actualMbps == null && amn.errorCode && amn.error, `retest of an unreachable node records a failure: ${amn?.errorCode}`, JSON.stringify(amn));
    const errs = ok('errors', amn?.address || 'x');
    check('Y4', errs?.errors?.length >= 1 && errs.errors[0].log_snippet, `failure log stored + copyable (stage ${errs?.errors?.[0]?.stage})`, JSON.stringify(errs ?? null).slice(0, 200));
  } else rec('SKIP', 'Y3', 'no second live node to fail');
  const rs2 = cli('retest-skips');
  check('Y5', rs2.code === 0 || /No unreachable failures/.test(rs2.err), `retest-skips: ${rs2.code === 0 ? `retesting ${rs2.json.retesting}` : rs2.err}`, rs2.err);
  if (rs2.code === 0) await waitRun('Y5b');
  await sleep(7000);
  const ar = cli('auto-retest');
  check('Y6', ar.code === 0 || /No retestable failures/.test(ar.err), `auto-retest: ${ar.code === 0 ? `retesting ${ar.json.retesting}` : ar.err}`, ar.err);
  if (ar.code === 0) await waitRun('Y6b');
  const fa = ok('failure-analysis');
  check('Y7', fa && typeof fa.total === 'number', `failure-analysis: ${fa?.failed} failed of ${fa?.total}`, JSON.stringify(fa ?? null).slice(0, 200));

  // ─── loop: start --loop --test-run, then stop ───
  const lp = cli(...startArgs('--test-run', '--loop'));
  check('L1', lp.code === 0 && lp.json.infiniteLoop === true, `start --loop --test-run → Test #${lp.json?.testNumber}`, lp.err);
  await sleep(20_000);
  const lstop = cli('stop');
  await sleep(5000);
  const ls = ok('status').state;
  check('L2', lstop.code === 0 && !['running'].includes(ls.status) && ls.continuousLoop === false, `stop ends the loop (status ${ls.status})`, JSON.stringify({ s: ls.status, loop: ls.continuousLoop }));

  // ─── clear / delete ───
  const clr = cli('clear');
  check('D1', clr.code === 0 && ok('state').results.length === 0, 'clear empties the displayed results', clr.err);
  const del = cli('run-delete', String(testNum));
  check('D2', del.code === 0 && !ok('runs').runs.some((r) => r.number === testNum), `run-delete ${testNum} removes the TEST RUN`, del.err);
  const delMissing = cli('run-delete', '99999');
  check('D3', delMissing.code !== 0, 'run-delete of a missing test → 404', delMissing.err);
  const loadPaid = cli('run-load', String(paidNum));
  check('D4', loadPaid.code === 0 && ok('state').results.some((r) => r.address === RIG && r.actualMbps > 0), `run-load ${paidNum} brings the paid test back`, loadPaid.err);

  // ─── sweep ───
  const dry = ok('sweep', '--dry-run');
  check('W1', dry && dry.dryRun === true && Array.isArray(dry.pending), `sweep --dry-run: ${dry?.pending?.length} waiting for grace`, JSON.stringify(dry ?? null).slice(0, 200));
  const sw = cli('sweep');
  check('W2', sw.code === 0 && !sw.json.errors.length, `sweep: ${sw.json?.startedClose?.length} start-closed · ${sw.json?.closed?.length} closed · ${sw.json?.pending?.length} waiting`, sw.err || sw.json?.errors);
  if (r8?.channel) {
    const swept = (sw.json?.startedClose || []).some((x) => (x.address || x) === r8.channel) || ok('channels').tracked.find((c) => c.address === r8.channel)?.status === 'closing';
    check('E6', swept, `sweep start-closed the channel auto-cancel left open (${r8.channel.slice(0, 8)}…)`, JSON.stringify(sw.json?.startedClose));
  }
  const chOnChain = ok('channels', '--chain');
  const foreign = (chOnChain?.onChain || []).filter((c) => !c.trackedByTester);
  check('W3', foreign.every((c) => !ok('channels').tracked.some((t) => t.address === c.address)), `sweep never touched the ${foreign.length} channels other projects own`, 'overlap');

  return finishChecks(s0);
}

function finishChecks(s0) {
  // restore
  ok('settings', ...Object.entries(s0).map(([k, v]) => `${k}=${v}`));
  rec('PASS', 'Z1', 'settings restored');

  // Every action above (plan runs, loads, retests, deletes) must leave the stores consistent:
  // test-plan and run-load each once overwrote a saved run. Local server only (it reads disk).
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL_)) {
    const dc = spawnSync(process.execPath, [join(ROOT, 'scripts', 'data-check.mjs'), '--json'], { encoding: 'utf8' });
    let rep = null;
    try { rep = JSON.parse(dc.stdout); } catch (err) { rep = { ok: false, problems: [{ code: 'PARSE', msg: err.message }] }; }
    check('Z2', rep.ok === true, `data-check: ${rep.problems.length} problem(s) after the whole e2e`, JSON.stringify(rep.problems).slice(0, 400));
  }
}

try { await main(); } catch (err) { rec('FAIL', 'ERR', err.stack?.split('\n').slice(0, 3).join(' | ') || err.message); }
const summary = `${PASS} passed · ${FAIL} failed · ${SKIP} skipped`;
console.log(`\n${summary}`);
writeFileSync(join(ROOT, 'test', 'cli-e2e-last-run.log'), `${new Date().toISOString()} ${URL_}${flag('--finish') ? ' --finish' : ''}\n${lines.join('\n')}\n${summary}\n`);
process.exit(FAIL ? 1 : 0);
