// ─── Egress guard for the speed origin ───
// A public origin streams to anyone who asks, and its egress is paid for. Each request
// reserves the size it names against a per-IP and a global daily allowance (so parallel
// requests cannot overshoot). When the request ends, the reservation is settled to the bytes
// really sent: a steady test asks for 150 MB per stream and stops at 10 s, so keeping the full
// reservation charged a busy node IP for bytes it never got (#31's shared node IP was refused
// at 7.75 GB of a 10 GB cap, 2026-10-21, and its tests fell back to the classic method).

/**
 * @param {{ perIp: number, total: number }} limits daily bytes per peer IP / for the whole origin
 * @returns {{ reserve(peer: string, n: number, now?: Date): object|null, settle(res: object, sent: number): void, used(peer?: string): number }}
 */
export function createEgressGuard({ perIp, total }) {
  let day = '';
  let dayTotal = 0;
  const byIp = new Map();
  const roll = (now) => {
    const d = now.toISOString().slice(0, 10);
    if (d !== day) { day = d; dayTotal = 0; byIp.clear(); }
  };
  return {
    /** Reserves n bytes for peer today; null when an allowance would be exceeded. */
    reserve(peer, n, now = new Date()) {
      roll(now);
      const used = byIp.get(peer) || 0;
      if (used + n > perIp || dayTotal + n > total) return null;
      byIp.set(peer, used + n);
      dayTotal += n;
      return { peer, n, day, settled: false };
    },
    /** Gives back the part of a reservation that was not sent (same day only; once). */
    settle(res, sent) {
      if (!res || res.settled) return;
      res.settled = true;
      if (res.day !== day) return;
      const back = Math.max(0, res.n - Math.max(0, Number(sent) || 0));
      byIp.set(res.peer, Math.max(0, (byIp.get(res.peer) || 0) - back));
      dayTotal = Math.max(0, dayTotal - back);
    },
    used(peer) {
      return peer == null ? dayTotal : (byIp.get(peer) || 0);
    },
  };
}
