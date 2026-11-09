#!/bin/bash
# ─── Bandwidth lab: known-cap rounds (ground truth = the cap) ───
# For each cap, shape the lab node VM's uplink (what it sends to clients) with tbf, run the
# session batch on the client VM, then remove the shaping. Never shapes any other machine.
#
#   bash scripts/bwlab/caps.sh <round> <repeats> "<caps in Mbit>" <plan> <extra-url> "<nodes>" "<origins>"
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
G=(--account="${GCP_ACCOUNT:?set GCP_ACCOUNT}" --project="${GCP_PROJECT:?set GCP_PROJECT}" --quiet)
ROUND=$1; REPS=$2; CAPS=$3; PLAN=$4; XURL=$5; NODES=$6; ORIGINS=$7
trap 'bash "$HERE/vm.sh" netem del >/dev/null 2>&1; echo "shaping removed (exit)"' EXIT
for CAP in $CAPS; do
  bash "$HERE/vm.sh" netem del >/dev/null 2>&1
  # burst ≥ rate/HZ and ≥ a few MTUs; 50 ms of queue.
  BURST=$(( CAP * 1000000 / 8 / 100 )); [ "$BURST" -lt 32000 ] && BURST=32000
  bash "$HERE/vm.sh" netem add tbf rate "${CAP}mbit" burst "$BURST" latency 50ms 2>&1 | grep -E "tbf" | head -1
  gcloud compute ssh "${G[@]}" --zone=us-east1-c snt-bw-client-use1 --command \
    "BATCH_EXTRA='${BATCH_EXTRA:-}' bash ~/bw/batch.sh $ROUND-cap$CAP $REPS '$PLAN' '$XURL' '$NODES' '$ORIGINS'" 2>&1 | grep -E "^$ROUND-|BATCH_DONE|rror"
done
