#!/bin/bash
# ─── box-restore ─────────────────────────────────────────────────────────────
# Final teardown of the real-server e2e on the test host, then proof that the
# host matches the baseline box-snapshot.sh took before any change.
#   bash scripts/dev/box-restore.sh check    snapshot "after" + diff only (no changes)
#   bash scripts/dev/box-restore.sh restore  remove everything snt-test created, then check
# Run `box-test-nodes.sh close` and, ≥ 3600 s later, `withdraw` BEFORE restore —
# restore shreds the key copies the bond withdrawal needs.
set -uo pipefail
HOST=${BOX_HOST:?set BOX_HOST (ssh host)}
HERE=$(cd "$(dirname "$0")/../.." && pwd)
SSH="ssh -o BatchMode=yes $HOST"
B=/home/ubuntu/snt-test

check() {
  bash "$HERE/scripts/dev/box-snapshot.sh" after >/dev/null
  $SSH "bash -s" <<'REMOTE'
B=/home/ubuntu/snt-test
cd $B || exit 1
bad=0
for f in ufw.txt nft-tables.txt ip-rule.txt ip-links.txt listening.txt docker.txt services.txt dvpnd-procs.txt; do
  # docker veth names and dhcp ports are volatile; compare the stable part
  case $f in
    ip-links.txt) filt='^veth' ;;
    listening.txt) filt=':(68|546|323) ' ;;
    *) filt='^$' ;;
  esac
  if diff <(grep -vE "$filt" baseline/$f) <(grep -vE "$filt" after/$f) >/dev/null; then echo "same  $f"
  else echo "DIFF  $f"; diff <(grep -vE "$filt" baseline/$f) <(grep -vE "$filt" after/$f) | head -8; bad=1; fi
done
# Routes: compare everything except docker-bridge / veth lines that churn.
if diff <(grep -vE 'veth|linkdown' baseline/ip-route.txt) <(grep -vE 'veth|linkdown' after/ip-route.txt) >/dev/null; then echo "same  ip-route.txt"
else echo "DIFF  ip-route.txt"; diff <(grep -vE 'veth|linkdown' baseline/ip-route.txt) <(grep -vE 'veth|linkdown' after/ip-route.txt) | head -8; bad=1; fi
grep -c "snt-test\|snt_\|snt-" after/nft-ruleset.txt | sed 's/^/snt references left in nft ruleset: /'
[ $bad -eq 0 ] && echo "RESTORE CHECK: CLEAN" || echo "RESTORE CHECK: DIFFERENCES ABOVE"
REMOTE
}

case "${1:-check}" in
  check) check ;;
  restore)
    bash "$HERE/scripts/dev/box-deploy.sh" remove
    bash "$HERE/scripts/dev/box-test-nodes.sh" teardown
    $SSH "sudo -n docker images -q --filter dangling=true | xargs -r sudo -n docker rmi >/dev/null 2>&1; \
      if [ -f $B/apt-installed.txt ]; then sudo -n DEBIAN_FRONTEND=noninteractive apt-get purge -y -q openvpn >/tmp/snt-purge.log 2>&1; sudo -n apt-get autoremove -y -q >>/tmp/snt-purge.log 2>&1; tail -1 /tmp/snt-purge.log; fi; \
      sudo -n systemctl stop snt-deadman.timer snt-deadman.service 2>/dev/null; sudo -n systemctl reset-failed 'snt-*' 2>/dev/null; \
      sudo -n find $B -name '*.json' -path '*keys*' -exec shred -u {} + ; sudo -n shred -u $B/keys/owner.json $B/rpc.txt 2>/dev/null; \
      mkdir -p /tmp/snt-evidence && sudo -n cp -r $B/baseline /tmp/snt-evidence/ && sudo -n rm -rf $B/node-* $B/ctl $B/tester $B/bin $B/keys $B/nodes.tsv $B/*.init.json $B/init-*.err $B/rpc.txt; ls $B"
    check ;;
  *) echo "usage: $0 check|restore"; exit 2 ;;
esac
