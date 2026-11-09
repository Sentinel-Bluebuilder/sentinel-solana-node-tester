/**
 * Sentinel Node Tester (Solana) — platform shim.
 * The Cosmos tester ran WireGuard on the host. On Solana every tunnel runs inside
 * a throwaway dvpnd client container (audit/docker.js), so the host never holds
 * a tunnel: nothing to clean up, and the client always has the rights it needs.
 */
export const WG_AVAILABLE = true;
export const IS_ADMIN = true;
export function emergencyCleanupSync() {}
export function watchdogCheck() { return false; }
export async function installWgTunnel() { throw new Error('host tunnels are not used on Solana — sessions run in client containers'); }
export async function uninstallWgTunnel() {}
