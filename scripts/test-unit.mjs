#!/usr/bin/env node
// ─── Unit tests ──────────────────────────────────────────────────────────────
// Offline once fixtures exist: memo wire format, client transcript parser,
// escrow math, scoring, settings, signed-metadata verification, overrides,
// countries, SQLite layer (in-memory), account decoding of real devnet bytes.
//   node scripts/test-unit.mjs            exit 0 = all pass
//   CAPTURE=1 node scripts/test-unit.mjs  re-capture test/fixtures/devnet-accounts.json from devnet
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import nacl from 'tweetnacl';
import { Keypair, PublicKey } from '@solana/web3.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(here, '..', 'test', 'fixtures');
const FIX = join(FIX_DIR, 'devnet-accounts.json');

let pass = 0; let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
}
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, what) => { if (!c) throw new Error(what || 'assertion failed'); };

// Known devnet anchors (verified on chain 2026-10-19).
const KNOWN = {
  owner: '11111111111111111111111111111111',
  node: '6AaXvhWpFDMf8FimxSb2Tb3bKcgPmbZxj4Tdtb31nP8F',
  channel: '6bqqLiCsA591aX6KgELYTf5F6doRKV8wfa4dQqYtrodA',
};

const { packBatch, decodeMemo, resultToRecord, memoFromSignatureInfo, SCHEMA } = await import('../lib/onchain-report.js');
const { parseClientOutput, escrowFor, prepayCost, summariseSessionError, CLIENT_SCRIPT } = await import('../audit/session-runner.js');
const { scoreResult } = await import('../lib/speed.js');
const { rawPayload, verifySignedMetadata, parseUri } = await import('../lib/discovery.js');
const { DOMAIN_NODE_METADATA, domain } = await import('../lib/nodeapi.js');
const { parseOverrides, clientSupports } = await import('../audit/node-test.js');
const { countryNameToCode: countryCode, countryCodeToName: countryName, countryToContinent, getFlagEmoji: flagEmoji } = await import('../core/countries.js');
const coreDb = await import('../core/db.js');
const solDb = await import('../lib/db.js');
const { toCosmosNode } = await import('../core/chain.js');
const { statusFromProbe, protocolDisplayName, metadataProblem } = await import('../protocol/v3protocol.js');
const { classifyProbeError, canAffordNextChannel, isInternetError, outageBeforeRecording } = await import('../audit/pipeline.js');
const { decodeAccount, accountSize } = await import('../lib/solana/accounts.js');
const { OFFSETS, DEPLOYED_SIZES, NETWORK } = await import('../lib/solana/idl.js');
const { pda } = await import('../lib/solana/program.js');
const { describeProgramError } = await import('../lib/solana/errors.js');
const { CLIENT_RUN_FLAGS, containerName } = await import('../audit/docker.js');
const { parseArgs, COMMANDS, parseKv, solanaNames, SOLANA_KEYS } = await import('../cli.js');
const { ERR } = await import('../lib/constants.js');

const pk = () => Keypair.generate().publicKey.toBase58();

console.log('memo wire format');
await t('pack → decode round-trip keeps every field', () => {
  const recs = [
    { address: pk(), ok: 1, mbps: 55.12, peers: 3, lat: 691, proto: 'wg', cc: 'US' },
    { address: pk(), ok: 0, mbps: null, peers: 0, lat: 0, proto: 'hy2', cc: 'IN' },
  ];
  const { memo, packed } = packBatch({ network: 'devnet', region: 'in', baselineMbps: 93.35, startedAt: 1792414752000 }, recs);
  eq(packed, 2, 'packed');
  ok(memo.startsWith('SNTR1|v3|devnet|IN|b=93.4|t=1792414752'), `header: ${memo.split('\n')[0]}`);
  const d = decodeMemo(memo);
  eq(d.count, 2); eq(d.region, 'IN'); eq(d.network, 'devnet'); eq(d.baselineMbps, 93.4);
  eq(d.records[0].address, recs[0].address); eq(d.records[0].mbps, 55.1); eq(d.records[0].protocol, 'wireguard'); eq(d.records[0].latencyMs, 691); eq(d.records[0].countryCode, 'US');
  eq(d.records[1].ok, false); eq(d.records[1].mbps, null); eq(d.records[1].protocol, 'hysteria2');
});
await t('packer never exceeds the memo limit and fits ≥ 10 full-length records', () => {
  const recs = Array.from({ length: 30 }, () => ({ address: pk(), ok: 1, mbps: 999.9, peers: 65535, lat: 65535, proto: 'ovpn', cc: 'DE' }));
  const { memo, packed } = packBatch({ network: 'devnet', region: 'US', baselineMbps: 1000, startedAt: Date.now() }, recs);
  ok(memo.length <= SCHEMA.MEMO_CHAR_LIMIT, `memo ${memo.length} > ${SCHEMA.MEMO_CHAR_LIMIT}`);
  ok(packed >= 10 && packed <= SCHEMA.MAX_RECORDS, `packed ${packed}`);
});
await t('decoder refuses v2 Cosmos memos, other versions and garbage', () => {
  eq(decodeMemo('SNTR1|v2|US|b=1.0|t=1\nsentnode1abc|1|5.0|0|'), null, 'v2');
  eq(decodeMemo('SNTR1|v4|devnet|US|b=1|t=1'), null, 'v4');
  eq(decodeMemo('hello'), null, 'garbage');
  eq(decodeMemo(''), null, 'empty');
});
await t('resultToRecord: skipped and malformed rows are not reported', () => {
  eq(resultToRecord({ address: pk(), skipped: true, actualMbps: null }), null, 'skipped');
  eq(resultToRecord({ address: 'sentnode1xyz', actualMbps: 3 }), null, 'bech32');
  const r = resultToRecord({ address: KNOWN.node, actualMbps: 55.1, peers: 2, latencyMs: 691, protocol: 'wireguard', countryCode: 'us' });
  eq(r.ok, 1); eq(r.proto, 'wg'); eq(r.cc, 'US');
  eq(resultToRecord({ address: KNOWN.node, actualMbps: 9, error: 'x' }).ok, 0, 'error wins over speed');
});
await t('memo prefix "[len] " from signature listings is stripped', () => {
  eq(memoFromSignatureInfo('[42] SNTR1|v3|x'), 'SNTR1|v3|x');
  eq(memoFromSignatureInfo(null), null);
});

console.log('escrow + scoring');
await t('prepayCost = ceil(bytes × price / 1e9)', () => {
  eq(prepayCost('1000', 100_000_000).toString(), '100', '100 MB at 1000/GB');
  eq(prepayCost('1', 1).toString(), '1', 'ceil');
  eq(prepayCost('0', 1e9).toString(), '0', 'free');
});
await t('escrow covers the prepay with margin and never drops below the floor', () => {
  eq(escrowFor({ pricePerGb: '1000', prepayBytes: 100_000_000, escrowFloor: 200_000 }), '200000', 'floor');
  eq(escrowFor({ pricePerGb: '10000000', prepayBytes: 1_000_000_000, escrowFloor: 200_000 }), '12000001', 'margin');
});
await t('scoreResult caps above baseline and derives pass flags', () => {
  const a = scoreResult(120, 100);
  eq(a.actualMbps, 97); eq(a.passBaseline, true); eq(a.ispBottleneck, true);
  const b = scoreResult(12, 100);
  eq(b.pass10mbps, true); eq(b.pass15mbps, false); eq(b.passBaseline, false);
  const c = scoreResult(null, null);
  eq(c.actualMbps, null); eq(c.baselineViable, false);
});

console.log('client transcript parser');
const PASS_TX = [
  'STEP init', "CFG prepay_bytes = 100000000", 'STEP reach 127.0.0.1:8443', 'REACH 200 0.013497', 'STEP daemon', 'STEP session-start', 'SESSION_START_RC 0',
  'SESSION_START_BEGIN', '{', '  "session": {', '    "id": "eb0d662d-5e6a-4dd0-93e3-42c3492899bc",', `    "channel": "${KNOWN.channel}"`, '  }', '}', 'SESSION_START_END',
  'SID eb0d662d-5e6a-4dd0-93e3-42c3492899bc', 'STEP download', 'DL_TRY 1 10000000 6888973 1.451600 0.691280 200', 'DOWNLOAD 10000000 6888973 1.451600 0.691280 200',
  'CONNECTIVITY 204 0.112759', 'STATUS_BEGIN', '{"session":{"id":"eb0d","status":"active","usage":{"rx_bytes":"10500000","tx_bytes":"200000","seconds":"9"},"spent":"100"}}', 'STATUS_END',
  'STEP stop', 'LOG_BEGIN', 'daemon log line', 'LOG_END', 'DONE',
].join('\n');
await t('a passing transcript parses into speed, channel, usage and spend', () => {
  const r = parseClientOutput(PASS_TX, { exitCode: 0, timedOut: false, testBytes: 10_000_000 });
  eq(r.ok, true); eq(r.stage, 'done'); eq(r.channel, KNOWN.channel); eq(r.sessionId, 'eb0d662d-5e6a-4dd0-93e3-42c3492899bc');
  eq(r.downloadedBytes, 10_000_000); eq(r.ttfbMs, 691); eq(r.totalMs, 1452); eq(r.mbps, 55.1);
  eq(r.connectivityOk, true); eq(r.clientRxBytes, 10_500_000); eq(r.spentBase, '100'); eq(r.cfg.prepay_bytes, '100000000');
});
await t('a dead tunnel counts every failed download attempt (curl 000 lines parse)', () => {
  // Shape from the real-server failure matrix: WireGuard with its tunnel port closed.
  const dead = (n) => `DL_TRY ${n} 0 0 21.827858 21.827857 000`;
  const tx = PASS_TX
    .replace('DL_TRY 1 10000000 6888973 1.451600 0.691280 200', [1, 1, 2, 2, 3, 3, 4, 4].map(dead).join('\n'))
    .replace('DOWNLOAD 10000000 6888973 1.451600 0.691280 200', 'DOWNLOAD 0 0 21.827858 21.827857 000')
    .replace('CONNECTIVITY 204 0.112759', 'CONNECTIVITY 000 10.001853 0.000000 10.001850');
  const r = parseClientOutput(tx, { exitCode: 0, timedOut: false, testBytes: 10_000_000 });
  eq(r.attempts, 8); eq(r.errorCode, ERR.TUNNEL_NO_TRAFFIC); eq(r.stage, 'download'); eq(r.connectivityOk, false);
  ok(/in 8 attempts/.test(r.error), r.error);
});
await t('a client container killed mid-session is a client failure, not a dead tunnel', () => {
  // Real-server e2e: the container was force-removed right after SID → read as TUNNEL_NO_TRAFFIC.
  const cut = PASS_TX.slice(0, PASS_TX.indexOf('STEP download') + 'STEP download'.length);
  const r = parseClientOutput(cut, { exitCode: 137, timedOut: false, testBytes: 10_000_000 });
  eq(r.errorCode, ERR.CLIENT_EXITED); eq(r.stage, 'client'); ok(/not a node fault/.test(r.error), r.error);
  const dead = parseClientOutput(PASS_TX.replace('DL_TRY 1 10000000 6888973 1.451600 0.691280 200', 'DL_TRY 1 0 0 9.1 9.1 000').replace('DOWNLOAD 10000000 6888973 1.451600 0.691280 200', 'DOWNLOAD 0 0 9.1 9.1 000'), { exitCode: 0, timedOut: false, testBytes: 10_000_000 });
  eq(dead.errorCode, ERR.TUNNEL_NO_TRAFFIC, 'a finished script with no bytes is still a dead tunnel');
});
await t('the client script never glues a fallback onto curl output', () => {
  ok(!/\|\| echo "0 0 0 0 000"|\|\| echo "000 0 0 0"/.test(CLIENT_SCRIPT), 'curl fallback must be a separate [ -n ] check');
});
await t('lab hooks are safe under set -u when no lab script is mounted (production sessions)', async () => {
  // The script runs with `set -u`: a bare $LAB_* that production never sets kills the session
  // ("parameter not set", exit 2). Each LAB_ variable read outside the mounted-script check
  // (which short-circuits first) must be assigned earlier in the script.
  const lines = CLIENT_SCRIPT.split('\n');
  const bad = [];
  lines.forEach((l, i) => {
    if (l.trim().startsWith('#') || l.trim().startsWith('if [ -f /mnt/snt/lab.sh ] &&')) return;
    for (const m of l.matchAll(/\$(LAB_\w+)/g)) {
      if (!lines.slice(0, i).some((p) => p.trim().startsWith(`${m[1]}=`))) bad.push(`${m[1]} (line ${i + 1})`);
    }
  });
  eq(bad.join(', '), '', 'LAB_ variables read before any assignment');
  // The mounted lab script runs under the same set -u: everything it reads must be set by the
  // client script or passed in the container env by runSessionTest.
  const { LAB_SH } = await import('../audit/speed-lab.js');
  const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'audit', 'session-runner.js'), 'utf8');
  const passed = new Set([...runner.matchAll(/`(LAB_\w+)=\$\{/g)].map((m) => m[1]));
  const set = new Set(lines.map((l) => /^\s*(LAB_\w+)=/.exec(l)?.[1]).filter(Boolean));
  const unknown = [...new Set([...LAB_SH.matchAll(/\$(LAB_\w+)/g)].map((m) => m[1]))]
    .filter((v) => !passed.has(v) && !set.has(v) && !new RegExp(`(^|[\\s;(])${v}=`, 'm').test(LAB_SH));
  eq(unknown.join(', '), '', 'lab script variables nobody sets');
});
await t('unreachable node → probe stage, UNREACHABLE', () => {
  const r = parseClientOutput('STEP init\nSTEP reach 1.2.3.4:8443\nREACH 000 6.0\nFAIL unreachable 1.2.3.4:8443', { exitCode: 13, timedOut: false, testBytes: 1e7 });
  eq(r.ok, false); eq(r.stage, 'probe'); eq(r.errorCode, ERR.UNREACHABLE);
});
await t('session start refusal → session stage with the daemon\'s own words', () => {
  const tx = 'STEP session-start\nSESSION_START_RC 1\nSESSION_START_BEGIN\nError: rpc error: code = FailedPrecondition desc = channel escrow cannot cover the prepay\nSESSION_START_END\nFAIL session-start\nERR_BEGIN\nERR_END\nLOG_BEGIN\nx\nLOG_END';
  const r = parseClientOutput(tx, { exitCode: 12, timedOut: false, testBytes: 1e7 });
  eq(r.stage, 'session'); eq(r.errorCode, ERR.SESSION_START_FAIL);
  ok(/escrow cannot cover the prepay/.test(r.error), r.error);
});
await t('short download → download stage, TUNNEL_NO_TRAFFIC', () => {
  const tx = PASS_TX.replace(/DOWNLOAD 10000000/, 'DOWNLOAD 4096').replace(/DL_TRY 1 10000000/, 'DL_TRY 1 4096');
  const r = parseClientOutput(tx, { exitCode: 0, timedOut: false, testBytes: 10_000_000 });
  eq(r.stage, 'download'); eq(r.errorCode, ERR.TUNNEL_NO_TRAFFIC); eq(r.channel, KNOWN.channel, 'channel still captured for the sweep');
});
await t('AmneziaWG on a kernel without nft fib ipv6 → PROTOCOL_UNSUPPORTED', () => {
  const r = parseClientOutput('UNSUPPORTED kernel lacks nft_fib_ipv6', { exitCode: 20, timedOut: false, testBytes: 1e7 });
  eq(r.errorCode, ERR.PROTOCOL_UNSUPPORTED);
});
await t('container timeout after the session started → download stage, CLIENT_TIMEOUT', () => {
  const r = parseClientOutput('STEP session-start\nSESSION_START_BEGIN\n{"session":{"id":"a"}}\nSESSION_START_END\nSID a\nSTEP download', { exitCode: 124, timedOut: true, testBytes: 1e7 });
  eq(r.errorCode, ERR.CLIENT_TIMEOUT); eq(r.stage, 'download');
});
await t('daemon never ready → client stage, DAEMON_NOT_READY', () => {
  const r = parseClientOutput('STEP daemon\nFAIL daemon-not-ready\nLOG_BEGIN\npreflight: rpc 429\nLOG_END', { exitCode: 11, timedOut: false, testBytes: 1e7 });
  eq(r.stage, 'client'); eq(r.errorCode, ERR.DAEMON_NOT_READY); ok(/429/.test(r.error), r.error);
});
await t('latency = request round trip after TLS (starttransfer − appconnect), not cold DNS', () => {
  const tx = PASS_TX.replace('CONNECTIVITY 204 0.112759', 'CONNECTIVITY 204 2.140000 2.030000 2.121000');
  const r = parseClientOutput(tx, { exitCode: 0, timedOut: false, testBytes: 10_000_000 });
  eq(r.rttMs, 91); eq(r.connectivityMs, 2140); eq(r.connectivityOk, true);
  const legacy = parseClientOutput(PASS_TX, { exitCode: 0, timedOut: false, testBytes: 10_000_000 });
  eq(legacy.rttMs, null, 'old 2-field line still parses');
});
await t('every speed source refusing through a working tunnel is not blamed on the node', () => {
  const tx = PASS_TX.replace(/DL_TRY 1 10000000 6888973 1.451600 0.691280 200/, 'DL_TRY 1 17 0 0.1 0.1 429').replace(/DOWNLOAD 10000000 6888973 1.451600 0.691280 200/, 'DOWNLOAD 17 0 0.1 0.1 429');
  const r = parseClientOutput(tx, { exitCode: 0, timedOut: false, testBytes: 10_000_000 });
  eq(r.errorCode, ERR.SPEED_SOURCE_UNAVAILABLE); eq(r.stage, 'download');
});
await t('summariseSessionError prefers the JSON error field', () => {
  eq(summariseSessionError('{"error":"node at capacity: peer_limit_reached"}', ''), 'node at capacity: peer_limit_reached');
});

console.log('signed metadata');
await t('signature over sha256(payload bytes) under the node-metadata domain verifies; tampering fails', () => {
  const kp = Keypair.generate();
  const payloadText = '{"node":"X","note":"brace } inside \\"quoted\\" { string","peers":{"current":1,"max":2}}';
  const digest = createHash('sha256').update(Buffer.from(payloadText, 'utf8')).digest();
  const sig = nacl.sign.detached(Buffer.concat([DOMAIN_NODE_METADATA, digest]), kp.secretKey);
  const body = `{"payload": ${payloadText}, "signature":"${Buffer.from(sig).toString('base64')}","signer":"${kp.publicKey.toBase58()}"}`;
  eq(rawPayload(body), payloadText, 'raw payload extraction');
  eq(verifySignedMetadata(body, JSON.parse(body)), true, 'valid');
  const tampered = body.replace('"current":1', '"current":9');
  eq(verifySignedMetadata(tampered, JSON.parse(tampered)), false, 'tampered');
  eq(domain('sentinel-dvpn/node-metadata/v1').length, 32);
});
await t('live cf4c372 node metadata verifies under sha256(tag); the old zero-padded domain is recognised as an outdated daemon', async () => {
  // Captured 2026-10-21 from #31's WireGuard node 8sV25K… (dvpnd cf4c372-ddv1), signed by the node.
  const { LEGACY_DOMAIN_NODE_METADATA, legacyDomain, DOMAIN_TICKET } = await import('../lib/nodeapi.js');
  const text = readFileSync(new URL('../test/fixtures/node-metadata.cf4c372.json', import.meta.url), 'utf8');
  const json = JSON.parse(text);
  ok(verifySignedMetadata(text, json), 'real node signature verifies with the cf4c372 domain');
  ok(!verifySignedMetadata(text, json, LEGACY_DOMAIN_NODE_METADATA), 'and not with the old one');
  eq(DOMAIN_NODE_METADATA.toString('hex'), createHash('sha256').update('sentinel-dvpn/node-metadata/v1').digest('hex'));
  eq(DOMAIN_TICKET.toString('hex'), createHash('sha256').update('sentinel-dvpn/ticket/v1').digest('hex'), 'ticket tag renamed from access-ticket/v1');
  // An old daemon's signature: the probe must say "outdated", not "bad signature".
  const kp = Keypair.generate();
  const payloadText = '{"node":"X"}';
  const digest = createHash('sha256').update(payloadText).digest();
  const sig = nacl.sign.detached(Buffer.concat([legacyDomain('sentinel-dvpn/node-metadata/v1'), digest]), kp.secretKey);
  const old = `{"payload":${payloadText},"signature":"${Buffer.from(sig).toString('base64')}","signer":"${kp.publicKey.toBase58()}"}`;
  ok(!verifySignedMetadata(old, JSON.parse(old)) && verifySignedMetadata(old, JSON.parse(old), LEGACY_DOMAIN_NODE_METADATA), 'old daemon told apart');
  eq(json.payload.bandwidth.download_bytes_per_second > 0, true, 'cf4c372 bandwidth field name');
});
await t('live cb33092e node metadata (node-4 WireGuard) verifies, and its claims and settlement parse', async () => {
  // Captured 2026-11-07 from node-4's WireGuard node 85UXF7Jo… (pure cb33092e sentinel-dvpnd).
  const text = readFileSync(new URL('../test/fixtures/node-metadata.cb33092e.json', import.meta.url), 'utf8');
  const json = JSON.parse(text);
  ok(verifySignedMetadata(text, json), 'cb33092e node signature verifies under sha256(tag)');
  const tampered = text.replace('"country":"US"', '"country":"DE"');
  eq(verifySignedMetadata(tampered, JSON.parse(tampered)), false, 'negative control: one changed byte fails');
  const p = json.payload;
  eq(p.program_id, 'J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs');
  eq(json.signer, p.owner, 'signed by the owner');
  ok(p.api && /^[0-9a-f]{64}$/.test(p.api.tls_sha256), 'tls pin');
  ok('download_bytes_per_second' in p.bandwidth, 'bandwidth field name unchanged since cf4c372');
  ok(p.settlement && p.settlement.prices && 'channel_price_per_gb' in p.settlement.prices, 'settlement prices');
  eq(p.service.type, 'wireguard');
});
await t('signed requests use the cf4c372 header name X-Sentinel-Signer', async () => {
  const { signRequest } = await import('../lib/nodeapi.js');
  const h = signRequest(Keypair.generate(), 'GET', '/v1/x', Buffer.alloc(0));
  ok(h['X-Sentinel-Signer'] && !h['X-Sentinel-Key'], 'X-Sentinel-Signer, not X-Sentinel-Key');
});
await t('parseUri handles default port and junk', () => {
  eq(parseUri('https://1.2.3.4').port, 443);
  eq(parseUri('https://h:8443').origin, 'https://h:8443');
  eq(parseUri('nope'), null);
});

console.log('settings, overrides, protocols, countries');
await t('NODE_URI_OVERRIDES parsing', () => {
  const m = parseOverrides(`${KNOWN.node}=172.20.52.21:8443, Abc=host.docker.internal ,junk`);
  eq(m.get(KNOWN.node).host, '172.20.52.21'); eq(m.get(KNOWN.node).port, 8443); eq(m.get('Abc').port, null); eq(m.size, 2);
});
await t('override to host.docker.internal: the laptop probes 127.0.0.1, containers redirect every TCP port', async () => {
  const { probeOrigin } = await import('../audit/pipeline.js');
  eq(probeOrigin(null), null);
  eq(probeOrigin({ host: 'host.docker.internal', port: 18611 }), 'https://127.0.0.1:18611');
  eq(probeOrigin({ host: '172.20.52.21', port: 8443 }), 'https://172.20.52.21:8443');
  eq(probeOrigin({ host: '10.0.0.5', port: null }), 'https://10.0.0.5:443');
  ok(CLIENT_SCRIPT.includes('ip daddr "$NIP" meta l4proto tcp dnat to "$OIP"'), 'tunnel TCP ports (V2Ray/Xray) must follow the override');
  ok(CLIENT_SCRIPT.includes('ip route replace "$OIP/32" via "$GW"'), 'the override address must stay outside the client tunnel');
});
await t('client protocol support: AmneziaWG needs nft fib ipv6', () => {
  eq(clientSupports('wireguard', {}), true); eq(clientSupports('amneziawg', { nftFibIpv6: false }), false); eq(clientSupports('amneziawg', { nftFibIpv6: true }), true); eq(clientSupports(null, {}), false);
});
await t('countries: code, name, continent, flag', () => {
  eq(countryCode('United States'), 'US'); eq(countryCode('in'), 'IN'); eq(countryName('DE'), 'Germany'); eq(countryToContinent('SG'), 'AS'); eq(flagEmoji('US'), '🇺🇸'); eq(countryCode(''), null);
});
await t('client containers carry the security and hairpin flags', () => {
  for (const f of ['NET_ADMIN', '/dev/net/tun:/dev/net/tun', 'apparmor=unconfined', 'systempaths=unconfined', 'net.ipv4.conf.all.route_localnet=1', 'AWG_FORCE_USERSPACE=1']) ok(CLIENT_RUN_FLAGS.includes(f), f);
  eq(containerName('ab/../cd'), 'snt-client-ab..cd');
});
await t('CLI flags: booleans never swallow the next positional; --k=v works', () => {
  const a = parseArgs(['start', '--test-run', 'X', '--limit=3', '--addresses', 'a,b']);
  eq(a.pos.join(','), 'start,X'); eq(a.f['test-run'], true); eq(a.f.limit, '3'); eq(a.f.addresses, 'a,b');
  ok(Object.keys(COMMANDS).length >= 50, `command table has ${Object.keys(COMMANDS).length}`);
});
await t('Solana node → Cosmos node shape (what the shared pipeline + pages read)', () => {
  const n = toCosmosNode({ address: KNOWN.node, uri: 'https://127.0.0.1:8443', pricePerGb: '1000', pricePerHour: '7', protocol: 'wireguard', listingFresh: true });
  eq(n.remoteUrl, 'https://127.0.0.1:8443'); eq(n.gigabyte_prices[0].quote_value, '1000'); eq(n.hourly_prices[0].quote_value, '7');
  eq(n.status, 'active'); eq(n.type, 1); eq(n._sol.protocol, 'wireguard'); eq(n.planIds.length, 0);
});
await t('probe → Cosmos nodeStatusV3 shape', () => {
  const st = statusFromProbe({ address: KNOWN.node, protocol: 'wireguard', country: 'United States', countryCode: 'US', pricePerGb: '1000' },
    { serviceType: 'wireguard', peers: 3, maxPeers: 250, reportedDownloadMbps: 80, reportedUploadMbps: 8, city: 'X', countryName: 'United States' });
  eq(st.type, 'wireguard'); eq(st.peers, 3); eq(st.qos.max_peers, 250); eq(st.bandwidth.download, 10_000_000); eq(st.location.country_code, 'US');
  eq(st.moniker, '6AaXvh…nP8F');
  eq(protocolDisplayName('hysteria2'), 'Hysteria2'); eq(protocolDisplayName('amneziawg'), 'AmneziaWG');
});
await t('probe error buckets (scan summary + fail rows)', () => {
  eq(classifyProbeError(new Error('TCP 1.2.3.4:1 closed or filtered')), 'TCP_REFUSED');
  eq(classifyProbeError(Object.assign(new Error('x'), { code: 'METADATA_INVALID' })), 'METADATA_INVALID');
  eq(classifyProbeError(new Error('request timed out')), 'TIMEOUT');
});
await t('scan refuses untrustworthy metadata before any channel opens (bad signature, wrong claims, TLS pin mismatch)', () => {
  const good = { signatureValid: true, claimsMatch: true, tlsPinMatch: true };
  eq(metadataProblem(good), null);
  eq(metadataProblem({ ...good, tlsPinMatch: null }), null, 'no pin advertised: first contact, accepted');
  ok(/signature/.test(metadataProblem({ ...good, signatureValid: false })));
  ok(/claims/.test(metadataProblem({ ...good, claimsMatch: false })));
  ok(/pin/.test(metadataProblem({ ...good, tlsPinMatch: false })), 'the client refuses a pin mismatch at session start, so the scan must too');
});

console.log('pause decisions');
await t('low-balance pause reads the chain: tokens below one escrow or SOL below 0.01 → pause', async () => {
  const fake = (amount, lamports) => ({ getBalance: async () => ({ denom: 'tdvpn', amount: String(amount), lamports }) });
  const st = () => ({ walletAddress: KNOWN.owner, spentUdvpn: 999, balanceUdvpn: 0 });
  let s = st(); let r = await canAffordNextChannel(fake(5_000_000, 2_000_000_000), s);
  eq(r.ok, true); eq(s.spentUdvpn, 0, 'chain balance resets the estimate'); eq(s.balanceUdvpn, 5_000_000);
  r = await canAffordNextChannel(fake(199_999, 2_000_000_000), st());
  eq(r.ok, false); eq(r.tokensOk, false);
  r = await canAffordNextChannel(fake(5_000_000, 9_999_999), st());
  eq(r.ok, false); eq(r.tokensOk, true); eq(r.solOk, false);
  r = await canAffordNextChannel({ getBalance: async () => { throw new Error('rpc down'); } }, { ...st(), balanceUdvpn: 300_000, spentUdvpn: 0 });
  eq(r.ok, true, 'falls back to the estimate when the RPC read fails');
});
await t('INTERNET_CHECK_URLS parses a comma list (test hook for the internet-down pause)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../audit/pipeline.js', import.meta.url), 'utf8');
  eq(/process\.env\.INTERNET_CHECK_URLS \|\| 'https:\/\/www\.google\.com,https:\/\/1\.1\.1\.1,https:\/\/www\.cloudflare\.com'/.test(src), true, 'default targets unchanged');
});
await t('a failure while the tester is offline is not recorded: pause, then retry (or stop)', async () => {
  // Real-server e2e: with the internet cut, healthy nodes failed DAEMON_NOT_READY and were recorded.
  const http = await import('node:http');
  const up = http.createServer((q, s) => { s.writeHead(204); s.end(); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const prev = process.env.INTERNET_CHECK_URLS;
  const node = { address: KNOWN.owner };
  const logs = [];
  const bc = (type, p) => { if (type === 'log') logs.push(p.msg); };
  try {
    process.env.INTERNET_CHECK_URLS = `http://127.0.0.1:${up.address().port}/`;
    eq(await outageBeforeRecording(node, { errorCode: 'DAEMON_NOT_READY' }, { status: 'running' }, bc), null, 'online → record the failure');
    process.env.INTERNET_CHECK_URLS = 'http://127.0.0.1:1/';
    const st = { status: 'running', stopRequested: false };
    setTimeout(() => { st.stopRequested = true; }, 300);
    eq(await outageBeforeRecording(node, { errorCode: 'DAEMON_NOT_READY' }, st, bc), 'stop', 'offline + stop → stop');
    eq(st.status, 'paused_internet');
    ok(logs.some((m) => /not recorded — the tester has no internet/.test(m)), 'logged');
    eq(await outageBeforeRecording(node, {}, { status: 'running', testRun: true }, bc), null, 'TEST RUN never pauses');
  } finally {
    if (prev === undefined) delete process.env.INTERNET_CHECK_URLS; else process.env.INTERNET_CHECK_URLS = prev;
    up.close();
  }
});
await t('internet-down detection keys on network errors only', () => {
  eq(isInternetError(new Error('getaddrinfo ENOTFOUND x')), true);
  eq(isInternetError(new Error('fetch failed')), true);
  eq(isInternetError(new Error('channel escrow cannot cover the prepay')), false);
});

console.log('run numbering (server.js)');
await t('a run index holding a run with no number never yields NaN (fresh install: retest before the first start)', async () => {
  // Evaluates the real getNextRunNumber from server.js against the index the hosted e2e produced.
  const src = (await import('node:fs')).readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const m = /function getNextRunNumber\(\) \{[\s\S]*?\n\}/.exec(src);
  ok(m, 'getNextRunNumber found');
  const make = (runs) => new Function('loadRunsIndex', `${m[0]}; return getNextRunNumber();`)(() => ({ runs }));
  eq(make([]), 1);
  eq(make([{ number: 2 }, { number: 5 }]), 6);
  eq(make([{ label: 'Auto-save before Test #1' }, { number: null, label: 'Test #NaN' }]), 1, 'index with no numbered run');
  eq(make([{ number: undefined }, { number: 3 }]), 4);
  ok(src.includes('if (!Number.isFinite(state.activeRunNumber)) state.activeRunNumber = getNextRunNumber();'), 'startFreshRun numbers the auto-save');
});

console.log('errors');
await t('program errors decode by the IDL numbers (live cf4c372 program, 2026-10-21)', () => {
  // Both seen in the live program's own AnchorError logs during the migration check.
  eq(describeProgramError(6023).name, 'BalanceZero');
  eq(describeProgramError(6033).name, 'ChannelNotClosing');
  eq(describeProgramError(102).name, 'InstructionDidNotDeserialize');
  // cb33092e appends two errors; every earlier number is unchanged.
  eq(describeProgramError(6049).name, 'MissingRentRecipient');
  eq(describeProgramError(6050).name, 'InvalidRentRecipient');
});
await t('every session is stopped explicitly and the stop outcome is recorded (no idle "active" session left on the node)', () => {
  ok(/SO=\$\(timeout 60 \$C client stop "\$SID" 2>&1\); SRC=\$\?/.test(CLIENT_SCRIPT), 'stop output captured, not sent to /dev/null');
  ok(!CLIENT_SCRIPT.includes('client stop "$SID" >/dev/null'), 'no silent stop');
  ok(CLIENT_SCRIPT.indexOf('client stop "$SID"') < CLIENT_SCRIPT.lastIndexOf('kill -TERM $DP 2>/dev/null; wait $DP'), 'stop before the final daemon kill');
  const good = parseClientOutput('SID a\nSTOP_RC 0\nAFTER_STOP "status": "ENDED"\nDONE\n', { exitCode: 0, timedOut: false, testBytes: 1 });
  ok(parseClientOutput('SID a\nROUTES_LEFT 1\nDONE\n', { exitCode: 0, timedOut: false, testBytes: 1 }).routesLeft === 1, 'node host route left after stop is parsed (#11)');
  ok(good.routesLeft === null, 'no ROUTES_LEFT line reads as null, not 0');
  ok(parseClientOutput('SID a\nAFTER_STOP_USAGE rx_bytes:10751932 tx_bytes:98432 \nDONE\n', { exitCode: 0, timedOut: false, testBytes: 1 }).clientRxAfterStop === 10751932, 'usage after stop parsed (Q0429 final sample)');
  ok(parseClientOutput('SID a\nAFTER_STOP_USAGE rx_bytes:10751932 tx_bytes:98432 \nDONE\n', { exitCode: 0, timedOut: false, testBytes: 1 }).clientTxAfterStop === 98432, 'tx after stop parsed separately (hy2 tx≈rx check)');
  ok(good.clientRxAfterStop === null, 'no AFTER_STOP_USAGE line reads as null');
  ok(/ROUTES_LEFT \$\(ip route show table main/.test(CLIENT_SCRIPT), 'script checks for a node host route after stop (#11)');
  ok(/if \[ "\$FAULT" = drop-reconnect \]; then/.test(CLIENT_SCRIPT) && CLIENT_SCRIPT.indexOf('nft add rule ip snt_drop o ip daddr "$DIP" drop') < CLIENT_SCRIPT.indexOf('nft delete table ip snt_drop; echo "DROP_END') && CLIENT_SCRIPT.indexOf('GET_STARTED_RC') < CLIENT_SCRIPT.indexOf('STEP stop'), 'drop-reconnect: node address cut, restored, then the started id is used (PR #25 A/B)');
  ok(CLIENT_SCRIPT.indexOf('SS0=$(grep -c') < CLIENT_SCRIPT.indexOf('DROP_BEGIN') && /\[ "\$SS" -gt "\$SS0" \] && break/.test(CLIENT_SCRIPT) && CLIENT_SCRIPT.indexOf('RECONNECTED') < CLIENT_SCRIPT.indexOf('GET_STARTED_RC'), 'drop-reconnect waits for the reconnect (new service start) before using the started id');
  ok(/if \[ "\$XFER" = upload \]; then/.test(CLIENT_SCRIPT) && CLIENT_SCRIPT.indexOf('echo "UPLOAD') < CLIENT_SCRIPT.lastIndexOf('probe b'), 'upload lab mode runs before the after-transfer probe');
  ok(parseClientOutput('SID a\nUPLOAD 10000000 1500000 6.6 200\nDONE\n', { exitCode: 0, timedOut: false, testBytes: 1 }).uploadedBytes === 10000000, 'upload bytes parsed');
  ok(/if \[ "\$FAULT" = kill-openvpn \]; then/.test(CLIENT_SCRIPT) && CLIENT_SCRIPT.indexOf('OVP=$(pidof openvpn)') > 0 && CLIENT_SCRIPT.indexOf('OVP=$(pidof openvpn)') < CLIENT_SCRIPT.indexOf('STEP stop') && !/pkill -9 -x/.test(CLIENT_SCRIPT), 'openvpn kill fault runs only when FAULT=kill-openvpn, before stop (#11 A/B)');
  ok(/^probe a$/m.test(CLIENT_SCRIPT) && /^probe b$/m.test(CLIENT_SCRIPT) && CLIENT_SCRIPT.indexOf('probe a') < CLIENT_SCRIPT.indexOf('STEP download') && CLIENT_SCRIPT.lastIndexOf('probe b') > CLIENT_SCRIPT.indexOf('echo "DOWNLOAD $DL"') && CLIENT_SCRIPT.lastIndexOf('probe b') < CLIENT_SCRIPT.indexOf('STEP stop'), 'counter probe after connect and after the download, before stop (Q0429)');
  eq(good.stopRc, 0); eq(good.afterStop, '"status": "ENDED"'); eq(good.stopError, null);
  const bad = parseClientOutput('SID a\nSTOP_RC 1\nSTOP_ERR_BEGIN\nrpc error: session not found\nSTOP_ERR_END\nDONE\n', { exitCode: 0, timedOut: false, testBytes: 1 });
  eq(bad.stopRc, 1); ok(/session not found/.test(bad.stopError), 'stop error kept for the log');
});
await t('cb33092e protocol bits: wg 1, v2ray 2, openvpn 4, amneziawg 8, xray 16, hysteria2 32 (node-3/node-4 live)', async () => {
  const { protocolNames, PROTOCOL_BITS } = await import('../lib/solana/idl.js');
  // node-4 on chain 2026-11-07 (FS36 table): port → bits → the service its config and metadata name.
  const live = [[1, 'wireguard'], [8, 'amneziawg'], [2, 'v2ray'], [16, 'xray'], [4, 'openvpn'], [32, 'hysteria2']];
  for (const [bits, name] of live) eq(protocolNames(bits).join(','), name, `bits ${bits}`);
  eq(protocolNames(63).length, 6, 'every bit maps to one protocol');
  // Mutant control: the pre-cb33 table must fail this same check.
  const old = new Map([[1, 'wireguard'], [2, 'v2ray'], [4, 'xray'], [8, 'openvpn'], [16, 'hysteria2'], [32, 'amneziawg']]);
  eq(live.filter(([bits, name]) => old.get(bits) !== name).length, 4, 'the old table misnames 4 of 6');
  ok(PROTOCOL_BITS.every(([bit, name]) => live.some(([b, n]) => b === bit && n === name)), 'table = live values');
});
await t('RPC plan: 429 backoff doubles 1 s → 30 s cap, calls are paced and counted', async () => {
  const { rateLimitBackoffMs, rpcCall, rpcCounters } = await import('../lib/solana/rpc.js');
  const seq = [1, 2, 3, 4, 5, 6, 7].map(() => rateLimitBackoffMs('https://test.invalid/a'));
  eq(seq.join(','), '1000,2000,4000,8000,16000,30000,30000');
  eq(rateLimitBackoffMs('https://test.invalid/b'), 1000, 'per endpoint');
  rpcCounters({ reset: true });
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) await rpcCall(async () => i, { label: 'pace' });
  ok(Date.now() - t0 >= 550, `4 calls take ≥ 600 ms at 5/s (took ${Date.now() - t0} ms)`);
  const c = rpcCounters();
  eq(c.requests, 4); eq(c.rateLimited, 0);
});
await t('cb33092e IDL: rent_recipient fields decode, open_subscription carries the rent recipient arg', async () => {
  const { BorshCoder, BN } = (await import('@coral-xyz/anchor')).default;
  const { loadIdl } = await import('../lib/solana/idl.js');
  const idl = loadIdl();
  const coder = new BorshCoder(idl);
  const rr = Keypair.generate().publicKey;
  const data = coder.instruction.encode('open_subscription', {
    expected_price: new BN(5), expected_duration_seconds: 60, expected_data_cap_gb: 1, expected_max_connections: 1,
    subscription_rent_recipient: rr,
  });
  eq(data.length, 8 + 8 + 4 + 4 + 1 + 32, 'discriminator + 4 terms + 32-byte rent recipient');
  ok(data.subarray(data.length - 32).equals(rr.toBuffer()), 'rent recipient is the last arg');
  for (const n of ['Channel', 'User', 'Subscription', 'Node', 'Plan']) {
    const f = idl.types.find((x) => x.name === n).type.fields.map((x) => x.name);
    ok(f.includes('rent_recipient') && !f.includes('rent_payer'), `${n} has rent_recipient`);
  }
});

console.log('sqlite (in-memory, shared Cosmos schema + Solana tables)');
await t('Cosmos results/error_logs accept Solana results; failure log is stored', () => {
  coreDb.useDb(coreDb.getDb(':memory:'));
  const run = coreDb.insertRun({ started_at: Date.now(), mode: 'p2p', wallet_address: KNOWN.owner });
  const nodeA = pk(); const nodeB = pk();
  coreDb.insertResult(run, { address: nodeA, type: 'WireGuard', moniker: 'a', country: 'United States', actualMbps: 50, sdk: 'dvpnd', diag: { latencyMs: 120 }, timestamp: new Date().toISOString() });
  const failId = coreDb.insertResult(run, { address: nodeB, type: 'Hysteria2', actualMbps: null, error: 'no bytes', errorCode: ERR.TUNNEL_NO_TRAFFIC });
  coreDb.insertErrorLog({ result_id: Number(failId), stage: 'download', error_code: ERR.TUNNEL_NO_TRAFFIC, error_message: 'no bytes', log_snippet: 'tail' });
  const errs = coreDb.getNodeErrors(nodeB, { limit: 5 });
  eq(errs.length, 1); eq(errs[0].error_code, ERR.TUNNEL_NO_TRAFFIC); eq(errs[0].log_snippet, 'tail');
  const row = coreDb.getDb().prepare('SELECT * FROM results WHERE node_addr = ?').get(nodeA);
  eq(row.service_type, 'wireguard'); eq(row.latency_ms, 120); eq(row.pass, 1); eq(row.sdk, 'dvpnd');
});
await t('Solana tables: channels idempotent, unknown columns ignored, reports, kv', () => {
  solDb.recordChannel({ address: KNOWN.channel, node_addr: KNOWN.node, run_id: 1, escrow_base: 200000 });
  solDb.recordChannel({ address: KNOWN.channel, node_addr: KNOWN.node, run_id: 1, escrow_base: 1 });
  eq(solDb.listChannels({ openOnly: true }).length, 1, 'idempotent'); eq(solDb.listChannels()[0].escrow_base, 200000);
  solDb.updateChannel(KNOWN.channel, { status: 'closed', refunded_base: 199900, not_a_column: 1 });
  eq(solDb.listChannels({ openOnly: true }).length, 0);
  solDb.insertReport({ signature: 'sig1', slot: 1, run_id: 1, record_count: 2, memo: 'SNTR1|v3' });
  solDb.insertReport({ signature: 'sig1', slot: 1, run_id: 1, record_count: 2, memo: 'SNTR1|v3' });
  eq(solDb.listReports().length, 1);
  solDb.kvSet('refundPending', '1'); eq(solDb.kvGet('refundPending'), '1'); eq(solDb.kvGet('nope'), null);
});

console.log('devnet account decoding (fixture)');
if (process.env.CAPTURE === '1' || !existsSync(FIX)) {
  const { rpcCall } = await import('../lib/solana/rpc.js');
  mkdirSync(FIX_DIR, { recursive: true });
  const out = {};
  for (const [name, addr] of [['node', KNOWN.node], ['channel', KNOWN.channel]]) {
    const info = await rpcCall((c) => c.getAccountInfo(new PublicKey(addr), 'confirmed'), { label: `fixture:${name}` });
    if (!info) throw new Error(`fixture ${name} ${addr} not found on devnet`);
    out[name] = { address: addr, data: Buffer.from(info.data).toString('base64') };
  }
  writeFileSync(FIX, JSON.stringify(out, null, 2) + '\n');
  console.log(`  (captured ${FIX})`);
}
const fx = JSON.parse(readFileSync(FIX, 'utf8'));
await t('Node account: deployed size, owner, uri, protocol, country', () => {
  const data = Buffer.from(fx.node.data, 'base64');
  eq(data.length, DEPLOYED_SIZES.node); eq(accountSize('node'), 337);
  const n = decodeAccount('node', data);
  eq(n.owner, KNOWN.owner); eq(n.uri, 'https://127.0.0.1:8443'); eq(n.protocolNames.join(), 'wireguard'); eq(n.country, 'US');
  eq(pda.node(n.owner, Buffer.from(n.nodeId, 'hex')).toBase58(), KNOWN.node, 'PDA re-derives');
  eq(new PublicKey(data.subarray(OFFSETS.node.owner, OFFSETS.node.owner + 32)).toBase58(), KNOWN.owner, 'owner memcmp offset');
});
await t('Channel account: deployed 299 B layout, owner/node offsets, voucher mode', () => {
  const data = Buffer.from(fx.channel.data, 'base64');
  eq(data.length, 299);
  const c = decodeAccount('channel', data);
  eq(c.owner, KNOWN.owner); eq(c.node, KNOWN.node); eq(c.mode, 0); eq(c.escrow, '200000'); eq(c.voucherSigner !== undefined, true, 'devnet voucher_signer field present');
  eq(new PublicKey(data.subarray(OFFSETS.channel.owner, OFFSETS.channel.owner + 32)).toBase58(), KNOWN.owner, 'owner offset');
  eq(new PublicKey(data.subarray(OFFSETS.channel.node, OFFSETS.channel.node + 32)).toBase58(), KNOWN.node, 'node offset');
  eq(pda.channel(c.owner, Buffer.from(c.channelId, 'hex')).toBase58(), KNOWN.channel, 'channel PDA re-derives');
});

// ─── Per-hour (stream) channels and plan (ticket) runs ──────────────────────
console.log('per-hour and plan runs');
const { credentialArgs, streamEscrow } = await import('../audit/session-runner.js');
const { closedEventFromLogs, serialized } = await import('../audit/channels.js');
const { parseProviderOverrides } = await import('../lib/plans.js');
const { resolvePlanRun, isNodeFault } = await import('../audit/pipeline.js');
const { PROGRAM_ID: PID } = await import('../lib/solana/program.js');
const { DOMAIN_PROVIDER_METADATA } = await import('../lib/nodeapi.js');
const PK = (n) => new PublicKey(Buffer.alloc(32, n)).toBase58();

await t('session credential flags: voucher per GB, stream per hour, ticket for plans', () => {
  eq(credentialArgs({ kind: 'gigabytes', escrow: '200000' }), '--new-channel --mode voucher --escrow-base-units 200000');
  eq(credentialArgs({ kind: 'hours', escrow: '1000' }), '--new-channel --mode stream --escrow-base-units 1000');
  eq(credentialArgs({ kind: 'ticket', provider: PK(1), subscription: PK(2) }), `--ticket --provider ${PK(1)} --subscription ${PK(2)}`);
  let threw = false; try { credentialArgs({ kind: 'ticket', provider: 'x; rm -rf /', subscription: PK(2) }); } catch (e) { threw = true; }
  ok(threw, 'a non-base58 provider must be refused (the flags are word-split in the client shell)');
  threw = false; try { credentialArgs({ kind: 'hours', escrow: '1 --x' }); } catch (e) { threw = true; }
  ok(threw, 'escrow must be digits only');
  ok(CLIENT_SCRIPT.includes('client start --node "$NODE" $CRED') && !CLIENT_SCRIPT.includes('--mode voucher'), 'the client script takes the credential from CRED, no hard-coded voucher mode');
});
await t('client script speaks the cb33092e interface (old names are ignored silently by the client)', () => {
  for (const want of ['sentinel-dvpnd init --instance c1', 'sentinel-dvpnd run --instance c1', 'sentinel-dvpn --home', '--daemon.endpoint $I/daemon.sock', '--instance c1', 'daemon status', 'SERVING',
    'client start', 'client status', 'client stop', '$I/keys/operator.json', 's#^dns_backend = ', 's#^dns_servers = ', 's#^prepay_bytes = ', '. /mnt/snt/rpc.env', 'escrow_base_units|']) {
    ok(CLIENT_SCRIPT.includes(want), `client script has ${want}`);
  }
  // The RPC URL can carry an API key: never on a command line (host ps shows every argv).
  ok(!/--rpc\.(url|ws-url)/.test(CLIENT_SCRIPT), 'no --rpc.url / --rpc.ws-url flags');
  ok(!/\benv [A-Z_]+=/.test(CLIENT_SCRIPT), 'no `env VAR=…` (that is argv too)');
  ok(CLIENT_SCRIPT.includes('export SENTINEL_DVPN_RPC_URL="$RPC" SENTINEL_DVPN_RPC_WS_URL="$WS"'), 'CLI gets its own prefix');
  ok(CLIENT_SCRIPT.includes('( unset SENTINEL_DVPN_RPC_URL SENTINEL_DVPN_RPC_WS_URL; export SENTINEL_DVPND_RPC_URL="$RPC" SENTINEL_DVPND_RPC_WS_URL="$WS"; exec sentinel-dvpnd run --instance c1 --home $I )'), 'daemon gets its own prefix only');
  // An earlier R= (flags) was clobbered by the reach probe's R=$(curl …) — live, 2026-11-07.
  ok(!/^RF?=.*rpc/m.test(CLIENT_SCRIPT), 'no RPC flag variable left to clobber');
  const runnerSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'audit', 'session-runner.js'), 'utf8');
  ok(!/`(RPC|WS)=\$\{/.test(runnerSrc), 'RPC/WS never passed as docker run -e (argv)');
  ok(/writeFileSync\(join\(hostDir, 'rpc\.env'\)[^\n]*mode: 0o600/.test(runnerSrc), 'rpc.env written 0600');
  // `url =` also sits under [tx.paymaster] in cb33's config: never rewrite it with a blanket sed.
  for (const gone of ['dvpnctl', 'dvpnd start', '--role client', 'client/config.toml', 'keys/device.json', 's#^url = ', '"message":"ready"', '--daemon.socket', 'session start']) {
    ok(!CLIENT_SCRIPT.includes(gone), `client script still uses the pre-cb33 ${gone}`);
  }
});
await t('client image check: same network/program/mint is not enough, the build must be cb33092e', async () => {
  const { clientBuildOk } = await import('../core/sdk-verify.js');
  ok(clientBuildOk({ tag: 'cb33092e-pure', commit: 'cb33092ec679499d590fcf716b9a03b66f44c417' }), 'the pure build');
  ok(clientBuildOk({ tag: 'unknown', commit: 'cb33092ec679' }), 'plain cb33092e build');
  ok(!clientBuildOk({ tag: 'cf4c372-ddv2', commit: '1d67a99bed' }), 'the cf4c372 client (open_channel → Custom 102 since 2026-11-02) must fail the check');
  ok(!clientBuildOk({ tag: 'fork-cb33-1-ddv19', commit: 'b036236f39' }), 'a dev fork build is not a release');
  ok(clientBuildOk({ tag: 'fork-cb33-4-final2', commit: '9a2e810' }), 'the fleet final release build');
  ok(clientBuildOk({ tag: 'fork-cb33-4-rc1', commit: '6bbc150' }), 'a fleet release candidate');
  ok(clientBuildOk({ tag: 'fork-cb33-4-final6.1', commit: '02b22fc' }), 'a point cut of a final release (final6.1)');
  ok(!clientBuildOk({ tag: 'fork-cb33-4-final6.', commit: '02b22fc' }), 'a half point tag is not a release');
  ok(!clientBuildOk({ tag: 'fork-cb33-4-final2-dirty', commit: '9a2e810' }), 'a suffixed final tag is not a release');
  ok(!clientBuildOk({}), 'an unreadable version must fail');
});
await t('origin egress guard charges the bytes sent, not the bytes asked for (shared node IP refused at 7.75 of 10 GB)', async () => {
  const { createEgressGuard } = await import('../lib/egress-guard.js');
  const g = createEgressGuard({ perIp: 2000, total: 3000 });
  const now = new Date('2026-10-21T18:00:00Z');
  // A steady test: 4 streams ask 150 each, all reserved up front, then stop early.
  const rs = [1, 2, 3, 4].map(() => g.reserve('ip', 150, now));
  ok(rs.every(Boolean) && g.used('ip') === 600, `reserved ${g.used('ip')}`);
  ok(g.reserve('ip', 1500, now) === null, 'parallel requests past the cap are still refused');
  for (const r of rs) g.settle(r, 20);
  ok(g.used('ip') === 80 && g.used() === 80, `settled to the bytes sent: ${g.used('ip')} / ${g.used()}`);
  g.settle(rs[0], 0);
  ok(g.used('ip') === 80, 'settling twice gives nothing back');
  // 12 such tests fit now; with the old up-front charge (600 each) the 4th was already refused.
  for (let i = 0; i < 11; i++) { const r = g.reserve('ip', 600, now); ok(r, `test ${i + 2} refused at ${g.used('ip')}`); g.settle(r, 80); }
  ok(g.used('ip') === 960, `12 tests = ${g.used('ip')}`);
  ok(g.reserve('ip', 1100, now) === null && g.reserve('other', 100, now), 'per-IP cap holds; another IP still served');
  const rTotal = g.reserve('third', 1999, now);
  ok(rTotal === null, `global cap holds (total ${g.used()})`);
  const tomorrow = new Date('2026-10-22T00:00:01Z');
  ok(g.reserve('ip', 2000, tomorrow) && g.used('ip') === 2000, 'a new UTC day starts from zero');
  g.settle(rs[1], 0);
  ok(g.used('ip') === 2000, 'a reservation from yesterday never credits today');
});
await t('a collapsed baseline is flagged and not cached; three in a row become the new level (starved origin read 51 vs ~800)', async () => {
  const { noteBaseline, baselineDegraded, resetBaselineHistory } = await import('../protocol/speedtest.js');
  resetBaselineHistory();
  ok(baselineDegraded(51, [800, 731]) === null, 'fewer than 3 readings: never flagged');
  for (const m of [731, 969, 800]) ok(noteBaseline(m).action === 'normal', `normal ${m}`);
  const d = noteBaseline(51);
  ok(d.action === 'degraded' && d.medianMbps === 800, JSON.stringify(d));
  ok(noteBaseline(780).action === 'normal', 'recovered reading is normal (the 51 never entered the history)');
  ok(noteBaseline(400).action === 'normal', 'just over half is not flagged (400 vs median 790)');
  ok(noteBaseline(100).action === 'degraded' && noteBaseline(110).action === 'degraded', 'two low readings flagged');
  const a = noteBaseline(105);
  ok(a.action === 'accepted' && a.streak.join() === '100,110,105', `third low reading accepted: ${JSON.stringify(a)}`);
  ok(noteBaseline(98).action === 'normal', 'the new level is normal afterwards');
  resetBaselineHistory();
});
await t('load lab: user output parses to epoch times; env is validated; production sessions never run a load profile', async () => {
  const { parseLoad, loadEnv, LOAD_SH } = await import('../audit/load-profile.js');
  const { CLIENT_SCRIPT } = await import('../audit/session-runner.js');
  const out = ['noise', 'LOADT0 1792610000 5000.00', 'LOADP 5001.50 204 0.412 0.274', 'LOADC 5002.00 200 5000000 1.73',
    'LOADC 5006.00 200 2100000 32.00', 'LOADW 5010.25 200 812000 0.95', 'LOADB 5020.00 200 98000000 10.00', 'LOADP 5003.5 000 0 0', 'LOADEND 5030.00 stop'].join('\n');
  const r = parseLoad(out);
  ok(r.t0 === 1792610000000, `t0 ${r.t0}`);
  ok(r.fetches.length === 4 && r.fetches[0].kind === 'chunk' && r.fetches[0].at === 1792610002000 && r.fetches[0].bytes === 5e6, JSON.stringify(r.fetches[0]));
  ok(r.fetches.map((f) => f.kind).join() === 'chunk,chunk,page,bulk', r.fetches.map((f) => f.kind).join());
  ok(r.probes[0].rttMs === 138 && r.probes[0].at === 1792610001500, JSON.stringify(r.probes[0]));
  ok(r.probes[1].rttMs === null, 'a failed probe has no RTT');
  ok(r.end.reason === 'stop' && r.end.at === 1792610030000, JSON.stringify(r.end));
  ok(parseLoad('LOADC 1 200 5 1').fetches[0].at === null, 'no LOADT0 → no invented times');
  const env = loadEnv({ profile: 'stream10', origin: 'https://10.0.0.5:8443/', pin: 'sha256//x', seed: 'abcdef0123456789' });
  ok(env.includes('LOAD_ORIGIN=https://10.0.0.5:8443') && env.includes('LOAD_CHUNK=5000000') && env.includes('LOAD_PERIOD=4'), env.join(' '));
  let threw = 0;
  try { loadEnv({ profile: 'ddos', origin: 'x', pin: 'p', seed: 'abcdef01' }); } catch (err) { threw++; }
  try { loadEnv({ profile: 'bulk', origin: 'x', pin: 'p', seed: 'not-hex!' }); } catch (err) { threw++; }
  ok(threw === 2, 'bad profile / seed refused');
  ok(CLIENT_SCRIPT.includes('if [ -f /mnt/snt/load.sh ]; then . /mnt/snt/load.sh; URLS=; fi'), 'client script sources load.sh only when mounted');
  ok(CLIENT_SCRIPT.includes('while [ $TRY -lt 4 ] && [ -n "$URLS" ]; do'), 'download loop skips when a load user emptied URLS');
  ok(LOAD_SH.includes('/mnt/snt/stop') && LOAD_SH.includes('LOAD_MAX'), 'load user ends on the stop file or LOAD_MAX');
});
await t('load report: knee = last step users were fine, cut = first step the tester read < 10, verdict names who is treated unfairly', async () => {
  const { stepMetrics, kneeAndCut } = await import('./bwlab/load-report.mjs');
  const T = 1_000_000;
  // Step k runs [T + k*1000, T + k*1000 + 1000). Each user streams one chunk per step.
  const mkRun = (rows) => ({
    steps: rows.map((r, k) => ({ n: r.n, live: r.n, start: T + k * 1000, end: T + k * 1000 + 1000, tester: { mbps: r.tester } })),
    users: Array.from({ length: rows[rows.length - 1].n }, (_, ui) => ({
      profile: 'stream10', connectedAt: T - 1, error: null,
      load: {
        fetches: rows.flatMap((r, k) => (ui < r.n ? [{ kind: 'chunk', at: T + k * 1000 + 10, code: '200', bytes: 5e6, seconds: r.chunkSec }] : [])),
        probes: rows.flatMap((r, k) => (ui < r.n ? [{ at: T + k * 1000 + 20, rttMs: r.rtt }] : [])),
        end: { at: T + 99_999 },
      },
    })),
  });
  const fair = kneeAndCut(stepMetrics(mkRun([{ n: 1, chunkSec: 1, rtt: 140, tester: 500 }, { n: 5, chunkSec: 2, rtt: 150, tester: 120 }, { n: 10, chunkSec: 5, rtt: 300, tester: 8 }])));
  ok(fair.knee === 5 && fair.cut === 10 && /unfair to users/.test(fair.verdict), JSON.stringify(fair));
  const early = kneeAndCut(stepMetrics(mkRun([{ n: 1, chunkSec: 1, rtt: 140, tester: 9 }, { n: 5, chunkSec: 2, rtt: 150, tester: 6 }])));
  ok(early.knee === 5 && early.cut === 1 && /unfair to the operator/.test(early.verdict), JSON.stringify(early));
  const atKnee = kneeAndCut(stepMetrics(mkRun([{ n: 1, chunkSec: 1, rtt: 140, tester: 300 }, { n: 5, chunkSec: 3.9, rtt: 200, tester: 9.5 }, { n: 10, chunkSec: 6, rtt: 400, tester: 2 }])));
  ok(atKnee.knee === 5 && atKnee.cut === 5 && /fair/.test(atKnee.verdict) && !/unfair/.test(atKnee.verdict), JSON.stringify(atKnee));
  const m = stepMetrics(mkRun([{ n: 2, chunkSec: 1, rtt: 140, tester: 50 }]))[0];
  ok(m.keptUp === 100 && m.chunkMbpsMedian === 40 && m.rttMedianMs === 140 && m.failed === 0, JSON.stringify(m));
});
await t('channel sweeps run one at a time (timer + CLI overlap closed the same channel twice)', async () => {
  const seen = [];
  let active = 0;
  const job = serialized(async (id, fail) => {
    active++; seen.push(`start ${id} active=${active}`);
    await new Promise((r) => setTimeout(r, 20));
    active--; seen.push(`end ${id}`);
    if (fail) throw new Error(`job ${id} failed`);
    return id;
  });
  const results = await Promise.allSettled([job(1), job(2, true), job(3)]);
  eq(seen.join(' | '), 'start 1 active=1 | end 1 | start 2 active=1 | end 2 | start 3 active=1 | end 3');
  eq(results.map((r) => r.status).join(','), 'fulfilled,rejected,fulfilled', 'a failed sweep reaches its caller and does not block the next one');
});
await t('failures that are not the node\'s fault are skips, never counted against it', () => {
  for (const code of [ERR.PROTOCOL_UNSUPPORTED, ERR.PLAN_CONNECTION_LIMIT, ERR.SPEED_SOURCE_UNAVAILABLE, ERR.CLIENT_EXITED, ERR.DOCKER_UNAVAILABLE]) eq(isNodeFault(code), false, code);
  for (const code of [ERR.TUNNEL_NO_TRAFFIC, ERR.SESSION_START_FAIL, ERR.UNREACHABLE, ERR.TICKET_REFUSED, ERR.CLIENT_TIMEOUT]) eq(isNodeFault(code), true, code);
});
await t('per-hour escrow = 1 hour of channel_price_per_hour; a node with no hourly price is refused', () => {
  eq(streamEscrow('1000'), '1000');
  eq(streamEscrow('250', 2), '500');
  let threw = false; try { streamEscrow('0'); } catch (e) { threw = true; }
  ok(threw, 'price 0 must throw');
});
await t('ChannelClosed event decodes from the close tx logs (returned / redeemed / forfeited)', () => {
  const disc = Buffer.from([119, 198, 23, 254, 216, 124, 84, 16]);
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const data = Buffer.concat([disc, Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3), Buffer.from([1]), u64(1000), u64(17), u64(983), u64(0), u64(5000)]);
  const pid = PID.toBase58();
  const logs = [`Program ${pid} invoke [1]`, 'Program log: Instruction: CloseChannel', `Program data: ${data.toString('base64')}`, `Program ${pid} consumed 9000 of 200000 compute units`, `Program ${pid} success`];
  const ev = closedEventFromLogs(logs);
  ok(ev, 'event found');
  eq(ev.escrow, '1000'); eq(ev.redeemed, '17'); eq(ev.returned, '983'); eq(ev.forfeited, '0');
  eq(closedEventFromLogs([`Program ${pid} invoke [1]`, `Program ${pid} success`]), null, 'no event → null');
});
await t('PROVIDER_API_OVERRIDES parses <providerPda>=<https origin>', () => {
  const m = parseProviderOverrides(`${PK(4)}=https://127.0.0.1:19443/, bad, ${PK(5)}=ftp://x`);
  eq(m.get(PK(4)), 'https://127.0.0.1:19443'); eq(m.size, 1);
});
await t('provider metadata verifies under the provider domain only', () => {
  const kp = nacl.sign.keyPair();
  const payload = JSON.stringify({ owner: 'o', api: { tls_sha256: 'ab' } });
  const digest = createHash('sha256').update(payload).digest();
  const sig = nacl.sign.detached(Buffer.concat([DOMAIN_PROVIDER_METADATA, digest]), kp.secretKey);
  const text = `{"payload":${payload},"signature":"${Buffer.from(sig).toString('base64')}","signer":"${new PublicKey(kp.publicKey).toBase58()}"}`;
  const json = JSON.parse(text);
  ok(verifySignedMetadata(text, json, DOMAIN_PROVIDER_METADATA), 'verifies with the provider domain');
  ok(!verifySignedMetadata(text, json), 'must NOT verify as node metadata (domain separation)');
});
await t('plan run refuses a subscription that is not ours / another plan / expired / wrong provider', async () => {
  const me = PK(7); const plan = PK(8); const prov = PK(9); const now = 1_000_000;
  const sub = { owner: me, plan, provider: prov, expiresAt: String(now + 60), dataCapGb: 1 };
  const run = (s, granter = prov) => resolvePlanRun(me, plan, PK(6), granter, { now, fetchSub: async () => s });
  const r = await run(sub);
  eq(r.provider, prov); eq(r.subscriptionId, PK(6)); eq(r.planId, plan);
  const refuse = async (s, granter, re) => { let m = ''; try { await run(s, granter); } catch (e) { m = e.message; } ok(re.test(m), `expected ${re}, got "${m}"`); };
  await refuse(null, prov, /not found/);
  await refuse({ ...sub, owner: PK(10) }, prov, /belongs to/);
  await refuse({ ...sub, plan: PK(11) }, prov, /is for plan/);
  await refuse({ ...sub, expiresAt: String(now - 1) }, prov, /expired/);
  await refuse(sub, PK(12), /does not run this plan/);
  eq((await run(sub, null)).provider, prov, 'granter optional: taken from the subscription');
});

await t('plan reconnects reuse the stored ticket (a ticket is a slot for its TTL)', async () => {
  const { ticketStoreDir } = await import('../audit/session-runner.js');
  const S = CLIENT_SCRIPT;
  const restore = S.indexOf('cp /mnt/tix/data.db* $I/');
  ok(restore > 0 && restore < S.indexOf('STEP daemon'), 'store restored before the daemon starts');
  const save = S.indexOf('cp $I/data.db* /mnt/tix/');
  ok(save > S.lastIndexOf('kill -TERM $DP') && save > S.indexOf('STEP stop'), 'store saved after the daemon stops');
  ok(S.indexOf('$C client tickets') < S.indexOf('echo "CRED $CRED"'), 'stored tickets looked up before connect');
  ok(/for TH in \$THS; do/.test(S) && /case "\$TH" in \*\[!A-Za-z0-9\]\*\) continue;; esac/.test(S) && /--ticket-hash \$TH/.test(S), 'every stored ticket is tried with a validated --ticket-hash');
  ok(/sort -rn/.test(S.slice(S.indexOf('$C client tickets'), S.indexOf('for TH in $THS'))), 'stored tickets tried newest expiry first');
  ok(/TICKET_REUSE_OK \$TH"; REUSED=\$TH; break;/.test(S), 'the first accepted ticket ends the loop');
  ok(/DP=\$!\n[\s\S]{0,400}trap 'kill -TERM \$DP 2>\/dev\/null; wait \$DP 2>\/dev\/null' EXIT\ntrap 'exit 143' TERM INT/.test(S), 'every exit stops the daemon and waits (its RPC websocket closes before the container goes)');
  ok(S.indexOf('CRED=$NEWCRED') > S.indexOf('for TH in $THS') && /if \[ \$RC -ne 0 \]; then\n  CRED=\$NEWCRED/.test(S), 'a new ticket is asked only after every stored one was refused');
  ok(/"\$E" -gt \$\(\(NOW\+120\)\)/.test(S), 'a ticket within 2 min of expiry is not reused');
  const r = parseClientOutput('SID a\nTICKET_REUSE ab12CD\nTICKET_REUSE_OK ab12CD\nDONE\n', { exitCode: 0, timedOut: false, testBytes: 1 });
  ok(r.ticketReused === 'ab12CD' && r.ticketReuseFailed === false, 'reuse parsed');
  const r2 = parseClientOutput('SID a\nTICKET_REUSE ab12\nTICKET_REUSE_FAILED ab12 x\nTICKET_REUSE cd34\nTICKET_REUSE_OK cd34\nDONE\n', { exitCode: 0, timedOut: false, testBytes: 1 });
  ok(r2.ticketReused === 'cd34' && r2.ticketReuseFailed === true, 'a refused ticket then an accepted one: both recorded');
  ok(parseClientOutput('SID a\nTICKET_REUSE ab12\nTICKET_REUSE_FAILED ab12 x\nDONE\n', { exitCode: 0, timedOut: false, testBytes: 1 }).ticketReused === null, 'an attempt that was refused is not counted as reused');
  let threw = false; try { ticketStoreDir('../../etc'); } catch (err) { threw = /subscription address/.test(err.message); }
  ok(threw, 'store dir refuses a non-address (no path tricks)');
});

await t('cb33 node refusals of a plan ticket go to the provider check (peer_limit_reached, credit_exhausted, ticket_invalid)', async () => {
  const { TICKET_REFUSAL_RE } = await import('../audit/node-test.js');
  // Verbatim from node-4 (cb33 fork-2), 2026-11-07 19:03Z: provider 409, subscription at max_connections.
  ok(TICKET_REFUSAL_RE.test('calling daemon: rpc error: code = FailedPrecondition desc = failed precondition: peer_limit_reached: peer limit reached'), 'peer_limit_reached');
  ok(TICKET_REFUSAL_RE.test('failed precondition: credit_exhausted: credit exhausted'), 'credit_exhausted');
  ok(TICKET_REFUSAL_RE.test('ticket_invalid'), 'ticket_invalid (older nodes)');
  ok(!TICKET_REFUSAL_RE.test('calling daemon: rpc error: code = Unavailable desc = connection refused'), 'a dead node is not sent to the provider check');
});

await t('ticket_invalid is diagnosed at the provider: 409 → connection limit, 402 → data used up, 403 → refused, 200 → node fault', async () => {
  const { diagnoseTicketRefusal } = await import('../lib/plans.js');
  const api = { origin: 'https://p', tlsSha256: 'ab' };
  const refuse = (status, body) => async () => { const e = new Error(`HTTP ${status}`); e.status = status === 401 ? 403 : status === 409 ? 409 : status >= 500 ? 502 : 403; e.errorCode = status >= 500 ? 'provider-unreachable' : 'ticket-refused'; e.providerResponse = body; throw e; };
  const v = async (requestTicket) => (await diagnoseTicketRefusal(null, { provider: PK(1), subscription: PK(2), node: PK(3) }, { api, requestTicket })).verdict;
  eq(await v(refuse(409, { error: { code: 'peer_limit_reached', message: 'peer limit reached' } })), 'connection-limit');
  eq(await v(refuse(402, { error: { code: 'credit_exhausted', message: 'credit exhausted' } })), 'credit-exhausted');
  eq(await v(refuse(403, { error: { code: 'subscription_invalid', message: 'node not in plan' } })), 'refused');
  eq(await v(async () => ({ ticket: {} })), 'node');
  eq(await v(refuse(503, 'down')), 'unknown');
});

console.log('admin DNS → client container');
await t('dnsToml passes literal IPs only and falls back to Cloudflare', async () => {
  const { dnsToml } = await import('../audit/session-runner.js');
  eq(dnsToml(['8.8.8.8', '8.8.4.4']), "'8.8.8.8', '8.8.4.4'");
  eq(dnsToml(['2606:4700:4700::1111']), "'2606:4700:4700::1111'");
  eq(dnsToml(["1.1.1.1'; rm -rf /", 'evil.example', '9.9.9.9']), "'9.9.9.9'", 'non-IP entries dropped');
  eq(dnsToml([]), "'1.1.1.1', '1.0.0.1'");
  eq(dnsToml(undefined), "'1.1.1.1', '1.0.0.1'");
});
await t('the client script writes the DNS choice into dns_servers', async () => {
  const { CLIENT_SCRIPT } = await import('../audit/session-runner.js');
  ok(CLIENT_SCRIPT.includes('s#^dns_servers = .*#dns_servers = [$DNS_TOML]#'), 'dns_servers sed missing');
});

console.log('page edits');
await t('page-edits parser: exact, counted and span edits; drift fails loudly', async () => {
  const { parseEdits, applyEdit } = await import('./dev/patch-pages.mjs');
  const edits = parseEdits([
    '# comment', '=== a.html :: one', '--- from', 'P2P', '--- to', 'tDVPN', '',
    '=== a.html :: two :: 2', '--- from', 'x', '--- to', 'y',
    '# ─── section', '=== a.html :: span', '--- from-start', '<b>', '--- from-end', '</b>', '--- to', '# shell comment kept', '<i/>',
  ].join('\n'));
  eq(edits.length, 3);
  eq(edits[2].parts.to, '# shell comment kept\n<i/>');
  let src = 'P2P x x <b>old</b>';
  for (const e of edits) src = applyEdit(src, e);
  eq(src, 'tDVPN y y # shell comment kept\n<i/>');
  let m = '';
  try { applyEdit('nothing here', edits[0]); } catch (err) { m = err.message; }
  ok(/expected 1 match\(es\), found 0/.test(m), `drift must fail, got "${m}"`);
  m = '';
  try { parseEdits('stray text'); } catch (err) { m = err.message; }
  ok(/stray line/.test(m), 'stray line must fail');
});

console.log('CLI prints Solana names');
await t('every Cosmos API key is renamed, nested too, and settings accept the Solana names', () => {
  const api = { state: { balanceUdvpn: '1', runSpentUdvpn: '2', runGranter: 'P', results: [{ spentUdvpn: '3', gigabyte_prices: [{ denom: 'tdvpn' }] }] }, plans: [{ ownerSentAddr: 'P', feeGrantActive: true, feeGrantCheckFailed: false, selfGranter: true, grantedBytes: '9' }], mnemonic: 'set', defaults: { maxPriceUdvpn: 0 } };
  const out = JSON.stringify(solanaNames(api));
  ok(!/Udvpn|[Gg]rant|ownerSent|denom|mnemonic/.test(out), `Cosmos name left: ${out}`);
  for (const v of Object.values(SOLANA_KEYS)) ok(out.includes(`"${v}"`), `${v} missing`);
  eq(JSON.stringify(parseKv(['maxPriceBase=5', 'gigabytes=1'])), '{"maxPriceUdvpn":5,"gigabytes":1}', 'settings input');
  eq(JSON.stringify(solanaNames({ a: [1, null, 'x'] })), '{"a":[1,null,"x"]}', 'non-objects untouched');
});

console.log('speed lab: unpredictable content and the lab transcript');
{
  const { expectedSha256, contentChunks, contentKey } = await import('../lib/speed-content.js');
  const { parseLab, analyzeLab, steadyState, labPlan } = await import('../audit/speed-lab.js');
  const SECRET = 'a'.repeat(64);
  await t('content depends on secret and seed, and prefixes hash consistently', () => {
    const one = Buffer.concat([...contentChunks(SECRET, 'aa11', 200_000)]);
    eq(one.length, 200_000, 'length');
    ok(!one.equals(Buffer.concat([...contentChunks(SECRET, 'aa12', 200_000)])), 'other seed must differ');
    ok(!one.equals(Buffer.concat([...contentChunks('b'.repeat(64), 'aa11', 200_000)])), 'other secret must differ');
    eq(expectedSha256(SECRET, 'aa11', 70_000), createHash('sha256').update(one.subarray(0, 70_000)).digest('hex'), 'prefix hash');
    ok(contentKey(SECRET, 'aa11').length === 32, 'key size');
  });
  // Synthetic transcript: 2 streams over 6 s on eth0 (1 s ramp, then flat), idle and loaded probes.
  const seedA = 'cafe0111';
  const seedB = 'cafe0112';
  const bytes = 12_386_364; // payload = wire / 1.1, split over 2 streams
  const shaA = expectedSha256(SECRET, seedA, bytes);
  const shaB = expectedSha256(SECRET, seedB, bytes);
  const ls = [];
  let rx = 1000;
  for (let i = 0; i <= 60; i++) {
    // 1 s ramp at 8 Mbps of wire, then a flat 42 Mbps of wire (10 % above the payload rate)
    const inc = i === 0 ? 0 : i <= 10 ? 100_000 : 525_000;
    rx += inc;
    ls.push(`LS ${(100 + i * 0.1).toFixed(2)} eth0=${rx} wg0=7`);
  }
  const transcript = [
    'LAB_START 99.00 M3:2:6',
    'LAB_IL 0.010 0.030 204', 'LAB_IL 0.010 0.032 204', 'LAB_IL 0.010 0.028 204', 'LAB_IL 0.010 0.031 204', 'LAB_IL 0.010 9 000',
    'LAB_BEGIN M3 2 6 100.00',
    ...ls,
    'LAB_LP M3 0.010 0.060 204', 'LAB_LP M3 0.010 0.080 204',
    'LAB_SS_BEGIN M3', 'cubic wscale:7,7 rto:204 rtt:21.5/3.2 retrans:0/3 mss:1448', 'LAB_SS_END M3',
    'LAB_END M3 106.10',
    `LAB_W M3 1 ${seedA} ${bytes} 0.001 0.020 0.050 0.080 6.0 200 28`,
    `LAB_W M3 2 ${seedB} ${bytes} 0.001 0.021 0.052 0.090 6.0 200 28`,
    `LAB_H M3 1 ${shaA}`,
    `LAB_H M3 2 ${shaB}`,
    'LAB_DONE 106.20',
  ].join('\n');
  await t('parseLab reads idle/loaded probes, streams, hashes, samples and ss', () => {
    const lab = parseLab(transcript);
    ok(lab.started && lab.done, 'start/done');
    eq(lab.idle.length, 4, 'idle probes (the failed 000 one dropped)');
    const m = lab.methods.M3;
    eq(m.streamsOut.length, 2, 'streams');
    eq(m.samples.length, 61, 'samples');
    eq(m.retrans, 3, 'retrans');
    eq(m.loaded.length, 2, 'loaded probes');
  });
  await t('analyzeLab verifies content and finds the steady state after the ramp', () => {
    const a = analyzeLab(parseLab(transcript), { secret: SECRET });
    const m = a.methods[0];
    eq(m.verified, true, 'verified');
    eq(m.httpOk, true, 'http');
    eq(m.iface, 'eth0', 'busiest interface');
    eq(m.naiveMbps, 33.03, 'naive = 24.77 MB over 6 s, ramp included');
    eq(m.steadyMbps, 38.18, 'steady = 42 Mbps of wire scaled to payload');
    eq(m.rampSeconds, 1, 'ramp');
    eq(a.idleLatency.medianMs, 20.5, 'idle latency median');
    eq(m.loadedLatency.medianMs, 60, 'loaded latency median');
    eq(m.falling, false, 'flat is not falling');
  });
  await t('tampered content is caught (a node serving other bytes)', () => {
    const bad = transcript.replace(shaB, '0'.repeat(64));
    eq(analyzeLab(parseLab(bad), { secret: SECRET }).methods[0].verified, false, 'verified');
  });
  await t('burst then throttle is flagged', () => {
    const samples = [];
    let r = 0;
    for (let i = 0; i <= 90; i++) { r += i <= 45 ? 1_000_000 : 300_000; samples.push({ t: i * 0.1, rx: { eth0: r } }); }
    eq(steadyState(samples, 'eth0').falling, true, 'falling');
  });
  await t('a stream that finishes early on its byte cap ends the steady window (no false falling flag)', () => {
    // 10 s plan: 4 s at 50 Mbps of wire, then one stream hits its cap and the rate halves.
    const lsCap = [];
    let rc = 1000;
    for (let i = 0; i <= 100; i++) { rc += i === 0 ? 0 : i <= 40 ? 625_000 : 312_500; lsCap.push(`LS ${(100 + i * 0.1).toFixed(2)} eth0=${rc}`); }
    const capT = ['LAB_START 99.00 C:2:10', 'LAB_BEGIN C 2 10 100.00', ...lsCap, 'LAB_END C 110.10',
      `LAB_W C 1 ${seedA} ${bytes} 0.001 0.020 0.050 0.080 4.05 200 0`,
      `LAB_W C 2 ${seedB} ${bytes} 0.001 0.021 0.052 0.090 10.0 200 28`,
      `LAB_H C 1 ${shaA}`, `LAB_H C 2 ${shaB}`, 'LAB_DONE 110.20'].join('\n');
    const m = analyzeLab(parseLab(capT), { secret: SECRET }).methods[0];
    eq(m.falling, false, 'not falling');
    eq(m.windowSeconds, 4.05, 'window ends at the early stream');
    eq(m.steadyWireMbps, 50, 'steady = the 2-stream rate');
  });
  await t('a sample line damaged by interleaved output does not poison the rate', () => {
    const damaged = transcript.replace(/^LS 100\.00 eth0=\d+ wg0=7$/m, 'LS 100.00 etLAB_LP M3 0.010 0.060 204');
    ok(damaged !== transcript, 'fixture line found');
    const m = analyzeLab(parseLab(damaged), { secret: SECRET }).methods[0];
    eq(m.iface, 'eth0', 'interface still found');
    ok(Number.isFinite(m.steadyMbps), `steady ${m.steadyMbps}`);
  });
  await t('line rate counts eth0, not a client tun device that counts more (Hysteria2)', () => {
    // hy2-client grows 10 % faster than eth0: it is the "busiest" interface, but not the line.
    const tunT = transcript.replace(/^LS (\S+) eth0=(\d+) wg0=7$/gm, (_, t, e) => `LS ${t} eth0=${e} hy2-client=${Math.round(Number(e) * 1.1)}`);
    ok(tunT !== transcript, 'fixture lines found');
    const m = analyzeLab(parseLab(tunT), { secret: SECRET }).methods[0];
    eq(m.iface, 'hy2-client', 'busiest is the tun device');
    eq(m.lineIface, 'eth0', 'line interface');
    eq(m.lineMbps, 42, 'line rate = eth0 steady rate');
    eq(m.steadyMbps, 38.18, 'payload rate unchanged');
  });
  await t('labPlan formats id:streams:seconds', () => {
    eq(labPlan([{ id: 'M2', streams: 1, seconds: 10 }, { id: 'M3', streams: 8, seconds: 10 }]), 'M2:1:10 M3:8:10');
    eq(labPlan([{ id: 'S', streams: 4, seconds: 10, capBytes: 150_000_000 }]), 'S:4:10:150000000', 'byte cap field');
  });

  // ─── Steady speed method (lib/speed-method.js) ───
  const { steadyConfig, perStreamCap, steadyLab, steadyResult, selectedSpeedMethod, speedMethodStatus } = await import('../lib/speed-method.js');
  const PIN = `sha256//${'A'.repeat(43)}=`;
  const envOn = { SPEED_METHOD: 'steady', SPEED_ORIGIN: 'https://203.0.113.5:8443/', SPEED_PIN: PIN, SPEED_SECRET: ` ${SECRET}\r\n` };
  await t('steady is the default method; classic is an explicit opt-out', () => {
    eq(selectedSpeedMethod({}), 'steady', 'unset = steady');
    eq(selectedSpeedMethod({ SPEED_METHOD: ' Classic ' }), 'classic', 'case and spaces ignored');
    let threw = false;
    try { selectedSpeedMethod({ SPEED_METHOD: 'stedy' }); } catch { threw = true; }
    ok(threw, 'a typo is refused, never silently mapped');
    eq(steadyConfig({ SPEED_METHOD: 'classic' }), null, 'classic → no steady config');
    threw = false;
    try { steadyConfig({}); } catch { threw = true; }
    ok(threw, 'default steady with no origin throws (callers fall back to classic and say so)');
    const { SPEED_METHOD, ...envDefault } = envOn;
    eq(steadyConfig(envDefault).origin, 'https://203.0.113.5:8443', 'origin set, SPEED_METHOD unset → steady');
    eq(steadyConfig({ ...envDefault, SPEED_ORIGIN: 'https://203.0.113.5' }).origin, 'https://203.0.113.5', 'port optional (443)');
  });
  await t('speedMethodStatus says what runs and why', async () => {
    const off = await speedMethodStatus({ SPEED_METHOD: 'classic' });
    eq(`${off.selected}/${off.active}/${off.ready}`, 'classic/classic/true', 'classic selected');
    const bad = await speedMethodStatus({});
    eq(`${bad.selected}/${bad.active}/${bad.ready}`, 'steady/classic/false', 'steady selected but unconfigured → classic, not ready');
    ok(/classic method used/.test(bad.problem), 'the fallback is named');
    const on = await speedMethodStatus(envOn, { probe: false });
    eq(`${on.active}/${on.version}/${on.streams}x${on.seconds}`, 'steady/steady-v1/4x10', 'steady active');
    ok(!('secret' in on), 'the secret is never returned');
  });
  await t('steadyConfig validates when on', () => {
    const c = steadyConfig(envOn);
    eq(c.origin, 'https://203.0.113.5:8443', 'trailing slash dropped');
    eq(c.secret, SECRET, 'secret trimmed (CRLF)');
    eq(`${c.streams}/${c.seconds}/${c.budgetBytes}`, '4/10/600000000', 'defaults');
    let threw = false;
    try { steadyConfig({ ...envOn, SPEED_ORIGIN: 'http://x' }); } catch { threw = true; }
    ok(threw, 'plain http origin refused');
    threw = false;
    try { steadyConfig({ ...envOn, SPEED_SECRET: 'short' }); } catch { threw = true; }
    ok(threw, 'short secret refused');
  });
  await t('perStreamCap keeps a test inside 60 % of the per-GB prepay', () => {
    const c = steadyConfig(envOn);
    eq(perStreamCap(c), 150_000_000, 'budget / streams');
    eq(perStreamCap(c, 1e9), 147_500_000, '(600 MB − 10 MB classic) / 4');
    eq(perStreamCap(c, 100_000_000), 12_500_000, 'small prepay');
    const lab = steadyLab(c, { prepayBytes: 1e9 });
    eq(lab.plan, 'S:4:10:147500000', 'plan');
    ok(/^[0-9a-f]{16}$/.test(lab.seedBase) && lab.noTrace === true, 'hex seed base, no trace');
  });
  // Regression: Node resumes TLS sessions, and a resumed session carries no server certificate, so
  // every pinned request after the first read "pin mismatch" (live CLI speed-test, 2026-10-21).
  await t('pinned origin checks hold on repeated connections; the baseline verifies its bytes', async () => {
    const https = await import('node:https');
    const { X509Certificate } = await import('node:crypto');
    const { contentChunks } = await import('../lib/speed-content.js');
    const { originReachable, measureSteadyBaseline } = await import('../lib/speed-method.js');
    const cert = readFileSync(new URL('../test/fixtures/tls-test-cert.pem', import.meta.url));
    const key = readFileSync(new URL('../test/fixtures/tls-test-key.pem', import.meta.url));
    const spki = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
    const pin = `sha256//${createHash('sha256').update(spki).digest('base64')}`;
    const srv = https.createServer({ cert, key }, (req, res) => {
      const u = new URL(req.url, 'https://x');
      if (u.pathname === '/p') { res.writeHead(204); return res.end(); }
      const n = Number(u.searchParams.get('n'));
      res.writeHead(200, { 'Content-Length': String(n) });
      for (const c of contentChunks(SECRET, u.searchParams.get('s'), n)) res.write(c);
      res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const cfg = { origin: `https://127.0.0.1:${srv.address().port}`, pin, secret: SECRET, streams: 2, seconds: 3, budgetBytes: 20e6 };
      const checks = [];
      for (let i = 0; i < 4; i++) checks.push(await originReachable(cfg));
      eq(checks.join(','), 'true,true,true,true', 'every repeated pinned check passes');
      eq(await originReachable({ ...cfg, pin: `sha256//${'B'.repeat(43)}=` }), false, 'a wrong pin is refused');
      const b = await measureSteadyBaseline(cfg);
      ok(b.bytes === 20e6 && b.mbps > 0 && b.method === 'steady-v1', `baseline verified ${b.bytes} B at ${b.mbps} Mbps`);
      const b2 = await measureSteadyBaseline(cfg);
      ok(b2.bytes === 20e6, 'a second baseline (new connections) verifies too');
      let threw = '';
      try { await measureSteadyBaseline({ ...cfg, secret: 'c'.repeat(64) }); } catch (err) { threw = err.message; }
      ok(/did not verify/.test(threw), 'bytes that do not match our secret are refused');
    } finally {
      srv.close();
    }
  });
  await t('steadyResult: verified reading, tampering, and a missing block', () => {
    const c = steadyConfig(envOn);
    const sTranscript = transcript.replace(/\bM3\b/g, 'S');
    const r = steadyResult(sTranscript, c);
    eq(r.ok, true, `ok (${r.reason})`);
    eq(r.mbps, 38.18, 'steady payload Mbps');
    ok(r.lineMbps != null && r.lineMbps >= r.mbps, `line rate ${r.lineMbps} ≥ payload ${r.mbps}`);
    eq(r.idleLatency.medianMs, 20.5, 'idle latency');
    const bad = steadyResult(sTranscript.replace(shaB, '0'.repeat(64)), c);
    eq(`${bad.ok}/${bad.verified}/${bad.reason}`, 'false/false/content hash mismatch', 'tampered');
    // A node that intercepts TLS: curl refuses the key (exit 90), nothing arrives.
    const pin = steadyResult(sTranscript.replace(/^(LAB_W S 2 \S+) \d+ (.*) 200 28$/m, '$1 0 $2 000 90'), c);
    eq(`${pin.ok}/${pin.verified}/${pin.reason}`, "false/false/tls key is not our origin's (pin mismatch)", 'pin mismatch is tampering');
    // Origin down / timeout with nothing received: no proof against the node, classic reading kept.
    const down = steadyResult(sTranscript.replace(/^(LAB_W S 2 \S+) \d+ (.*) 200 28$/m, '$1 0 $2 000 7'), c);
    eq(`${down.ok}/${down.verified}/${down.reason}`, 'false/null/origin request failed', 'origin down is not tampering');
    const none = steadyResult('DOWNLOAD 1 2 3 4 200', c);
    eq(`${none.ok}/${none.reason}`, 'false/the steady block did not run', 'missing block');
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
