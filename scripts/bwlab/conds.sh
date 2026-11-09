#!/bin/bash
# ─── Bandwidth lab: network-condition rounds (netem / tbf on the lab node's uplink only) ───
#   bash scripts/bwlab/conds.sh <round> <repeats> "<name>=<qdisc spec>;…" <plan> <extra-url> "<nodes>" "<origins>"
# e.g. "loss1=netem loss 1%;delay100=netem delay 100ms"
# Each spec is applied as `tc qdisc add dev ens4 root <spec>` on snt-bw-node, the batch runs on
# the client VM, and the qdisc is removed again (also on exit).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
G=(--account="${GCP_ACCOUNT:?set GCP_ACCOUNT}" --project="${GCP_PROJECT:?set GCP_PROJECT}" --quiet)
ROUND=$1; REPS=$2; SPECS=$3; PLAN=$4; XURL=$5; NODES=$6; ORIGINS=$7
trap 'bash "$HERE/vm.sh" netem del >/dev/null 2>&1; echo "conditions removed (exit)"' EXIT
IFS=';' read -ra LIST <<< "$SPECS"
for item in "${LIST[@]}"; do
  NAME=${item%%=*}; SPEC=${item#*=}
  bash "$HERE/vm.sh" netem del >/dev/null 2>&1
  # shellcheck disable=SC2086
  bash "$HERE/vm.sh" netem add $SPEC 2>&1 | grep -E "netem|tbf" | head -1
  gcloud compute ssh "${G[@]}" --zone=us-east1-c snt-bw-client-use1 --command \
    "BATCH_EXTRA='${BATCH_EXTRA:-}' bash ~/bw/batch.sh $ROUND-$NAME $REPS '$PLAN' '$XURL' '$NODES' '$ORIGINS'" 2>&1 | grep -E "^$ROUND-|BATCH_DONE|rror"
done
