/**
 * Sentinel Node Tester (Solana) — diagnostics hooks used by shared code.
 * The Cosmos tester paused when a host VPN interfered with its own tunnels.
 * The Solana tunnel lives inside a client container, so the host cannot
 * interfere; these keep the shared call sites working.
 */

export async function checkAndPauseIfInterference() {
  return true;
}

export function classifyFailure(err) {
  const msg = String(err?.message || err || '');
  if (/timed out|timeout/i.test(msg)) return 'timeout';
  if (/ECONN|EHOST|ENETUNREACH|fetch failed/i.test(msg)) return 'network';
  return 'fatal';
}
