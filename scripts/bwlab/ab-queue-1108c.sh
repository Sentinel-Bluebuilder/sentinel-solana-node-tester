#!/bin/bash
# ─── #1b A/B queue 3, 2026-11-08: PR #25 (waits for the reconnect), hy2 meter on the final-sample base ───
# Runs on the cloud build box. Sweeps until the wallet covers the six sessions (escrow comes back as test
# channels pass their 2 h grace), at most 30 min.
set -uo pipefail
cd "$(dirname "$0")/../.."
export PATH=$HOME/snt1b/node/bin:$PATH
URL=http://127.0.0.1:3031
WG=SLVJNn38s5RfqcVW7a7A4hGKqjY7Y1bKkUpG7wrGX5D
HY2=E8nefMLBuBzG1CrA4dSDU9mqq6ZNpv69Bt3w9QEtzvPf
NEED=1300000
arm() { # <label> <bin-dir> <build-prefix> <node> [AB_FAULT] [AB_XFER] [AB_HOLD]
  echo "== $1 $(date -u +%T)"
  AB_NODES=$4 AB_FAULT=${5:-} AB_XFER=${6:-} AB_HOLD=${7:-} bash scripts/bwlab/ab-client.sh "$2" "$1" "$3" > ~/snt1b/ab-$1.log 2>&1
  echo "   exit $? $(tail -1 ~/snt1b/ab-$1.log)"
}
balance() { node cli.js status --json --url $URL | grep -oE '"balanceBase":[0-9]+' | grep -oE '[0-9]+$'; }
for i in $(seq 1 15); do
  node cli.js sweep --url $URL > ~/snt1b/sweep-3.json 2>&1
  B=$(balance); echo "sweep $i $(date -u +%T) $(grep -oE '"withdrawnBase": *"[0-9]+"' ~/snt1b/sweep-3.json) balance $B"
  [ "${B:-0}" -ge $NEED ] && break
  sleep 120
done
[ "${B:-0}" -ge $NEED ] || { echo "QUEUE_ABORT balance $B < $NEED"; exit 1; }
arm P25-A3 ~/snt1b/bin cb33092 $WG drop-reconnect
arm P25-B3 ~/q10-B pr-reconnect-id- $WG drop-reconnect
arm HYF-A-down ~/hy2f-A pr-final-sample-A $HY2 '' '' 20
arm HYF-A-up ~/hy2f-A pr-final-sample-A $HY2 '' upload 20
arm HYF-B-down ~/hy2f-B hy2-on-final-sample-B $HY2 '' '' 20
arm HYF-B-up ~/hy2f-B hy2-on-final-sample-B $HY2 '' upload 20
echo "QUEUE_DONE $(date -u +%T)"
