#!/bin/bash
# ─── box-test-nodes ──────────────────────────────────────────────────────────
# Devnet test nodes on a real host (BOX_HOST), one per protocol, for
# the tester's real-server e2e. Run from the laptop; it re-executes itself on the
# host over SSH:
#   bash scripts/dev/box-test-nodes.sh up        init (once), open_node (once), firewall, start
#   bash scripts/dev/box-test-nodes.sh status    PDAs, units, ports
#   bash scripts/dev/box-test-nodes.sh stop      stop daemons (nodes stay registered)
#   bash scripts/dev/box-test-nodes.sh start     start daemons again
#   bash scripts/dev/box-test-nodes.sh close     stop, delist + close_node (bond → unbonding)
#   bash scripts/dev/box-test-nodes.sh withdraw  withdraw matured bonds (≥ 3600 s after close)
#   bash scripts/dev/box-test-nodes.sh teardown  remove units, firewall rules, interfaces, homes
#   An existing dfe36c7 node home: stop it, then `sudo bash scripts/dev/migrate-node-home.sh <home>` (cf4c372 layout).
#
# Everything lives under /home/ubuntu/snt-test, units are snt-node@<proto>, ufw
# rules carry the comment "snt-test", interfaces are snt-*. Nothing else on the
# host is touched (another project's node runs there — never stop or edit it).
set -uo pipefail
HOST=${BOX_HOST:?set BOX_HOST (ssh host)}
B=${SNT_B:-/home/ubuntu/snt-test}
# Another host (the bandwidth lab VM): copy this script there and run it with SNT_ON_HOST=1 and
# SNT_B / SNT_OWNER / SNT_OWNER_ATA / SNT_IP / SNT_WAN set (scripts/bwlab/vm.sh does this).

# ─── Laptop side: ship the RPC URL once, then run this script on the host ───
if [ "${SNT_ON_HOST:-}" != 1 ] && { [ ! -d "$B" ] || [ "$(hostname)" != "ubuntu-server-1" ]; }; then
  HERE=$(cd "$(dirname "$0")/../.." && pwd)
  RPC=$(grep -E '^SOLANA_RPC_URLS=' "$HERE/.env" | head -1 | cut -d= -f2- | cut -d, -f1)
  [ -n "$RPC" ] || { echo "SOLANA_RPC_URLS missing in .env"; exit 1; }
  printf '%s' "$RPC" | ssh -o BatchMode=yes "$HOST" "umask 077; cat > $B/rpc.txt"
  exec ssh -o BatchMode=yes "$HOST" "bash -s -- $*" < "$0"
fi

# ─── Host side ───
export PATH=$B/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
OWNER=${SNT_OWNER:-11111111111111111111111111111111}
MINT=Hen2LVP6KooGaXEvdSyCHWghsEY4gLLn7wix8z6zHFSa
VAULT=EQJyAyWLGZSye3BMfDQVdhrfp1QKEByNX9q2J9TzFmfy
OURATA=${SNT_OWNER_ATA:-EhDydiQnv7yaYoE4nnh6CUdnfrJzaaVa56min95sAJRF}
IP=${SNT_IP:?set SNT_IP (the host public IP)}
WAN=${SNT_WAN:-ens3}
COUNTRY=${SNT_COUNTRY:-US}
# Vouchers per redeem tx. 1 = a tx per voucher (heavy on RPC); a demo node batches.
REDEEM_THRESHOLD=${SNT_REDEEM_THRESHOLD:-1}
CTL=$B/ctl
STATE=$B/nodes.tsv
RPC=$(cat $B/rpc.txt)
S="sudo -n"
# name  service    bit  api    iface      subnet          tunnel ports (proto:port …)            internal ports
NODES="wg    wireguard  1   18611  snt-wg0    10.211.1.1/24   udp:18621                               -
awg   amneziawg  32  18612  snt-awg0   10.211.2.1/24   udp:18622                               -
v2ray v2ray      2   18613  -          -               tcp:18623,tcp:18624                     api:18641
xray  xray       4   18614  -          -               tcp:18626,tcp:18627                     api:18642
ovpn  openvpn    8   18615  snt-ovpn0  10.211.5.1/24   udp:18629                               mgmt:18643
hy2   hysteria2  16  18616  -          -               udp:18630                               auth:18644,stats:18645"

ctl() { $S $B/bin/dvpnctl --home "$CTL" "$@"; }
node_by_id() { ctl node search | python3 -c "
import sys,json
try:
  a=[x['address'] for x in json.load(sys.stdin) if bytes(x['value'].get('nodeId') or []).hex()=='$1']
  print(a[0] if a else '')
except Exception as e: print('')"; }

ensure_ctl() {
  $S mkdir -p "$CTL/keys"; $S chmod 700 "$CTL" "$CTL/keys"
  $S install -m 600 $B/keys/owner.json "$CTL/keys/owner.json"
  $S tee "$CTL/config.toml" >/dev/null <<EOF
output = 'json'
[key]
name = 'owner'
[log]
format = 'console'
level = 'warn'
[rpc]
commitment = 'confirmed'
timeout = 30000000000
url = '$RPC'
ws_url = '${RPC/https/wss}'
[tx]
commitment = 'confirmed'
compute_unit_margin_percent = 20
confirm_timeout = 90000000000
loaded_data_limit_bytes = 8388608
max_priority_fee_lamports = 100000
priority_fee_lamports = 0
EOF
  $S chmod 600 "$CTL/config.toml"
}

ensure_unit() {
  $S tee /etc/systemd/system/snt-node@.service >/dev/null <<EOF
[Unit]
Description=snt-test dVPN node %i (temporary, Node Tester Solana e2e)
After=network-online.target
[Service]
Environment=PATH=$B/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$B/bin/dvpnd start --home $B/node-%i
KillSignal=SIGTERM
TimeoutStopSec=40
Restart=no
StandardOutput=append:$B/node-%i/daemon.log
StandardError=append:$B/node-%i/daemon.log
EOF
  $S systemctl daemon-reload
}

# Pin interface / subnet / ports in the generated protocol config; drop REALITY inbounds.
patch_cfg() {
  local H=$1 SVC=$2 IFACE=$3 SUBNET=$4 TPORTS=$5 IPORTS=$6
  $S python3 - "$H/node/$SVC/config.toml" "$SVC" "$IFACE" "$SUBNET" "$TPORTS" "$IPORTS" <<'PY'
import re, sys
p, svc, iface, subnet, tports, iports = sys.argv[1:]
s = open(p).read()
def setkey(s, k, v):
    return re.sub(rf"(?m)^{k} = .*$", f"{k} = {v}", s, count=1)
tp = [int(x.split(':')[1]) for x in tports.split(',')]
ip = {} if iports == '-' else {x.split(':')[0]: int(x.split(':')[1]) for x in iports.split(',')}
if svc in ('wireguard', 'amneziawg', 'openvpn'):
    s = setkey(s, 'interface', f"'{iface}'")
    s = setkey(s, 'addresses', f"['{subnet}']")
    s = setkey(s, 'listen_port', str(tp[0]))
    if svc == 'openvpn': s = setkey(s, 'management_port', str(ip['mgmt']))
elif svc in ('v2ray', 'xray'):
    s = setkey(s, 'api_port', str(ip['api']))
    blocks = re.split(r'(?=^\[\[inbounds\]\])', s, flags=re.M)
    head, inb = blocks[0], [b for b in blocks[1:] if "security = 'reality'" not in b]
    for i, b in enumerate(inb):
        inb[i] = re.sub(r'(?m)^port = \d+$', f'port = {tp[i]}', b, count=1)
    s = head + ''.join(inb)
elif svc == 'hysteria2':
    s = setkey(s, 'listen_port', str(tp[0]))
    s = setkey(s, 'auth_port', str(ip['auth']))
    s = setkey(s, 'stats_port', str(ip['stats']))
open(p, 'w').write(s)
PY
}

fw_open() {
  local API=$1 TPORTS=$2 IFACE=$3
  # No ufw on the host (the lab VM): its cloud firewall rule opens the ports instead.
  $S ufw status 2>/dev/null | grep -q "Status: active" || return 0
  $S ufw allow "$API/tcp" comment snt-test >/dev/null
  for t in ${TPORTS//,/ }; do $S ufw allow "${t#*:}/${t%%:*}" comment snt-test >/dev/null; done
  [ "$IFACE" != "-" ] && $S ufw route allow in on "$IFACE" out on "$WAN" comment snt-test >/dev/null
  return 0
}

wait_ready() { local i; for i in $(seq 1 60); do $S grep -q '"message":"ready"' "$1" 2>/dev/null && return 0; sleep 2; done; return 1; }

up_one() {
  local N=$1 SVC=$2 BIT=$3 API=$4 IFACE=$5 SUBNET=$6 TPORTS=$7 IPORTS=$8 H=$B/node-$1
  if ! $S test -f "$H/node/config.toml"; then
    $S $B/bin/dvpnd init --role node --home "$H" --owner "$OWNER" --country "$COUNTRY" --api-hosts "$IP" --api-port "$API" \
      --prices.channel-per-gb 1000 --prices.channel-per-hour 1000 --prices.lease-per-hour 1000 \
      --service "$SVC" --plain-key 2>"$B/init-$N.err" | $S tee "$H.init.json" >/dev/null || { echo "$N: init FAILED: $(tail -2 "$B/init-$N.err")"; return 1; }
    local KEY; KEY=$($S python3 -c "import json;d=json.load(open('$H.init.json'));print(d.get('key_name') or d['key'])")
    $S install -m 600 $B/keys/owner.json "$H/node/keys/$KEY.json"
    $S sed -i "s#^url = .*#url = '$RPC'#; s#^ws_url = .*#ws_url = '${RPC/https/wss}'#" "$H/config.toml"
    $S sed -i "s#^threshold_base_units = .*#threshold_base_units = $REDEEM_THRESHOLD#" "$H/node/config.toml"
    patch_cfg "$H" "$SVC" "$IFACE" "$SUBNET" "$TPORTS" "$IPORTS"
    echo "$N: initialised"
  fi
  local NID; NID=$($S python3 -c "import json;print(json.load(open('$H.init.json'))['id'])")
  if ! $S grep -q "^$N	" "$STATE" 2>/dev/null; then
    local OUT; OUT=$(ctl node open-node --node-id "$NID" --bond 1000000 --country "$COUNTRY" --protocols "$BIT" --uri "https://$IP:$API" \
      --prices.channel-price-per-gb 1000 --prices.channel-price-per-hour 1000 --prices.lease-price-per-hour 1000 \
      --mint "$MINT" --vault "$VAULT" --owner-token "$OURATA" --rent-payer "$OWNER" 2>&1)
    grep -q '"signature"' <<<"$OUT" || { echo "$N: open-node FAILED: $(echo "$OUT" | tail -3)"; return 1; }
    sleep 6
    local PDA; PDA=$(node_by_id "$NID")
    [ -n "$PDA" ] || { echo "$N: open-node landed but the node account was not found by id"; return 1; }
    printf '%s\t%s\t%s\t%s\t%s\n' "$N" "$PDA" "$NID" "$SVC" "$API" | $S tee -a "$STATE" >/dev/null
    echo "$N: open_node → $PDA"
    sleep 7
  fi
  fw_open "$API" "$TPORTS" "$IFACE"
  if systemctl is-active -q "snt-node@$N"; then echo "$N: already running"; return 0; fi
  $S truncate -s 0 "$H/daemon.log" 2>/dev/null
  $S systemctl start "snt-node@$N"
  if wait_ready "$H/daemon.log"; then echo "$N: ready"; else echo "$N: NOT ready: $($S grep -E '"level":"(error|fatal)"' "$H/daemon.log" | tail -2 | cut -c1-300)"; fi
  sleep 7
}

status() {
  [ -f "$STATE" ] || { echo "no test nodes"; return; }
  while IFS=$'\t' read -r N PDA NID SVC API; do
    printf 'NODE %-6s %-10s %s api %s unit %s\n' "$N" "$SVC" "$PDA" "$API" "$(systemctl is-active "snt-node@$N")"
  done < "$STATE"
}

case "${1:-status}" in
  up)
    $S systemctl disable --now openvpn >/dev/null 2>&1   # the apt package's stub unit; purged at teardown
    ensure_ctl; ensure_unit
    while read -r N SVC BIT API IFACE SUBNET TPORTS IPORTS; do
      [ -n "${2:-}" ] && [ "$2" != "$N" ] && continue
      up_one "$N" "$SVC" "$BIT" "$API" "$IFACE" "$SUBNET" "$TPORTS" "$IPORTS"
    done <<< "$NODES"
    status ;;
  status) status ;;
  stop)  for N in $(cut -f1 "$STATE"); do [ -n "${2:-}" ] && [ "$2" != "$N" ] && continue; $S systemctl stop "snt-node@$N"; done; status ;;
  start) for N in $(cut -f1 "$STATE"); do [ -n "${2:-}" ] && [ "$2" != "$N" ] && continue; $S systemctl start "snt-node@$N"; done; sleep 10; status ;;
  close)
    ensure_ctl
    while IFS=$'\t' read -r N PDA NID SVC API; do
      $S systemctl stop "snt-node@$N"
      ctl node delist-node --node "$PDA" >/dev/null 2>&1; sleep 7
      OUT=$(ctl node close-node --node "$PDA" --rent-payer "$OWNER" 2>&1)
      grep -q '"signature"' <<<"$OUT" && echo "$N: closed (bond unbonding)" || echo "$N: close FAILED: $(echo "$OUT" | tail -1)"
      sleep 7
    done < "$STATE" ;;
  withdraw)
    ensure_ctl
    WAIT=$(ctl program params | python3 -c "import sys,json; print(json.load(sys.stdin)['unbondingSeconds'])")
    NOW=$(date +%s); IDS=$(cut -f3 "$STATE" | tr '\n' ' ')
    while read -r ADDR AMOUNT CLOSED; do
      [ -z "$ADDR" ] && continue
      if [ "$NOW" -lt $((CLOSED + WAIT)) ]; then echo "wait  $ADDR withdrawable in $((CLOSED + WAIT - NOW)) s"; continue; fi
      OUT=$(ctl node withdraw-node-bond --node-unbonding "$ADDR" --owner-token "$OURATA" --mint "$MINT" --vault "$VAULT" --rent-recipient "$OWNER" 2>&1)
      grep -q '"signature"' <<<"$OUT" && echo "OK    $ADDR $AMOUNT returned" || echo "FAIL  $ADDR $(echo "$OUT" | tail -1)"
      sleep 7
    done < <(ctl node unbonding search | python3 -c "
import sys,json
ids=set('$IDS'.split())
for x in json.load(sys.stdin):
    v=x['value']
    if v['owner']=='$OWNER' and bytes(v.get('nodeId') or []).hex() in ids: print(x['address'], v['amount'], v['closedAt'])") ;;
  teardown)
    for N in $(cut -f1 "$STATE" 2>/dev/null); do $S systemctl stop "snt-node@$N" 2>/dev/null; done
    $S rm -f /etc/systemd/system/snt-node@.service; $S systemctl daemon-reload
    # ufw rules carrying our comment, highest number first so numbering stays valid.
    for n in $($S ufw status numbered | grep "# snt-test" | sed -E 's/^\[ *([0-9]+)\].*/\1/' | sort -rn); do $S ufw --force delete "$n" >/dev/null; done
    for i in snt-wg0 snt-awg0 snt-ovpn0; do ip link show "$i" >/dev/null 2>&1 && $S ip link del "$i"; done
    for t in $($S nft list tables | awk '/dvpnd_snt-/{print $2" "$3}' | tr ' ' ':'); do $S nft delete table "${t%%:*}" "${t#*:}"; done
    echo "teardown done (homes and keys are removed by box-restore.sh after bonds are withdrawn)" ;;
  *) echo "usage: $0 up [name]|status|stop [name]|start [name]|close|withdraw|teardown"; exit 2 ;;
esac
