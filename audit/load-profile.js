// ─── Load lab: one simulated user inside a real paid session ───
// scripts/bwlab/load.mjs runs N real sessions at once (one client container each). Each
// mounts this script as /mnt/snt/load.sh: right after the session is up it runs a traffic
// profile until /mnt/snt/stop appears (or LOAD_MAX seconds), then the session ends as usual.
// Production sessions never mount it (runSessionTest `load` option).
//
// Profiles (LOAD_PROFILE):
//   stream10  video-like: a LOAD_CHUNK-byte chunk every LOAD_PERIOD s (default 5 MB / 4 s =
//             10 Mbps). A chunk that takes longer than the period means the player would stall.
//   browse    page-like: 0.2–3 MB fetches on a new connection, 3–20 s apart.
//   bulk      greedy: back-to-back 10 s downloads (1 GB asked, the public origin's cap) at
//             whatever speed the tunnel gives; a failed window waits 1 s.
// Every profile also probes latency (one RTT = starttransfer − appconnect) every 2 s.
//
// Timestamps are /proc/uptime seconds: the host kernel's clock, shared by every container on
// the client VM (busybox date has no milliseconds). LOADT0 maps them to epoch seconds.
// Output lines:
//   LOADT0 <epoch_s> <uptime_s>
//   LOADC <uptime_start> <http_code> <bytes> <seconds>     stream10 chunk
//   LOADW <uptime_start> <http_code> <bytes> <seconds>     browse fetch
//   LOADB <uptime_start> <http_code> <bytes> <seconds>     bulk 10 s window
//   LOADP <uptime> <http_code> <starttransfer_s> <appconnect_s>
//   LOADEND <uptime> <reason>
export const LOAD_SH = String.raw`
read LU _ < /proc/uptime; echo "LOADT0 $(date +%s) $LU"
LOAD_CURL="-s -k --pinnedpubkey $LOAD_PIN"
[ -n "$PROXY" ] && LOAD_CURL="$LOAD_CURL -x $PROXY"
load_up() { read LU _ < /proc/uptime; }
load_age() { load_up; awk -v a="$LU" -v b="$LOAD_START" 'BEGIN{print int(a-b)}'; }
load_stop() { [ -f /mnt/snt/stop ] || [ "$(load_age)" -ge "$LOAD_MAX" ]; }
load_up; LOAD_START=$LU
( while ! load_stop; do
    R=$(curl $LOAD_CURL -m 5 -o /dev/null -w '%{http_code} %{time_starttransfer} %{time_appconnect}' "$LOAD_ORIGIN/p"); load_up; [ -n "$R" ] || R="000 0 0"
    echo "LOADP $LU $R"; sleep 2
  done ) &
LOAD_PROBE=$!
k=0
case "$LOAD_PROFILE" in
  stream10)
    while ! load_stop; do
      k=$((k+1)); load_up; S=$LU
      R=$(curl $LOAD_CURL -m $((LOAD_PERIOD * 8)) -o /dev/null -w '%{http_code} %{size_download} %{time_total}' "$LOAD_ORIGIN/d/v$k.bin?s=$LOAD_SEED$(printf %06x $k)&n=$LOAD_CHUNK")
      [ -n "$R" ] || R="000 0 0"; echo "LOADC $S $R"
      load_up; W=$(awk -v p="$LOAD_PERIOD" -v s="$S" -v n="$LU" 'BEGIN{w=p-(n-s); if (w>0) printf "%.2f", w; else print 0}')
      [ "$W" != 0 ] && sleep "$W"
    done ;;
  browse)
    while ! load_stop; do
      k=$((k+1)); N=$(( (RANDOM % 2800 + 200) * 1000 )); load_up; S=$LU
      R=$(curl $LOAD_CURL -m 60 -o /dev/null -w '%{http_code} %{size_download} %{time_total}' "$LOAD_ORIGIN/d/p$k.bin?s=$LOAD_SEED$(printf %06x $k)&n=$N")
      [ -n "$R" ] || R="000 0 0"; echo "LOADW $S $R"
      sleep $((RANDOM % 18 + 3))
    done ;;
  bulk)
    while ! load_stop; do
      k=$((k+1)); load_up; S=$LU
      R=$(curl $LOAD_CURL -m 10 -o /dev/null -w '%{http_code} %{size_download} %{time_total}' "$LOAD_ORIGIN/d/b$k.bin?s=$LOAD_SEED$(printf %06x $k)&n=1000000000")
      [ -n "$R" ] || R="000 0 0"; echo "LOADB $S $R"
      case "$R" in 200*) ;; *) sleep 1 ;; esac
    done ;;
  *) echo "LOADEND 0 unknown-profile" ;;
esac
kill $LOAD_PROBE 2>/dev/null; wait $LOAD_PROBE 2>/dev/null
load_up; [ -f /mnt/snt/stop ] && echo "LOADEND $LU stop" || echo "LOADEND $LU max"
`;

/** Env lines for a load user's container. */
export function loadEnv({ profile, origin, pin, seed, maxSeconds = 3600, chunkBytes = 5_000_000, periodSeconds = 4 }) {
  if (!/^(stream10|browse|bulk)$/.test(profile)) throw new Error(`unknown load profile ${profile}`);
  if (!/^[0-9a-f]{8,40}$/.test(seed)) throw new Error('load seed must be 8–40 hex chars');
  return [`LOAD_PROFILE=${profile}`, `LOAD_ORIGIN=${origin.replace(/\/$/, '')}`, `LOAD_PIN=${pin}`, `LOAD_SEED=${seed}`,
    `LOAD_MAX=${Math.floor(maxSeconds)}`, `LOAD_CHUNK=${Math.floor(chunkBytes)}`, `LOAD_PERIOD=${Math.floor(periodSeconds)}`];
}

/**
 * Parses a load user's container output. Times become epoch milliseconds (LOADT0 maps the
 * container's uptime clock). Returns { t0, fetches: [{ kind, at, code, bytes, seconds }],
 * probes: [{ at, code, rttMs }], end }.
 */
export function parseLoad(output) {
  const out = { t0: null, fetches: [], probes: [], end: null };
  let epoch = null;
  let up0 = null;
  const at = (u) => (epoch == null ? null : Math.round((epoch + (Number(u) - up0)) * 1000));
  for (const raw of String(output || '').split('\n')) {
    const p = raw.trim().split(/\s+/);
    if (p[0] === 'LOADT0' && p.length >= 3) { epoch = Number(p[1]); up0 = Number(p[2]); out.t0 = epoch * 1000; continue; }
    if ((p[0] === 'LOADC' || p[0] === 'LOADW' || p[0] === 'LOADB') && p.length >= 5) {
      out.fetches.push({ kind: { LOADC: 'chunk', LOADW: 'page', LOADB: 'bulk' }[p[0]], at: at(p[1]), code: p[2], bytes: Number(p[3]) || 0, seconds: Number(p[4]) || 0 });
    } else if (p[0] === 'LOADP' && p.length >= 5) {
      const st = Number(p[3]); const ac = Number(p[4]);
      out.probes.push({ at: at(p[1]), code: p[2], rttMs: p[2] === '204' && st > 0 && ac > 0 && st >= ac ? Math.round((st - ac) * 1000 * 10) / 10 : null });
    } else if (p[0] === 'LOADEND') {
      out.end = { at: at(p[1]), reason: p[2] || null };
    }
  }
  return out;
}
