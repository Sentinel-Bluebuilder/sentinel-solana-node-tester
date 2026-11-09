// ─── Speed lab: measure a tunnel against truth, several ways at once ───
// Lab only (plan Part D): runSessionTest mounts LAB_SH into the client container when a
// `lab` option is passed; production sessions never see it. One session runs, back to back:
//   L1  idle latency   — N small HTTPS requests to our origin, RTT = starttransfer − appconnect
//   Mx  downloads      — `streams` parallel, time-bounded downloads of per-test content
//                        (lib/speed-content.js); interface byte counters sampled ~10 Hz; a
//                        latency probe ~5 Hz while it runs (loaded latency); `ss -tin` mid-way
// The analyzer turns that into several speed figures so they can be compared with each
// other and with ground truth: naive (bytes / curl total time), transfer-only, and the
// steady-state rate after the slow-start ramp (median and p90 of the samples).
import { expectedSha256 } from '../lib/speed-content.js';

export const LAB_SH = String.raw`
lab_up() { awk '{print $1}' /proc/uptime; }
lab_cx() { if [ -n "$PROXY" ]; then echo "-x $PROXY"; fi; }
lab_probe() { curl -sk --pinnedpubkey "$LAB_PIN" $(lab_cx) -m 5 -o /dev/null -w "$1"' %{time_appconnect} %{time_starttransfer} %{http_code}\n' "$LAB_ORIGIN/p"; }
# One write per sample line: parallel probes printing between the pieces would split it.
lab_sampler() { while [ ! -f /tmp/lab_stop ]; do echo "LS $(lab_up)$(awk '{sub(/:/," ")} NR>2 && $1!="lo"{printf " %s=%s",$1,$2}' /proc/net/dev)"; sleep 0.1; done; }
# Trace mode: sample counters around the tester's own download (method id TESTER), then return.
# The runner calls lab_trace_end right after it prints DOWNLOAD.
if [ "$LAB_TRACE" = 1 ]; then
  rm -f /tmp/lab_stop
  T0=$(lab_up)
  lab_sampler > /tmp/lab_trace 2>&1 &
  LAB_TRACE_PID=$!
  ( sleep 3; top -bn1 2>/dev/null | head -15 > /tmp/lab_ps ) &
  lab_trace_end() {
    touch /tmp/lab_stop; wait $LAB_TRACE_PID 2>/dev/null; rm -f /tmp/lab_stop
    echo "LAB_BEGIN TESTER 1 0 $T0"; cat /tmp/lab_trace; echo "LAB_END TESTER $(lab_up)"
    echo "LAB_PS_BEGIN"; cat /tmp/lab_ps 2>/dev/null; echo "LAB_PS_END"
    rm -f /tmp/lab_trace /tmp/lab_ps
  }
  return 0 2>/dev/null
fi
echo "LAB_START $(lab_up) $LAB_PLAN"
i=0; while [ $i -lt "$LAB_IDLE_N" ]; do i=$((i+1)); lab_probe LAB_IL; done
k=0
for spec in $LAB_PLAN; do
  k=$((k+1))
  ID=$(echo "$spec" | cut -d: -f1); N=$(echo "$spec" | cut -d: -f2); SECS=$(echo "$spec" | cut -d: -f3)
  # Optional 4th field: bytes per stream (the origin stops there), so a test fits inside the prepay.
  CAP=$(echo "$spec" | cut -d: -f4); NARG=; [ -n "$CAP" ] && NARG="&n=$CAP"
  echo "LAB_BEGIN $ID $N $SECS $(lab_up)"
  # LAB_OPTS may hold "nosample" / "noprobe" to measure without the lab's own background traffic.
  SP=; PP=
  case "$LAB_OPTS" in *nosample*) ;; *) lab_sampler & SP=$!;; esac
  case "$LAB_OPTS" in *noprobe*) ;; *) ( while :; do lab_probe "LAB_LP $ID"; sleep 0.2; done ) & PP=$!;; esac
  PIDS=""
  j=0; while [ $j -lt "$N" ]; do
    j=$((j+1)); SEED="$LAB_SEED_BASE$k$j"
    # Methods named X* fetch the tester's own third-party speed host (no content check), for comparison.
    # XR* repeats the tester's own request exactly: the first TEST_BYTES as a Range.
    RANGEARG=""
    case "$ID" in XR*) RANGEARG="-r 0-$((TEST_BYTES-1))";; esac
    case "$ID" in X*) U="$LAB_EXTRA_URL"; SEED=ext; PINARG="";; *) U="$LAB_ORIGIN/d/$SEED.bin?s=$SEED$NARG"; PINARG="--pinnedpubkey $LAB_PIN";; esac
    LABW='LAB_W '"$ID $j $SEED"' %{size_download} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{http_code} %{exitcode} %{remote_ip}\n'
    case "$ID" in
      # XT* is the tester's download command byte for byte (no -k, body to /dev/null).
      # XF*: as XT but in the foreground inside $(...), exactly how the tester calls it.
      XF*) DLX=$(curl -s -m "$SECS" $(lab_cx) -r "0-$((TEST_BYTES-1))" -o /dev/null -w "$LABW" "$U"); printf '%s' "$DLX" > /tmp/lab_w.$j; printf '\n' >> /tmp/lab_w.$j ;;
      # XL*: repeat requests of the extra URL until SECS is up (hosts that cap one request's size,
      # e.g. Cloudflare's 25 MB). One LAB_W per stream: total bytes, first-byte time, elapsed.
      XL*) ( T0=$(lab_up); TOT=0; NREQ=0; FIRST=; CODE=200
             while :; do
               REM=$(awk -v a="$T0" -v b="$(lab_up)" -v s="$SECS" 'BEGIN{r=s-(b-a); if (r<=0) print 0; else printf "%d", r+0.999}')
               [ "$REM" -le 0 ] && break
               L=$(curl -s $(lab_cx) -m "$REM" -o /dev/null -w '%{size_download} %{time_starttransfer} %{http_code}' "$U")
               # Trailing defaults so $1..$3 always exist (no brace expansions: this is a JS template).
               set -- $L 0 0 000; RB=$1; RF=$2; RC=$3
               TOT=$((TOT + RB)); NREQ=$((NREQ + 1)); [ -z "$FIRST" ] && FIRST=$RF
               # A request cut by the time limit reads 000 with bytes: that is the normal end.
               [ "$RC" = 200 ] || { [ "$RB" -gt 0 ] && [ "$RC" = 000 ]; } || { CODE=$RC; break; }
             done
             [ -n "$FIRST" ] || FIRST=0
             echo "LAB_W $ID $j ext $TOT 0 0 0 $FIRST $(awk -v a="$T0" -v b="$(lab_up)" 'BEGIN{print b-a}') $CODE 0 requests:$NREQ" > /tmp/lab_w.$j ) & ;;
      XT*) ( curl -s -m "$SECS" $(lab_cx) -r "0-$((TEST_BYTES-1))" -o /dev/null -w "$LABW" "$U" > /tmp/lab_w.$j 2>&1 ) & ;;
      *) ( curl -sk $PINARG $RANGEARG $(lab_cx) -m "$SECS" -o - -w '%{stderr}'"$LABW" "$U" 2>/tmp/lab_w.$j | sha256sum | awk -v id="$ID" -v j="$j" '{print "LAB_H", id, j, $1}' > /tmp/lab_h.$j ) & ;;
    esac
    # A foreground XF* started no job; its stale $! would be the client daemon.
    case "$ID" in XF*) ;; *) PIDS="$PIDS $!";; esac
  done
  H=$((SECS / 2)); [ "$H" -gt 5 ] && H=5; sleep "$H"; echo "LAB_SS_BEGIN $ID"; ss -tin state established 2>/dev/null | head -40; echo "LAB_SS_END $ID"
  for p in $PIDS; do wait $p; done
  # Only our own jobs: a bare "wait" would also wait for the client daemon and hang the session.
  for p in $PP $SP; do kill $p 2>/dev/null; wait $p 2>/dev/null; done
  echo "LAB_END $ID $(lab_up)"
  # One file per stream: parallel appends to one file interleave mid-line.
  cat /tmp/lab_w.* /tmp/lab_h.* 2>/dev/null; rm -f /tmp/lab_w.* /tmp/lab_h.*
done
echo "LAB_DONE $(lab_up)"
`;

/** Lab plan string for the container: "M2:1:10 M3a:4:10:150000000" (id:streams:seconds[:bytes per stream]). */
export function labPlan(methods) {
  return methods.map((m) => [m.id, m.streams, m.seconds, ...(m.capBytes ? [m.capBytes] : [])].join(':')).join(' ');
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

/** Parse the lab lines of a container transcript. Pure; unit-tested. */
export function parseLab(out) {
  const lab = { idle: [], methods: {}, started: false, done: false };
  let cur = null;
  let inSs = null;
  for (const raw of String(out).split('\n')) {
    const line = raw.trim();
    const f = line.split(/\s+/);
    if (inSs) {
      if (f[0] === 'LAB_SS_END') { inSs = null; continue; }
      const m = lab.methods[inSs];
      const retr = /retrans:\d+\/(\d+)/.exec(line);
      const rtt = /\brtt:([\d.]+)\//.exec(line);
      if (retr) m.retrans += Number(retr[1]);
      if (rtt) m.ssRtt.push(Number(rtt[1]));
      continue;
    }
    switch (f[0]) {
      case 'LAB_START': lab.started = true; break;
      case 'LAB_DONE': lab.done = true; break;
      case 'LAB_IL': if (f[3] === '204') lab.idle.push((Number(f[2]) - Number(f[1])) * 1000); break;
      case 'LAB_BEGIN':
        cur = lab.methods[f[1]] = { id: f[1], streams: Number(f[2]), seconds: Number(f[3]), t0: Number(f[4]), t1: null, samples: [], loaded: [], streamsOut: [], hashes: {}, retrans: 0, ssRtt: [] };
        break;
      case 'LAB_END': if (lab.methods[f[1]]) lab.methods[f[1]].t1 = Number(f[2]); cur = null; break;
      case 'LAB_LP':
        if (lab.methods[f[1]] && f[4] === '204') lab.methods[f[1]].loaded.push((Number(f[3]) - Number(f[2])) * 1000);
        break;
      case 'LAB_SS_BEGIN': if (lab.methods[f[1]]) inSs = f[1]; break;
      case 'LAB_W': {
        const m = lab.methods[f[1]];
        if (m) {
          m.streamsOut.push({
            stream: Number(f[2]), seed: f[3], bytes: Number(f[4]), tDns: Number(f[5]), tConnect: Number(f[6]),
            tTls: Number(f[7]), tFirstByte: Number(f[8]), tTotal: Number(f[9]), http: f[10], curlExit: Number(f[11]),
          });
        }
        break;
      }
      case 'LAB_H': if (lab.methods[f[1]]) lab.methods[f[1]].hashes[f[2]] = f[3]; break;
      case 'LS': {
        if (!cur) break;
        const s = { t: Number(f[1]), rx: {} };
        if (!Number.isFinite(s.t)) break;
        for (const kv of f.slice(2)) {
          const [k, v] = kv.split('=');
          // Only whole counters: a line damaged by interleaved output must not inject NaN.
          if (k && /^\d+$/.test(v || '')) s.rx[k] = Number(v);
        }
        cur.samples.push(s);
        break;
      }
      default: break;
    }
  }
  return lab;
}

/**
 * Steady-state rate from cumulative byte samples (~10 Hz). Rates are taken over `windowSec`
 * windows (100 ms intervals are too bursty on long paths). The ramp ends at the first window
 * that reaches 80 % of the median of the windows after it; median / p90 of the rest are the
 * steady rate. Also flags a falling trend (burst then throttle): last third < 70 % of the first.
 */
export function steadyState(samples, iface, { windowSec = 1 } = {}) {
  const pts = samples.filter((s) => Number.isFinite(s.rx[iface]));
  const rates = [];
  let a = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[a].t;
    if (dt + 1e-9 < windowSec) continue;
    rates.push({ t: pts[i].t, bps: ((pts[i].rx[iface] - pts[a].rx[iface]) * 8) / dt });
    a = i;
  }
  // A last window shorter than the rest straddles the curl timeout; windows are whole here,
  // but the final one still holds the transfer's tail: drop it.
  const body = rates.slice(0, -1);
  let start = body.length;
  for (let i = 0; i < body.length; i++) {
    const after = median(body.slice(i + 1).map((x) => x.bps));
    if (after == null || body[i].bps >= 0.8 * after) { start = i; break; }
  }
  const steady = body.slice(start).map((x) => x.bps);
  const third = Math.floor(steady.length / 3);
  const first = third ? steady.slice(0, third).reduce((a, b) => a + b, 0) / third : null;
  const last = third ? steady.slice(-third).reduce((a, b) => a + b, 0) / third : null;
  return {
    // Time from the first sample to the start of the first steady window.
    rampSeconds: start < body.length ? r2(start > 0 ? body[start - 1].t - pts[0].t : 0) : null,
    samples: steady.length,
    medianBps: median(steady),
    p90Bps: pct(steady, 90),
    falling: first != null && last != null && first > 0 ? last < 0.7 * first : false,
  };
}

/** The interface that carried the download: the one whose counter grew the most. */
function busiestIface(samples) {
  if (samples.length < 2) return null;
  // First and last sample that carry a finite counter for each interface (a damaged line
  // may lack one).
  const keys = new Set(samples.flatMap((s) => Object.keys(s.rx)));
  let best = null;
  for (const k of keys) {
    const ok = samples.filter((s) => Number.isFinite(s.rx[k]));
    if (ok.length < 2) continue;
    const d = ok[ok.length - 1].rx[k] - ok[0].rx[k];
    if (best == null || d > best.d) best = { k, d };
  }
  return best && best.d > 0 ? best : null;
}

/**
 * Turn parsed lab output into comparable figures. `secret` verifies every stream's bytes
 * (null skips verification and says so). Pure apart from hashing.
 */
export function analyzeLab(lab, { secret = null } = {}) {
  const idle = lab.idle;
  const out = {
    idleLatency: { n: idle.length, medianMs: r2(median(idle)), p90Ms: r2(pct(idle, 90)), jitterMs: r2(idle.length >= 4 ? pct(idle, 75) - pct(idle, 25) : null) },
    methods: [],
  };
  for (const m of Object.values(lab.methods)) {
    const payload = m.streamsOut.reduce((a, s) => a + (s.bytes || 0), 0);
    const tTotal = Math.max(0, ...m.streamsOut.map((s) => s.tTotal || 0));
    const tFirst = m.streamsOut.length ? Math.min(...m.streamsOut.map((s) => s.tFirstByte || Infinity)) : null;
    const busiest = busiestIface(m.samples);
    // A stream that ended before the time limit (curl exit 0: the byte cap or the body ran out)
    // leaves fewer streams running: what follows is not an N-stream rate, and a falling flag
    // there would be false. The steady window ends when the first stream ends early.
    const early = m.streamsOut.filter((s) => s.curlExit === 0 && s.tTotal > 0 && s.tTotal < m.seconds - 0.5).map((s) => s.tTotal);
    const cutoff = early.length && Number.isFinite(m.t0) ? m.t0 + Math.min(...early) : Infinity;
    const window = m.samples.filter((s) => s.t <= cutoff);
    const ss = busiest ? steadyState(window, busiest.k) : null;
    // Line rate is what crossed the container's own network interface (eth0): the tunnel's outer
    // bytes. The "busiest" interface can be a client's tun device (Hysteria2's hy2-client counts
    // more than eth0 carries), so the line rate never uses it.
    const lineIface = window.some((s) => Number.isFinite(s.rx.eth0)) ? 'eth0' : busiest?.k;
    const ssLine = lineIface ? (lineIface === busiest?.k ? ss : steadyState(window, lineIface)) : null;
    // Interface counters include tunnel/TLS overhead; scale the steady rate to payload.
    const payloadRatio = busiest && busiest.d > 0 ? payload / busiest.d : null;
    // false = proof of tampering: bytes that hash wrong, or a TLS key that is not our origin's
    // (curl exit 90, pinned key mismatch). A stream that got nothing for another reason (origin
    // down, timeout) proves nothing about the node: null, not false.
    let verified = null;
    let tamper = null;
    if (secret && m.streamsOut.some((s) => s.seed !== 'ext')) {
      const own = m.streamsOut.filter((s) => s.seed !== 'ext');
      const pinFail = own.find((s) => s.curlExit === 90);
      const badHash = own.find((s) => s.bytes > 0 && m.hashes[String(s.stream)] !== expectedSha256(secret, s.seed, s.bytes));
      if (pinFail) { verified = false; tamper = 'tls key is not our origin\'s (pin mismatch)'; }
      else if (badHash) { verified = false; tamper = 'content hash mismatch'; }
      else if (own.length > 0 && own.length === m.streams && own.every((s) => s.bytes > 0)) verified = true;
    }
    out.methods.push({
      id: m.id, streams: m.streams, seconds: m.seconds,
      payloadBytes: payload,
      verified,
      tamper,
      httpOk: m.streamsOut.length === m.streams && m.streamsOut.every((s) => s.http === '200' || s.http === '206'),
      naiveMbps: r2(tTotal > 0 ? (payload * 8) / tTotal / 1e6 : null),
      transferMbps: r2(tTotal > tFirst && tFirst != null ? (payload * 8) / (tTotal - tFirst) / 1e6 : null),
      steadyMbps: r2(ss?.medianBps != null && payloadRatio ? (ss.medianBps * payloadRatio) / 1e6 : null),
      steadyP90Mbps: r2(ss?.p90Bps != null && payloadRatio ? (ss.p90Bps * payloadRatio) / 1e6 : null),
      rampSeconds: ss?.rampSeconds ?? null,
      // Seconds of the method's window that count (shorter when a stream finished early).
      windowSeconds: r2(Number.isFinite(cutoff) ? cutoff - m.t0 : null),
      falling: ss?.falling ?? false,
      iface: busiest?.k ?? null,
      wireBytes: busiest?.d ?? null,
      payloadToIface: r2(payloadRatio),
      steadyWireMbps: r2(ss?.medianBps != null ? ss.medianBps / 1e6 : null),
      lineIface: lineIface ?? null,
      lineMbps: r2(ssLine?.medianBps != null ? ssLine.medianBps / 1e6 : null),
      setupMs: r2(tFirst != null && Number.isFinite(tFirst) ? tFirst * 1000 : null),
      loadedLatency: { n: m.loaded.length, medianMs: r2(median(m.loaded)), p90Ms: r2(pct(m.loaded, 90)) },
      retrans: m.retrans,
      ssRttMs: r2(median(m.ssRtt)),
    });
  }
  return out;
}
