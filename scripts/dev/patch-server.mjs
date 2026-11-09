#!/usr/bin/env node
// ─── patch-server ────────────────────────────────────────────────────────────
// Builds server.js from the Cosmos tester's COMMITTED server.js (git HEAD of
// work/sentinel-node-tester, see readCosmos) plus the Solana edits below.
// Every edit is an exact string replacement that must match exactly once, so a
// newer Cosmos server either patches cleanly or fails loudly naming the edit.
//   node scripts/dev/patch-server.mjs            # write server.js
//   node scripts/dev/patch-server.mjs --check    # exit 1 if server.js has drifted from the build
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCosmos } from './patch-pages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = join(ROOT, 'server.js');
const CHECK = process.argv.includes('--check');
const log = CHECK ? () => {} : (m) => console.log(m);
let src = readCosmos(process.env.COSMOS_TESTER_DIR || join(ROOT, '..', 'sentinel-node-tester'), 'server.js');

const EDITS = [
  ['cosmjs wallet imports → Solana wallet',
    `import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';

// Walk RPC_ENDPOINTS in order and return the first SigningStargateClient that
// connects. Replaces a hardcoded \`rpc.sentinel.co:443\` connect that returned
// stale balances when that node fell behind tip while reporting catching_up=false.
async function connectWithRpcFailover(wallet) {
  const opts = { gasPrice: GasPrice.fromString(GAS_PRICE) };
  let lastErr;
  for (const url of RPC_ENDPOINTS) {
    try {
      return await SigningStargateClient.connectWithSigner(url, wallet, opts);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All RPC endpoints unreachable');
}`,
    `// Solana: the tester wallet is the TEST_KEYFILE keypair; balances are tDVPN base
// units (6 decimals, the same scale the dashboards use). No CosmJS client.
import { tokenBalanceBase } from './core/wallet.js';
import { walletAddress as solanaWalletAddress } from './lib/wallet.js';
import { TOKEN_LABEL, DVPND_IMAGE } from './lib/constants.js';
import { dockerStatus, imagePresent } from './audit/docker.js';
import solanaRoutes from './routes/solana.js';`],
  ['public error redaction covers Solana addresses',
    `const _PUBLIC_ADDR_RE = /\\b(sent|sentnode|sentpub|sentvaloper)1[a-z0-9]{6,}\\b/gi;`,
    `// Solana: base58 public keys (wallets, providers, PDAs) — 32–44 chars, no 0/O/I/l.
// Longer base58 runs (tx signatures) have no word boundary inside, so they stay.
const _PUBLIC_ADDR_RE = /\\b[1-9A-HJ-NP-Za-km-z]{32,44}\\b/g;`],
  ['health checks Docker + the client image, not host tunnels',
    `  if (!IS_ADMIN && WG_AVAILABLE) {
    issues.push(process.platform === 'win32'
      ? 'Not running as Administrator — WireGuard nodes will fail. Use SentinelAudit.vbs to elevate.'
      : 'Not running as root — WireGuard nodes will fail. Re-run with \`sudo\`.');
  }
  if (!v2ray) issues.push('V2Ray binary not found — download from https://github.com/v2fly/v2ray-core/releases and place in bin/');
  if (!WG_AVAILABLE && process.platform === 'win32') issues.push('WireGuard not installed — install from https://www.wireguard.com/install/');
  if (!WG_AVAILABLE && process.platform === 'linux') issues.push('WireGuard not installed — \`sudo apt install wireguard-tools\` (Debian/Ubuntu) or \`sudo dnf install wireguard-tools\` (Fedora)');
  if (!WG_AVAILABLE && process.platform === 'darwin') issues.push('WireGuard not installed — \`brew install wireguard-tools\`');`,
    `  // Solana: no tunnel ever runs on the host, so admin rights, WireGuard and V2Ray are
  // not needed. Every session runs the dvpnd client in a container: Docker + the image.
  const docker = await dockerStatus();
  if (!docker.ok) issues.push(\`Docker unavailable — every paid session runs in a client container (\${docker.error})\`);
  else if (!(await imagePresent(DVPND_IMAGE)).ok) issues.push(\`client image \${DVPND_IMAGE} missing — load it before a paid run\`);`],
  ['boot banner: containers, not host tunnels',
    `  if (!IS_ADMIN) {
    if (process.platform === 'win32') {
      console.warn('⚠  NOT running as Administrator — WireGuard tests will be skipped.');
    } else {
      console.warn('⚠  NOT running as root — WireGuard tests will be skipped. Re-run with \`sudo\`.');
    }
  } else {
    if (process.platform === 'win32') {
      console.log('✓  Running as Administrator — WireGuard tunnels will work without UAC.\\n');
    } else {
      console.log('✓  Running as root — WireGuard tunnels will work.\\n');`,
    `  {
    {
      console.log(\`✓  Sessions run the dvpnd client in containers (\${DVPND_IMAGE}); nothing tunnels on this host.\\n\`);`],
  ['sub-plan granter wording',
    `error: 'granter (sent1...) required'`,
    `error: 'granter (provider PDA) required'`],
  ['retest reason wording',
    `reason = 'LCD stale — may have reactivated'`,
    `reason = 'Listing stale — may have reactivated'`],
  ['boot warning: MNEMONIC → TEST_KEYFILE',
    `  console.warn('⚠  MNEMONIC is not set.');
  console.warn('   The server will start, but any test that signs a TX will fail.');
  console.warn('   Fix: copy .env.example to .env and set MNEMONIC to a 12-word Cosmos phrase.');`,
    `  console.warn('⚠  TEST_KEYFILE is not set.');
  console.warn('   The server will start, but any test that pays a session will fail.');
  console.warn('   Fix: copy .env.example to .env and set TEST_KEYFILE to a solana-keygen JSON key file.');`],
  ['default tester client = dvpnd',
    `try { state.activeSDK = _rfs(SDK_PREF_FILE, 'utf8').trim() || 'js'; } catch { state.activeSDK = 'js'; }`,
    `// Solana: one client implementation — the reference dvpnd in the client container.
state.activeSDK = 'dvpnd';`],
  ['sdk-info names dvpnd',
    `    const ACTIVE_TO_TRACKED = { js: 'blue-js', tkd: 'tkd-js' };
    const DISPLAY_NAME = { js: 'Blue JS', tkd: 'TKD JS', csharp: 'Blue C#' };`,
    `    const ACTIVE_TO_TRACKED = { dvpnd: 'dvpnd' };
    const DISPLAY_NAME = { dvpnd: 'dvpnd', js: 'dvpnd', tkd: 'dvpnd', csharp: 'dvpnd' };`],
  ['on-chain reports: wallet from TEST_KEYFILE',
    `    let address = req.query.address || state.walletAddress || null;
    if (!address) {
      if (!process.env.MNEMONIC) {
        return res.status(503).json({ error: 'tester wallet not yet initialized' });
      }
      try {
        const { account } = await cachedWalletSetup(process.env.MNEMONIC);
        address = account.address;
      } catch (e) {
        return res.status(503).json({ error: 'tester wallet not yet initialized', detail: e.message });
      }
    }`,
    `    const address = req.query.address || state.walletAddress || solanaWalletAddress();
    if (!address) return res.status(503).json({ error: 'tester wallet not yet initialized' });`],
  ['SDK switch is a no-op on Solana',
    `  const { sdk } = req.body;
  const SDK_LABELS = { js: 'Blue JS', csharp: 'Blue C#', tkd: 'TKD JS (Official)' };`,
    `  const { sdk } = req.body;
  // Solana has one client (dvpnd); every SDK choice maps onto it.
  const SDK_LABELS = { js: 'dvpnd', csharp: 'dvpnd', tkd: 'dvpnd', dvpnd: 'dvpnd' };`],
  ['SDK switch keeps dvpnd',
    `  const changed = state.activeSDK !== sdk;
  state.activeSDK = sdk;
  try { _wfs(SDK_PREF_FILE, sdk, 'utf8'); } catch {}`,
    `  const changed = false;
  state.activeSDK = 'dvpnd';`],
  ['SDK switch reports the client actually used',
    `  res.json({ ok: true, sdk });`,
    `  res.json({ ok: true, sdk: 'dvpnd' });`],
  ['SDK switch error wording',
    `Invalid SDK. Use "js", "csharp", or "tkd"`,
    `Invalid client. Solana has one client: "dvpnd"`],
  ['no npm SDKs on Solana',
    `const NPM_PKGS = { 'blue-js': 'blue-js-sdk', 'tkd-js': '@sentinel-official/sentinel-js-sdk' };`,
    `// dvpnd is not published to npm: the client is the pinned image (DVPND_IMAGE, see /api/sdk-versions).
const NPM_PKGS = {};`],
  ['run log: client label',
    `  const SDK_LABELS = { js: 'Blue JS', csharp: 'Blue C#', tkd: 'TKD JS' };
  const label = \`\${SDK_LABELS[state.activeSDK] || state.activeSDK} SDK, `,
    `  const SDK_LABELS = { dvpnd: 'DVPND' };
  const label = \`\${SDK_LABELS[state.activeSDK] || state.activeSDK} client, `],
  ['start: optional node list (read)',
    `  const pricingMode = (req.body?.pricingMode === 'hours' || req.query.pricingMode === 'hours') ? 'hours' : 'gigabytes';`,
    `  const pricingMode = (req.body?.pricingMode === 'hours' || req.query.pricingMode === 'hours') ? 'hours' : 'gigabytes';
  // Solana: test only these node PDAs (a hosted lab node set); empty = every listed node.
  const onlyAddresses = Array.isArray(req.body?.addresses) ? req.body.addresses.filter((a) => typeof a === 'string' && a) : [];`],
  ['start: optional node list (pass)',
    `        await runAudit(false, state, tracked, null, { testRun, pricingMode });`,
    `        await runAudit(false, state, tracked, null, { testRun, pricingMode, addresses: onlyAddresses });`],
  ['plan run log: access tickets',
    `(subscription-allocated sessions, plan-scoped node set)`,
    `(access-ticket sessions, plan-scoped node set)`],
  ['health: key file wording',
    `  if (!MNEMONIC) issues.push('MNEMONIC not set in .env — copy .env.example to .env and add your wallet mnemonic');`,
    `  if (!MNEMONIC) issues.push('TEST_KEYFILE not set in .env — point it at a funded solana-keygen JSON key file');`],
  ['boot banner wording',
    `    console.log('│  No MNEMONIC configured — dashboard is view-only.           │');
    console.log('│                                                              │');
    console.log('│  To run audits:                                              │');
    console.log('│    1. Copy .env.example to .env                              │');
    console.log('│    2. Add your Sentinel wallet mnemonic                      │');`,
    `    console.log('│  No TEST_KEYFILE configured — dashboard is view-only.       │');
    console.log('│                                                              │');
    console.log('│  To run audits:                                              │');
    console.log('│    1. Copy .env.example to .env                              │');
    console.log('│    2. Set TEST_KEYFILE to a funded solana-keygen key file    │');`],
  ['boot balance via Solana',
    `    try {
      const w = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
      const [acc] = await w.getAccounts();
      state.walletAddress = acc.address;
      const tmpClient = await connectWithRpcFailover(w);
      const bal = await tmpClient.getBalance(acc.address, DENOM);
      state.balanceUdvpn = parseInt(bal?.amount || '0', 10);
      state.spentUdvpn = 0; // Real chain balance is the truth — reset estimate
      state.balance = \`\${(state.balanceUdvpn / 1_000_000).toFixed(4)} P2P\`;
      state.estimatedTotalCost = '0 P2P';
      tmpClient.disconnect();
      console.log(\`Wallet: \${acc.address} | Balance: \${state.balance}\`);`,
    `    try {
      const bal = await tokenBalanceBase();
      state.walletAddress = bal.address;
      state.balanceUdvpn = parseInt(bal.amount || '0', 10);
      state.spentUdvpn = 0; // Real chain balance is the truth — reset estimate
      state.balance = \`\${(state.balanceUdvpn / 1_000_000).toFixed(4)} P2P\`;
      state.estimatedTotalCost = '0 P2P';
      console.log(\`Wallet: \${bal.address} | Balance: \${state.balance} (\${bal.sol} SOL)\`);`],
  ['periodic balance via Solana',
    `        const w = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: 'sent' });
        const [acc] = await w.getAccounts();
        const tmpClient = await connectWithRpcFailover(w);
        const bal = await tmpClient.getBalance(acc.address, DENOM);
        const fresh = parseInt(bal?.amount || '0', 10);
        tmpClient.disconnect();`,
    `        const bal = await tokenBalanceBase();
        const fresh = parseInt(bal.amount || '0', 10);`],
  ['mount Solana routes before listen',
    `app.listen(PORT, LISTEN_HOST, async () => {`,
    `// ─── Solana additions: doctor, test channels + sweep, single-node probe ───────
app.use(solanaRoutes({ state, broadcast, isAuditBusy }));

app.listen(PORT, LISTEN_HOST, async () => {`],
  // Fresh install, first action a retest (no start yet): activeRunNumber is undefined, the
  // auto-save files a run with no number, and Math.max(undefined)+1 = NaN poisons every later
  // run ("Test #NaN", testNumber null). Found on the hosted e2e; the Cosmos server has it too.
  ['run numbering ignores non-numeric entries',
    `  return (index.runs.length > 0 ? Math.max(...index.runs.map(r => r.number)) : 0) + 1;`,
    `  const nums = index.runs.map(r => r.number).filter(Number.isFinite);
  return (nums.length > 0 ? Math.max(...nums) : 0) + 1;`],
  ['auto-save before the first run gets a real number',
    `  const prevResults = getResults();
  if (prevResults.length > 0) {
    const runDir = path.join(RUNS_DIR,`,
    `  const prevResults = getResults();
  if (!Number.isFinite(state.activeRunNumber)) state.activeRunNumber = getNextRunNumber();
  if (prevResults.length > 0) {
    const runDir = path.join(RUNS_DIR,`],
  // Solana plan ids are Plan PDAs (base58); parseInt would turn every one into NaN.
  // test-plan is a CLI command here (hidden in Cosmos): it must start a fresh run like
  // test-sub-plan. Without it the plan rows stayed under the CURRENT run number and the
  // next start saved them over that run (saved GCP run #79 was overwritten, 2026-10-20).
  ['plan test: fresh run, plan address passed through, saved at the end',
    `  state.stopRequested = false;
  res.json({ ok: true, planId });
  const tracked = withBatchTracking(broadcast, 'subscription');
  runPlanTest(parseInt(planId), state, tracked).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    tracked('state', { state });
  });`,
    `  state.stopRequested = false;
  const { newNum } = startFreshRun(\`Plan \${planId}\`, { mode: 'subscription', plan_id: String(planId) });
  state.continuousLoop = false;
  state.runMode = 'subscription';
  state.runPlanId = String(planId);
  state.testRun = false;
  state.planAddresses = Array.isArray(req.body.addresses) && req.body.addresses.length ? req.body.addresses.map(String) : null;
  state.activeBatchId = 0;
  state.resumeHeadAddr = null;
  state.auditLogPath = null;
  broadcastStateFresh();
  broadcast('log', { msg: \`🚀 Starting Test #\${newNum} — Mode: Plan \${planId} (subscribe, then access-ticket sessions)\${state.planAddresses ? \` — \${state.planAddresses.length} roster node(s) only\` : ''}\` });
  res.json({ ok: true, planId, testNumber: newNum });
  const tracked = withBatchTracking(broadcast, 'subscription');
  runPlanTest(String(planId), state, tracked).then(() => {
    saveCurrentRun(\`Test #\${newNum} — Plan \${planId}\`);
    tracked('log', { msg: \`💾 Test #\${newNum} complete and saved\` });
  }).catch(err => {
    state.status = 'error';
    state.errorMessage = err.message;
    tracked('state', { state });
  });`],
  // A provider limits live tickets per subscription (maxConnections, counted for 24 h), so a
  // plan test must be able to stay on part of the roster: optional body.addresses, the same
  // filter /api/start --addresses uses. Absent = the whole roster, as in Cosmos.
  ['sub-plan test: optional roster subset',
    `  state.runGranter = String(granter);
  state.testRun = false;
  // Brand-new test → drop any prior batch handle. Resume reuses; start does not.`,
    `  state.runGranter = String(granter);
  state.testRun = false;
  state.planAddresses = Array.isArray(req.body?.addresses) && req.body.addresses.length ? req.body.addresses.map(String) : null;
  // Brand-new test → drop any prior batch handle. Resume reuses; start does not.`],
  // Clear wipes the DISPLAYED rows only. saveResults(state) also writes into state.activeRunDir,
  // which still points at the last run after a stop, so clear replaced that SAVED run's
  // results.json with [] (cli-e2e Z2 caught run #14 on the GCP VM, 2026-10-21: a loop stopped
  // right after a pass was saved, then clear). Cosmos has the same code.
  ['clear never writes into a saved run dir',
    `  state.status = 'idle';
  saveResults(state);`,
    `  state.status = 'idle';
  saveResults({ activeRunDir: null });`],
  // saveResults() also writes into state.activeRunDir. Loading a run before this pointed
  // there kept the PREVIOUS run's dir, so the loaded rows overwrote that run's results.json
  // (run-load 85 overwrote TEST RUN #88, 2026-10-20). Cosmos has the same code.
  ['loading a run writes only into its own dir',
    `  results.length = 0;
  results.push(...data);
  saveResults(state);
  rehydrateState(data);`,
    `  results.length = 0;
  results.push(...data);
  state.activeRunDir = path.join(RUNS_DIR, \`test-\${String(num).padStart(3, '0')}\`);
  saveResults(state);
  rehydrateState(data);`],
  // A saved run's failures.jsonl was the whole global log (every run's failures) copied in.
  ['per-run failures: helper',
    `function saveRunsIndex(index) {`,
    `// A run's failures.jsonl holds only that run's failures: lines for its own nodes, stamped
// inside its own span. The global results/failures.jsonl keeps every run's lines.
function writeRunFailures(runDir, rows) {
  const failLog = path.join(__dirname, 'results', 'failures.jsonl');
  if (!_ex(failLog)) return;
  const nodes = new Set(rows.map(r => r.address));
  const times = rows.map(r => Date.parse(r.timestamp || '')).filter(Number.isFinite);
  const from = times.length ? Math.min(...times) - 15 * 60_000 : -Infinity;
  const to = times.length ? Math.max(...times) + 60_000 : Infinity;
  const keep = _rfs(failLog, 'utf8').split('\\n').filter((l) => {
    if (!l) return false;
    try {
      const j = JSON.parse(l);
      const t = Date.parse(j.ts || '');
      return nodes.has(j.node) && (!Number.isFinite(t) || (t >= from && t <= to));
    } catch (e) {
      console.error('[runs] unparseable failures.jsonl line skipped:', e.message);
      return false;
    }
  });
  _wfs(path.join(runDir, 'failures.jsonl'), keep.length ? keep.join('\\n') + '\\n' : '', 'utf8');
}

function saveRunsIndex(index) {`],
  ['per-run failures: save',
    `  const failLog = path.join(__dirname, 'results', 'failures.jsonl');
  if (_ex(failLog)) _cp(failLog, path.join(runDir, 'failures.jsonl'));`,
    `  writeRunFailures(runDir, results);`],
  ['per-run failures: persist',
    `  const failLog = path.join(__dirname, 'results', 'failures.jsonl');
  if (_ex(failLog)) { try { _cp(failLog, path.join(runDir, 'failures.jsonl')); } catch (e) { console.error('[persistActiveRun] failures copy failed:', e.message); } }`,
    `  try { writeRunFailures(runDir, results); } catch (e) { console.error('[persistActiveRun] failures write failed:', e.message); }`],
  ['per-run failures: fresh run',
    `    try { _cp(path.join(__dirname, 'results', 'failures.jsonl'), path.join(runDir, 'failures.jsonl')); } catch { }`,
    `    try { writeRunFailures(runDir, prevResults); } catch (e) { console.error('[runs] failures write failed:', e.message); }`],
  // A corrupt index came back EMPTY, and the next save wrote that empty list over it: every
  // saved run vanished from the list. Keep the bad file and rebuild from the run folders.
  ['runs index: corrupt file is kept and rebuilt, never emptied',
    `    console.error(\`[loadRunsIndex] corrupt or unreadable \${RUNS_INDEX}: \${err.message}\`);
    return { runs: [], activeRun: null };
  }
}`,
    `    console.error(\`[loadRunsIndex] corrupt or unreadable \${RUNS_INDEX}: \${err.message} — rebuilding from run folders\`);
    return rebuildRunsIndex();
  }
}

function rebuildRunsIndex() {
  const keep = \`\${RUNS_INDEX}.corrupt-\${Date.now()}\`;
  try { _cp(RUNS_INDEX, keep); } catch (e) { console.error('[runs] could not keep the corrupt index:', e.message); }
  const runs = [];
  for (const name of _rd(RUNS_DIR)) {
    const m = /^test-(\\d+)$/.exec(name);
    if (!m) continue;
    const file = path.join(RUNS_DIR, name, 'results.json');
    if (!_ex(file)) continue;
    try {
      const rows = JSON.parse(_rfs(file, 'utf8'));
      const passed = rows.filter(r => r.actualMbps != null);
      runs.push({
        number: Number(m[1]), label: \`Test #\${Number(m[1])} (recovered)\`, date: _statSync(file).mtime.toISOString(),
        total: rows.length, passed: passed.length, failed: rows.length - passed.length,
        pass10: passed.filter(r => r.actualMbps >= 10).length, recovered: true,
      });
    } catch (e) { console.error(\`[runs] \${name}/results.json unreadable, left out of the rebuilt index: \${e.message}\`); }
  }
  runs.sort((a, b) => a.number - b.number);
  const index = { runs, activeRun: null };
  saveRunsIndex(index);
  console.error(\`[runs] index rebuilt from \${runs.length} run folder(s); the corrupt file is kept as \${path.basename(keep)}\`);
  return index;
}`],
  // Run numbers were max(saved)+1: deleting the newest runs handed their numbers (and
  // folders) out again, and the in-flight run's reserved number was not counted. A
  // high-water mark makes numbers unique for good. The write is atomic (tmp + rename).
  ['runs index: atomic write + high-water mark',
    `function saveRunsIndex(index) {
  _wfs(RUNS_INDEX, JSON.stringify(index, null, 2), 'utf8');
}

function getNextRunNumber() {
  const index = loadRunsIndex();
  const nums = index.runs.map(r => r.number).filter(Number.isFinite);
  return (nums.length > 0 ? Math.max(...nums) : 0) + 1;
}`,
    `function saveRunsIndex(index) {
  const nums = index.runs.map(r => r.number).filter(Number.isFinite);
  if (Number.isFinite(index.activeRun)) nums.push(index.activeRun);
  index.highWater = Math.max(Number(index.highWater) || 0, 0, ...nums);
  const data = JSON.stringify(index, null, 2);
  const tmp = RUNS_INDEX + '.tmp';
  _wfs(tmp, data, 'utf8');
  try { _rfs2(tmp, RUNS_INDEX); } catch (e) {
    console.error('[runs] index rename failed, writing in place:', e.message);
    _wfs(RUNS_INDEX, data, 'utf8');
  }
}

function getNextRunNumber() {
  const index = loadRunsIndex();
  const nums = index.runs.map(r => r.number).filter(Number.isFinite);
  if (Number.isFinite(index.activeRun)) nums.push(index.activeRun);
  return Math.max(Number(index.highWater) || 0, 0, ...nums) + 1;
}`],
  ['runs index: a deleted number stays used',
    `  if (i === -1 && state.activeRunNumber !== num) return false;
  if (i !== -1) index.runs.splice(i, 1);`,
    `  if (i === -1 && state.activeRunNumber !== num) return false;
  index.highWater = Math.max(Number(index.highWater) || 0, num);
  if (i !== -1) index.runs.splice(i, 1);`],
  ['atomic JSON write helper',
    `function writeRunFailures(runDir, rows) {`,
    `// JSON stores are written tmp + rename: a crash mid-write must never leave half a file.
function _writeAtomic(file, data) {
  const tmp = file + '.tmp';
  _wfs(tmp, data, 'utf8');
  try { _rfs2(tmp, file); } catch (e) {
    console.error(\`[store] rename of \${path.basename(file)} failed, writing in place:\`, e.message);
    _wfs(file, data, 'utf8');
  }
}

function writeRunFailures(runDir, rows) {`],
  ['listen banner names the Solana tester',
    'console.log(`\\nSentinel Node Audit Dashboard → http://',
    'console.log(`\\nSentinel Node Audit Dashboard (Solana) → http://'],
];

let failed = 0;
for (const [name, from, to] of EDITS) {
  const n = src.split(from).length - 1;
  if (n !== 1) { console.error(`✗ ${name}: expected 1 match, found ${n}`); failed++; continue; }
  src = src.replace(from, to);
  log(`✓ ${name}`);
}
const mn = src.split(`'MNEMONIC not set in .env'`).length - 1;
src = src.split(`'MNEMONIC not set in .env'`).join(`'TEST_KEYFILE not set in .env'`);
log(`✓ ${mn} start/resume/retest guards reworded`);
// Token amounts: the Cosmos token is P2P; on Solana it is tDVPN (devnet) / DVPN.
// "P2P" as a MODE name (pay each node directly) stays — only amounts change.
for (const [name, from, to, want] of [
  ['balance / spend amounts', 'toFixed(4)} P2P`', 'toFixed(4)} ${TOKEN_LABEL}`', 4],
  ['zero spend', `'0 P2P'`, '`0 ${TOKEN_LABEL}`', 5],
  ['insufficient-funds reason', `'Need more P2P'`, '`Need more ${TOKEN_LABEL}`', 1],
]) {
  const n = src.split(from).length - 1;
  if (n !== want) { console.error(`✗ ${name}: expected ${want} matches, found ${n}`); failed++; continue; }
  src = src.split(from).join(to);
  log(`✓ ${n} ${name} → token label`);
}
// Saved runs and the state snapshot go through _writeAtomic (counted: each must still match).
for (const [name, from, to, want] of [
  ['saved run results.json', `_wfs(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2), 'utf8');`, `_writeAtomic(path.join(runDir, 'results.json'), JSON.stringify(results, null, 2));`, 2],
  ['auto-saved run results.json', `_wfs(path.join(runDir, 'results.json'), JSON.stringify(prevResults, null, 2), 'utf8');`, `_writeAtomic(path.join(runDir, 'results.json'), JSON.stringify(prevResults, null, 2));`, 1],
  ['state snapshot', `    _wfs(STATE_SNAPSHOT_FILE, JSON.stringify({`, `    _writeAtomic(STATE_SNAPSHOT_FILE, JSON.stringify({`, 1],
]) {
  const n = src.split(from).length - 1;
  if (n !== want) { console.error(`✗ atomic write — ${name}: expected ${want} matches, found ${n}`); failed++; continue; }
  src = src.split(from).join(to);
  log(`✓ ${n} ${name} write(s) atomic`);
}
if (/@cosmjs|DirectSecp256k1HdWallet|connectWithRpcFailover/.test(src)) { console.error('✗ Cosmos wallet code still present'); failed++; }
if (failed) process.exit(1);
if (CHECK) {
  const cur = readFileSync(FILE, 'utf8');
  if (cur === src) { console.log('✓ server.js = Cosmos HEAD server.js + patch-server edits'); process.exit(0); }
  const a = cur.split('\n'); const b = src.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  console.error(`✗ server.js drifted from the build at line ${i + 1}: ${String(a[i]).trim().slice(0, 120)}`);
  process.exit(1);
}
writeFileSync(FILE, src);
console.log('server.js patched');
