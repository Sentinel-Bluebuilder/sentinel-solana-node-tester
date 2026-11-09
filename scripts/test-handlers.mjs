#!/usr/bin/env node
// ─── Route sweep (no spend) ──────────────────────────────────────────────────
// The shared Cosmos server keeps state in fixed paths inside the project
// (results/, data/audit.db), so this suite boots an ISOLATED copy: the source
// is copied to a temp dir, node_modules is linked, and the copy runs on a free
// port with an ADMIN_TOKEN. Checks:
//   * the pages stay identical to the Cosmos tester's (only explorer links + the
//     dvpnd SDK label may differ) — guards the "identical UI" requirement
//   * public pages never call an admin/action endpoint
//   * admin gate: 401 without token, 403 without X-Admin-Request, login cookie
//   * Broadcast Live gates every public live surface
//   * PUBLIC_MODE refuses to start without ADMIN_TOKEN
//   * a TEST RUN through /api/start writes nothing on chain
// Reads devnet (discovery + probe) but never spends.
import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, cpSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { buildPages, PAGES, readCosmos } from './dev/patch-pages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COSMOS = process.env.COSMOS_TESTER_DIR || join(ROOT, '..', 'sentinel-node-tester');
const TOKEN = `handler-test-${Date.now()}`;
const RIG = '6AaXvhWpFDMf8FimxSb2Tb3bKcgPmbZxj4Tdtb31nP8F';

let pass = 0; let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
}
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, what) => { if (!c) throw new Error(what || 'assertion failed'); };
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// ─── isolated copy ───
const work = mkdtempSync(join(tmpdir(), 'snt-routes-'));
const SKIP = new Set(['node_modules', 'results', 'data', '.git', 'test', 'memory', 'docs']);
cpSync(ROOT, work, { recursive: true, filter: (src) => !SKIP.has(basename(src)) || dirname(src) !== ROOT });
symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'junction');

function boot(env) {
  return new Promise(async (resolve) => {
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: work,
      env: { ...process.env, PORT: String(port), LISTEN_HOST: '127.0.0.1', ALLOW_PUBLIC_TEST: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('exit', (code) => resolve({ child, port, exited: true, code, log: () => log }));
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`${base}/health`); if (r.ok) return resolve({ child, port, base, log: () => log }); } catch (err) { /* booting */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    resolve({ child, port, base, log: () => log, timedOut: true });
  });
}

let srv;
async function req(method, path, { auth = false, csrf = true, headers = {}, body } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (auth) h.Authorization = `Bearer ${TOKEN}`;
  if (method !== 'GET' && csrf) h['X-Admin-Request'] = '1';
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(srv.base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

try {
  console.log('pages are the Cosmos pages');
  await t('pages = the Cosmos pages + exactly the edits in scripts/dev/page-edits.txt', () => {
    if (!existsSync(COSMOS)) throw new Error(`Cosmos tester not found at ${COSMOS} (set COSMOS_TESTER_DIR)`);
    const { pages } = buildPages(COSMOS, readFileSync(join(ROOT, 'scripts', 'dev', 'page-edits.txt'), 'utf8'));
    for (const f of PAGES) {
      const mine = readFileSync(join(ROOT, f), 'utf8');
      if (mine === pages[f]) continue;
      const a = mine.split('\n'); const b = pages[f].split('\n');
      const i = a.findIndex((l, k) => l !== b[k]);
      throw new Error(`${f} differs from Cosmos + page-edits at line ${i + 1}: ${String(a[i]).trim().slice(0, 120)}`);
    }
  });
  await t('server.js = the committed Cosmos server.js + exactly the edits in scripts/dev/patch-server.mjs', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'dev', 'patch-server.mjs'), '--check'], { encoding: 'utf8' });
    ok(r.status === 0, (r.stderr || r.stdout).trim());
  });
  await t('kept Cosmos modules = committed Cosmos copies (+ only the documented Solana edits)', () => {
    const lf = (s) => s.replace(/\r/g, '');
    for (const f of ['core/db.js', 'core/auth.js', 'core/rate-limit.js', 'core/types.js']) {
      ok(lf(readFileSync(join(ROOT, f), 'utf8')) === lf(readCosmos(COSMOS, f)), `${f} drifted from the Cosmos tester`);
    }
    // settings.js: strip the Solana comment and restore the Cosmos default, then it must match.
    let s = lf(readFileSync(join(ROOT, 'core/settings.js'), 'utf8')).replace(/^\s*\/\/ Solana: on by default.*\n/m, '').replace('autoCancelAfterTest: true,', 'autoCancelAfterTest: false,');
    ok(s === lf(readCosmos(COSMOS, 'core/settings.js')), 'core/settings.js differs from Cosmos beyond the autoCancelAfterTest default');
    let c = lf(readFileSync(join(ROOT, 'audit/continuous.js'), 'utf8'))
      .replace(/  \/\/ Solana: the tester wallet is the TEST_KEYFILE key file \(read live from env so\n  \/\/ tests can override it\)\. Cosmos read process\.env\.MNEMONIC here\.\n  const keyfile = process\.env\.TEST_KEYFILE;\n  if \(!keyfile \|\| !keyfile\.trim\(\)\) \{/, '  // Read live from env so tests can override process.env.MNEMONIC.\n  const mnemonic = process.env.MNEMONIC;\n  if (!mnemonic || !mnemonic.trim()) {')
      .replace(`'TEST_KEYFILE not set in .env — cannot pay sessions'`, `'MNEMONIC not set in .env — cannot sign session TXs'`)
      .replace(`_ctrl.activeSDK          = 'dvpnd'; // Solana: one client (dvpnd)`, `_ctrl.activeSDK          = opts.activeSDK || _ctrl.activeSDK || 'js';`)
      .replace("'subscriptionGranter (Provider PDA of the plan) required for subscription mode'", "'subscriptionGranter (sent1... plan owner address) required for subscription mode'")
      .replace("`Provider ${granterAddr} is not listed or its signed metadata does not verify (tester ${granteeAddr}). ` +\n      'Subscription mode needs a live provider to issue access tickets.',", "`No active fee-grant from ${granterAddr} to ${granteeAddr}. ` +\n      'The plan owner must grant a fee allowance before subscription mode can run.',")
      .replace("`Provider check failed: ${fgErr.message}`", "`Fee-grant check failed: ${fgErr.message}`");
    ok(c === lf(readCosmos(COSMOS, 'audit/continuous.js')), 'audit/continuous.js differs from Cosmos beyond the key-file check, the dvpnd client and the provider-check wording');
  });
  await t('pages carry no Cosmos-only wording (P2P amounts, udvpn, LCD, fee grant, mnemonic, Sentinel chain)', () => {
    const banned = [/\d P2P\b|out of P2P|need [\d.]+ P2P/, /udvpn/, /\bLCD\b/, /fee.?grant(?!Active)/i, /\bmnemonic\b/i, /Sentinel chain/, /p2pscan|explorer\.sentinel\.co/, /BLUE JS|TKD JS/, /Sentinel blockchain/, /under development/];
    for (const f of PAGES) {
      // The live-view demo seed and internal identifiers (maxPriceUdvpn, feeGrantActive,
      // sentnode demo addresses) are code, not wording — check visible text patterns only.
      const lines = readFileSync(join(ROOT, f), 'utf8').split('\n');
      lines.forEach((l, i) => {
        const text = l.replace(/maxPriceUdvpn|feeGrantActive|_selectedGranter|selfGranter|err\.includes\('mnemonic'\)/g, '');
        for (const re of banned) ok(!re.test(text) || /^\s*\/\//.test(l), `${f}:${i + 1} still says ${re}: ${l.trim().slice(0, 100)}`);
      });
    }
  });
  await t('the dashboard CLI guide names every CLI command, and no command that does not exist', () => {
    const cmds = [...readFileSync(join(ROOT, 'cli.js'), 'utf8').matchAll(/^def\('([a-z-]+)'/gm)].map((m) => m[1]);
    const html = readFileSync(join(ROOT, 'admin.html'), 'utf8');
    const end = html.indexOf('id="cli-troubleshoot"');
    ok(end > 0, 'CLI guide not found');
    const guide = html.slice(html.indexOf('id="cli-install"'), html.indexOf('</div>', end + 3000)).replace(/<[^>]+>/g, ' ');
    const missing = cmds.filter((c) => !new RegExp(`(^|[^a-z-])${c}([^a-z-]|$)`).test(guide));
    ok(!missing.length, `not in the guide: ${missing.join(' ')}`);
    const bogus = [...guide.matchAll(/node cli\.js ([a-z][a-z-]*)/g)].map((m) => m[1]).filter((c) => !cmds.includes(c) && c !== 'help');
    ok(!bogus.length, `guide names missing commands: ${bogus.join(' ')}`);
  });
  await t('public pages never call an action endpoint', () => {
    for (const f of ['public.html', 'live.html', 'node.html']) {
      const html = readFileSync(join(ROOT, f), 'utf8');
      ok(!/['"`]\/api\/(start|stop|resume|retest|clear|auto-retest|runs\/save|runs\/load|sdk['"`]|dns|test-plan|test-sub-plan|solana\/channels\/sweep)/.test(html), `${f} references an action endpoint`);
    }
  });

  console.log('boot guards');
  await t('PUBLIC_MODE=true without ADMIN_TOKEN refuses to start', async () => {
    const r = await boot({ PUBLIC_MODE: 'true', ADMIN_TOKEN: '' });
    if (!r.exited) { r.child.kill(); throw new Error('server started'); }
    ok(r.code !== 0 && /ADMIN_TOKEN/.test(r.log()), `exit ${r.code}`);
  });
  await t('a non-loopback LISTEN_HOST without ADMIN_TOKEN refuses to start', async () => {
    const r = await boot({ LISTEN_HOST: '0.0.0.0', ADMIN_TOKEN: '' });
    if (!r.exited) { r.child.kill(); throw new Error('server started'); }
    ok(r.code !== 0, `exit ${r.code}`);
  });

  srv = await boot({ ADMIN_TOKEN: TOKEN, PUBLIC_MODE: 'false' });
  if (srv.timedOut || srv.exited) throw new Error(`server did not start:\n${srv.log()}`);

  console.log('admin gate');
  await t('admin API: 401 without token, 200 with Bearer', async () => {
    for (const p of ['/api/stats', '/api/state', '/api/runs', '/api/solana/doctor', '/api/solana/channels', '/api/events']) eq((await req('GET', p)).status, 401, p);
    eq((await req('GET', '/api/stats', { auth: true })).status, 200, 'bearer');
  });
  await t('EVERY adminOnly route refuses no token and a wrong token (read from the source)', async () => {
    const routes = [];
    for (const [file, re] of [['server.js', /\bapp\.(get|post|put|delete)\(\s*'([^']+)'\s*,\s*adminOnly\b/g], ['routes/solana.js', /\br\.(get|post|put|delete)\(\s*'([^']+)'\s*,\s*adminOnly\b/g]]) {
      for (const m of readFileSync(join(ROOT, file), 'utf8').matchAll(re)) routes.push([m[1].toUpperCase(), m[2].replace(/:[a-zA-Z]+/g, RIG)]);
    }
    ok(routes.length >= 40, `only ${routes.length} adminOnly routes found — the source pattern changed`);
    const open = [];
    for (const [method, path] of routes) {
      const body = method === 'GET' ? undefined : {};
      const none = await req(method, path, { body });
      const wrong = await req(method, path, { body, headers: { Authorization: 'Bearer wrong-token' } });
      if (none.status !== 401 || wrong.status !== 401) open.push(`${method} ${path} → ${none.status}/${wrong.status}`);
    }
    ok(!open.length, `routes not refused:\n    ${open.join('\n    ')}`);
    console.log(`    (${routes.length} admin routes checked)`);
  });
  await t('the only unauthenticated writes are login/logout and the ALLOW_PUBLIC_TEST-gated public loop', async () => {
    const src = readFileSync(join(ROOT, 'server.js'), 'utf8') + readFileSync(join(ROOT, 'routes', 'solana.js'), 'utf8');
    const writes = [...src.matchAll(/\b(?:app|r)\.(post|put|delete)\(\s*((?:ADMIN_PATH\s*\+\s*)?'[^']+')\s*,\s*(\S+)/g)]
      .filter((m) => !m[3].startsWith('adminOnly')).map((m) => m[2].replace(/ADMIN_PATH\s*\+\s*/, '/admin').replace(/'/g, ''));
    eq(writes.sort().join(' '), ['/admin/login', '/admin/logout', '/api/public/test/start', '/api/public/test/stop'].sort().join(' '), 'open writes');
    eq((await req('POST', '/api/public/test/start', { body: {} })).status, 403, 'public start without ALLOW_PUBLIC_TEST');
    eq((await req('POST', '/api/public/test/stop', { body: {} })).status, 403, 'public stop without ALLOW_PUBLIC_TEST');
  });
  await t('writes need X-Admin-Request even with a valid token', async () => {
    eq((await req('POST', '/api/stop', { auth: true, csrf: false, body: {} })).status, 403);
    eq((await req('POST', '/api/solana/channels/sweep', { auth: true, csrf: false, body: { dryRun: true } })).status, 403);
  });
  await t('/admin → login; form login sets a session cookie that opens /admin and the API', async () => {
    const r = await req('GET', '/admin');
    ok(r.status === 302 || r.status === 401, `status ${r.status}`);
    const bad = await fetch(`${srv.base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=wrong', redirect: 'manual' });
    ok(bad.status >= 300, `wrong token status ${bad.status}`);
    ok(!String(bad.headers.get('set-cookie') || '').includes('admin_session=s'), 'no session for a wrong token');
    const good = await fetch(`${srv.base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}`, redirect: 'manual' });
    const cookie = String(good.headers.get('set-cookie') || '').split(';')[0];
    ok(cookie.startsWith('admin_session='), `cookie ${cookie}`);
    eq((await req('GET', '/admin', { headers: { Cookie: cookie } })).status, 200, '/admin with cookie');
    eq((await req('GET', '/api/stats', { headers: { Cookie: cookie } })).status, 200, 'API with cookie');
  });

  console.log('public surfaces');
  await t('pages and public reads answer', async () => {
    for (const p of ['/live', `/node/${RIG}`, '/health', '/api/broadcast', '/api/public/stats', '/api/public/test/status', '/api/public/sdk-info', '/api/public/nodes', '/api/public/countries', '/api/public/runs', '/api/public/batches', '/api/public/errors', '/api/settings', '/api/solana/info', `/api/public/node/${RIG}/errors`, `/api/public/node/${RIG}/bandwidth`]) {
      eq((await req('GET', p)).status, 200, p);
    }
  });
  await t('sdk-info names the dvpnd client', async () => {
    eq((await req('GET', '/api/public/sdk-info')).json.name, 'dvpnd');
  });
  await t('Broadcast Live off: public logs and live-state are empty', async () => {
    eq((await req('GET', '/api/broadcast')).json.broadcastLive, false);
    eq((await req('GET', '/api/public/logs')).json.logs.length, 0);
    eq((await req('GET', '/api/public/live-state')).json.broadcastLive, false);
  });
  await t('public SSE opens with an init frame and no wallet internals', async () => {
    const ctl = new AbortController();
    const res = await fetch(`${srv.base}/api/public/events`, { signal: ctl.signal });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = Buffer.from(value).toString();
    ctl.abort();
    ok(text.includes('"type":"init"'), 'init frame');
    ok(!/balanceUdvpn|walletAddress|runGranter/.test(text), 'wallet internals leaked');
  });
  await t('broadcast toggle (admin) turns the live surfaces on and back off', async () => {
    eq((await req('POST', '/api/broadcast', { auth: true, body: {} })).json.broadcastLive, true);
    eq((await req('GET', '/api/public/live-state')).json.broadcastLive, true);
    eq((await req('POST', '/api/broadcast', { auth: true, body: {} })).json.broadcastLive, false);
  });

  console.log('TEST RUN through the admin API');
  await t('start {testRun:true} runs discovery + probe only and writes nothing on chain', async () => {
    // Record the public stream with Broadcast Live on: the run's log must never name the wallet.
    const wallet = (await req('GET', '/api/solana/info')).json.tester;
    eq((await req('POST', '/api/broadcast', { auth: true, body: {} })).json.broadcastLive, true);
    const ctl = new AbortController();
    let publicText = '';
    const pub = fetch(`${srv.base}/api/public/events`, { signal: ctl.signal })
      .then(async (res) => { for await (const c of res.body) publicText += Buffer.from(c).toString(); })
      .catch((err) => { if (err.name !== 'AbortError') throw err; });
    const s = await req('POST', '/api/start', { auth: true, body: { testRun: true } });
    eq(s.status, 200); eq(s.json.testRun, true);
    let st;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      st = (await req('GET', '/api/stats', { auth: true })).json.state;
      if (!['running', 'paused', 'paused_balance', 'paused_internet'].includes(st.status)) break;
    }
    eq(st.status, 'done', 'status');
    eq(Number(st.runSpentUdvpn), 0, 'spend');
    const results = (await req('GET', '/api/state', { auth: true })).json.results;
    ok(results.every((r) => r.errorCode === 'TEST_RUN_SKIP'), JSON.stringify(results.map((r) => r.errorCode)));
    eq((await req('GET', '/api/solana/channels', { auth: true })).json.tracked.length, 0, 'channels');
    eq((await req('GET', '/api/solana/reports', { auth: true })).json.reports.length, 0, 'reports');
    ctl.abort();
    await pub;
    eq((await req('POST', '/api/broadcast', { auth: true, body: {} })).json.broadcastLive, false);
    ok(publicText.includes('"type":"log"'), 'the public stream carried the run log');
    if (wallet) ok(!publicText.includes(wallet), 'the public /live stream named the tester wallet');
  });
  await t('a second start while running is refused', async () => {
    await req('POST', '/api/start', { auth: true, body: { testRun: true } });
    const again = await req('POST', '/api/start', { auth: true, body: { testRun: true } });
    eq(again.json.error, 'Already running');
    await req('POST', '/api/stop', { auth: true, body: {} });
  });
} finally {
  if (srv?.child) srv.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  try { rmSync(work, { recursive: true, force: true }); } catch (err) { console.warn(`temp dir cleanup failed: ${err.message}`); }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail && srv?.log) console.log(`--- server log ---\n${srv.log().slice(-3000)}`);
process.exit(fail ? 1 : 0);
