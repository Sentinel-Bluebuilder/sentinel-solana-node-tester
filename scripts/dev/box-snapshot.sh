#!/bin/bash
# ─── box-snapshot ────────────────────────────────────────────────────────────
# Records the test host's network / service state BEFORE the tester's temporary
# changes, so box-restore.sh can prove teardown put everything back.
#   bash scripts/dev/box-snapshot.sh [baseline|after]     (runs on the laptop)
# Writes /home/ubuntu/snt-test/<name>/ on the box. Read-only on the host itself.
set -uo pipefail
HOST=${BOX_HOST:?set BOX_HOST (ssh host)}
NAME=${1:-baseline}
ssh -o BatchMode=yes "$HOST" "bash -s" "$NAME" <<'REMOTE'
set -uo pipefail
NAME=$1
D=/home/ubuntu/snt-test/$NAME
mkdir -p "$D"; chmod 700 /home/ubuntu/snt-test
sudo -n ufw status numbered                     > "$D/ufw.txt" 2>&1
sudo -n nft list tables                         > "$D/nft-tables.txt" 2>&1
# Full ruleset minus volatile counters / docker-managed set elements.
sudo -n nft -s list ruleset 2>&1 | grep -v "^\s*elements = "  > "$D/nft-ruleset.txt"
ip route show table all                         > "$D/ip-route.txt" 2>&1
ip rule                                         > "$D/ip-rule.txt" 2>&1
ip -o link | awk -F': ' '{print $2}' | sed 's/@.*//' | sort > "$D/ip-links.txt"
ss -lntu | awk 'NR>1{print $1, $5}' | sort -u   > "$D/listening.txt"
sudo -n docker ps -a --format '{{.Names}} {{.Image}}' | sort > "$D/docker.txt" 2>&1
systemctl list-units --type=service --state=running --no-legend | awk '{print $1}' | sort > "$D/services.txt"
pgrep -f "dvpnd start" -a | sort                > "$D/dvpnd-procs.txt"
date -u +%FT%TZ > "$D/taken-at.txt"
echo "snapshot $NAME → $D"; wc -l "$D"/*.txt | tail -1
REMOTE
