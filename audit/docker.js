// ─── Docker (client containers) ──────────────────────────────────────────────
// The paid session never runs on the host: a dVPN client captures the default
// route and installs a kill switch, which on this machine would sever the
// tester's own RPC and dashboard traffic (and on an admin box, SSH). Each test
// is one throwaway container from the Node Manager image — own network
// namespace, own tunnel, deleted on exit. Plain `docker` CLI via spawn; no
// dockerode, so the same code drives Docker Desktop and a Linux engine.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CLIENTS_DIR, DVPND_IMAGE } from '../lib/constants.js';

const CONTAINER_PREFIX = 'snt-client-';

/** Security/network flags every client container needs (verified by Node Manager on Docker Desktop + Ubuntu). */
export const CLIENT_RUN_FLAGS = [
  '--cap-add', 'NET_ADMIN', '--cap-add', 'NET_RAW',
  '--device', '/dev/net/tun:/dev/net/tun',
  '--security-opt', 'apparmor=unconfined',
  '--security-opt', 'systempaths=unconfined',
  '--sysctl', 'net.ipv4.conf.all.src_valid_mark=1',
  '--sysctl', 'net.ipv6.conf.all.disable_ipv6=0',
  // Lets a hairpin DNAT rewrite 127.0.0.1 (lab nodes that advertise loopback); inert otherwise.
  '--sysctl', 'net.ipv4.conf.all.route_localnet=1',
  '--add-host', 'host.docker.internal:host-gateway',
  '-e', 'WG_I_PREFER_BUGGY_USERSPACE_TO_POLISHED_KMOD=1',
  '-e', 'AWG_FORCE_USERSPACE=1',
];

function run(args, { timeoutMs = 30_000, onLine = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true });
    let out = '';
    let partial = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    const feed = (chunk) => {
      const text = chunk.toString('utf8');
      out += text;
      if (!onLine) return;
      partial += text;
      const lines = partial.split(/\r?\n/);
      partial = lines.pop();
      for (const l of lines) onLine(l);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`docker ${args[0]} failed to start: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (onLine && partial) onLine(partial);
      if (killed) return resolve({ exitCode: 124, output: out, timedOut: true });
      resolve({ exitCode: code ?? 1, output: out, timedOut: false });
    });
  });
}

/** Engine reachable? Returns { ok, version | error }. */
export async function dockerStatus() {
  try {
    const r = await run(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
    if (r.exitCode !== 0) return { ok: false, error: r.output.trim().split('\n').pop() || `docker version exited ${r.exitCode}` };
    return { ok: true, version: r.output.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function imagePresent(tag = DVPND_IMAGE) {
  const r = await run(['image', 'inspect', '--format', '{{.Id}}', tag], { timeoutMs: 15_000 });
  return r.exitCode === 0 ? { ok: true, id: r.output.trim() } : { ok: false, error: r.output.trim().split('\n').pop() };
}

export function containerName(id) {
  return `${CONTAINER_PREFIX}${String(id).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 24)}`;
}

/**
 * Run `script` with /bin/sh inside a fresh client container.
 *   hostDir  → mounted read-only at /mnt/snt (holds wallet.json and rpc.env for the run)
 *   env      → KEY=VALUE pairs passed with -e. They show in the host's `ps`: never a key
 *              or an RPC URL (those go in rpc.env, mode 600).
 *   ticketDir → optional, mounted read-write at /mnt/tix: the client daemon's store for a
 *              plan subscription, kept between sessions so a live ticket is reused.
 * Resolves { exitCode, output, timedOut }. On timeout the container is force-removed.
 */
export async function runClientContainer({ id, hostDir, ticketDir = null, env = [], script, timeoutMs = 360_000, onLine = null, image = DVPND_IMAGE }) {
  const name = containerName(id);
  const args = ['run', '--rm', '--name', name, ...CLIENT_RUN_FLAGS, '-v', `${hostDir}:/mnt/snt:ro`];
  if (ticketDir) args.push('-v', `${ticketDir}:/mnt/tix`);
  for (const e of env) args.push('-e', e);
  args.push('--entrypoint', '/bin/sh', image, '-c', script);
  const r = await run(args, { timeoutMs, onLine });
  if (r.timedOut) await removeContainers([name]).catch((err) => console.warn('[docker] rm after timeout failed:', err.message));
  return r;
}

// docker stop first (SIGTERM → the script's trap stops the daemon, which closes its RPC
// websocket), then rm -f. A bare rm -f vanishes the netns with the socket still open.
const STOP_GRACE_S = 3;
async function removeContainers(ids) {
  await run(['stop', '-t', String(STOP_GRACE_S), ...ids], { timeoutMs: (STOP_GRACE_S + 10) * 1000 })
    .catch((err) => console.warn('[docker] stop before rm failed:', err.message));
  return run(['rm', '-f', ...ids], { timeoutMs: 60_000 });
}

/** Remove containers left behind by a crashed run (names start with the prefix). Returns the count. */
export async function removeStaleClients() {
  const r = await run(['ps', '-aq', '--filter', `name=^${CONTAINER_PREFIX}`], { timeoutMs: 15_000 });
  if (r.exitCode !== 0) return 0;
  const ids = r.output.split(/\s+/).filter(Boolean);
  if (!ids.length) return 0;
  await removeContainers(ids);
  return ids.length;
}

/**
 * Remove client session dirs left behind by a crash. Each holds a copy of the tester's key
 * (wallet.json) for its run; a session removes its own dir in `finally`, which never runs
 * when the server is killed mid-session (a key copy sat in results/clients for 2 days).
 * Call only when no session is in flight (boot, run start). Returns the count removed.
 */
export function removeStaleClientDirs() {
  let names;
  try {
    names = readdirSync(CLIENTS_DIR);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[docker] cannot list ${CLIENTS_DIR}: ${err.message}`);
    return 0;
  }
  let n = 0;
  for (const name of names) {
    try {
      rmSync(join(CLIENTS_DIR, name), { recursive: true, force: true });
      n++;
    } catch (err) {
      console.warn(`[docker] cannot remove stale client dir ${name}: ${err.message}`);
    }
  }
  return n;
}

/**
 * Stop: kill every in-flight client container now (the operator pressed Stop).
 * The tunnel and kill switch live in the container's own network namespace and
 * vanish with it; the channel it opened is already tracked for the refund sweep.
 * Returns the number of containers removed.
 */
export async function stopClients() {
  return removeStaleClients();
}

/** Quick capability probe: can this engine run the client at all (tun device + nft)? */
export async function probeClientCapabilities(image = DVPND_IMAGE) {
  const script = [
    'set -u',
    // cb33092e names: daemon sentinel-dvpnd, CLI sentinel-dvpn (result keys keep the old names).
    'command -v sentinel-dvpnd >/dev/null && echo HAVE_DVPND || echo NO_DVPND',
    'command -v sentinel-dvpn >/dev/null && echo HAVE_DVPNCTL || echo NO_DVPNCTL',
    '[ -e /dev/net/tun ] && echo HAVE_TUN || echo NO_TUN',
    'nft list tables >/dev/null 2>&1 && echo HAVE_NFT || echo NO_NFT',
    'if nft -f - >/dev/null 2>&1 <<NFT',
    'add table ip6 snt_cap',
    'add chain ip6 snt_cap c { type filter hook prerouting priority -300; }',
    'add rule ip6 snt_cap c fib saddr type != local drop',
    'NFT',
    'then echo HAVE_FIB6; nft delete table ip6 snt_cap >/dev/null 2>&1; else echo NO_FIB6; fi',
    'sentinel-dvpnd version 2>/dev/null | head -3',
  ].join('\n');
  // The probe reads nothing from the host: mount an empty dir, never the project (it holds .env).
  mkdirSync(CLIENTS_DIR, { recursive: true });
  const emptyDir = mkdtempSync(join(CLIENTS_DIR, 'cap-'));
  let r;
  try {
    r = await runClientContainer({ id: 'cap-probe', hostDir: emptyDir, script, timeoutMs: 60_000, image });
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
  const has = (k) => new RegExp(`^HAVE_${k}$`, 'm').test(r.output);
  return {
    ok: r.exitCode === 0 && has('DVPND') && has('DVPNCTL') && has('TUN') && has('NFT'),
    dvpnd: has('DVPND'), dvpnctl: has('DVPNCTL'), tun: has('TUN'), nft: has('NFT'),
    /** AmneziaWG clients need nft fib for IPv6; Docker Desktop's kernel lacks it. */
    nftFibIpv6: has('FIB6'),
    output: r.output.trim().slice(-800),
  };
}
