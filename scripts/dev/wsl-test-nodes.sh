#!/bin/bash
# ─── wsl-test-nodes ──────────────────────────────────────────────────────────
# Extra devnet test nodes for the tester's multi-node / multi-protocol e2e, one
# per protocol, inside WSL next to the shared rig node. Each is owned by the
# devnet test wallet (key file only — copied 0600 into each home, never into the
# repo) and bonds 1 tDVPN, which comes back after close + 3600 s unbonding.
#
#   wsl -d Ubuntu -u root -e bash …/wsl-test-nodes.sh up       init (once), open_node (once), start daemons
#   wsl -d Ubuntu -u root -e bash …/wsl-test-nodes.sh status   PDAs, listing, daemons
#   wsl -d Ubuntu -u root -e bash …/wsl-test-nodes.sh stop     stop the daemons (nodes stay registered)
#   wsl -d Ubuntu -u root -e bash …/wsl-test-nodes.sh close    stop, delist + close_node (bond → unbonding)
#   wsl -d Ubuntu -u root -e bash …/wsl-test-nodes.sh withdraw withdraw matured bonds
#
# Nodes advertise https://<WSL eth0 IP>:<port>: routable from Windows and from
# Docker Desktop containers without NODE_URI_OVERRIDES.
set -uo pipefail
export PATH=/root/.local/share/solana/install/active_release/bin:/usr/local/go/bin:/usr/local/bin:$PATH
ROOT=${SENTINEL_SOLANA_DIR:?set SENTINEL_SOLANA_DIR (the sentinel-solana checkout, as a WSL path)}
D=$ROOT/upstream/sentinel-dvpnd/bin/dvpnd
CTL_BIN=$ROOT/upstream/sentinel-dvpnctl/bin/dvpnctl
KEYFILE=$ROOT/keys/devnet/client.json
OWNER=11111111111111111111111111111111
MINT=Hen2LVP6KooGaXEvdSyCHWghsEY4gLLn7wix8z6zHFSa
CTL=/root/snt-ctl
STATE=/root/snt-test-nodes.tsv
VMIP=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)
# protocol  api-port  bit
NODES="v2ray 18511 2
xray 18512 4
openvpn 18513 8
hysteria2 18514 16
wireguard 18515 1"

ctl() { "$CTL_BIN" --home "$CTL" "$@"; }
rpc_url() { grep -E "^url" /root/dvpnd-node/config.toml | head -1 | sed -E "s/^url *= *'([^']+)'.*/\1/"; }
wait_ready() { local i; for i in $(seq 1 60); do grep -q '"message":"ready"' "$1" 2>/dev/null && return 0; sleep 2; done; return 1; }

ensure_ctl() {
  mkdir -p "$CTL/keys"; chmod 700 "$CTL" "$CTL/keys"
  install -m 600 "$KEYFILE" "$CTL/keys/owner.json"
  local url; url=$(rpc_url)
  cat > "$CTL/config.toml" <<EOF
output = 'json'

[key]
name = 'owner'

[log]
format = 'console'
level = 'warn'

[rpc]
commitment = 'confirmed'
timeout = 30000000000
url = '$url'
ws_url = '${url/https/wss}'

[tx]
commitment = 'confirmed'
compute_unit_margin_percent = 20
confirm_timeout = 90000000000
loaded_data_limit_bytes = 8388608
max_priority_fee_lamports = 100000
priority_fee_lamports = 0
EOF
  chmod 600 "$CTL/config.toml"
}

# Devnet constants (same values sentinel-solana's own e2e-full.sh uses).
VAULT=EQJyAyWLGZSye3BMfDQVdhrfp1QKEByNX9q2J9TzFmfy
OURATA=EhDydiQnv7yaYoE4nnh6CUdnfrJzaaVa56min95sAJRF
# The ONE node account with this node id (never "any node except X").
node_by_id() { ctl node search | python3 -c "
import sys,json
try:
  a=[x['address'] for x in json.load(sys.stdin) if bytes(x['value'].get('nodeId') or []).hex()=='$1']
  print(a[0] if a else '')
except Exception: print('')"; }

up_one() {
  local P=$1 PORT=$2 BIT=$3 H=/root/snt-node-$1
  if [ ! -f "$H/node/config.toml" ]; then
    mkdir -p "$H"
    "$D" init --role node --home "$H" --owner "$OWNER" --country US --api-hosts "$VMIP" --api-port "$PORT" \
      --prices.channel-per-gb 1000 --prices.channel-per-hour 1000 --prices.lease-per-hour 1000 \
      --service "$P" --plain-key > "$H/init.json" 2>"$H/init.err" || { echo "$P: init FAILED: $(tail -2 "$H/init.err")"; return 1; }
    local key; key=$(python3 -c "import json;d=json.load(open('$H/init.json'));print(d.get('key_name') or d['key'])")
    install -m 600 "$KEYFILE" "$H/node/keys/$key.json"
    local url; url=$(rpc_url)
    sed -i "s#^url = .*#url = '$url'#; s#^ws_url = .*#ws_url = '${url/https/wss}'#" "$H/config.toml"
    sed -i "s#^threshold_base_units = .*#threshold_base_units = 1#" "$H/node/config.toml"
    # REALITY carries no traffic on this build: keep only ws/grpc/tcp inbounds.
    for f in "$H/node/v2ray/config.toml" "$H/node/xray/config.toml"; do [ -f "$f" ] && python3 - "$f" <<'PY'
import re,sys
p=sys.argv[1]; s=open(p).read()
blocks=re.split(r'(?=\[\[inbounds\]\])', s)
keep=[b for b in blocks if not (b.startswith('[[inbounds]]') and re.search(r"security\s*=\s*'reality'", b))]
open(p,'w').write(''.join(keep))
PY
    done
    echo "$P: initialised ($H)"
  fi
  local NID; NID=$(python3 -c "import json;print(json.load(open('$H/init.json'))['id'])")
  if ! grep -q "^$P	" "$STATE" 2>/dev/null; then
    local OUT; OUT=$(ctl node open-node --node-id "$NID" --bond 1000000 --country US --protocols "$BIT" --uri "https://$VMIP:$PORT" \
      --prices.channel-price-per-gb 1000 --prices.channel-price-per-hour 1000 --prices.lease-price-per-hour 1000 \
      --mint "$MINT" --vault "$VAULT" --owner-token "$OURATA" --rent-payer "$OWNER" 2>&1)
    grep -q '"signature"' <<<"$OUT" || { echo "$P: open-node FAILED: $(echo "$OUT" | tail -3)"; return 1; }
    sleep 5
    local PDA; PDA=$(node_by_id "$NID")
    [ -n "$PDA" ] || { echo "$P: open-node landed but the node account was not found by id"; return 1; }
    printf '%s\t%s\t%s\t%s\n' "$P" "$PDA" "$NID" "$PORT" >> "$STATE"
    echo "$P: open_node → $PDA"
    sleep 7
  fi
  if pgrep -f "dvpnd start --home $H" >/dev/null; then echo "$P: daemon already running"; return 0; fi
  nohup "$D" start --home "$H" > "$H/daemon.log" 2>&1 &
  if wait_ready "$H/daemon.log"; then echo "$P: daemon ready"; else echo "$P: daemon NOT ready: $(grep -E '"level":"(error|fatal)"' "$H/daemon.log" | tail -2)"; fi
  sleep 7
}

status() {
  echo "VM_IP $VMIP"
  [ -f "$STATE" ] || { echo "no test nodes"; return; }
  while IFS=$'\t' read -r P PDA NID PORT; do
    local run=down; pgrep -f "dvpnd start --home /root/snt-node-$P" >/dev/null && run=up
    printf 'NODE %-10s %s port %s daemon %s\n' "$P" "$PDA" "$PORT" "$run"
  done < "$STATE"
}

case "${1:-status}" in
  up)
    [ -x "$D" ] && [ -x "$CTL_BIN" ] || { echo "dvpnd/dvpnctl missing — run sentinel-solana scripts/build-all.sh"; exit 1; }
    ensure_ctl
    modprobe wireguard 2>/dev/null
    while read -r P PORT BIT; do up_one "$P" "$PORT" "$BIT"; done <<< "$NODES"
    status ;;
  status) status ;;
  stop)
    for H in /root/snt-node-*; do pkill -TERM -f "dvpnd start --home $H" 2>/dev/null; done
    sleep 5; status ;;
  close)
    ensure_ctl
    for H in /root/snt-node-*; do pkill -TERM -f "dvpnd start --home $H" 2>/dev/null; done; sleep 5
    while IFS=$'\t' read -r P PDA NID PORT; do
      ctl node delist-node --node "$PDA" >/dev/null 2>&1; sleep 7
      OUT=$(ctl node close-node --node "$PDA" --rent-payer "$OWNER" 2>&1)
      echo "$P: close-node $(echo "$OUT" | grep -oE '"signature" *: *"[^"]+"' | head -1 || echo "$OUT" | tail -1)"
      sleep 7
    done < "$STATE" ;;
  withdraw)
    ensure_ctl
    WAIT=$(ctl program params | python3 -c "import sys,json; print(json.load(sys.stdin)['unbondingSeconds'])")
    NOW=$(date +%s)
    # Only the unbonding accounts of THIS script's node ids (the wallet owns other projects' bonds too).
    IDS=$(cut -f3 "$STATE" | tr '\n' ' ')
    while read -r ADDR AMOUNT CLOSED; do
      [ -z "$ADDR" ] && continue
      if [ "$NOW" -lt $((CLOSED + WAIT)) ]; then echo "wait  $ADDR $AMOUNT withdrawable in $((CLOSED + WAIT - NOW)) s"; continue; fi
      OUT=$(ctl node withdraw-node-bond --node-unbonding "$ADDR" --owner-token "$OURATA" --mint "$MINT" --vault "$VAULT" --rent-payer "$OWNER" 2>&1)
      grep -q '"signature"' <<<"$OUT" && echo "OK    $ADDR $AMOUNT returned" || echo "FAIL  $ADDR $(echo "$OUT" | tail -1)"
      sleep 7
    done < <(ctl node unbonding search | python3 -c "
import sys,json
ids=set('$IDS'.split())
for x in json.load(sys.stdin):
    v=x['value']
    if v['owner']=='$OWNER' and bytes(v.get('nodeId') or []).hex() in ids: print(x['address'], v['amount'], v['closedAt'])") ;;
  *) echo "usage: $0 up|status|stop|close|withdraw"; exit 2 ;;
esac
