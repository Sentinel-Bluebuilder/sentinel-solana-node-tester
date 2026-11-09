#!/bin/bash
# ─── wsl-node ────────────────────────────────────────────────────────────────
# Dev rig: start (or stop) ONLY the shared WSL node daemon — node 6AaXvh… in
# /root/dvpnd-node, provisioned by work/sentinel-solana and also used by
# Plan Manager (Solana). Its config is not touched: on start the daemon
# heartbeats (list_node), which refreshes the 24 h listing so clients — and
# this tester — can discover it.
#
#   MSYS_NO_PATHCONV=1 wsl -d Ubuntu -u root -e bash <repo>/scripts/dev/wsl-node.sh
#   … wsl-node.sh down     # stop the node daemon only (never the provider)
#   … wsl-node.sh ip       # print the WSL VM address for NODE_URI_OVERRIDES
#
# The node advertises https://127.0.0.1:8443. A client container cannot reach
# that, so the tester maps it with NODE_URI_OVERRIDES=<nodePda>=<vm-ip>:8443.
set -uo pipefail
export PATH=/root/.local/share/solana/install/active_release/bin:/usr/local/go/bin:$PATH
D=${D:?set D (path to the dvpnd binary)}
NH=${NH:-/root/dvpnd-node}
LOGDIR=/root/node-tester-solana-dev
mkdir -p "$LOGDIR"

vm_ip() { ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1; }

case "${1:-up}" in
  ip) vm_ip; exit 0 ;;
  down)
    pkill -TERM -f "dvpnd start --home $NH" 2>/dev/null
    for _ in $(seq 1 15); do pgrep -f "dvpnd start --home $NH" >/dev/null || break; sleep 1; done
    pgrep -f "dvpnd start --home $NH" >/dev/null && echo "node daemon still running" || echo "node daemon stopped"
    exit 0 ;;
esac

[ -x "$D" ] || { echo "dvpnd binary missing at $D — run work/sentinel-solana/scripts/build-all.sh"; exit 1; }
if pgrep -f "dvpnd start --home $NH" >/dev/null; then echo "already running"; echo "VM_IP $(vm_ip)"; exit 0; fi
modprobe wireguard 2>/dev/null || echo "wireguard module not loaded — dvpnd falls back to wireguard-go"
for a in 1 2 3 4; do
  nohup "$D" start --home "$NH" >"$LOGDIR/node.log" 2>&1 &
  for _ in $(seq 1 60); do grep -q '"message":"ready"' "$LOGDIR/node.log" 2>/dev/null && break; sleep 2; done
  if grep -q '"message":"ready"' "$LOGDIR/node.log"; then echo "node ready"; echo "VM_IP $(vm_ip)"; exit 0; fi
  grep -q 429 "$LOGDIR/node.log" || { echo "node FAILED: $(tail -3 "$LOGDIR/node.log")"; exit 1; }
  pkill -TERM -f "dvpnd start --home $NH" 2>/dev/null; sleep $((a * 20))
done
echo "node FAILED after retries: $(tail -3 "$LOGDIR/node.log")"
exit 1
