#!/bin/bash
# ─── Bandwidth lab: the before/after matrix, run ON the lab client VM ───
# Runs without the laptop: each condition is set on the lab node's uplink over SSH
# (key ~/.ssh/labnode, node reached by its internal IP), the batch runs here with the
# shipped steady method (every session also takes the classic reading), and the
# condition is removed again (also on exit).
#   bash matrix.sh <round> "<name>=<reps>=<qdisc spec>;…" "<node>@<proto> …" "<origin-ip>@<name>"
# e.g. "cap25=3=tbf rate 25mbit burst 32000 latency 50ms;loss1=2=netem loss 1%"
set -uo pipefail
ROUND=$1; SPECS=$2; NODES=$3; ORIGINS=$4
NIP=${NODE_IP:-$(getent hosts snt-bw-node.us-central1-a.c.ddv-node-test-5821.internal | cut -d' ' -f1)}
node_sh() { ssh -i ~/.ssh/labnode -o BatchMode=yes -o ConnectTimeout=15 "${NODE_USER:-node}@$NIP" "$@"; }
clear_q() { node_sh 'sudo tc qdisc del dev ens4 root 2>/dev/null; true'; }
trap 'clear_q; echo "MATRIX conditions removed (exit)"' EXIT
IFS=';' read -ra LIST <<< "$SPECS"
for item in "${LIST[@]}"; do
  NAME=${item%%=*}; REST=${item#*=}; REPS=${REST%%=*}; SPEC=${REST#*=}
  clear_q
  [ "$SPEC" != none ] && node_sh "sudo tc qdisc add dev ens4 root $SPEC"
  echo "MATRIX $NAME reps=$REPS qdisc: $(node_sh 'tc qdisc show dev ens4 | head -1')"
  BATCH_EXTRA=--steady bash ~/bw/batch.sh "$ROUND-$NAME" "$REPS" 'S:4:10' none "$NODES" "$ORIGINS" 2>&1 | grep -E "^$ROUND-|BATCH_DONE|rror"
done
echo MATRIX_DONE
