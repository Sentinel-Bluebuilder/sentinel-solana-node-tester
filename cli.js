#!/usr/bin/env node
// ─── sentinel-audit-sol — CLI for the Node Tester (Solana) ───────────────────
// Thin HTTP client over the running server: every command is one route of the
// shared (Cosmos-identical) API or of /api/solana/*, so the CLI, the dashboards
// and the e2e harness exercise exactly the same code.
//
//   node cli.js <command> [args] [--json] [--url http://127.0.0.1:3011]
//
// Auth: ADMIN_TOKEN from the environment / .env is sent as a Bearer token, and
// every write carries X-Admin-Request: 1.
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const C = {};
const def = (name, help, run) => { C[name] = { help, run }; };
const enc = encodeURIComponent;

// ─── run control ───
// --addresses a,b → { addresses: [...] } (empty when not given)
const addrs = (a) => (a.f.addresses ? { addresses: String(a.f.addresses).split(',').map((x) => x.trim()).filter(Boolean) } : {});
def('start', 'start [--test-run] [--loop] [--hours] [--addresses a,b] — new test (saves the current one first); --addresses limits it to those nodes', (a) => post('/api/start', { testRun: !!a.f['test-run'], infiniteLoop: !!a.f.loop, pricingMode: a.f.hours ? 'hours' : 'gigabytes', ...(a.f.addresses ? { addresses: String(a.f.addresses).split(',').map((s) => s.trim()).filter(Boolean) } : {}) }));
def('resume', 'resume the current (incomplete) test', () => post('/api/resume', {}));
def('stop', 'stop the current test', () => post('/api/stop', {}));
def('retest-fails', 'retest-fails [--addresses a,b] — retest failed nodes of the current test', (a) => post('/api/retest-fails', a.f.addresses ? { addresses: String(a.f.addresses).split(',').map((s) => s.trim()).filter(Boolean) } : {}));
def('retest-skips', 'retest nodes that failed as unreachable', () => post('/api/retest-skips', {}));
def('auto-retest', 'auto-retest [--force] — retest every retestable failure', (a) => post('/api/auto-retest', { force: !!a.f.force }));
def('clear', 'clear the displayed results (refused while running)', () => post('/api/clear', {}));
def('wait', 'wait [--timeout S] — block until the run is no longer running; exit 1 on error', (a) => waitIdle(Number(a.f.timeout || 3600)));

// ─── state ───
def('status', 'run state (counters, wallet, balance)', () => get('/api/stats'));
def('state', 'run state + every result of the current test', () => get('/api/state'));
def('results', 'results [--page N] [--limit N]', (a) => get(`/api/results?${qs({ page: a.f.page, limit: a.f.limit })}`));
def('health', 'prelaunch health (wallet, client, issues)', () => get('/api/health'));
def('ping', 'liveness', () => get('/health'));
def('failure-analysis', 'failure categories of the current test', () => get('/api/failure-analysis'));

// ─── runs ───
def('runs', 'saved tests', () => get('/api/runs'));
def('run', 'run <n> — one saved test with every result', (a) => get(`/api/runs/${need(a, 0, 'n')}`));
def('run-save', 'run-save [--label L] — save the current test', (a) => post('/api/runs/save', a.f.label ? { label: String(a.f.label) } : {}));
def('run-load', 'run-load <n> — show a saved test (read-only)', (a) => post(`/api/runs/load/${need(a, 0, 'n')}`, {}));
def('run-delete', 'run-delete <n> — delete a saved test', (a) => call('DELETE', `/api/runs/${need(a, 0, 'n')}`));
def('cross-sdk', 'per-node results across saved tests', () => get('/api/cross-sdk'));

// ─── settings / config ───
def('settings', 'settings [key=value …] — show or change run settings: gigabytes, maxPriceBase, autoCancelAfterTest, onchainEnabled, onchainBatchSize, onchainRegion (batchSize: no effect on Solana). See `config` for every setting', (a) => (a.pos.length ? post('/api/settings', parseKv(a.pos)) : get('/api/settings')));
def('config', 'every setting with its source, effect and how to change it: runtime (settings / dns / broadcast) and .env (restart)', () => get('/api/solana/config'));
def('broadcast', 'broadcast [toggle] — show or flip Broadcast Live', (a) => (a.pos[0] === 'toggle' ? post('/api/broadcast', {}) : get('/api/broadcast')));
def('dns', 'dns [preset] [--servers a,b] — show or set DNS', (a) => (a.pos[0] || a.f.servers ? post('/api/dns', a.f.servers ? { servers: String(a.f.servers).split(',').map((s) => s.trim()).filter(Boolean) } : { preset: a.pos[0] }) : get('/api/dns')));
def('sdk', 'sdk [dvpnd] — show the client (Solana has one: dvpnd)', (a) => (a.pos[0] ? post('/api/sdk', { sdk: a.pos[0] }) : get('/api/sdk')));
def('sdk-versions', 'client + tester versions', () => get('/api/sdk-versions'));
def('sdk-verify', 'sdk-verify [key] — verify the client build', (a) => (a.pos[0] ? get(`/api/sdk-verify/${enc(a.pos[0])}`) : get('/api/sdk-verify')));
def('sdk-latest', 'latest published SDK versions (Solana: none — dvpnd is the pinned image, see sdk-versions)', () => get('/api/sdk-latest'));
def('transport-cache', 'transport cache stats', () => get('/api/transport-cache'));

// ─── chain / nodes ───
def('nodes', 'live-listed nodes on chain', () => get('/api/chain/nodes'));
def('node-status', 'node-status <remoteUrl> — node status proxy (public hosts only)', (a) => get(`/api/chain/node-status?remoteUrl=${need(a, 0, 'remoteUrl')}`));
def('probe', 'probe <nodePda> — signed metadata, TLS pin, reachability (never spends)', (a) => post(`/api/solana/node/${need(a, 0, 'nodePda')}/probe`, {}));
def('plans', 'listed plans on chain (id = Plan PDA, provAddress = Provider PDA)', () => get('/api/plans'));
def('admin-plans', 'admin-plans — every listed plan with its terms (admin view)', () => get('/api/admin/plans'));
def('subscriptions', 'subscriptions of the tester wallet (id = Subscription PDA)', () => get('/api/subscriptions'));
def('sub-plans', 'active subscriptions + provider check + live roster count', () => get('/api/sub-plans'));
def('test-plan', 'test-plan <planPda> [--addresses a,b] — subscribe (or reuse an active subscription), then test the roster with tickets; --addresses keeps to those roster nodes (a plan allows only maxConnections live tickets)', (a) => post('/api/test-plan', { planId: need(a, 0, 'planPda'), ...addrs(a) }));
def('test-sub-plan', 'test-sub-plan <planPda> <subscriptionPda> <providerPda> [--loop] [--addresses a,b] — ticket sessions on every roster node, or only on --addresses', (a) => post('/api/test-sub-plan', { planId: need(a, 0, 'planPda'), subscriptionId: need(a, 1, 'subscriptionPda'), granter: need(a, 2, 'providerPda'), infiniteLoop: !!a.f.loop, ...addrs(a) }));

// ─── Solana ───
def('info', 'network, program, mint, tester wallet', () => get('/api/solana/info'));
def('doctor', 'Docker, client image, client caps, wallet, RPC, speed method — ready for a paid run?', () => get('/api/solana/doctor'));
def('speed', 'speed method in use (steady = default, classic = SPEED_METHOD=classic) and a pinned check of its origin', () => get('/api/solana/speed'));
def('speed-test', 'speed-test — fresh direct baseline of the tester link with the active method (moves up to SPEED_BUDGET_MB)', () => post('/api/solana/speed/baseline', {}));
def('channels', 'channels [--open] [--chain] — test channels (tracked, and on chain)', (a) => get(`/api/solana/channels?${qs({ open: a.f.open ? 1 : undefined, chain: a.f.chain ? 1 : undefined })}`));
def('sweep', 'sweep [--dry-run] — start-close / close test channels, withdraw refunds', (a) => post('/api/solana/channels/sweep', { dryRun: !!a.f['dry-run'] }));
def('reports', 'reports [--limit N] — report memos this tester posted (local)', (a) => get(`/api/solana/reports?${qs({ limit: a.f.limit })}`));
def('onchain-reports', 'onchain-reports [--limit N] [--address A] — decode report memos from chain', (a) => get(`/api/onchain-reports?${qs({ limit: a.f.limit, address: a.f.address })}`));

// ─── public (what /, /live and /node show) ───
def('pub-nodes', 'pub-nodes [--q] [--country] [--service] [--sort] [--limit] [--run-id]', (a) => get(`/api/public/nodes?${qs({ q: a.f.q, country: a.f.country, service: a.f.service, sort: a.f.sort, limit: a.f.limit, offset: a.f.offset, runId: a.f['run-id'] })}`));
def('pub-node', 'pub-node <address> [--history N]', (a) => get(`/api/public/node/${need(a, 0, 'address')}?${qs({ historyLimit: a.f.history })}`));
def('errors', 'errors <address> [--limit N] [--stage S] — stored failure logs', (a) => get(`/api/public/node/${need(a, 0, 'address')}/errors?${qs({ limit: a.f.limit, stage: a.f.stage })}`));
def('bandwidth', 'bandwidth <address> [--limit N]', (a) => get(`/api/public/node/${need(a, 0, 'address')}/bandwidth?${qs({ limit: a.f.limit })}`));
def('error-search', 'error-search [--q] [--stage] [--limit] — failures across all nodes', (a) => get(`/api/public/errors?${qs({ q: a.f.q, stage: a.f.stage, limit: a.f.limit })}`));
def('countries', 'countries with node counts', () => get('/api/public/countries'));
def('pub-runs', 'public run list', () => get('/api/public/runs'));
def('runs-current', 'current batch (live view)', () => get('/api/public/runs/current'));
def('runs-last', 'last completed batch', () => get('/api/public/runs/last'));
def('batches', 'batches [--limit N]', (a) => get(`/api/public/batches?${qs({ limit: a.f.limit })}`));
def('batch', 'batch <id> [--limit N]', (a) => get(`/api/public/batch/${need(a, 0, 'id')}?${qs({ limit: a.f.limit })}`));
def('stats', 'public network stats', () => get('/api/public/stats'));
def('sdk-info', 'client shown on /live', () => get('/api/public/sdk-info'));
def('test-status', 'continuous-loop status', () => get('/api/public/test/status'));
def('live-state', 'what /live hydrates from', () => get('/api/public/live-state'));
def('logs', 'public log backlog', () => get('/api/public/logs'));
def('pub-test-start', 'pub-test-start (needs ALLOW_PUBLIC_TEST=true on the server)', () => post('/api/public/test/start', { mode: 'p2p' }));
def('pub-test-stop', 'pub-test-stop (needs ALLOW_PUBLIC_TEST=true on the server)', () => post('/api/public/test/stop', {}));

// ─── args ────────────────────────────────────────────────────────────────────
const BOOLEAN_FLAGS = new Set(['json', 'test-run', 'loop', 'hours', 'force', 'open', 'chain', 'dry-run', 'help', 'raw']);
function parseArgs(argv) {
  const out = { pos: [], f: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) out.f[k] = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(k)) out.f[k] = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.f[k] = argv[++i];
      else out.f[k] = true;
    } else out.pos.push(a);
  }
  return out;
}
function need(a, i, name) {
  const v = a.pos[i];
  if (!v) { console.error(`missing <${name}>`); process.exit(2); }
  return enc(v);
}
function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  return p.toString();
}
// ─── Solana names ────────────────────────────────────────────────────────────
// The HTTP API keeps the Cosmos tester's field names: the dashboards are the
// Cosmos pages and read them. The CLI is the Solana tool, so it prints Solana
// names (and accepts them in `settings key=value`). --raw prints the API as is.
const SOLANA_KEYS = {
  balanceUdvpn: 'balanceBase', // tDVPN base units (6 decimals)
  spentUdvpn: 'spentBase',
  runSpentUdvpn: 'runSpentBase',
  maxPriceUdvpn: 'maxPriceBase',
  denom: 'token',
  feeGrantActive: 'providerVerified', // provider listed + signed metadata + TLS pin check out
  feeGrantCheckFailed: 'providerCheckFailed',
  selfGranter: 'ownProvider', // the tester wallet owns the plan's provider
  ownerSentAddr: 'provider', // Provider PDA
  runGranter: 'runProvider',
  grantedBytes: 'allocatedBytes', // the subscription's data allocation
  mnemonic: 'testKeyfile', // /api/health: the wallet key file is set
};
const API_KEYS = Object.fromEntries(Object.entries(SOLANA_KEYS).map(([k, v]) => [v, k]));
function solanaNames(v) {
  if (Array.isArray(v)) return v.map(solanaNames);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [SOLANA_KEYS[k] || k, solanaNames(x)]));
}

function parseKv(pairs) {
  const out = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq < 1) { console.error(`expected key=value, got "${p}"`); process.exit(2); }
    const k = API_KEYS[p.slice(0, eq)] || p.slice(0, eq); const v = p.slice(eq + 1);
    out[k] = v === 'true' ? true : v === 'false' ? false : /^-?\d+$/.test(v) ? Number(v) : v;
  }
  return out;
}

// ─── http ────────────────────────────────────────────────────────────────────
let BASE = `http://127.0.0.1:${process.env.PORT || 3001}`;
async function call(method, path, body) {
  const headers = { Accept: 'application/json', 'X-Admin-Request': '1' };
  if (process.env.ADMIN_TOKEN) headers.Authorization = `Bearer ${process.env.ADMIN_TOKEN}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (err) {
    throw new Error(`cannot reach the server at ${BASE} (${err.cause?.code || err.message}) — is it running? (npm start)`);
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (err) { json = { error: text.slice(0, 300) }; }
  // The shared API answers some refusals with HTTP 200 + { error } — treat those as failures too.
  if (!res.ok || (json && typeof json === 'object' && json.error && json.ok !== true)) {
    const e = new Error(json.message || json.error || `HTTP ${res.status}`);
    e.status = res.status; e.body = json;
    throw e;
  }
  return json;
}
const get = (p) => call('GET', p);
const post = (p, b = {}) => call('POST', p, b);

const BUSY = ['running', 'paused', 'paused_balance', 'paused_internet'];
async function waitIdle(timeoutS) {
  const until = Date.now() + timeoutS * 1000;
  let last = '';
  // A start returns before the pipeline flips to running; give it a moment.
  await new Promise((r) => setTimeout(r, 1500));
  for (;;) {
    const s = (await get('/api/stats')).state;
    const line = `${s.status} total ${s.totalNodes} pass ${s.testedNodes} fail ${s.failedNodes} skip ${s.skippedNodes}`;
    if (line !== last) { process.stderr.write(`[wait] ${line}\n`); last = line; }
    if (!BUSY.includes(s.status)) {
      if (s.status === 'error') { const e = new Error(s.errorMessage || 'run failed'); e.body = { state: s }; throw e; }
      return { ok: true, state: s };
    }
    if (Date.now() > until) throw new Error(`timed out after ${timeoutS}s waiting for the run (status ${s.status})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function usage() {
  const w = Math.max(...Object.keys(C).map((k) => k.length));
  console.log('Usage: node cli.js <command> [args] [--json] [--raw] [--url URL]');
  console.log('  Amounts are tDVPN base units (6 decimals). --raw prints the shared API field names (Cosmos-compatible).\n');
  for (const [k, c] of Object.entries(C)) console.log(`  ${k.padEnd(w)}  ${c.help}`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.f.url) BASE = String(a.f.url).replace(/\/$/, '');
  const name = a.pos.shift();
  if (!name || a.f.help || name === 'help') { usage(); return; }
  const cmd = C[name];
  if (!cmd) { console.error(`unknown command "${name}"`); usage(); process.exit(2); }
  try {
    const out = await cmd.run(a);
    console.log(JSON.stringify(a.f.raw ? out : solanaNames(out), null, a.f.json ? 0 : 2));
  } catch (err) {
    const body = err.body && typeof err.body === 'object' ? { body: a.f.raw ? err.body : solanaNames(err.body) } : {};
    console.error(JSON.stringify({ ok: false, error: err.message, status: err.status, ...body }, null, 2));
    // exitCode, not exit(): a hard exit while a fetch socket is closing trips a libuv assertion on Windows.
    process.exitCode = 1;
  }
}

export { C as COMMANDS, parseArgs, parseKv, solanaNames, SOLANA_KEYS };
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
