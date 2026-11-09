#!/bin/bash
# ─── box-deploy ──────────────────────────────────────────────────────────────
# Hosts the tester on a real Linux host (BOX_HOST) for the real-server
# e2e: committed HEAD only (git archive), npm ci, a loopback-only systemd unit.
#   bash scripts/dev/box-deploy.sh [deploy|env KEY=VAL…|restart|stop|logs|remove]
# Reach it from the laptop with:  ssh -N -L 3021:127.0.0.1:3021 "$BOX_HOST"
# The admin token is written to the host (0600) and copied to
# test/box-admin-token on the laptop (git-ignored) for the CLI.
set -uo pipefail
HOST=${BOX_HOST:?set BOX_HOST (ssh host)}
B=/home/ubuntu/snt-test
T=$B/tester
HERE=$(cd "$(dirname "$0")/../.." && pwd)
SSH="ssh -o BatchMode=yes $HOST"

unit() {
  $SSH "sudo -n tee /etc/systemd/system/snt-tester.service >/dev/null" <<EOF
[Unit]
Description=snt-test Node Tester (Solana) — temporary real-server e2e
After=network-online.target docker.service
[Service]
WorkingDirectory=$T
ExecStart=/usr/bin/node server.js
KillSignal=SIGTERM
TimeoutStopSec=60
Restart=no
StandardOutput=append:$T/results-boot.log
StandardError=append:$T/results-boot.log
EOF
  $SSH "sudo -n systemctl daemon-reload"
}

case "${1:-deploy}" in
  deploy)
    cd "$HERE" || exit 1
    [ -z "$(git status --porcelain -- audit core lib protocol platforms routes server.js cli.js package.json package-lock.json chain)" ] \
      || { echo "uncommitted runtime changes — commit first (only HEAD is shipped)"; exit 1; }
    $SSH "sudo -n systemctl stop snt-tester 2>/dev/null; sudo -n mkdir -p $T && sudo -n chown ubuntu:ubuntu $T"
    git archive --format=tar HEAD | $SSH "tar -x -C $T"
    $SSH "cd $T && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2"
    if ! $SSH "test -f $T/.env"; then
      TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
      RPCS=$(grep -E '^SOLANA_RPC_URLS=' .env | head -1 | cut -d= -f2-)
      IMAGE=$(grep -E '^DVPND_IMAGE=' .env | head -1 | cut -d= -f2-)
      $SSH "umask 077; cat > $T/.env" <<EOF
PORT=3021
LISTEN_HOST=127.0.0.1
ADMIN_TOKEN=$TOKEN
PUBLIC_MODE=true
SOLANA_RPC_URLS=$RPCS
TEST_KEYFILE=$B/keys/owner.json
DVPND_IMAGE=$IMAGE
EOF
      mkdir -p test; (umask 077; printf '%s' "$TOKEN" > test/box-admin-token)
      echo "admin token → test/box-admin-token"
    fi
    unit
    $SSH "sudo -n systemctl start snt-tester; sleep 12; systemctl is-active snt-tester; curl -s -m 5 http://127.0.0.1:3021/health | head -c 200; echo" ;;
  env)
    shift
    for kv in "$@"; do
      k=${kv%%=*}
      # KEY= (empty) removes the key. (An "[ -n ] && echo" as the last command made the
      # group fail on removal, so the mv never ran and the key silently stayed.)
      $SSH "cd $T && { grep -v '^$k=' .env; if [ -n '${kv#*=}' ]; then echo '$kv'; fi; } > .env.new && mv .env.new .env && chmod 600 .env"
    done
    $SSH "grep -vE '^(ADMIN_TOKEN|SOLANA_RPC_URLS)=' $T/.env" ;;
  restart) $SSH "sudo -n systemctl restart snt-tester; sleep 12; systemctl is-active snt-tester" ;;
  stop)    $SSH "sudo -n systemctl stop snt-tester; systemctl is-active snt-tester" ;;
  logs)    $SSH "tail -n ${2:-40} $T/results-boot.log" ;;
  remove)
    $SSH "sudo -n systemctl stop snt-tester 2>/dev/null; sudo -n rm -f /etc/systemd/system/snt-tester.service; sudo -n systemctl daemon-reload; sudo -n docker ps -aq --filter name=^snt-client- | xargs -r sudo -n docker rm -f"
    rm -f "$HERE/test/box-admin-token"; echo removed ;;
  *) echo "usage: $0 deploy|env KEY=VAL…|restart|stop|logs [n]|remove"; exit 2 ;;
esac
