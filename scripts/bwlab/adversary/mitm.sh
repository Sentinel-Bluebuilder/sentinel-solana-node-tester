#!/bin/bash
# ─── Bandwidth lab adversary: intercept the speed origin on the LAB NODE VM (snt-bw-node) only ───
#   bash scripts/bwlab/adversary/mitm.sh on <origin-ip>   |   off <origin-ip>
# "on": a fake origin (fake-origin.py, own self-signed key) on :9443 of the node VM, and NAT that
# sends the tester's speed traffic to it, both for tunnelled traffic (WireGuard: PREROUTING on
# snt-wg0) and for connections the node opens itself (V2Ray: OUTPUT).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
G=(--account="${GCP_ACCOUNT:?set GCP_ACCOUNT}" --project="${GCP_PROJECT:?set GCP_PROJECT}" --quiet)
MODE=$1; OIP=$2
SSH=(gcloud compute ssh "${G[@]}" --zone=us-central1-a snt-bw-node --command)
if [ "$MODE" = on ]; then
  gcloud compute scp "${G[@]}" --zone=us-central1-a "$HERE/fake-origin.py" snt-bw-node:/tmp/fake-origin.py >/dev/null 2>&1
  "${SSH[@]}" "set -e; cd /tmp; [ -f fk.pem ] || openssl req -x509 -newkey rsa:2048 -nodes -keyout fk.key -out fk.pem -days 2 -subj /CN=fake >/dev/null 2>&1
    systemctl is-active --quiet snt-fake-origin || sudo systemd-run --unit=snt-fake-origin python3 /tmp/fake-origin.py 9443 /tmp/fk.pem /tmp/fk.key >/dev/null
    sudo iptables -t nat -A PREROUTING -i snt-wg0 -p tcp -d $OIP --dport 8443 -j REDIRECT --to-ports 9443
    sudo iptables -t nat -A OUTPUT -p tcp -d $OIP --dport 8443 -j REDIRECT --to-ports 9443
    sleep 1; sudo iptables -t nat -S | grep 9443; systemctl is-active --quiet snt-fake-origin && echo MITM_ON"
else
  "${SSH[@]}" "sudo iptables -t nat -D PREROUTING -i snt-wg0 -p tcp -d $OIP --dport 8443 -j REDIRECT --to-ports 9443 2>/dev/null
    sudo iptables -t nat -D OUTPUT -p tcp -d $OIP --dport 8443 -j REDIRECT --to-ports 9443 2>/dev/null
    sudo systemctl stop snt-fake-origin 2>/dev/null; sudo iptables -t nat -S | grep -c 9443; echo MITM_OFF"
fi
