/**
 * Sentinel Node Tester (Solana) — platform shim.
 * V2Ray/Xray clients run inside the dvpnd client container (SOCKS on 127.0.0.1:1080
 * there), never on the host. The Cosmos /api/stop handler calls killAllV2Ray() to
 * kill the in-flight tunnel; here that means removing the in-flight client
 * container, so Stop takes effect at once instead of after the session ends.
 */
import { stopClients } from '../../audit/docker.js';

export async function checkV2Ray() { return true; }
export function killAllV2Ray() {
  stopClients()
    .then((n) => { if (n) console.log(`[stop] removed ${n} in-flight client container(s)`); })
    .catch((err) => console.error('[stop] could not remove client containers:', err.message));
}
export function killV2RayByPid() {}
export function cleanupV2Ray() {}
