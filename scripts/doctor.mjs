#!/usr/bin/env node
// ─── doctor ──────────────────────────────────────────────────────────────────
// Everything a paid run needs, checked WITHOUT the server and without spending:
// .env, IDL, RPC pool, program config, wallet key + balances, Docker, the
// client image, and what the client container can run on this kernel.
//   node scripts/doctor.mjs        exit 0 = ready for a paid run
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const no = (m) => { bad++; console.log(`  ✗ ${m}`); };
const info = (m) => console.log(`  · ${m}`);

console.log('Sentinel Node Tester (Solana) — doctor');
existsSync(join(ROOT, '.env')) ? ok('.env present') : no('.env missing — cp .env.example .env');
existsSync(join(ROOT, 'chain', 'idl', 'dvpn.devnet.json')) ? ok('devnet IDL generated') : no('chain/idl/dvpn.devnet.json missing — npm run patch-idl');

const { NETWORK, PROGRAM_ID } = await import('../lib/solana/idl.js');
const { getRpcState } = await import('../lib/solana/rpc.js');
const { getConfig } = await import('../lib/solana/accounts.js');
const { walletConfigured, walletBalances } = await import('../lib/wallet.js');
const { dockerStatus, imagePresent, probeClientCapabilities } = await import('../audit/docker.js');
const { DVPND_IMAGE } = await import('../lib/constants.js');

info(`network ${NETWORK} · program ${PROGRAM_ID.toBase58()}`);
const rpc = await getRpcState();
rpc.slot ? ok(`RPC slot ${rpc.slot} via ${rpc.serving}`) : no(`RPC unreachable (${rpc.pool.join(', ')})`);
try {
  const cfg = await getConfig();
  ok(`program config: paused mask ${cfg.pausedMask}, fee ${cfg.feeBps} bps, channel grace ${cfg.channelCloseGraceSeconds} s, listing TTL ${cfg.nodeListingTtlSeconds} s`);
} catch (err) { no(`program config unreadable: ${err.message}`); }

if (!walletConfigured()) no('TEST_KEYFILE not set — paid runs disabled (TEST RUN still works)');
else {
  try {
    const w = await walletBalances();
    ok(`wallet ${w.address}: ${w.sol} SOL · ${w.token} tDVPN · program balance ${w.userBalance} · ${w.openChannels} open channel(s)`);
    if (w.lamports < 10_000_000) no('less than 0.01 SOL — channel rent and fees will fail');
  } catch (err) { no(err.message); }
}

const d = await dockerStatus();
if (!d.ok) no(`Docker unavailable: ${d.error}`);
else {
  ok(`Docker ${d.version}`);
  const img = await imagePresent(DVPND_IMAGE);
  if (!img.ok) no(`client image ${DVPND_IMAGE} missing — build it with 'npm run build-client-image' (docker/client.Dockerfile, a cb33092e sentinel-dvpnd)`);
  else {
    ok(`client image ${DVPND_IMAGE}`);
    const caps = await probeClientCapabilities(DVPND_IMAGE);
    caps.ok ? ok('client container runs sentinel-dvpnd + sentinel-dvpn with /dev/net/tun and nftables') : no(`client container cannot run sentinel-dvpnd: ${caps.output.slice(-300)}`);
    info(`AmneziaWG client ${caps.nftFibIpv6 ? 'supported' : 'NOT supported on this kernel (no nft_fib_ipv6) — such nodes are skipped'}`);
  }
}
if (process.env.NODE_URI_OVERRIDES) info(`URI overrides: ${process.env.NODE_URI_OVERRIDES}`);

console.log(bad ? `\n${bad} problem(s)` : '\nready for a paid run');
process.exit(bad ? 1 : 0);
