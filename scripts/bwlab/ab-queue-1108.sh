#!/bin/bash
# ─── #1b A/B queue, 2026-11-08: #11 openvpn kill, PR #25 reconnect id, hy2 tun meter (node-3) ───
# Runs on the cloud build box. Each pair: A = pure cb33092e, B = the PR's client build.
set -uo pipefail
cd "$(dirname "$0")/../.."
export PATH=$HOME/snt1b/node/bin:$PATH
WG=SLVJNn38s5RfqcVW7a7A4hGKqjY7Y1bKkUpG7wrGX5D
HY2=E8nefMLBuBzG1CrA4dSDU9mqq6ZNpv69Bt3w9QEtzvPf
arm() { # <label> <bin-dir> <build-prefix> <node> [AB_FAULT] [AB_XFER]
  echo "== $1 $(date -u +%T)"
  AB_NODES=$4 AB_FAULT=${5:-} AB_XFER=${6:-} bash scripts/bwlab/ab-client.sh "$2" "$1" "$3" > ~/snt1b/ab-$1.log 2>&1
  echo "   exit $? $(tail -1 ~/snt1b/ab-$1.log)"
}
OVPN=9EQJ7dBwneFUse9yy8Hg56u2wPiGF5qkjAaA1ZAr64nP
arm K11-A2 ~/snt1b/bin cb33092 $OVPN kill-openvpn
arm K11-B2 ~/q11-B pr-ovpn-host-route- $OVPN kill-openvpn
arm P25-A ~/snt1b/bin cb33092 $WG drop-reconnect
arm P25-B ~/q10-B pr-reconnect-id- $WG drop-reconnect
arm HY-A-down ~/snt1b/bin cb33092 $HY2
arm HY-A-up ~/snt1b/bin cb33092 $HY2 '' upload
arm HY-B-down ~/hy2-B pr-hy2-tun-meter- $HY2
arm HY-B-up ~/hy2-B pr-hy2-tun-meter- $HY2 '' upload
echo "QUEUE_DONE $(date -u +%T)"
