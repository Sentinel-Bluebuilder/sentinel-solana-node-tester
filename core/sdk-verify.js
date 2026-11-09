/**
 * Sentinel Node Tester (Solana) — client version info.
 * The Cosmos tester verified npm SDK tarballs against GitHub tags. On Solana
 * the client is the reference `dvpnd` inside the client image; its build
 * identity (network / program / mint) is read from the image once.
 */

import { spawnSync } from 'node:child_process';
import { DVPND_IMAGE, CLIENT_BUILD } from '../lib/constants.js';
import { NETWORK, PROGRAM_ID, MINT } from '../lib/solana/idl.js';

let _cached = null;

function dvpndVersion() {
  if (_cached) return _cached;
  try {
    const r = spawnSync('docker', ['run', '--rm', '--entrypoint', 'sentinel-dvpnd', DVPND_IMAGE, 'version'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    const json = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}');
    _cached = { tag: json.tag || null, commit: json.commit || null, version: json.tag && json.tag !== 'unknown' ? json.tag : (json.commit && json.commit !== 'unknown' ? json.commit : DVPND_IMAGE.split(':').pop()), network: json.network || null, programId: json.program_id || null, mint: json.mint || null, image: DVPND_IMAGE };
  } catch (err) {
    console.error('[sdk-verify] dvpnd version read failed:', err.message);
    _cached = { version: null, image: DVPND_IMAGE, error: err.message };
  }
  return _cached;
}

/** True when the image's dvpnd speaks the program version on chain (tag or commit names CLIENT_BUILD). */
// The fleet's release builds of the same program are tagged fork-cb33-<n>[-rcN|-final…], point cuts
// included (final6.1) (fork-final-build.sh); scripts/ops/repin-client.sh pins the exact tag and
// checks the image's sums. Only release tags: a dev fork build (fork-cb33-1-ddv19) still fails.
const FORK_TAG = /^fork-cb33-\d+-(rc\d+|final(\d+(\.\d+)?)?)$/;

export function clientBuildOk(v) {
  return String(v.tag || '').startsWith(CLIENT_BUILD) || String(v.commit || '').startsWith(CLIENT_BUILD)
    || FORK_TAG.test(String(v.tag || ''));
}

export function getInstalledVersions() {
  return { dvpnd: dvpndVersion() };
}

// The dashboard shows `warning` as the Verify tooltip, so it says what was checked.
export async function verifyAllSdks() {
  const v = dvpndVersion();
  if (!v.version) return { dvpnd: { key: 'dvpnd', ok: false, ...v, warning: `cannot read the client from ${DVPND_IMAGE}: ${v.error || 'no version'}` } };
  const want = { network: NETWORK, programId: PROGRAM_ID.toBase58(), mint: MINT.toBase58() };
  const wrong = Object.keys(want).filter((k) => v[k] && v[k] !== want[k]);
  // Same network, program and mint is not enough: the program was redeployed in place (grants,
  // 2026-10-21), and an older dvpnd builds open_channel the program now refuses (Custom 102).
  const clientOk = clientBuildOk(v);
  const ok = !wrong.length && clientOk;
  const warning = wrong.length
    ? `client image built for a different ${wrong.join(' / ')}: ${wrong.map((k) => `${v[k]} ≠ ${want[k]}`).join(', ')}`
    : !clientOk
      ? `dvpnd ${v.version} in ${DVPND_IMAGE} predates the program on chain; it needs a ${CLIENT_BUILD} build (tag ${CLIENT_BUILD}-*)`
      : `dvpnd ${v.version} in ${DVPND_IMAGE} is built for ${NETWORK}, this program and this mint`;
  return { dvpnd: { key: 'dvpnd', ok, ...v, warning, counts: { mismatched: wrong.length + (clientOk ? 0 : 1), missingOnGithub: 0 } } };
}

export async function verifySdk(key) {
  if (key !== 'dvpnd') throw new Error(`Unknown SDK key: ${key}`);
  return (await verifyAllSdks()).dvpnd;
}
