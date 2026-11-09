// ─── Constants ───────────────────────────────────────────────────────────────
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Runtime state: audit.db, settings.json, raw/, clients/ (scratch homes). */
export const DATA_DIR = process.env.DATA_DIR || join(PROJECT_ROOT, 'results');
export const CLIENTS_DIR = join(DATA_DIR, 'clients');

export const PORT = Number(process.env.PORT) || 3001;
export const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';
export const ADMIN_PATH = '/admin';

// Pinned client build; override with DVPND_IMAGE. Built by docker/client.Dockerfile from pure
// upstream cb33092e (= public 26de5240), the code the program on chain runs since 2026-11-02;
// older clients cannot open channels (err 102).
export const DVPND_IMAGE = process.env.DVPND_IMAGE || 'snt-tester/dvpnd:devnet-cb33092e';
// The upstream commit the client must be built from (its version tag or commit starts with it).
export const CLIENT_BUILD = 'cb33092';

/** Program constants (work/sentinel-solana/docs/03-PROGRAM-REFERENCE.md). */
export const TOKEN_LABEL = process.env.SOLANA_NETWORK === 'mainnet' ? 'DVPN' : 'tDVPN';
export const STATUS_LISTED = 1;
export const CHANNEL_OPEN = 0;
export const CHANNEL_CLOSING = 1;
export const MODE_VOUCHER = 0;
export const MODE_STREAM = 1;

/** Default bytes the client prepays per session (node default prepay_min_bytes = 100 MB). */
export const DEFAULT_PREPAY_BYTES = 100_000_000;
/** Escrow floor in base units: 0.2 tDVPN, the same number Node Manager's self-test uses. */
export const DEFAULT_ESCROW_BASE = 200_000;

/** Speed-test download endpoint; `{bytes}` is substituted. */
export const SPEED_URL_TEMPLATE = process.env.SPEED_URL || 'https://speed.cloudflare.com/__down?bytes={bytes}';
/** Connectivity probe through the tunnel (informational, like the Cosmos tester's Google check). */
export const CONNECTIVITY_URL = process.env.CONNECTIVITY_URL || 'https://www.google.com/generate_204';

export const BASELINE_MIN_MBPS = 30;

/** Error codes a per-node result can carry (public, stable — the dashboards key on them). */
export const ERR = Object.freeze({
  NOT_LISTED: 'NOT_LISTED',
  LISTING_EXPIRED: 'LISTING_EXPIRED',
  UNREACHABLE: 'UNREACHABLE',
  METADATA_INVALID: 'METADATA_INVALID',
  PROTOCOL_UNSUPPORTED: 'PROTOCOL_UNSUPPORTED',
  DOCKER_UNAVAILABLE: 'DOCKER_UNAVAILABLE',
  DAEMON_NOT_READY: 'DAEMON_NOT_READY',
  SESSION_START_FAIL: 'SESSION_START_FAIL',
  TUNNEL_NO_TRAFFIC: 'TUNNEL_NO_TRAFFIC',
  SPEED_SOURCE_UNAVAILABLE: 'SPEED_SOURCE_UNAVAILABLE',
  SPEED_CONTENT_TAMPERED: 'SPEED_CONTENT_TAMPERED', // the bytes that reached the client are not the bytes our origin sent — a node fault
  CLIENT_EXITED: 'CLIENT_EXITED', // the client container died mid-session (killed / OOM) — not a node fault
  PLAN_CONNECTION_LIMIT: 'PLAN_CONNECTION_LIMIT', // the subscription's live tickets already use every plan connection — not a node fault
  TICKET_REFUSED: 'TICKET_REFUSED', // the plan's provider refused a ticket for this node (not on the roster, subscription invalid, …)
  CLIENT_TIMEOUT: 'CLIENT_TIMEOUT',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  TEST_RUN_SKIP: 'TEST_RUN_SKIP',
  STOP_REQUESTED: 'STOP_REQUESTED',
  UNKNOWN: 'UNKNOWN',
});

/** Stages a node test passes through, in order. */
export const STAGES = Object.freeze(['listing', 'probe', 'client', 'session', 'download', 'done']);
