#!/bin/bash
# ─── Build the tester's client image (docker/client.Dockerfile) on this machine ───
#   npm run build-client-image [-- <sentinel-dvpnd> <sentinel-dvpn>]
# Binaries default to $CB33_BIN_DIR (~/snt1b/bin), the output of scripts/build-cb33-binaries.sh
# (pure upstream cb33092e, devnet link-time identity). The tag comes from DVPND_IMAGE in .env
# (default lib/constants.js). The build fails unless the daemon reports the devnet program and
# a cb33092 tag/commit (see the Dockerfile).
# Docker must already be running; this script never starts Docker Desktop.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN=${CB33_BIN_DIR:-$HOME/snt1b/bin}
DAEMON=${1:-$BIN/sentinel-dvpnd}
CLI=${2:-$BIN/sentinel-dvpn}
TAG=${DVPND_IMAGE:-}
[ -n "$TAG" ] || TAG=$(grep -E '^DVPND_IMAGE=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)
[ -n "$TAG" ] || TAG=$(sed -nE "s/.*DVPND_IMAGE \|\| '([^']+)'.*/\1/p" "$ROOT/lib/constants.js" | head -1)
[ -n "$TAG" ] || { echo "no image tag (DVPND_IMAGE)" >&2; exit 1; }
for f in "$DAEMON" "$CLI"; do [ -f "$f" ] || { echo "missing binary: $f" >&2; exit 1; }; done
docker info >/dev/null 2>&1 || { echo "Docker is not running: start it first (this script never starts it)" >&2; exit 1; }
CTX=$(mktemp -d)
trap 'rm -rf "$CTX"' EXIT
install -m 755 "$DAEMON" "$CTX/sentinel-dvpnd"
install -m 755 "$CLI" "$CTX/sentinel-dvpn"
docker build -f "$ROOT/docker/client.Dockerfile" --build-arg "EXPECT_BUILD=${EXPECT_BUILD:-cb33092}" -t "$TAG" "$CTX"
docker run --rm "$TAG" version
echo "built $TAG"
