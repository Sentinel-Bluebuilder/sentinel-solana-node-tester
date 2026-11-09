#!/bin/bash
# ─── #1b A/B queue 2, 2026-11-08: PR #25 rerun, hy2 download pair with a 20 s hold (node-3) ───
# Runs on the cloud build box after ab-queue-1108.sh. Sweeps matured test channels first (escrow back).
set -uo pipefail
cd "$(dirname "$0")/../.."
export PATH=$HOME/snt1b/node/bin:$PATH
URL=http://127.0.0.1:3031
WG=SLVJNn38s5RfqcVW7a7A4hGKqjY7Y1bKkUpG7wrGX5D
HY2=E8nefMLBuBzG1CrA4dSDU9mqq6ZNpv69Bt3w9QEtzvPf
arm() { # <label> <bin-dir> <build-prefix> <node> [AB_FAULT] [AB_XFER] [AB_HOLD]
  echo "== $1 $(date -u +%T)"
  AB_NODES=$4 AB_FAULT=${5:-} AB_XFER=${6:-} AB_HOLD=${7:-} bash scripts/bwlab/ab-client.sh "$2" "$1" "$3" > ~/snt1b/ab-$1.log 2>&1
  echo "   exit $? $(tail -1 ~/snt1b/ab-$1.log)"
}
node cli.js sweep --url $URL > ~/snt1b/sweep-2.json 2>&1
echo "sweep $(grep -oE '"withdrawnBase": *"[0-9]+"' ~/snt1b/sweep-2.json) balance $(node cli.js status --json --url $URL | grep -oE '"balanceBase":[0-9]+')"
arm P25-A2 ~/snt1b/bin cb33092 $WG drop-reconnect
arm P25-B2 ~/q10-B pr-reconnect-id- $WG drop-reconnect
arm HY-A-down2 ~/snt1b/bin cb33092 $HY2 '' '' 20
arm HY-B-down2 ~/hy2-B pr-hy2-tun-meter- $HY2 '' '' 20
echo "QUEUE_DONE $(date -u +%T)"
