/**
 * Sentinel Node Tester (Solana) — Constants & Configuration
 * Same export surface as the Cosmos tester's core/constants.js so the shared
 * server.js / db.js / continuous.js run unchanged; values are Solana's.
 */

import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─── Environment Config ──────────────────────────────────────────────────────
// The Cosmos server gates every paid route on `MNEMONIC`. On Solana the wallet is
// a key file (TEST_KEYFILE); MNEMONIC is a truthy marker when one is configured.
export const MNEMONIC = (process.env.TEST_KEYFILE || '').trim() ? 'TEST_KEYFILE' : '';
export const DENOM = 'tdvpn';
export const TOKEN = process.env.SOLANA_NETWORK === 'mainnet' ? 'DVPN' : 'tDVPN';
export const GAS_PRICE = '0';
/** GB prepaid per session (the client signs a voucher for it at session start). */
export const GIGS = Math.max(1, parseInt(process.env.GIGABYTES_PER_NODE || '1', 10));
export const TEST_MB = parseInt(process.env.TEST_MB || '10', 10);
export const MAX_NODES = parseInt(process.env.MAX_NODES || '0', 10);
export const NODE_DELAY = parseInt(process.env.NODE_DELAY_MS || '7000', 10);
export const LOW_BALANCE_WARN = 500_000; // 0.5 tDVPN (6 decimals, same scale as udvpn)
export const PORT = parseInt(process.env.PORT || '3001', 10);

// ─── DNS: written into each client container's config (dns_servers) ─
// Handshake resolvers, as in the Sentinel SDK presets. (The Cosmos tester's placeholder
// 198.51.100.1 is a documentation address: as dns_servers it would break every lookup.)
const _hns = ['103.196.38.38', '103.196.38.39'];
export const DNS_PRESETS = {
  hns:        _hns,
  handshake:  _hns,
  google:     ['8.8.8.8', '8.8.4.4'],
  cloudflare: ['1.1.1.1', '1.0.0.1'],
  quad9:      ['9.9.9.9', '149.112.112.112'],
  opendns:    ['208.67.222.222', '208.67.220.220'],
};
export let ACTIVE_DNS = (process.env.DNS_SERVERS || '').split(',').map(s => s.trim()).filter(Boolean);
if (ACTIVE_DNS.length === 0) ACTIVE_DNS = DNS_PRESETS.cloudflare;
export function setActiveDns(servers) { ACTIVE_DNS = servers; }

// ─── Chain endpoints (Solana RPC pool; LCD does not exist on Solana) ─────────
export const RPC_ENDPOINTS = (process.env.SOLANA_RPC_URLS || 'https://api.devnet.solana.com').split(',').map(s => s.trim()).filter(Boolean);
export const RPC = RPC_ENDPOINTS[0];
export const LCD_ENDPOINTS = [];

// ─── Batch / retention ───────────────────────────────────────────────────────
export const BATCH_SIZE = 5;
export const DEFAULT_BATCH_RETENTION = 200;
export const NODE_CACHE_TTL = 5 * 60_000;
export const SESSION_MAP_TTL = 120_000;

// ─── Paths ───────────────────────────────────────────────────────────────────
export const RESULTS_DIR = path.join(PROJECT_ROOT, 'results');
export const RAW_DIR = path.join(RESULTS_DIR, 'raw');
export const RESULTS_FILE = path.join(RESULTS_DIR, 'results.json');
export const CREDS_FILE = path.join(RESULTS_DIR, 'session-credentials.json');
export const FAILURE_LOG = path.join(RESULTS_DIR, 'failures.jsonl');
export const TRANSACTIONS_LOG = path.join(RESULTS_DIR, 'transactions.jsonl');

// ─── Platform ────────────────────────────────────────────────────────────────
export const PLATFORM = process.platform;

// Explorer links (Solana Explorer; devnet adds ?cluster=devnet).
export const EXPLORER_CLUSTER = (process.env.SOLANA_NETWORK || 'devnet') === 'mainnet' ? '' : 'devnet';
export function explorerUrl(kind, id) {
  return `https://explorer.solana.com/${kind}/${encodeURIComponent(id)}${EXPLORER_CLUSTER ? `?cluster=${EXPLORER_CLUSTER}` : ''}`;
}
