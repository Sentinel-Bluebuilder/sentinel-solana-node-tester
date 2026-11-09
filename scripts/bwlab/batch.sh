#!/bin/bash
# ─── Bandwidth lab: a batch of measured sessions, run ON the client VM (copied to ~/bw/batch.sh) ───
#   bash batch.sh <round-label> <repeats> <plan> <extra-url> "<node>@<protocol> ..." "<origin-ip>@<name> ..."
# BATCH_EXTRA adds session.mjs flags (e.g. --steady: the tester's own steady method, no lab block).
cd ~/bw/repo; export PATH=/opt/node/bin:$PATH
R=$1; N=$2; PLAN=$3; XURL=$4; NODES=$5; ORIGINS=$6
for i in $(seq 1 $N); do
  for nd in $NODES; do
    for og in $ORIGINS; do
      # shellcheck disable=SC2086
      node scripts/bwlab/session.mjs --node "${nd%@*}" --origin "https://${og%@*}:8443" --pin "$(sed 's/pin //' ~/bw/pin.txt)" --secret-file ~/bw/secret.txt \
        --plan "$PLAN" --extra-url "$XURL" --gigabytes 5 --label "$R-${nd#*@}-${og#*@}-r$i" --out test/bwlab/vm/sessions.jsonl ${BATCH_EXTRA:-} > /tmp/last-session.log 2>&1
      tail -1 test/bwlab/vm/sessions.jsonl | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const m=(j.lab?j.lab.methods:[]).map(m=>m.id+"x"+m.streams+"="+m.steadyMbps+(m.verified===false?"!UNVERIFIED":"")).join(" ");const sm=(j.tester&&j.tester.speedMethod)||j.speedMethod;const st=sm?"STEADY "+sm.basis+" "+sm.mbps+" line "+sm.lineMbps+" classic "+sm.classicMbps+" verified "+sm.verified+" idle "+(sm.idleLatency&&sm.idleLatency.medianMs)+(sm.falling?" FALLING":""):"";console.log(j.label,"tester",j.tester&&j.tester.actualMbps,"idle",j.lab&&j.lab.idleLatency.medianMs,m,st,j.error?"ERR "+j.error.errorCode+" "+j.error.message.slice(0,160):"")})'
      sleep 8
    done
  done
done
echo BATCH_DONE
