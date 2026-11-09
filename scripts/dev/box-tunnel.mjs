#!/usr/bin/env node
// ─── box-tunnel ──────────────────────────────────────────────────────────────
// Reach the box test nodes (scripts/dev/box-test-nodes.sh) from the laptop when
// the cloud security group only passes SSH. One SSH connection carries:
//   - TCP: node API ports and the V2Ray/Xray tunnel ports  (ssh -L, same port)
//   - UDP: WireGuard / OpenVPN / Hysteria2 tunnel ports      (framed over TCP)
// UDP framing: the laptop listens on udp/<port>, wraps each datagram as
// [u16 length][bytes] on a TCP stream (one stream per client source), and this
// same script runs on the box in "server" mode to unwrap it and talk to the node
// on 127.0.0.1:<port>. Traffic arrives on the box over loopback, so the box
// firewall is not involved.
//
//   node scripts/dev/box-tunnel.mjs            run until Ctrl-C (laptop)
//   node scripts/dev/box-tunnel.mjs check      probe every forwarded port once
//
// The tester then needs NODE_URI_OVERRIDES=<pda>=host.docker.internal:<apiPort>,…
// so client containers send box traffic to the laptop, and the laptop-side probe
// uses 127.0.0.1:<apiPort>.
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { connect, createServer } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOST = process.env.BOX_HOST; if (!HOST) throw new Error('set BOX_HOST (ssh host)');
const REMOTE_SCRIPT = '/home/ubuntu/snt-test/box-tunnel.mjs';
const PID_FILE = '/home/ubuntu/snt-test/box-tunnel.pid';
const TCP_PORTS = [18611, 18613, 18614, 18615, 18616, 18623, 18624, 18626, 18627];
const UDP_PORTS = [18621, 18629, 18630];
const FRAME_OFFSET = 10000; // udp/18621 travels as tcp/28621
const IDLE_MS = 180_000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ─── Framing ───
function frame(buf) {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(buf.length, 0);
  return Buffer.concat([head, buf]);
}
function deframer(onPacket) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const len = pending.readUInt16BE(0);
      if (pending.length < 2 + len) break;
      onPacket(pending.subarray(2, 2 + len));
      pending = pending.subarray(2 + len);
    }
  };
}

// ─── Box side: tcp/<port+offset> → udp 127.0.0.1:<port> ───
function server(ports) {
  // A dropped SSH connection can leave the previous relay holding its ports: replace it.
  try {
    const old = Number(readFileSync(PID_FILE, 'utf8'));
    if (old && old !== process.pid) { process.kill(old, 'SIGTERM'); log(`stopped previous relay ${old}`); }
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ESRCH') log(`previous relay: ${err.message}`);
  }
  writeFileSync(PID_FILE, String(process.pid));
  for (const port of ports) {
    createServer((sock) => {
      const udp = createSocket('udp4');
      udp.connect(port, '127.0.0.1');
      udp.on('message', (m) => sock.write(frame(m)));
      udp.on('error', (err) => { log(`udp ${port} error: ${err.message}`); sock.destroy(); });
      sock.on('data', deframer((p) => udp.send(p)));
      sock.on('close', () => { try { udp.close(); } catch (err) { log(`udp ${port} close: ${err.message}`); } });
      sock.on('error', (err) => log(`tcp ${port + FRAME_OFFSET} error: ${err.message}`));
    }).on('error', (err) => { log(`tcp ${port + FRAME_OFFSET} listen: ${err.message}`); process.exit(1); })
      .listen(port + FRAME_OFFSET, '127.0.0.1', () => log(`server udp ${port} via tcp ${port + FRAME_OFFSET}`));
  }
  // The laptop keeps our stdin open; when SSH goes away, so do we.
  process.stdin.on('end', () => { log('ssh closed — exiting'); process.exit(0); });
  process.stdin.resume();
}

// ─── Laptop side: udp/<port> → tcp 127.0.0.1:<port+offset> (ssh -L) ───
function udpClient(port) {
  const udp = createSocket('udp4');
  const flows = new Map(); // "addr:port" → { sock, timer }
  udp.on('message', (msg, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`;
    let f = flows.get(key);
    if (!f) {
      const sock = connect(port + FRAME_OFFSET, '127.0.0.1');
      f = { sock, timer: null };
      flows.set(key, f);
      sock.on('data', deframer((p) => udp.send(p, rinfo.port, rinfo.address)));
      sock.on('close', () => flows.delete(key));
      sock.on('error', (err) => { log(`udp ${port} flow ${key}: ${err.message}`); flows.delete(key); });
      log(`udp ${port}: new flow from ${key}`);
    }
    clearTimeout(f.timer);
    f.timer = setTimeout(() => { f.sock.destroy(); flows.delete(key); }, IDLE_MS);
    f.sock.write(frame(msg));
  });
  udp.on('error', (err) => { log(`udp ${port} listen error: ${err.message}`); process.exitCode = 1; });
  udp.bind(port, '0.0.0.0', () => log(`laptop udp ${port} → tcp ${port + FRAME_OFFSET}`));
}

function laptop() {
  const self = readFileSync(fileURLToPath(import.meta.url));
  // Ship this script to the box first (same file runs both ends).
  const put = spawn('ssh', ['-o', 'BatchMode=yes', HOST, `umask 077; cat > ${REMOTE_SCRIPT}`], { stdio: ['pipe', 'inherit', 'inherit'] });
  put.stdin.end(self);
  put.on('close', (code) => {
    if (code !== 0) { log(`could not copy the script to ${HOST} (exit ${code})`); process.exit(1); }
    const fwd = [...TCP_PORTS, ...UDP_PORTS.map((p) => p + FRAME_OFFSET)].flatMap((p) => ['-L', `0.0.0.0:${p}:127.0.0.1:${p}`]);
    let ssh = null;
    let stopping = false;
    const connectSsh = () => {
      // A dropped connection can leave the previous relay holding its ports: replace it.
      ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', ...fwd,
        HOST, `exec node ${REMOTE_SCRIPT} server ${UDP_PORTS.join(' ')}`], { stdio: ['pipe', 'inherit', 'inherit'] });
      ssh.on('close', (c) => {
        if (stopping) return;
        log(`ssh exited (${c}) — reconnecting in 10 s`);
        setTimeout(connectSsh, 10_000);
      });
    };
    connectSsh();
    for (const p of UDP_PORTS) udpClient(p);
    log(`tunnel up: tcp ${TCP_PORTS.join(',')} · udp ${UDP_PORTS.join(',')}`);
    process.on('SIGINT', () => { stopping = true; ssh.kill(); process.exit(0); });
  });
}

const mode = process.argv[2] || 'laptop';
if (mode === 'server') server(process.argv.slice(3).map(Number));
else if (mode === 'laptop') laptop();
else { console.log('usage: node scripts/dev/box-tunnel.mjs [laptop|server <udp ports…>]'); process.exitCode = 2; }
