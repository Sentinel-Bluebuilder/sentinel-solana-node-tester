/**
 * Runtime-mutable audit settings.
 *
 * Disk-persisted, hot-reloaded by `getSettings()`. Pipeline code reads these
 * via the helper functions instead of the static constants in `constants.js`,
 * so the operator can flip them from the admin UI without restarting.
 *
 * Defaults match the previous hard-coded values exactly:
 *   gigabytes        — 1   (was GIGS, also env GIGABYTES_PER_NODE)
 *   batchSize        — 5   (was BATCH_SIZE)
 *   autoCancelAfterTest — false (NEW; off by default — preserves existing behavior)
 *   maxPriceUdvpn    — 0   (NEW; 0 disables the cap)
 *
 * The cancel/refund flow itself (when autoCancelAfterTest=true) batches up to
 * `batchSize` MsgCancelSession messages per TX, mirroring batch payment.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SETTINGS_FILE = path.join(PROJECT_ROOT, 'results', '.audit-settings.json');

// ─── Defaults ────────────────────────────────────────────────────────────────
// gigabytes: legacy default (env GIGABYTES_PER_NODE wins on first read).
const ENV_GIGS = Math.max(1, parseInt(process.env.GIGABYTES_PER_NODE || '1', 10));

const DEFAULTS = Object.freeze({
  gigabytes: ENV_GIGS,
  batchSize: 5,
  // Solana: on by default — closes (start_close → close → withdraw) every test channel after a run.
  autoCancelAfterTest: true,
  maxPriceUdvpn: 0,
  // On-chain reporting (opt-in). Posts a tester self-send TX with a
  // base64-encoded binary report (see core/onchain-report.js) every
  // `onchainBatchSize` completed nodes. Region 2-letter ISO; empty = auto.
  onchainEnabled: false,
  onchainBatchSize: 6,
  onchainRegion: '',
});

// ─── In-memory cache ─────────────────────────────────────────────────────────
let _cache = null;

function loadFromDisk() {
  try {
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULTS };
    const raw = readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return sanitize({ ...DEFAULTS, ...parsed });
  } catch (e) {
    console.warn('[settings] loadFromDisk failed, using defaults:', e.message);
    return { ...DEFAULTS };
  }
}

function sanitize(s) {
  return {
    gigabytes: clampInt(s.gigabytes, 1, 100, DEFAULTS.gigabytes),
    batchSize: clampInt(s.batchSize, 1, 5, DEFAULTS.batchSize),
    autoCancelAfterTest: !!s.autoCancelAfterTest,
    maxPriceUdvpn: clampInt(s.maxPriceUdvpn, 0, 1_000_000_000, DEFAULTS.maxPriceUdvpn),
    onchainEnabled: !!s.onchainEnabled,
    onchainBatchSize: clampInt(s.onchainBatchSize, 1, 6, DEFAULTS.onchainBatchSize),
    onchainRegion: sanitizeRegion(s.onchainRegion),
  };
}

function sanitizeRegion(v) {
  if (typeof v !== 'string') return DEFAULTS.onchainRegion;
  const cleaned = v.trim().toUpperCase().slice(0, 2);
  if (cleaned.length === 0) return '';
  if (!/^[A-Z]{2}$/.test(cleaned)) return DEFAULTS.onchainRegion;
  return cleaned;
}

function clampInt(v, lo, hi, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the current settings object. Cached after first read; call
 * `reloadSettings()` to force a re-read from disk (useful in tests).
 */
export function getSettings() {
  if (_cache === null) _cache = loadFromDisk();
  return _cache;
}

export function reloadSettings() {
  _cache = loadFromDisk();
  return _cache;
}

/**
 * Patch settings, persist to disk, return the new effective settings.
 * Unknown keys are dropped; bad values are clamped.
 */
export function updateSettings(patch) {
  const next = sanitize({ ...getSettings(), ...patch });
  try {
    mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    console.warn('[settings] persist failed (in-memory only):', e.message);
  }
  _cache = next;
  return _cache;
}

export function getDefaultSettings() {
  return { ...DEFAULTS };
}

// ─── Convenience accessors used inside the audit pipeline ───────────────────
export function gigsRT() { return getSettings().gigabytes; }
export function batchSizeRT() { return getSettings().batchSize; }
export function autoCancelRT() { return getSettings().autoCancelAfterTest; }
export function maxPriceUdvpnRT() { return getSettings().maxPriceUdvpn; }
export function onchainEnabledRT() { return getSettings().onchainEnabled; }
export function onchainBatchSizeRT() { return getSettings().onchainBatchSize; }
export function onchainRegionRT() { return getSettings().onchainRegion; }
