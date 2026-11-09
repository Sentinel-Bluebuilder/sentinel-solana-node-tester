# ─── Tester client image: sentinel-dvpnd cb33092e + every protocol's client tools ─
# The program on devnet runs upstream cb33092e since 2026-11-02 (public as
# sentinel-official/sentinel-solana 26de5240, same code); older builds can no longer open
# channels (open_channel → Custom 102). This image carries a PURE cb33092e client: the tester
# tests nodes with the client users get.
#
# Protocol tools: the same pinned sources and checksums as Node Manager (Solana)
# docker/dvpnd.Dockerfile (#28b). sentinel-dvpnd / sentinel-dvpn: static Linux binaries of
# the cb33092e tree with devnet link-time identity (SENTINEL_NETWORK=devnet + program + mint
# ldflags, as upstream's Makefile sets them), built by `scripts/build-cb33-binaries.sh`.
#
# Build context = a directory holding exactly two files, `sentinel-dvpnd` and `sentinel-dvpn`:
#   docker build -f docker/client.Dockerfile -t snt-tester/dvpnd:devnet-cb33092e <ctx>
# The build fails unless sentinel-dvpnd reports the devnet program and a cb33092 tag/commit.
# hnsd is left out: the tester's client never resolves Handshake names itself.

FROM golang:1.27.1-alpine3.24 AS build
RUN apk add --no-cache bash ca-certificates curl git make gcc musl-dev linux-headers unzip

ARG TARGETARCH=amd64
ARG XRAY_VERSION=v26.3.27
ARG XRAY_SHA256_amd64=23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae
RUN set -eux; \
    [ "${TARGETARCH}" = amd64 ] || { echo "only amd64 is pinned here" >&2; exit 1; }; \
    curl -fsSL --retry 3 --retry-delay 2 -o /tmp/xray.zip \
        "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip"; \
    echo "${XRAY_SHA256_amd64}  /tmp/xray.zip" | sha256sum -c -; \
    unzip -j /tmp/xray.zip xray -d /usr/local/bin; chmod +x /usr/local/bin/xray; rm /tmp/xray.zip

ARG HYSTERIA_VERSION=v2.9.2
ARG HYSTERIA_SHA256_amd64=86fef8e2f1b2bf41318ac96724eee6c3b449e4e510022cc89658b63a6713922a
RUN set -eux; \
    curl -fsSL --retry 3 --retry-delay 2 -o /usr/local/bin/hysteria2 \
        "https://github.com/apernet/hysteria/releases/download/app/${HYSTERIA_VERSION}/hysteria-linux-amd64"; \
    echo "${HYSTERIA_SHA256_amd64}  /usr/local/bin/hysteria2" | sha256sum -c -; \
    chmod +x /usr/local/bin/hysteria2

ARG AMNEZIAWG_TOOLS_COMMIT=61e741780e8465a67a7d7fb6cffe14a8a15d624a
RUN git clone https://github.com/amnezia-vpn/amneziawg-tools.git /tmp/amneziawg-tools && \
    git -C /tmp/amneziawg-tools checkout --quiet "${AMNEZIAWG_TOOLS_COMMIT}" && \
    make -C /tmp/amneziawg-tools/src --jobs=$(nproc) && \
    make -C /tmp/amneziawg-tools/src install \
        DESTDIR=/tmp/amneziawg-out PREFIX=/usr \
        WITH_WGQUICK=yes WITH_BASHCOMPLETION=no WITH_SYSTEMDUNITS=no && \
    install -m 0755 /tmp/amneziawg-out/usr/bin/awg /usr/local/bin/awg && \
    install -m 0755 /tmp/amneziawg-out/usr/bin/awg-quick /usr/local/bin/awg-quick && \
    rm -rf /tmp/amneziawg-tools /tmp/amneziawg-out

ARG AMNEZIAWG_GO_COMMIT=1cc94272ca8e9e223a5fe76382f5880f09d3c12d
RUN git clone https://github.com/amnezia-vpn/amneziawg-go.git /tmp/amneziawg-go && \
    git -C /tmp/amneziawg-go checkout --quiet "${AMNEZIAWG_GO_COMMIT}" && \
    cd /tmp/amneziawg-go && go build -o /usr/local/bin/amneziawg-go . && rm -rf /tmp/amneziawg-go

ARG WIREGUARD_GO_VERSION=0.0.20250522
RUN git clone --branch="${WIREGUARD_GO_VERSION}" --depth=1 https://github.com/WireGuard/wireguard-go.git /tmp/wireguard-go && \
    cd /tmp/wireguard-go && go build -o /usr/local/bin/wireguard-go . && rm -rf /tmp/wireguard-go

FROM alpine:3.24

RUN apk add --no-cache \
    bash ca-certificates curl iproute2 nftables openvpn v2ray wireguard-tools && \
    rm -rf /etc/v2ray/ /usr/share/v2ray/

COPY --chmod=0755 sentinel-dvpnd /usr/local/bin/sentinel-dvpnd
COPY --chmod=0755 sentinel-dvpn /usr/local/bin/sentinel-dvpn
COPY --from=build /usr/local/bin/xray /usr/local/bin/xray
COPY --from=build /usr/local/bin/hysteria2 /usr/local/bin/hysteria2
COPY --from=build /usr/local/bin/awg /usr/local/bin/awg
COPY --from=build /usr/local/bin/awg-quick /usr/local/bin/awg-quick
COPY --from=build /usr/local/bin/amneziawg-go /usr/local/bin/amneziawg-go
COPY --from=build /usr/local/bin/wireguard-go /usr/local/bin/wireguard-go

# AWG_FORCE_USERSPACE=1 makes awg-quick use amneziawg-go even when the host has an older
# amneziawg kernel module (see #28b's Dockerfile for the failure it avoids).
RUN <<'EOF'
set -e
f=/usr/local/bin/awg-quick
sed -i 's#if ! cmd ip link add "$INTERFACE" type amneziawg; then#if [[ -n ${AWG_FORCE_USERSPACE:-} ]] || ! cmd ip link add "$INTERFACE" type amneziawg; then#' "$f"
sed -i 's#\[\[ -e /sys/module/amneziawg \]\] ||#[[ -z ${AWG_FORCE_USERSPACE:-} \&\& -e /sys/module/amneziawg ]] ||#' "$f"
test "$(grep -c AWG_FORCE_USERSPACE "$f")" -eq 2
EOF

# Fail the build on a client that cannot talk to the program on chain.
# EXPECT_BUILD: the tag/commit prefix the client must carry (cb33092 = the pure client; an
# A/B against a fixed fork client passes e.g. fork-cb33-, see scripts/bwlab/ab-client.sh).
ARG EXPECT_BUILD=cb33092
RUN v="$(sentinel-dvpnd version)"; echo "$v"; \
    echo "$v" | grep -q '"program_id":"J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs"' && \
    echo "$v" | grep -q '"network":"devnet"' && \
    echo "$v" | grep -qE "\"(tag|commit)\":\"${EXPECT_BUILD}" && \
    sentinel-dvpn version >/dev/null

# Alpine has no resolvectl (cb33's Linux default); the session script also sets the key.
ENV SENTINEL_DVPND_NETWORK_DNS_BACKEND=resolvconf

ENTRYPOINT ["sentinel-dvpnd"]
