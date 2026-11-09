#!/bin/bash
# ─── Run the tester itself on a GCP VM (project ddv-node-test-5821, snt-bw-* only) ───
# A datacenter vantage with Linux Docker (AmneziaWG works), paying from a FRESH LAB KEY:
# the shared test wallet's key never goes to a cloud VM (fund it with scripts/bwlab/fund.mjs).
#
#   bash scripts/bwlab/tester-vm.sh setup                     docker + node 24 on the VM
#   bash scripts/bwlab/tester-vm.sh push                      the working tree (no .env, keys, results, node_modules)
#   bash scripts/bwlab/tester-vm.sh image <dvpnd> <dvpnctl>   build docker/client.Dockerfile there
#   bash scripts/bwlab/tester-vm.sh env <lab-key.json> [KEY=VAL…]   .env + key (0600) on the VM
#   bash scripts/bwlab/tester-vm.sh start|stop|logs [n]       the server on 127.0.0.1:$PORT (reach it with `tunnel`)
#   bash scripts/bwlab/tester-vm.sh tunnel                    ssh -L 3031 → the VM's server (background)
#   bash scripts/bwlab/tester-vm.sh ssh <command>
set -uo pipefail
HERE=$(cd "$(dirname "$0")/../.." && pwd)
G=(--account="${GCP_ACCOUNT:?set GCP_ACCOUNT}" --project="${GCP_PROJECT:?set GCP_PROJECT}" --quiet)
VM=${TESTER_VM:-snt-bw-tester}
ZONE=${TESTER_ZONE:-us-east1-c}
PORT=${TESTER_PORT:-3031}
R=/home/ubuntu/snt-tester
on() { gcloud compute ssh "${G[@]}" --zone="$ZONE" "ubuntu@$VM" --command "$*"; }
cp_to() { gcloud compute scp "${G[@]}" --zone="$ZONE" "$@" >/dev/null; }

case "${1:-}" in
  setup)
    on 'set -e; export DEBIAN_FRONTEND=noninteractive
      sudo apt-get -qq update >/dev/null; sudo apt-get -qq install -y ca-certificates curl git build-essential python3 >/dev/null
      command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sudo sh >/dev/null 2>&1; }
      sudo usermod -aG docker ubuntu
      if ! command -v node >/dev/null || ! node -v | grep -q "^v24"; then
        curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null 2>&1; sudo apt-get -qq install -y nodejs >/dev/null; fi
      docker --version; node -v' ;;
  push)
    TGZ=$(mktemp --suffix=.tgz)
    (cd "$HERE" && { git ls-files; git ls-files --others --exclude-standard; } | sort -u \
      | grep -vE '^(\.env$|results/|data/|keys/|node_modules/)' | while read -r f; do [ -f "$f" ] && echo "$f"; done \
      | tar -czf "$TGZ" -T -)
    cp_to "$TGZ" "ubuntu@$VM:/tmp/tester.tgz"; rm -f "$TGZ"
    on "set -e; mkdir -p $R; tar -C $R -xzf /tmp/tester.tgz; rm /tmp/tester.tgz; cd $R; npm ci --no-audit --no-fund --loglevel=error >/dev/null; echo pushed; git -C $R rev-parse 2>/dev/null; ls $R | head -30 | tr '\n' ' '" ;;
  image)
    cp_to "$2" "ubuntu@$VM:/tmp/dvpnd"; cp_to "$3" "ubuntu@$VM:/tmp/dvpnctl"
    on "set -e; C=\$(mktemp -d); mv /tmp/dvpnd /tmp/dvpnctl \$C/; cd $R
      sudo docker build -q -f docker/client.Dockerfile -t snt-tester/dvpnd:devnet-cf4c372-ddv2 \$C; rm -rf \$C
      sudo docker run --rm snt-tester/dvpnd:devnet-cf4c372-ddv2 version" ;;
  env)
    KEY=$2; shift 2
    cp_to "$KEY" "ubuntu@$VM:/tmp/lab-key.json"
    LINES=$(printf '%s\n' "$@")
    on "set -e; mkdir -p $R/keys; chmod 700 $R/keys; install -m 600 /tmp/lab-key.json $R/keys/lab.json; rm /tmp/lab-key.json
      printf '%s\n' 'PORT=$PORT' 'LISTEN_HOST=127.0.0.1' 'TEST_KEYFILE=$R/keys/lab.json' > $R/.env
      printf '%s\n' \"$LINES\" >> $R/.env; chmod 600 $R/.env; grep -oE '^[A-Z_]+=' $R/.env | tr '\n' ' '" ;;
  start)
    on "cd $R; pid=\$(sudo ss -ltnp 'sport = :$PORT' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1); [ -n \"\$pid\" ] && kill \$pid && sleep 2
      sudo -u ubuntu sg docker -c 'nohup node server.js > server.log 2>&1 &'; sleep 6; tail -3 server.log" ;;
  stop) on "pid=\$(sudo ss -ltnp 'sport = :$PORT' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1); [ -n \"\$pid\" ] && kill \$pid && echo stopped \$pid" ;;
  logs) on "tail -n ${2:-40} $R/server.log" ;;
  tunnel) gcloud compute ssh "${G[@]}" --zone="$ZONE" "ubuntu@$VM" -- -o ExitOnForwardFailure=yes -N -f -L "$PORT:127.0.0.1:$PORT" && echo "tunnel 127.0.0.1:$PORT → $VM" ;;
  ssh) shift; on "$*" ;;
  *) echo "usage: see the header"; exit 2 ;;
esac
