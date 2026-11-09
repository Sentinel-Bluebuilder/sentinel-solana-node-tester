#!/bin/bash
# ─── Pure upstream cb33092e client binaries (Linux amd64, devnet identity) ───────
#   scripts/build-cb33-binaries.sh [<upstream tree>] [<out dir>]
# Builds sentinel-dvpnd + sentinel-dvpn from an UNMODIFIED upstream tree (default ~/up-cb33:
# cb33092e, the same code as public sentinel-official/sentinel-solana 26de5240) inside a
# golang container: the tree is mounted read-only, nothing is installed on the host. The
# ldflags are upstream's Makefile LD_FLAGS with the devnet program + mint, so the build
# identity is link-time, exactly as upstream ships it. Run it on a build box, not a laptop.
set -euo pipefail
SRC=${1:-$HOME/up-cb33}
OUT=${2:-$HOME/snt1b/bin}
CACHE=${GO_CACHE_DIR:-$HOME/snt1b}
SDK=github.com/sentinel-official/sentinel-go-sdk/v3
PROGRAM_ID=J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs
MINT=Hen2LVP6KooGaXEvdSyCHWghsEY4gLLn7wix8z6zHFSa
C=$(git -C "$SRC" rev-parse HEAD)
case "$C" in cb33092e*) ;; *) echo "upstream tree is at $C, not cb33092e" >&2; exit 1;; esac
[ -z "$(git -C "$SRC" status --porcelain)" ] || { echo "upstream tree has local changes: refusing (pure build only)" >&2; exit 1; }
LD="-s -w -X $SDK/version.Commit=$C -X $SDK/version.Tag=cb33092e-pure -X $SDK/version.Network=devnet -X $SDK/version.ProgramID=$PROGRAM_ID -X $SDK/version.Mint=$MINT"
mkdir -p "$OUT" "$CACHE/gomod" "$CACHE/gocache"
docker run --rm --cpus 2 -u "$(id -u):$(id -g)" -e HOME=/tmp -e GOMODCACHE=/gomod -e GOCACHE=/gocache \
  -e GOFLAGS=-buildvcs=false -e CGO_ENABLED=0 \
  -v "$SRC:/src:ro" -v "$CACHE/gomod:/gomod" -v "$CACHE/gocache:/gocache" -v "$OUT:/out" golang:1.27.3 bash -c "
  set -e
  cd /src/sentinel-dvpnd && go build -trimpath -mod=readonly -ldflags \"$LD\" -o /out/sentinel-dvpnd ./cmd/sentinel-dvpnd
  cd /src/sentinel-dvpn && go build -trimpath -mod=readonly -ldflags \"$LD\" -o /out/sentinel-dvpn ./cmd/sentinel-dvpn"
sha256sum "$OUT/sentinel-dvpnd" "$OUT/sentinel-dvpn"
"$OUT/sentinel-dvpnd" version
