#!/bin/bash
# ─── Bandwidth lab VMs (GCP project ddv-node-test-5821, names snt-bw-* only) ───
# #31 owns that project: never touch ddv-* VMs or its bucket, never switch the gcloud config.
#
#   bash scripts/bwlab/vm.sh list
#   bash scripts/bwlab/vm.sh node-setup <nodebin.tgz> <lab-key.json>   binaries + lab key + RPC on snt-bw-node
#   bash scripts/bwlab/vm.sh nodes <up [name]|status|stop|start|close|withdraw|teardown>
#   bash scripts/bwlab/vm.sh netem <iface-args…>   e.g. "add loss 1%" / "del" on the node's uplink
#   bash scripts/bwlab/vm.sh ssh <vm> <command>
#   bash scripts/bwlab/vm.sh delete-all                deletes every snt-bw-* lab VM (not snt-bw-demo-*) and, when no demo node is left, the snt-bw-allow rule
#
# Lab nodes run under their own key (scripts/bwlab/fund.mjs), never the shared test wallet's.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/../.." && pwd)
G=(--account="${GCP_ACCOUNT:?set GCP_ACCOUNT}" --project="${GCP_PROJECT:?set GCP_PROJECT}" --quiet)
NODE_VM=snt-bw-node
NODE_ZONE=us-central1-a
LAB_OWNER=${LAB_OWNER:-JCPgUDoQ8zdz3CHu4ADHtRs3nbYVS9GLWoyY5u1TrsaF}
LAB_OWNER_ATA=${LAB_OWNER_ATA:-JCNAcAU4yVuVBaR8s4JvKwJHgDG9UeEXeU9hmqBcse7c}

zone_of() { gcloud compute instances list "${G[@]}" --filter="name=$1" --format='value(zone.basename())'; }
on() { local vm=$1; shift; gcloud compute ssh "${G[@]}" --zone="$(zone_of "$vm")" "$vm" --command "$*"; }
node_ip() { gcloud compute instances describe "${G[@]}" --zone=$NODE_ZONE $NODE_VM --format='value(networkInterfaces[0].accessConfigs[0].natIP)'; }

case "${1:-list}" in
  list) gcloud compute instances list "${G[@]}" --filter='name~^snt-bw-' --format='table(name,zone.basename(),machineType.basename(),status,networkInterfaces[0].accessConfigs[0].natIP)' ;;
  node-setup)
    TGZ=$2; KEY=$3
    RPC=$(grep -E '^SOLANA_RPC_URLS=' "$HERE/.env" | head -1 | cut -d= -f2- | cut -d, -f1)
    TMP=$(mktemp -d); printf '%s' "$RPC" > "$TMP/rpc.txt"
    gcloud compute scp "${G[@]}" --zone=$NODE_ZONE "$TGZ" "$KEY" "$TMP/rpc.txt" "$HERE/scripts/dev/box-test-nodes.sh" $NODE_VM:/tmp/ >/dev/null
    rm -rf "$TMP"
    on $NODE_VM 'set -e; B=$HOME/snt-test; mkdir -p $B/keys; chmod 700 $B $B/keys
      tar -C $B -xzf /tmp/nodebin.tgz; install -m 600 /tmp/'"$(basename "$KEY")"' $B/keys/owner.json; install -m 600 /tmp/rpc.txt $B/rpc.txt
      install -m 755 /tmp/box-test-nodes.sh $B/nodes.sh; rm -f /tmp/nodebin.tgz /tmp/'"$(basename "$KEY")"' /tmp/rpc.txt
      sudo DEBIAN_FRONTEND=noninteractive apt-get -qq update >/dev/null; sudo DEBIAN_FRONTEND=noninteractive apt-get -qq install -y wireguard-tools iperf3 >/dev/null
      echo setup-ok; ls $B/bin' ;;
  nodes)
    shift
    IP=$(node_ip)
    on $NODE_VM "SNT_ON_HOST=1 SNT_B=\$HOME/snt-test SNT_OWNER=$LAB_OWNER SNT_OWNER_ATA=$LAB_OWNER_ATA SNT_IP=$IP SNT_WAN=ens4 bash \$HOME/snt-test/nodes.sh $*" ;;
  netem) shift; on $NODE_VM "sudo tc qdisc ${1:-show} dev ens4 root ${*:2}; tc qdisc show dev ens4" ;;
  ssh) vm=$2; shift 2; on "$vm" "$*" ;;
  delete-all)
    # Demo nodes (snt-bw-demo-*) are kept for the owner: they are not lab VMs.
    for line in $(gcloud compute instances list "${G[@]}" --filter='name~^snt-bw- AND NOT name~^snt-bw-demo-' --format='value(name,zone.basename())' | tr '\t' ':'); do
      gcloud compute instances delete "${G[@]}" --zone="${line#*:}" "${line%%:*}"
    done
    # The firewall rule stays while a demo node still uses its tag.
    if [ -z "$(gcloud compute instances list "${G[@]}" --filter='name~^snt-bw-demo-' --format='value(name)')" ]; then
      gcloud compute firewall-rules delete "${G[@]}" snt-bw-allow 2>/dev/null
    else
      echo "kept snt-bw-allow: a demo node uses it"
    fi
    gcloud compute instances list "${G[@]}" --filter='name~^snt-bw-' --format='value(name)' ;;
  *) echo "usage: see the header"; exit 2 ;;
esac
