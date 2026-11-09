#!/bin/bash
# ─── Repin the tester's client image to a staged build (fork-final-build.sh stage dir) ───
#   scripts/ops/repin-client.sh <stage-dir> [--apply]
#
# <stage-dir> is the product's stage folder copied to this box (MANIFEST, SHA256SUMS,
# linux-amd64/sentinel-dvpnd + sentinel-dvpn). Checks the sums, reads the tag from MANIFEST,
# confirms both binaries report that tag + commit, builds snt-tester/dvpnd:<tag>, and checks
# the binaries inside the image against SHA256SUMS. Without --apply it stops there (dry run).
# With --apply it also sets DVPND_IMAGE in .env (backup .env.bak-<time>); restarting the
# tester stays a separate, deliberate step. Run on the build box (the cloud build box), never on a laptop.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
STAGE=${1:?stage dir}; APPLY=${2:-}
[ -z "$APPLY" ] || [ "$APPLY" = --apply ] || { echo "second arg: --apply or nothing" >&2; exit 2; }
cd "$STAGE"

# ─── Verify the stage ───
sha256sum -c --quiet SHA256SUMS
TAG=$(awk '/^tag:/{print $2}' MANIFEST); COMMIT=$(awk '/^commit:/{print substr($2,1,7)}' MANIFEST)
case "$TAG" in ''|*[!A-Za-z0-9._-]*) echo "MANIFEST tag missing or odd: '$TAG'" >&2; exit 1;; esac
D=linux-amd64/sentinel-dvpnd; C=linux-amd64/sentinel-dvpn
chmod 755 "$D" "$C"
for b in "$D" "$C"; do
  V=$("./$b" version 2>&1)
  grep -qF "\"tag\":\"$TAG\"" <<<"$V" && grep -qF "\"commit\":\"$COMMIT" <<<"$V" \
    || { echo "$b reports $V, MANIFEST says $TAG $COMMIT" >&2; exit 1; }
done
echo "[repin] stage ok: $TAG ($COMMIT)"

# ─── Build and check the image ───
IMAGE=snt-tester/dvpnd:$TAG
DVPND_IMAGE=$IMAGE EXPECT_BUILD=$TAG bash "$ROOT/scripts/build-client-image.sh" "$STAGE/$D" "$STAGE/$C" > "$STAGE/image-build.log" 2>&1 \
  || { tail -20 "$STAGE/image-build.log" >&2; exit 1; }
IN=$(docker run --rm --entrypoint sh "$IMAGE" -c 'sha256sum "$(command -v sentinel-dvpnd)" "$(command -v sentinel-dvpn)"' | awk '{print $1}' | tr '\n' ' ')
WANT="$(awk '/linux-amd64\/sentinel-dvpnd$/{print $1}' SHA256SUMS) $(awk '/linux-amd64\/sentinel-dvpn$/{print $1}' SHA256SUMS) "
[ "$IN" = "$WANT" ] || { echo "image binaries differ from SHA256SUMS: $IN vs $WANT" >&2; exit 1; }
echo "[repin] built $IMAGE; binaries in the image match SHA256SUMS"

# ─── Apply (optional) ───
if [ "$APPLY" = --apply ]; then
  cd "$ROOT"
  cp .env ".env.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  if grep -q '^DVPND_IMAGE=' .env; then sed -i "s#^DVPND_IMAGE=.*#DVPND_IMAGE=$IMAGE#" .env; else echo "DVPND_IMAGE=$IMAGE" >> .env; fi
  echo "[repin] .env now: $(grep '^DVPND_IMAGE=' .env); restart the tester to use it"
else
  echo "[repin] dry run: .env unchanged ($(grep '^DVPND_IMAGE=' "$ROOT/.env" || echo 'DVPND_IMAGE unset'))"
fi
