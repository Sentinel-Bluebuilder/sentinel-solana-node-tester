#!/usr/bin/env node
// ─── Data stores under abuse (isolated copy, no chain, no spend) ───
// Seeds saved runs into a throwaway copy of the tester, boots it, and breaks things the
// way real use did on 2026-10-20: a corrupt runs index, deleting the newest runs, loading
// an old run while another is active, a server killed mid-boot. After each case the
// stores must still be consistent (scripts/data-check.mjs, 0 problems).
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = `breaks-${Date.now()}`;
let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
}
const ok = (c, what) => { if (!c) throw new Error(what || 'assertion failed'); };
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// ─── isolated copy without results/data/.env ───
const work = mkdtempSync(join(tmpdir(), 'snt-breaks-'));
const SKIP = new Set(['node_modules', 'results', 'data', '.git', 'test', 'memory', 'docs', '.env']);
cpSync(ROOT, work, { recursive: true, filter: (src) => !SKIP.has(basename(src)) || dirname(src) !== ROOT });
symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'junction');
const RUNS = join(work, 'results', 'runs');
const runFile = (n) => join(RUNS, `test-${String(n).padStart(3, '0')}`, 'results.json');

function seed(numbers, { corruptIndex = false, activeRun = null } = {}) {
  rmSync(join(work, 'results'), { recursive: true, force: true });
  mkdirSync(RUNS, { recursive: true });
  const t0 = Date.parse('2026-10-20T10:00:00Z');
  const runs = numbers.map((n) => {
    const rows = [{ address: `NODE${n}`.padEnd(32, 'x'), type: 'WireGuard', actualMbps: 10 + n, errorCode: null, timestamp: new Date(t0 + n * 60_000).toISOString() }];
    mkdirSync(dirname(runFile(n)), { recursive: true });
    writeFileSync(runFile(n), JSON.stringify(rows, null, 2));
    return { number: n, label: `Test #${n}`, date: new Date(t0 + n * 60_000 + 5_000).toISOString(), total: 1, passed: 1, failed: 0, pass10: 1 };
  });
  writeFileSync(join(RUNS, 'index.json'), corruptIndex ? '{"runs": [ {"number": 1, "lab' : JSON.stringify({ runs, activeRun: activeRun ?? numbers[numbers.length - 1] }, null, 2));
}

function boot() {
  return new Promise(async (resolve) => {
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: work,
      env: { ...process.env, PORT: String(port), LISTEN_HOST: '127.0.0.1', ADMIN_TOKEN: TOKEN, PUBLIC_MODE: 'false', ALLOW_PUBLIC_TEST: '', TEST_KEYFILE: '', SOLANA_RPC_URLS: 'http://127.0.0.1:9' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`${base}/health`); if (r.ok) return resolve({ child, base, log: () => log }); } catch (err) { /* booting */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    resolve({ child, base, log: () => log, timedOut: true });
  });
}
async function stop(srv, signal = 'SIGTERM') {
  if (!srv?.child || srv.child.exitCode != null) return;
  const done = new Promise((r) => srv.child.once('exit', r));
  srv.child.kill(signal);
  await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
}
async function api(srv, method, path, body) {
  const res = await fetch(srv.base + path, {
    method,
    headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}`, 'X-Admin-Request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch (err) { return { status: res.status, json: null, text }; }
}
function dataCheck() {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'data-check.mjs'), '--root', work, '--json'], { encoding: 'utf8' });
  return JSON.parse(r.stdout);
}
const index = () => JSON.parse(readFileSync(join(RUNS, 'index.json'), 'utf8'));

let srv = null;
try {
  console.log('runs index');
  await t('a corrupt index is kept aside and rebuilt from the run folders, never emptied', async () => {
    seed([1, 2, 3], { corruptIndex: true });
    srv = await boot();
    ok(!srv.timedOut, `server did not boot: ${srv.log().slice(-300)}`);
    const runs = (await api(srv, 'GET', '/api/runs')).json?.runs || [];
    ok(runs.map((r) => r.number).join() === '1,2,3', `runs listed: ${JSON.stringify(runs.map((r) => r.number))}`);
    ok(readdirSync(RUNS).some((f) => f.startsWith('index.json.corrupt-')), 'corrupt index not kept');
    ok(Array.isArray(index().runs) && index().runs.length === 3, 'index.json not rebuilt');
    await stop(srv);
  });

  await t('deleting the newest runs never hands their numbers out again', async () => {
    seed([1, 2, 3]);
    srv = await boot();
    ok((await api(srv, 'DELETE', '/api/runs/3')).status === 200, 'delete #3 refused');
    ok((await api(srv, 'DELETE', '/api/runs/2')).status === 200, 'delete #2 refused');
    const saved = await api(srv, 'POST', '/api/runs/load/1');
    ok(saved.status === 200, `load #1: ${saved.status}`);
    ok(index().highWater >= 3, `highWater ${index().highWater}`);
    const cur = (await api(srv, 'GET', '/api/runs/current')).json;
    const next = cur?.nextNumber ?? null;
    if (next != null) ok(next > 3, `next run number ${next} reuses a deleted one`);
    await stop(srv);
  });

  console.log('loading runs');
  await t('loading an old run leaves every other saved run byte-identical', async () => {
    seed([1, 2, 3]);
    srv = await boot();
    const before = [1, 2, 3].map((n) => readFileSync(runFile(n), 'utf8'));
    for (const n of [1, 3, 2, 1]) ok((await api(srv, 'POST', `/api/runs/load/${n}`)).status === 200, `load ${n}`);
    const after = [1, 2, 3].map((n) => readFileSync(runFile(n), 'utf8'));
    ok(before.every((b, i) => b === after[i]), `changed: ${[1, 2, 3].filter((n, i) => before[i] !== after[i]).join(',')}`);
    await stop(srv);
  });

  await t('clear empties the view but never a saved run (the run dir stays attached after load/stop)', async () => {
    seed([1, 2, 3]);
    srv = await boot();
    const before = [1, 2, 3].map((n) => readFileSync(runFile(n), 'utf8'));
    ok((await api(srv, 'POST', '/api/runs/load/3')).status === 200, 'load 3');
    const cleared = await api(srv, 'POST', '/api/clear');
    ok(cleared.status === 200, `clear: ${cleared.status}`);
    const after = [1, 2, 3].map((n) => readFileSync(runFile(n), 'utf8'));
    ok(before.every((b, i) => b === after[i]), `clear rewrote saved run(s): ${[1, 2, 3].filter((n, i) => before[i] !== after[i]).join(',')}`);
    await stop(srv);
    const dc = dataCheck();
    ok(dc.ok, JSON.stringify(dc.problems));
  });

  console.log('crashes');
  await t('a server killed right after boot leaves the stores consistent', async () => {
    seed([1, 2]);
    srv = await boot();
    await api(srv, 'POST', '/api/runs/load/1');
    await stop(srv, 'SIGKILL');
    srv = await boot();
    ok(!srv.timedOut, 'reboot after kill failed');
    const runs = (await api(srv, 'GET', '/api/runs')).json?.runs || [];
    ok(runs.length === 2, `runs after kill: ${runs.length}`);
    await stop(srv);
    const dc = dataCheck();
    ok(dc.ok, JSON.stringify(dc.problems));
  });

  await t('no .tmp files left behind by index writes', () => {
    ok(!readdirSync(RUNS).some((f) => f.endsWith('.tmp')), readdirSync(RUNS).join(','));
  });
} finally {
  await stop(srv);
  try { rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (err) { console.warn(`temp dir cleanup failed: ${err.message}`); }
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
