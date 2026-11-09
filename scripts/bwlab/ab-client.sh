#!/bin/bash
# ─── Client A/B: the six-protocol paid run with a chosen client build (Q0429) ───
#   scripts/bwlab/ab-client.sh <bin-dir> <label> [expect-build-prefix]
#
# <bin-dir> holds sentinel-dvpnd + sentinel-dvpn (A = pure cb33092e from
# scripts/build-cb33-binaries.sh; B = a fixed client, e.g. FWX's fork build with prefix fork-cb33-).
# Builds image snt-tester/dvpnd:ab-<label>, restarts the tester with DVPND_IMAGE set to it, runs
# one paid per-GB session on each AB_NODES node (default: node-3's six, pure 26de5240), writes
# <out>/ab-<label>.json + a table, then restarts the tester on its normal image.
#
# Env: AB_URL (tester, default http://127.0.0.1:3031), AB_RESTART (command that (re)starts the
# tester with the current env, default ~/snt1b/start-server.sh), AB_OUT (default ~/snt1b/ab),
# AB_NODES (comma list). Run on the build box (the cloud build box), never on a laptop. Spends 6 small
# channels (1 GB prepay each at the node's price; escrow back after the grace via the sweep).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${1:?bin dir}; LABEL=${2:?label}; EXPECT=${3:-cb33092}
case "$LABEL" in *[!A-Za-z0-9._-]*) echo "label: letters, digits, . _ - only" >&2; exit 2;; esac
URL=${AB_URL:-http://127.0.0.1:3031}
RESTART=${AB_RESTART:-$HOME/snt1b/start-server.sh}
OUT=${AB_OUT:-$HOME/snt1b/ab}
NODES=${AB_NODES:-SLVJNn38s5RfqcVW7a7A4hGKqjY7Y1bKkUpG7wrGX5D,1PwMkSjnyugAZHdHvDsddETzPUAubPkeyWymT7Ercn6,Di5V9K2Vt5uptJUk7oVVnkDRXt9qWy5HhLbkEJMxEuM2,E9RG1iZJjsLfEuLfDYTHM4yXCjyFE21jBbJLFvGoL2FD,9EQJ7dBwneFUse9yy8Hg56u2wPiGF5qkjAaA1ZAr64nP,E8nefMLBuBzG1CrA4dSDU9mqq6ZNpv69Bt3w9QEtzvPf}
TAG=snt-tester/dvpnd:ab-$LABEL
mkdir -p "$OUT"
cd "$ROOT"

restore() { echo "[ab] restoring the tester's normal image"; env -u DVPND_IMAGE -u SNT_FAULT -u SNT_XFER -u SNT_HOLD "$RESTART"; }
# AB_XFER=upload: each session POSTs TEST_BYTES up the tunnel instead of downloading (fault lab only).
case "${AB_XFER:-}" in ''|upload) ;; *) echo "AB_XFER: upload or unset" >&2; exit 2;; esac
trap restore EXIT
# AB_FAULT=kill-openvpn: the #11 A/B (openvpn killed mid-session, then stopped); fault lab only.
case "${AB_FAULT:-}" in ''|kill-openvpn|drop-reconnect|mtu-probe|reconnect-same) ;; *) echo "AB_FAULT: kill-openvpn, drop-reconnect, mtu-probe, reconnect-same or unset" >&2; exit 2;; esac

echo "[ab] build $TAG from $BIN (expect $EXPECT)"
DVPND_IMAGE=$TAG EXPECT_BUILD=$EXPECT bash scripts/build-client-image.sh "$BIN/sentinel-dvpnd" "$BIN/sentinel-dvpn"
DVPND_IMAGE=$TAG SNT_FAULT=${AB_FAULT:-} SNT_XFER=${AB_XFER:-} SNT_HOLD=${AB_HOLD:-} "$RESTART"
for _ in $(seq 1 30); do node cli.js health --url "$URL" >/dev/null 2>&1 && break; sleep 1; done

# AB_SUBPLAN="<plan> <subscription> <provider>": a plan-ticket run (test-sub-plan) instead of a paid
# per-GB one, on the tester's own subscription. No channel; the ticket store is reused.
if [ -n "${AB_SUBPLAN:-}" ]; then
  read -r SP_PLAN SP_SUB SP_PROV EXTRA <<< "$AB_SUBPLAN"
  for v in "$SP_PLAN" "$SP_SUB" "$SP_PROV"; do
    [[ "$v" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || { echo "AB_SUBPLAN: plan sub provider (base58)" >&2; exit 2; }
  done
  [ -z "${EXTRA:-}" ] || { echo "AB_SUBPLAN: exactly three values" >&2; exit 2; }
  echo "[ab] plan-ticket run on $NODES (sub ${SP_SUB:0:8})"
  node cli.js test-sub-plan "$SP_PLAN" "$SP_SUB" "$SP_PROV" --addresses "$NODES" --url "$URL" >/dev/null
else
  echo "[ab] paid run on $(echo "$NODES" | tr ',' '\n' | wc -l) nodes"
  node cli.js start --addresses "$NODES" --url "$URL" >/dev/null
fi
node cli.js wait --timeout 1800 --url "$URL" >/dev/null || true
node cli.js state --json --url "$URL" > "$OUT/ab-$LABEL.json"
node scripts/bwlab/ab-report.mjs "$OUT/ab-$LABEL.json" "$LABEL" | tee "$OUT/ab-$LABEL.txt"
