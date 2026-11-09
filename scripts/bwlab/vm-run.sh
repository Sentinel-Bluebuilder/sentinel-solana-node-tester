#!/bin/bash
# ─── One CLI run on the tester VM, then a one-line-per-node summary ───
#   bash scripts/bwlab/vm-run.sh <start args…>     e.g. --addresses A,B   or   --hours --addresses A
# Runs ON the VM via tester-vm.sh ssh; prints status, then per node: pass, error, Mbps (steady,
# line, classic), latency, verified MB, client config and channel.
HERE=$(cd "$(dirname "$0")/../.." && pwd)
ARGS="$*"
bash "$HERE/scripts/bwlab/tester-vm.sh" ssh "cd /home/ubuntu/snt-tester
node cli.js start $ARGS --url http://127.0.0.1:3031 >/tmp/start.json 2>&1 || { cat /tmp/start.json; exit 1; }
node cli.js wait --timeout 3000 --url http://127.0.0.1:3031 >/dev/null 2>&1
node scripts/bwlab/vm-summary.mjs http://127.0.0.1:3031"
