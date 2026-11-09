// ─── One paid session against one node ──────────────────────────────────────
// Runs the dVPN client role of `dvpnd` in a throwaway container (see
// audit/docker.js for why never on the host), signing with the tester wallet:
//
//   init client home → point it at our RPC → start the daemon → `client start`
//   with the run's credential (per GB: `--new-channel --mode voucher --escrow-base-units N`,
//   the daemon opens the channel and signs the prepay voucher; per hour: `--mode
//   stream`; plan: `--ticket --provider P --subscription S`, no channel at all)
//   → pull TEST_BYTES through the tunnel
//   (or through the SOCKS proxy for V2Ray/Xray) → connectivity probe → session
//   status (client-metered bytes, spent) → client stop → daemon SIGTERM.
//
// Client interface = upstream cb33092e (the program on chain since 2026-11-02; public as
// sentinel-official/sentinel-solana 26de5240): daemon `sentinel-dvpnd init|run --instance c1`,
// CLI `sentinel-dvpn client start|status|stop` + `daemon status` (SERVING = ready). One
// config.toml per instance: top-level `prepay_bytes` / `escrow_base_units`, `[network]`
// `dns_backend` / `dns_servers` / `kill_switch`. Unknown keys are IGNORED, so an old name
// silently keeps the default; the CFG lines echo what the client really holds.
// The tester wallet is both the owner and the device key (keys/operator.json), so the SDK
// looks up no grant and the owner pays from its own token account (no approve-delegate).
//
// The script is the same shape Node Manager (Solana) proved on Docker Desktop
// and on an Ubuntu host for all six protocols. Every line it prints with a
// known prefix is parsed here into a structured result; the daemon log tail is
// kept for the failure-log UX.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runClientContainer } from './docker.js';
import { isIP } from 'node:net';
import { CLIENTS_DIR, DATA_DIR, CONNECTIVITY_URL, ERR } from '../lib/constants.js';
import { ACTIVE_DNS, DNS_PRESETS } from '../core/constants.js';
import { speedSources } from '../lib/speed.js';
import { keypairToJson } from '../lib/wallet.js';
import { parseUri } from '../lib/discovery.js';
import { LAB_SH } from './speed-lab.js';
import { LOAD_SH, loadEnv } from './load-profile.js';

export const CLIENT_SCRIPT = String.raw`
set -u
# Set only around the bandwidth lab's trace (audit/speed-lab.js); defined so set -u never trips on them.
LAB_TRACE=
LAB_TRACE_PID=
H=/tmp/snt
# cb33092e: the daemon is sentinel-dvpnd (instance c1 = a client; tags are c|n|p + number),
# the CLI is sentinel-dvpn. The RPC URL can carry an API key, so it never goes on a command
# line (argv shows in the host's ps for every user): it comes from a 0600 file in the run dir
# and reaches each binary as ITS env var (SENTINEL_DVPN_* = CLI, SENTINEL_DVPND_* = daemon;
# each flags the other's prefix as a mismatch, so the daemon's subshell unsets the CLI's).
# Never sed the url keys: config.toml also has [tx.paymaster] url.
. /mnt/snt/rpc.env
export SENTINEL_DVPN_RPC_URL="$RPC" SENTINEL_DVPN_RPC_WS_URL="$WS"
I=$H/c1
C="sentinel-dvpn --home $H/ctl --output json --key.name owner --daemon.endpoint $I/daemon.sock --instance c1"
mkdir -p $H/ctl/keys
cp /mnt/snt/wallet.json $H/wallet.json && chmod 600 $H/wallet.json
cp $H/wallet.json $H/ctl/keys/owner.json && chmod 600 $H/ctl/keys/owner.json
if [ "$SERVICE" = "amneziawg" ]; then
  if ! nft -f - >/dev/null 2>&1 <<NFT
add table ip6 snt_cap
add chain ip6 snt_cap c { type filter hook prerouting priority -300; }
add rule ip6 snt_cap c fib saddr type != local drop
NFT
  then echo "UNSUPPORTED kernel lacks nft_fib_ipv6, which the AmneziaWG client kill switch needs"; exit 20; fi
  nft delete table ip6 snt_cap >/dev/null 2>&1
fi
echo "STEP init"
sentinel-dvpnd init --instance c1 --home $I --owner "$OWNER" --plain-key --force > $H/init.log 2>&1 || { echo "FAIL init"; echo LOG_BEGIN; cat $H/init.log; echo LOG_END; exit 10; }
# The tester wallet is the device key too (signer == owner: no grant, no token delegate).
install -m 600 $H/wallet.json $I/keys/operator.json
sed -i "s#^dns_backend = .*#dns_backend = 'resolvconf'#" $I/config.toml
sed -i "s#^dns_servers = .*#dns_servers = [$DNS_TOML]#" $I/config.toml
sed -i "s#^prepay_bytes = .*#prepay_bytes = $PREPAY#" $I/config.toml
grep -E '^(prepay_bytes|escrow_base_units|basis|kill_switch|dns_backend|dns_servers|owner) ' $I/config.toml | sed 's/^/CFG /'
HP=$(echo "$NODE_URI" | sed -E 's#^https?://##')
NH=$(echo "$HP" | cut -d: -f1)
NP=$(echo "$HP" | cut -s -d: -f2); [ -n "$NP" ] || NP=443
if [ -n "$OVERRIDE_HOST" ]; then
  OIP=$(getent ahostsv4 "$OVERRIDE_HOST" | awk '{print $1; exit}')
  [ -n "$OIP" ] || OIP="$OVERRIDE_HOST"
  NIP=$(getent ahostsv4 "$NH" | awk '{print $1; exit}'); [ -n "$NIP" ] || NIP="$NH"
  echo "STEP hairpin $NH:$NP -> $OIP:$OVERRIDE_PORT"
  # A node advertising 127.0.0.1 needs route_localnet (set on the container) and a
  # masquerade so the rewritten packet leaves with the container's own source.
  nft add table ip snt_hairpin
  nft add chain ip snt_hairpin out '{ type nat hook output priority -100; }'
  nft add chain ip snt_hairpin post '{ type nat hook postrouting priority 100; }'
  nft add rule ip snt_hairpin out ip daddr "$NIP" tcp dport "$NP" dnat to "$OIP:$OVERRIDE_PORT"
  nft add rule ip snt_hairpin out ip daddr "$NIP" udp dport != 53 dnat to "$OIP"
  # Every other TCP port too (V2Ray/Xray tunnels run on their own ports), port kept.
  nft add rule ip snt_hairpin out ip daddr "$NIP" meta l4proto tcp dnat to "$OIP"
  nft add rule ip snt_hairpin post ip daddr "$OIP" masquerade
  # The client routes everything into its tunnel except the node address; the
  # rewritten address must stay on the container's own uplink as well.
  case "$OIP" in 127.*) ;; *) GW=$(ip route show default | awk '{print $3; exit}'); [ -n "$GW" ] && ip route replace "$OIP/32" via "$GW";; esac
  sed -i "s#^kill_switch = .*#kill_switch = 'off'#" $I/config.toml
  echo "STEP kill-switch off (hairpin)"
fi
echo "STEP reach $NH:$NP"
R=$(curl -sk -m 8 -o /dev/null -w '%{http_code} %{time_total}' "https://$NH:$NP/v1/metadata" || true)
echo "REACH $R"
case "$R" in 000*) echo "FAIL unreachable $NH:$NP"; exit 13;; esac
# Plan runs: bring back the subscription's client store (it holds the tickets already issued).
if [ -n "$TICKET_SUB" ] && [ -f /mnt/tix/data.db ]; then cp /mnt/tix/data.db* $I/ && echo "TICKET_STORE restored"; fi
echo "STEP daemon"
( unset SENTINEL_DVPN_RPC_URL SENTINEL_DVPN_RPC_WS_URL; export SENTINEL_DVPND_RPC_URL="$RPC" SENTINEL_DVPND_RPC_WS_URL="$WS"; exec sentinel-dvpnd run --instance c1 --home $I ) > $H/client.log 2>&1 &
DP=$!
# Every way out stops the daemon and waits for it, so it closes its RPC websocket before the
# container goes: a container removed with its daemon still connected sends no FIN, and the
# RPC gate holds that socket ~300 s against the token's cap (#28b, 2026-11-08). PID 1 (this sh)
# only sees SIGTERM (docker stop) through a trap.
trap 'kill -TERM $DP 2>/dev/null; wait $DP 2>/dev/null' EXIT
trap 'exit 143' TERM INT
i=0; while [ $i -lt 90 ] && ! $C daemon status 2>/dev/null | grep -q SERVING; do i=$((i+1)); sleep 1; done
$C daemon status 2>/dev/null | grep -q SERVING || { echo "FAIL daemon-not-ready"; echo LOG_BEGIN; tail -40 $H/client.log; tail -5 $H/init.log; echo LOG_END; kill -TERM $DP 2>/dev/null; exit 11; }
echo "STEP session-start"
# CRED = how this session pays: a new voucher channel (per GB), a new stream channel
# (per hour), or an access ticket from a plan's provider (subscription). Base58 / digits
# only, so the unquoted expansion splits into flags safely.
# A reconnect presents the ticket it already holds for this node (a ticket is a slot for its
# whole TTL; asking again uses a second slot and the provider refuses at max_connections).
# Every stored ticket for this node + subscription is tried, newest expiry first: the node can
# still hold one (its last session's close never arrived) while another is free. Only when all
# are refused does the session ask for a new ticket.
THS=
if [ -n "$TICKET_SUB" ]; then
  NOW=$(date +%s)
  THS=$($C client tickets 2>/dev/null | tr -d ' \n' | grep -oE '\{[^{}]*\}' | grep -F "\"node\":\"$NODE\"" | grep -F "\"subscription\":\"$TICKET_SUB\"" \
    | while read -r T; do E=$(echo "$T" | grep -oE '"expires_at":"?[0-9]+' | grep -oE '[0-9]+$'); HH=$(echo "$T" | grep -oE '"hash":"[A-Za-z0-9]+"' | cut -d'"' -f4); [ -n "$E" ] && [ -n "$HH" ] && [ "$E" -gt $((NOW+120)) ] && echo "$E $HH"; done | sort -rn | awk '{print $2}' | head -4 | tr '\n' ' ')
fi
NEWCRED=$CRED
RC=1; OUT=; REUSED=
for TH in $THS; do
  case "$TH" in *[!A-Za-z0-9]*) continue;; esac
  echo "TICKET_REUSE $TH"
  OUT=$(timeout 150 $C client start --node "$NODE" --ticket-hash $TH 2>&1); RC=$?
  [ $RC -eq 0 ] && { echo "TICKET_REUSE_OK $TH"; REUSED=$TH; break; }
  echo "TICKET_REUSE_FAILED $TH $(echo "$OUT" | tail -1)"
done
if [ $RC -ne 0 ]; then
  CRED=$NEWCRED; echo "CRED $CRED"
  OUT=$(timeout 150 $C client start --node "$NODE" $CRED 2>&1); RC=$?
fi
echo "SESSION_START_RC $RC"
echo "SESSION_START_BEGIN"; echo "$OUT"; echo "SESSION_START_END"
SID=$(echo "$OUT" | grep -oE '"id": *"[^"]+"' | head -1 | sed -E 's/.*: *"([^"]+)"/\1/')
[ -n "$SID" ] || { echo "FAIL session-start"; echo ERR_BEGIN; grep -iE '"level":"(error|warn)"' $H/client.log | tail -8; echo ERR_END; echo LOG_BEGIN; tail -40 $H/client.log; echo LOG_END; kill -TERM $DP 2>/dev/null; wait $DP 2>/dev/null; exit 12; }
echo "SID $SID"
PX=$(echo "$OUT" | grep -oE '"proxy_endpoint": *"[^"]*"' | head -1 | sed -E 's/.*: *"([^"]*)"/\1/')
if [ -n "$PX" ]; then PROXY="socks5h://$PX"; fi
[ -n "$PROXY" ] && echo "PROXY $PROXY"
sleep 4
# Counter probe (Q0429): the kernel/userspace interface counters next to the client's own usage
# report, right after connect (a) and right after the download (b), so a wrong client count
# can be told apart from traffic that never used that interface.
probe() {
  echo "PROBE_BEGIN $1"
  wg show all transfer 2>/dev/null | sed 's/^/wg /'; awg show all transfer 2>/dev/null | sed 's/^/awg /'
  wg show all latest-handshakes 2>/dev/null | sed 's/^/wg-hs /'; awg show all latest-handshakes 2>/dev/null | sed 's/^/awg-hs /'
  ip -br link 2>/dev/null | grep -E "dvpn|awg|wg|tun"
  # Per-direction packet/byte counters of every tunnel link (hy2 tx≈rx question).
  for L in $(ip -br link 2>/dev/null | awk '$1 ~ /dvpn|awg|wg|tun/ {sub(/@.*/, "", $1); print $1}'); do ip -s link show "$L" 2>/dev/null | sed "s/^/ipstat $L /"; done
  $C client status "$SID" 2>&1 | grep -E '"(rx_bytes|tx_bytes|seconds|status)"'
  echo "PROBE_END $1"
}
probe a
# Load lab only (scripts/bwlab/load.mjs, audit/load-profile.js): a simulated user's traffic
# until /mnt/snt/stop; such a session measures no speed of its own (URLS emptied).
if [ -f /mnt/snt/load.sh ]; then . /mnt/snt/load.sh; URLS=; fi
# Bandwidth lab only: LAB_FIRST=1 runs the lab block before the tester's own download (order effects).
if [ -f /mnt/snt/lab.sh ] && [ "$LAB_FIRST" = 1 ]; then . /mnt/snt/lab.sh; fi
echo "STEP download"
# Bandwidth lab only: trace interface counters and processes during the tester's own download.
# (The steady speed method mounts the same script with LAB_NOTRACE=1: no trace in production.)
if [ -f /mnt/snt/lab.sh ] && [ "$LAB_NOTRACE" != 1 ]; then LAB_TRACE=1; . /mnt/snt/lab.sh; LAB_TRACE=; fi
# Sources are tried in order on every attempt (a rate-limited speed host must
# never read as "the node carried no traffic"); a Range keeps big files to TEST_BYTES.
SIZE=0; TRY=0; DL="0 0 0 0 000"
while [ $TRY -lt 4 ] && [ -n "$URLS" ]; do
  TRY=$((TRY+1))
  for U in $URLS; do
    # A failed curl still prints its -w line (code 000); only an empty answer gets the fallback.
    # ("|| echo" would glue a second line onto it and the parser would drop the attempt.)
    if [ -n "$PROXY" ]; then DL=$(curl -s -m "$DL_TIMEOUT" -x "$PROXY" -r "0-$((TEST_BYTES-1))" -o /dev/null -w '%{size_download} %{speed_download} %{time_total} %{time_starttransfer} %{http_code}' "$U"); else DL=$(curl -s -m "$DL_TIMEOUT" -r "0-$((TEST_BYTES-1))" -o /dev/null -w '%{size_download} %{speed_download} %{time_total} %{time_starttransfer} %{http_code}' "$U"); fi
    [ -n "$DL" ] || DL="0 0 0 0 000"
    echo "DL_TRY $TRY $DL"
    SIZE=$(echo "$DL" | awk '{print int($1)}')
    CODE=$(echo "$DL" | awk '{print $5}')
    if [ "$SIZE" -ge "$MIN_BYTES" ] && { [ "$CODE" = "200" ] || [ "$CODE" = "206" ]; }; then break 2; fi
  done
  sleep 3
done
echo "DOWNLOAD $DL"
if [ -n "$LAB_TRACE_PID" ]; then lab_trace_end; LAB_TRACE_PID=; fi
# Fault lab only (Q0429 hy2): XFER=upload sends TEST_BYTES up the tunnel instead of the download.
if [ "$XFER" = upload ]; then
  if [ -n "$PROXY" ]; then UPX="-x $PROXY"; else UPX=; fi
  UP=$(head -c "$TEST_BYTES" /dev/zero | curl -sS -m "$DL_TIMEOUT" $UPX -X POST -H 'Content-Type: application/octet-stream' --data-binary @- -o /dev/null -w '%{size_upload} %{speed_upload} %{time_total} %{http_code} exit=%{exitcode}' "$UP_URL" 2>$H/up.err)
  [ -n "$UP" ] || UP="0 0 0 000"; echo "UPLOAD $UP"
  [ -s $H/up.err ] && echo "UPLOAD_ERR $(tail -1 $H/up.err)"
  # Q0434: on a failed upload, the verbose retry and the client's netfilter state right after it.
  case "$UP" in *" 000 "*)
    echo "UPDIAG_BEGIN"
    ip -s link show dvpn-c1 2>&1 | sed 's/^/before /'
    head -c 100000 /dev/zero | curl -v -m 20 $UPX -X POST -H 'Content-Type: application/octet-stream' --data-binary @- -o /dev/null "$UP_URL" 2>&1 | grep -vE '^[<>] (cf-|set-cookie|report-to|nel)' | tail -40
    echo "conntrack: $(command -v conntrack || echo not-installed)"; conntrack -L 2>&1 | grep -E '100\.100\.100|4\.239|104\.16|162\.159' | head -20
    cat /proc/net/nf_conntrack 2>/dev/null | grep -E '100\.100\.100' | head -10
    nft list ruleset 2>&1 | grep -nE 'counter|drop|reject|table|chain' | head -60
    ip -s link show dvpn-c1 2>&1 | sed 's/^/after /'
    echo "UPDIAG_END";;
  esac
  # Q0434: a 1 MB POST five times in curl's default order, then forced -6 twice and -4 twice.
  for FAM in d d d d d 6 6 4 4; do
    FF=""; [ "$FAM" = d ] || FF="-$FAM"
    echo "UPFAM $FAM $(head -c 1000000 /dev/zero | curl -sS $FF -m 15 $UPX -X POST --data-binary @- -o /dev/null -w '%{http_code} %{time_total} %{remote_ip} exit=%{exitcode}' "$UP_URL" 2>&1 | tr '\n' ' ')"
  done
  echo "V6ROUTE $(ip -6 route get 2606:4700:7::da 2>&1 | tr '\n' ' ')"
  echo "V6ROUTE2 $(ip -6 route get 2606:4700::6810:84e5 2>&1 | tr '\n' ' ')"
  echo "WG_ALLOWED $(wg show all allowed-ips 2>&1 | tr '\n' ' ')"
  ip -6 rule show 2>&1 | sed 's/^/V6RULE /'
  ip -6 route show table all 2>&1 | grep -vE '^(local|multicast|anycast) ' | head -20 | sed 's/^/V6RT /'
fi
# Fault lab only: HOLD seconds after the transfer, so a periodic usage sample lands before stop.
case "$HOLD" in ''|*[!0-9]*) ;; *) echo "HOLD $HOLD"; sleep "$HOLD";; esac
probe b
# Latency = request round trip after the TLS handshake (starttransfer − appconnect): one RTT
# through the tunnel, the same direct or via SOCKS, and free of the first DNS lookup's cost.
if [ -n "$PROXY" ]; then CN=$(curl -s -m 10 -x "$PROXY" -o /dev/null -w '%{http_code} %{time_total} %{time_appconnect} %{time_starttransfer}' "$CONN_URL"); else CN=$(curl -s -m 10 -o /dev/null -w '%{http_code} %{time_total} %{time_appconnect} %{time_starttransfer}' "$CONN_URL"); fi
[ -n "$CN" ] || CN="000 0 0 0"
echo "CONNECTIVITY $CN"
# Bandwidth lab only (audit/speed-lab.js): present only when a lab session mounts it.
if [ -f /mnt/snt/lab.sh ] && [ "$LAB_FIRST" != 1 ]; then . /mnt/snt/lab.sh; fi
echo "STATUS_BEGIN"; $C client status "$SID" 2>&1; echo "STATUS_END"
# Fault lab only (#11): kill the openvpn process the way a crash would, then stop as usual;
# ROUTES_LEFT below then shows whether the node host route outlives the session.
if [ "$FAULT" = kill-openvpn ]; then
  echo "ROUTE_BEFORE_KILL $(ip route show table main | grep -E "^$NH( |/32 )" | head -1)"
  # busybox pkill -x never matches (tested in this image, 11-08); pidof matches the exact name.
  OVP=$(pidof openvpn); echo "OPENVPN_PIDS $OVP"
  if [ -n "$OVP" ]; then kill -9 $OVP; echo "KILL_RC $?"; else echo "KILL_RC none"; fi; sleep 2
  echo "OPENVPN_AFTER_KILL $(pidof openvpn || echo gone)"
  echo "ROUTE_AFTER_KILL $(ip route show table main | grep -E "^$NH( |/32 )" | head -1)"
fi
# Fault lab only (Q0436): is the node API's TLS reply lost to the tunnel MTU? DF pings that fit
# and do not fit, the API's TLS handshake at the tun's own MTU, then again at 1340, which is left
# set so the stop's DELETE runs at 1340 too.
if [ "$FAULT" = mtu-probe ]; then
  TUN=dvpn-c1
  echo "MTU_TUN $(ip link show $TUN 2>&1 | grep -oE 'mtu [0-9]+')"
  for SZ in 1292 1372 1392; do echo "MTU_PING $SZ $(ping -M do -c 2 -W 3 -s $SZ $NH 2>&1 | grep -E 'packets transmitted|too long|Message too|invalid|unrecognized' | head -1)"; done
  for k in 1 2; do echo "MTU_TLS native $(curl -sk -o /dev/null --max-time 10 -w '%{http_code} connect=%{time_connect} tls=%{time_appconnect} exit=%{exitcode}' https://$HP/ 2>&1 | tr '\n' ' ')"; done
  ip link set $TUN mtu 1340; echo "MTU_SET_RC $? $(ip link show $TUN 2>&1 | grep -oE 'mtu [0-9]+')"
  for k in 1 2; do echo "MTU_TLS 1340 $(curl -sk -o /dev/null --max-time 10 -w '%{http_code} connect=%{time_connect} tls=%{time_appconnect} exit=%{exitcode}' https://$HP/ 2>&1 | tr '\n' ' ')"; done
fi
# Fault lab only (PR #25 A/B): cut the node's address for 45 s (longer than the
# client's own node_timeout_seconds, 30 s by default), let the client reconnect, then use the id that client start returned.
if [ "$FAULT" = drop-reconnect ]; then
  DIP=$(getent ahostsv4 "$NH" | awk '{print $1; exit}'); [ -n "$DIP" ] || DIP=$NH
  SS0=$(grep -c '"message":"service started"' $H/client.log)
  echo "DROP_BEGIN $(date +%s) $DIP starts_before $SS0"
  nft add table ip snt_drop && nft add chain ip snt_drop o '{ type filter hook output priority -10; }' && nft add rule ip snt_drop o ip daddr "$DIP" drop
  sleep 45
  nft delete table ip snt_drop; echo "DROP_END $(date +%s) rc $?"
  # Wait for the reconnect itself (a new "service started" in the daemon log): the stored row of
  # the started id can read "active" before and after, so its status proves nothing.
  i=0; while [ $i -lt 45 ]; do i=$((i+1)); SS=$(grep -c '"message":"service started"' $H/client.log); echo "RECONNECT_POLL $i starts $SS"; [ "$SS" -gt "$SS0" ] && break; sleep 2; done
  sleep 5; echo "RECONNECTED $([ "$SS" -gt "$SS0" ] && echo yes || echo no) $(date +%s)"
  echo "RECONNECT_LOG_BEGIN"; grep -v '"grpc.component"' $H/client.log | grep -iE 'lost|reconnect|attempt|service (started|stopped)|closing remote|timeout' | tail -12; echo "RECONNECT_LOG_END"
  echo "SESSIONS_BEGIN"; $C client sessions 2>&1 | grep -E '"(id|status|node)"' | head -20; echo "SESSIONS_END"
  GO=$($C client status "$SID" 2>&1); echo "GET_STARTED_RC $?"; echo "GET_STARTED_BEGIN"; echo "$GO" | head -30; echo "GET_STARTED_END"
  SO2=$(timeout 60 $C client stop "$SID" 2>&1); echo "STOP_STARTED_RC $?"; echo "STOP_STARTED_BEGIN"; echo "$SO2" | tail -5; echo "STOP_STARTED_END"
  sleep 2; echo "SESSIONS_AFTER_BEGIN"; $C client sessions 2>&1 | grep -E '"(id|status)"' | head -20; echo "SESSIONS_AFTER_END"
  echo "LINKS_AFTER $(ip -br link 2>/dev/null | grep -cE 'dvpn|wg|tun')"
  BO=$($C client status 00000000-0000-4000-8000-000000000000 2>&1); echo "GET_BOGUS_RC $?"; echo "GET_BOGUS_BEGIN"; echo "$BO" | tail -3; echo "GET_BOGUS_END"
  nft delete table ip snt_drop 2>/dev/null
fi
echo "STEP stop"
# End the session explicitly and say so: a stop that fails silently leaves it "active" on the
# node until its idle timeout (FS36 saw three such on node-4, 2026-11-07). Retried once.
SO=$(timeout 60 $C client stop "$SID" 2>&1); SRC=$?
if [ $SRC -ne 0 ]; then sleep 3; SO=$(timeout 60 $C client stop "$SID" 2>&1); SRC=$?; fi
echo "STOP_RC $SRC"
[ $SRC -eq 0 ] || { echo "STOP_ERR_BEGIN"; echo "$SO" | tail -5; echo "STOP_ERR_END"; }
AS=$($C client status "$SID" 2>&1)
echo "AFTER_STOP $(echo "$AS" | grep -oE '"(status|state)": *"[A-Za-z_]+"' | head -1)"
# Usage as stored after stop: it includes the final sample taken at teardown (Q0429).
echo "AFTER_STOP_USAGE $(echo "$AS" | grep -oE '"(rx_bytes|tx_bytes)": *"?[0-9]+' | tr -d '" ' | tr '\n' ' ')"
echo "ROUTES_LEFT $(ip route show table main 2>/dev/null | grep -cE "^$NH( |/32 )")"
echo "ROUTE_LINE_LEFT $(ip route show table main 2>/dev/null | grep -E "^$NH( |/32 )" | head -1)"
# reconnect-same (fault lab, #48): a user with one ticket disconnects and reconnects at once. After the
# clean stop above, start again on the same ticket 5 times; a refused start is retried every 1 s for up
# to 20 s, so the refusal window is measured. Each reconnect is stopped cleanly before the next.
if [ "$FAULT" = reconnect-same ] && [ -n "$REUSED" ]; then
  for k in 1 2 3 4 5; do
    T0=$(date +%s); FIRST=; ROUT=; RRC=1
    while :; do
      ROUT=$(timeout 60 $C client start --node "$NODE" --ticket-hash $REUSED 2>&1); RRC=$?
      if [ -z "$FIRST" ]; then
        if [ $RRC -eq 0 ]; then FIRST=ok; else FIRST="refused:$(echo "$ROUT" | grep -oE 'peer_limit_reached|ticket_[a-z_]+' | head -1)"; fi
      fi
      [ $RRC -eq 0 ] && break
      [ $(( $(date +%s) - T0 )) -ge 20 ] && break
      sleep 1
    done
    RSID=$(echo "$ROUT" | grep -oE '"id": *"[^"]+"' | head -1 | sed -E 's/.*: *"([^"]+)"/\1/')
    echo "RECON $k first=$FIRST connected=$([ $RRC -eq 0 ] && echo yes || echo no) after=$(( $(date +%s) - T0 ))s sid=$RSID last=$(echo "$ROUT" | tail -1 | cut -c1-140)"
    if [ -n "$RSID" ]; then
      RSO=$(timeout 60 $C client stop "$RSID" 2>&1); RSRC=$?
      echo "RECON_STOP $k rc=$RSRC closing_failed=$(echo "$RSO" | grep -ciE 'closing remote session failed')"
    fi
  done
elif [ "$FAULT" = reconnect-same ]; then
  echo "RECON skipped: the session did not run on a stored ticket"
fi
sleep 2
kill -TERM $DP 2>/dev/null; wait $DP 2>/dev/null
# Plan runs: keep the client store (with this session's ticket) for the next connect.
if [ -n "$TICKET_SUB" ] && [ -d /mnt/tix ]; then
  rm -f /mnt/tix/data.db /mnt/tix/data.db-wal /mnt/tix/data.db-shm
  cp $I/data.db* /mnt/tix/ && chmod 600 /mnt/tix/data.db* && echo "TICKET_STORE saved"
fi
echo "LOG_BEGIN"; tail -25 $H/client.log; echo "LOG_END"
echo "SAMPLE_LOG_BEGIN"; grep -iE 'sampl|stats' $H/client.log | tail -20; echo "SAMPLE_LOG_END"
echo "DONE"
`;

function between(out, a, b) {
  const i = out.indexOf(a);
  const j = out.indexOf(b, i + a.length);
  return i >= 0 && j > i ? out.slice(i + a.length, j).trim() : '';
}

function num(s) {
  const n = Number(String(s || '').trim());
  return Number.isFinite(n) ? n : 0;
}

/** Turn a session-start error blob into one operator-readable line. */
export function summariseSessionError(startBlob, logBlob) {
  const text = `${startBlob}\n${logBlob}`;
  const m = /"(error|message)"\s*:\s*"([^"]{8,220})"/.exec(startBlob) || /error[:=]\s*([^\n]{8,220})/i.exec(startBlob);
  if (m) return (m[2] || m[1]).trim();
  const e = /"level":"error"[^\n]*"message":"([^"]{4,220})"/.exec(text);
  if (e) return e[1];
  return startBlob.split('\n')[0].slice(0, 220) || 'session start failed';
}

/** Parse the container transcript into a flat session result. Pure; unit-tested. */
export function parseClientOutput(out, { exitCode, timedOut, testBytes }) {
  const r = {
    ok: false, stage: 'client', errorCode: null, error: null,
    sessionId: null, channel: null, proxy: null, reachCode: null, reachMs: null,
    downloadedBytes: 0, speedBps: 0, mbps: null, totalMs: null, ttfbMs: null, attempts: 0,
    connectivityOk: null, connectivityMs: null, rttMs: null,
    clientRxBytes: null, clientTxBytes: null, clientSeconds: null, spentBase: null, sessionStatus: null,
    stopRc: null, stopError: null, afterStop: null, routesLeft: null, clientRxAfterStop: null, clientTxAfterStop: null,
    steps: [], log: '', unsupported: null, cfg: {},
  };
  const stopRc = /^STOP_RC (\d+)$/m.exec(out);
  if (stopRc) r.stopRc = Number(stopRc[1]);
  r.stopError = between(out, 'STOP_ERR_BEGIN', 'STOP_ERR_END').slice(0, 400) || null;
  r.afterStop = /^AFTER_STOP (.*)$/m.exec(out)?.[1]?.trim() || null;
  const routesLeft = /^ROUTES_LEFT (\d+)$/m.exec(out);
  r.routesLeft = routesLeft ? Number(routesLeft[1]) : null;
  const afterUsage = /^AFTER_STOP_USAGE (.*)$/m.exec(out)?.[1] || '';
  const afterRx = /rx_bytes:(\d+)/.exec(afterUsage);
  r.clientRxAfterStop = afterRx ? Number(afterRx[1]) : null;
  const up = /^UPLOAD (\d+) /m.exec(out);
  r.uploadedBytes = up ? Number(up[1]) : null;
  r.ticketReused = /^TICKET_REUSE_OK ([A-Za-z0-9]+)$/m.exec(out)?.[1] || null;
  r.ticketReuseFailed = /^TICKET_REUSE_FAILED/m.test(out);
  const afterTx = /tx_bytes:(\d+)/.exec(afterUsage);
  r.clientTxAfterStop = afterTx ? Number(afterTx[1]) : null;
  for (const m of out.matchAll(/^STEP (.+)$/gm)) r.steps.push(m[1].trim());
  for (const m of out.matchAll(/^CFG (\w+) = (.+)$/gm)) r.cfg[m[1]] = m[2].trim();
  const unsupported = /^UNSUPPORTED (.+)$/m.exec(out);
  if (unsupported) {
    r.unsupported = unsupported[1].trim();
    r.errorCode = ERR.PROTOCOL_UNSUPPORTED; r.error = `client cannot run here: ${r.unsupported}`;
    return r;
  }
  const reach = /^REACH (\d{3}) ([\d.]+)$/m.exec(out);
  if (reach) { r.reachCode = reach[1]; r.reachMs = Math.round(num(reach[2]) * 1000); }
  r.log = between(out, 'LOG_BEGIN', 'LOG_END').slice(-6000);
  const errLines = between(out, 'ERR_BEGIN', 'ERR_END');
  const start = between(out, 'SESSION_START_BEGIN', 'SESSION_START_END');
  r.sessionId = /^SID (.+)$/m.exec(out)?.[1]?.trim() || null;
  r.channel = /"channel"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(start)?.[1] || null;
  r.proxy = /^PROXY (.+)$/m.exec(out)?.[1]?.trim() || null;
  if (timedOut) {
    r.stage = r.sessionId ? 'download' : 'session';
    r.errorCode = ERR.CLIENT_TIMEOUT; r.error = 'client container timed out';
    return r;
  }
  const fail = /^FAIL (\S+)(.*)$/m.exec(out);
  if (fail) {
    const kind = fail[1];
    if (kind === 'unreachable') { r.stage = 'probe'; r.errorCode = ERR.UNREACHABLE; r.error = `node API unreachable from the client container (${fail[2].trim()})`; }
    else if (kind === 'init' || kind === 'daemon-not-ready') { r.stage = 'client'; r.errorCode = ERR.DAEMON_NOT_READY; r.error = `client daemon ${kind === 'init' ? 'init failed' : 'never became ready'}: ${r.log.split('\n').slice(-3).join(' | ').slice(0, 300)}`; }
    else if (kind === 'session-start') { r.stage = 'session'; r.errorCode = ERR.SESSION_START_FAIL; r.error = summariseSessionError(start, errLines || r.log); }
    else { r.stage = 'client'; r.errorCode = ERR.UNKNOWN; r.error = `client failed: ${kind} ${fail[2].trim()}`.slice(0, 300); }
    return r;
  }
  const tries = [...out.matchAll(/^DL_TRY (\d+) ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) (\d{3})$/gm)];
  r.attempts = tries.length;
  const dl = /^DOWNLOAD ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) (\d{3})$/m.exec(out);
  if (dl) {
    r.downloadedBytes = Math.round(num(dl[1]));
    r.speedBps = num(dl[2]);
    r.totalMs = Math.round(num(dl[3]) * 1000);
    r.ttfbMs = Math.round(num(dl[4]) * 1000);
    r.httpCode = dl[5];
  }
  const cn = /^CONNECTIVITY (\d{3}) ([\d.]+)(?: ([\d.]+) ([\d.]+))?$/m.exec(out);
  if (cn) {
    r.connectivityOk = cn[1] !== '000' && Number(cn[1]) < 500;
    r.connectivityMs = Math.round(num(cn[2]) * 1000);
    const rtt = cn[4] !== undefined ? num(cn[4]) - num(cn[3]) : null;
    r.rttMs = rtt != null && rtt > 0 ? Math.round(rtt * 1000) : null;
  }
  const status = between(out, 'STATUS_BEGIN', 'STATUS_END');
  if (status) {
    try {
      const j = JSON.parse(status);
      const s = j.session || j;
      r.sessionStatus = s.status || null;
      if (s.usage) { r.clientRxBytes = num(s.usage.rx_bytes); r.clientTxBytes = num(s.usage.tx_bytes); r.clientSeconds = num(s.usage.seconds); }
      if (s.spent !== undefined) r.spentBase = String(s.spent);
    } catch (err) {
      const rx = /"rx_bytes"\s*:\s*"?(\d+)/.exec(status); const tx = /"tx_bytes"\s*:\s*"?(\d+)/.exec(status); const sp = /"spent"\s*:\s*"?(\d+)/.exec(status);
      if (rx) r.clientRxBytes = Number(rx[1]); if (tx) r.clientTxBytes = Number(tx[1]); if (sp) r.spentBase = sp[1];
    }
  }
  if (!r.sessionId) { r.stage = 'session'; r.errorCode = ERR.SESSION_START_FAIL; r.error = summariseSessionError(start, errLines || r.log); return r; }
  // The script prints FAIL for every failure it handles; dying mid-session without one (and
  // before the DOWNLOAD summary) means the container itself was killed — a client-side crash,
  // never evidence about the node. (Real-server e2e: a crashed client read "no bytes in 0 attempts".)
  if (!/^DOWNLOAD /m.test(out) && !/^DONE$/m.test(out) && exitCode !== 0) {
    r.stage = 'client'; r.errorCode = ERR.CLIENT_EXITED;
    r.error = `client container exited (code ${exitCode}) during the session, before the download finished — a client-side failure, not a node fault`;
    return r;
  }
  // Every speed source answered with an HTTP error THROUGH the tunnel: the tunnel works, the
  // download host refused (rate limit / outage). Not a node fault — say so instead of blaming it.
  if (r.downloadedBytes < Math.floor(testBytes * 0.99) && r.httpCode && /^[45]\d\d$/.test(r.httpCode)) {
    r.stage = 'download'; r.errorCode = ERR.SPEED_SOURCE_UNAVAILABLE;
    r.error = `every speed source refused the download through the tunnel (last HTTP ${r.httpCode}) — the tunnel works; the speed host is rate-limiting or down`;
    return r;
  }
  if (r.downloadedBytes < Math.floor(testBytes * 0.99)) {
    r.stage = 'download'; r.errorCode = ERR.TUNNEL_NO_TRAFFIC;
    r.error = r.downloadedBytes ? `only ${r.downloadedBytes} of ${testBytes} bytes came through the tunnel in ${r.attempts} attempts` : `no bytes came through the tunnel in ${r.attempts} attempts (session ${r.sessionStatus || 'unknown'})`;
    return r;
  }
  if (!/^DONE$/m.test(out) || exitCode !== 0) {
    r.stage = 'done'; r.errorCode = ERR.UNKNOWN; r.error = `client exited ${exitCode} after the download`;
    return r;
  }
  r.stage = 'done';
  r.ok = true;
  r.mbps = r.totalMs ? Math.round(((r.downloadedBytes * 8) / (r.totalMs / 1000) / 1e6) * 100) / 100 : Math.round((r.speedBps * 8 / 1e6) * 100) / 100;
  return r;
}

/**
 * Base units the client commits at session start: it signs a voucher for its own
 * prepay, owed = ceil(prepayBytes × pricePerGb / 1e9) (sentinel-solana docs/25 §5).
 */
export function prepayCost(pricePerGb, prepayBytes) {
  const price = BigInt(String(pricePerGb || '0'));
  return (price * BigInt(prepayBytes) + 999_999_999n) / 1_000_000_000n;
}

/** Escrow that covers the prepay voucher with margin, never below the configured floor. */
export function escrowFor({ pricePerGb, prepayBytes, escrowFloor }) {
  const owed = prepayCost(pricePerGb, prepayBytes);
  const withMargin = owed + owed / 5n + 1n;
  return withMargin > BigInt(escrowFloor) ? withMargin.toString() : String(escrowFloor);
}

/**
 * Stream (per-hour) escrow: `hours` of the node's channel_price_per_hour — the Cosmos
 * per-hour test buys 1 hour. The channel is closed right after the session, so only
 * the elapsed time is paid and the rest comes back.
 */
export function streamEscrow(pricePerHour, hours = 1) {
  const rate = BigInt(String(pricePerHour || '0'));
  if (rate <= 0n) throw new Error('node does not sell per-hour channels (channel_price_per_hour = 0)');
  return (rate * BigInt(hours)).toString();
}

/**
 * The `client start` credential flags for one session.
 *   { kind: 'gigabytes', escrow }                → --new-channel --mode voucher --escrow-base-units N
 *   { kind: 'hours', escrow }                    → --new-channel --mode stream --escrow-base-units N
 *   { kind: 'ticket', provider, subscription }   → --ticket --provider P --subscription S
 */
export function credentialArgs(cred) {
  const b58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (cred.kind === 'ticket') {
    if (!b58.test(cred.provider || '') || !b58.test(cred.subscription || '')) throw new Error('ticket credential needs a provider and a subscription address');
    return `--ticket --provider ${cred.provider} --subscription ${cred.subscription}`;
  }
  if (!/^\d+$/.test(String(cred.escrow || ''))) throw new Error(`escrow must be base units, got "${cred.escrow}"`);
  return `--new-channel --mode ${cred.kind === 'hours' ? 'stream' : 'voucher'} --escrow-base-units ${cred.escrow}`;
}

/**
 * The admin DNS choice as the client's `dns_servers` TOML list ('1.1.1.1', '1.0.0.1').
 * Only literal IPs pass (the value lands in a sed expression in the container);
 * an empty or invalid list falls back to Cloudflare, the client's own default.
 */
export function dnsToml(servers) {
  const ips = (Array.isArray(servers) ? servers : []).map(s => String(s).trim()).filter(s => isIP(s));
  return (ips.length ? ips : DNS_PRESETS.cloudflare).map(s => `'${s}'`).join(', ');
}

/**
 * Run one session. `node` = discovered node (lib/discovery.js), `probe` = its
 * probe record (for service type), `override` = { host, port } when the on-chain
 * URI is not routable from a container (lab nodes). `pricing` = 'gigabytes'
 * (voucher channel, default) | 'hours' (stream channel) | 'ticket' with
 * `ticket` = { provider, subscription } (plan runs: no channel, no spend).
 */
/**
 * The client daemon's store for one plan subscription, kept between sessions (mode 700).
 * A provider counts every unexpired ticket against the plan's max_connections for its TTL
 * (24 h), and a node re-admits a stored ticket: so a reconnect must present the ticket it
 * already holds (`--ticket-hash`), never ask for a new one. The store lives in the client's
 * own data.db, which dies with the container unless it is kept here.
 */
export function ticketStoreDir(subscription) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(subscription || '')) throw new Error('ticket store needs a subscription address');
  const dir = join(DATA_DIR, 'tickets', subscription);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function runSessionTest({ node, probe, keypair, rpcUrl, settings, override = null, onLine = null, onChannel = null, pricing = 'gigabytes', ticket = null, lab = null, load = null, onStart = null }) {
  const id = randomUUID().slice(0, 8);
  const hostDir = join(CLIENTS_DIR, id);
  mkdirSync(hostDir, { recursive: true });
  // Load lab: the caller ends a load user by writing <hostDir>/stop (seen in the container as /mnt/snt/stop).
  if (onStart) onStart({ id, hostDir });
  const t0 = Date.now();
  try {
    writeFileSync(join(hostDir, 'wallet.json'), keypairToJson(keypair), { mode: 0o600 });
    // The RPC URL may carry an API key: a 0600 file, never `docker run -e` (host ps shows argv).
    if (/['\n\r]/.test(rpcUrl)) throw new Error('RPC URL contains a quote or newline');
    writeFileSync(join(hostDir, 'rpc.env'), `RPC='${rpcUrl}'\nWS='${rpcUrl.replace(/^http/, 'ws')}'\n`, { mode: 0o600 });
    // Bandwidth lab (plan Part D): mount the lab script; production sessions pass no `lab`.
    if (lab) writeFileSync(join(hostDir, 'lab.sh'), LAB_SH, { mode: 0o644 });
    if (load) writeFileSync(join(hostDir, 'load.sh'), LOAD_SH, { mode: 0o644 });
    const service = probe?.serviceType || node.protocol || 'wireguard';
    const prepay = Math.min(settings.prepayBytes, probe?.settlement?.prepay_limits?.max_bytes ? Number(probe.settlement.prepay_limits.max_bytes) : Infinity);
    const escrow = pricing === 'ticket' ? null
      : pricing === 'hours' ? streamEscrow(node.pricePerHour, settings.hours || 1)
        : escrowFor({ pricePerGb: node.pricePerGb, prepayBytes: prepay, escrowFloor: settings.escrowBase });
    const cred = credentialArgs(pricing === 'ticket' ? { kind: 'ticket', ...ticket } : { kind: pricing, escrow });
    const target = parseUri(node.uri);
    const dlTimeout = Math.max(60, Math.ceil(settings.testBytes / (250_000 / 8))); // ≥ 60 s, assumes ≥ 0.25 Mbps worst case
    const env = [
      `OWNER=${keypair.publicKey.toBase58()}`,
      `NODE=${node.address}`,
      `NODE_URI=${node.uri}`,
      `SERVICE=${service}`,
      `CRED=${cred}`,
      `PREPAY=${prepay}`,
      `URLS=${process.env.SNT_XFER === 'upload' ? '' : speedSources(settings.testBytes).join(' ')}`,
      `TEST_BYTES=${settings.testBytes}`,
      `MIN_BYTES=${Math.floor(settings.testBytes * 0.99)}`,
      `DL_TIMEOUT=${dlTimeout}`,
      `CONN_URL=${CONNECTIVITY_URL}`,
      `PROXY=${service === 'v2ray' || service === 'xray' ? 'socks5h://127.0.0.1:1080' : ''}`,
      `DNS_TOML=${dnsToml(ACTIVE_DNS)}`,
      `OVERRIDE_HOST=${override ? override.host : ''}`,
      `OVERRIDE_PORT=${override ? override.port : (target ? target.port : 443)}`,
      // Fault lab only (#11 A/B): SNT_FAULT=kill-openvpn on the tester process; never set in production.
      `FAULT=${['kill-openvpn', 'drop-reconnect', 'mtu-probe', 'reconnect-same'].includes(process.env.SNT_FAULT) ? process.env.SNT_FAULT : ''}`,
      `TICKET_SUB=${pricing === 'ticket' ? ticket.subscription : ''}`,
      // Fault lab only: SNT_XFER=upload on the tester process (no download; POST TEST_BYTES).
      `XFER=${process.env.SNT_XFER === 'upload' ? 'upload' : ''}`,
      `UP_URL=https://speed.cloudflare.com/__up`,
      `HOLD=${/^\d{1,3}$/.test(process.env.SNT_HOLD || '') ? process.env.SNT_HOLD : ''}`,
      ...(load ? loadEnv(load) : []),
      ...(lab ? [`LAB_ORIGIN=${lab.origin}`, `LAB_PIN=${lab.pin}`, `LAB_PLAN=${lab.plan}`, `LAB_SEED_BASE=${lab.seedBase}`, `LAB_IDLE_N=${lab.idleN ?? 20}`, `LAB_EXTRA_URL=${lab.extraUrl || ''}`, `LAB_FIRST=${lab.first ? 1 : 0}`, `LAB_OPTS=${lab.opts || ''}`, `LAB_NOTRACE=${lab.noTrace ? 1 : 0}`] : []),
    ];
    // The channel is recorded the moment the daemon prints it, not after the
    // container exits: a timeout or a kill must never leave escrow the sweep
    // does not know about.
    let inStart = false;
    let seenChannel = null;
    const lineHook = (line) => {
      if (line.startsWith('SESSION_START_BEGIN')) inStart = true;
      else if (line.startsWith('SESSION_START_END')) inStart = false;
      else if (inStart && !seenChannel) {
        const m = /"channel"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(line);
        if (m) {
          seenChannel = m[1];
          if (onChannel) {
            try { onChannel(seenChannel, escrow); } catch (err) { console.error('[session] onChannel hook failed:', err.message); }
          }
        }
      }
      if (onLine) onLine(line);
    };
    const ticketDir = pricing === 'ticket' ? ticketStoreDir(ticket.subscription) : null;
    const run = await runClientContainer({ id, hostDir, ticketDir, env, script: CLIENT_SCRIPT, timeoutMs: settings.clientTimeoutSec * 1000, onLine: lineHook });
    const parsed = parseClientOutput(run.output, { exitCode: run.exitCode, timedOut: run.timedOut, testBytes: settings.testBytes });
    // The client's own `spent` refreshes on its 60 s issuer tick, so a short test
    // usually reads none; the prepay voucher it signed at start is the commitment.
    // Per-hour: what was paid is known only when the channel is closed (elapsed time),
    // which the caller does right after this returns. Ticket: the plan was prepaid.
    const committed = !parsed.sessionId || pricing !== 'gigabytes' ? null : prepayCost(node.pricePerGb, prepay).toString();
    if (pricing === 'gigabytes' && (parsed.spentBase == null || parsed.spentBase === '0')) parsed.spentBase = committed;
    if (pricing === 'ticket') parsed.spentBase = '0';
    parsed.ticketHash = /"ticket_hash"\s*:\s*"([^"]+)"/.exec(run.output)?.[1] || parsed.ticketReused || null;
    return { ...parsed, pricing, committedBase: committed, escrowBase: escrow, prepayBytes: pricing === 'gigabytes' ? prepay : null, service, durationMs: Date.now() - t0, containerExit: run.exitCode, transcript: run.output.slice(-20_000), ...(lab ? { labOutput: run.output } : {}), ...(load ? { loadOutput: run.output } : {}) };
  } finally {
    rmSync(hostDir, { recursive: true, force: true });
  }
}
