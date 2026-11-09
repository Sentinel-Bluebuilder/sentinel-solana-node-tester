# Bandwidth lab, round 0: dev rig node (2026-10-20, 22:50–23:50 UTC)

Node: `6AaXvhWp…` (WireGuard, WSL on the laptop, exits through the laptop's home internet).
Client: the normal `dvpnd` client container on the laptop. Our origin `scripts/bwlab/origin.mjs` on the
laptop's WSL vEthernet address (no WAN). Per-GB sessions, 1 GB prepay. Raw transcripts and
`sessions.jsonl` are in this folder; every number below comes from them.

## What the tester reported vs what the tunnel carried

| Session | Tester (10 MB, `bytes / time_total`) | Same tunnel, our origin, 1 stream steady | 4 streams steady |
|---|---|---|---|
| r1 | 4.16 Mbps | 232.9 Mbps (verified bytes) | 293.6 Mbps |
| r2 | 4.99 Mbps | 229.8 Mbps | — |

The tunnel is not slow; the tester's figure comes from its speed host.

## Why: the speed host, not the node

- `.env` sets `SPEED_URL=https://ash-speed.hetzner.com/100MB.bin` (Hetzner, Ashburn, US East). The
  code default is Cloudflare. Every tester reading here was Hetzner Ashburn.
- Through the tunnel, Hetzner Ashburn runs a flat ~5 Mbps for the whole download (per-second trace,
  r10: `0.5 13.7 6.6 4.6 4.9 5.3 4.6 4.8 5.3 5.5 5.3 4.3 5.2 4.7 5.0`).
- Through the same tunnel, OVH runs 48–74 Mbps (r2 X1 / r10 XFa trace).
- Directly from the laptop with no tunnel, Hetzner Ashburn runs 23–25 Mbps and OVH 30–38 Mbps.
- Inside the tunnel, the Hetzner connection shows RTT 196 ms and `rcv_ooopack:419` out of 831 segments
  (`ss -tin`, r11): heavy reordering on the node's long path. With one Cubic stream on a 200 ms path
  that pins throughput near 5 Mbps. The receive window was not the limit (`rcv_wnd` 1.5 MB).
- Ruled out by experiment: the order of downloads in the session (r4), curl options and calling style
  (exact tester command in the foreground with `-m 320`, r8/r9/r10), and the lab's own background traffic (r7).
- Hetzner answers parallel streams with HTTP 429 (r11: 2 of 4 streams refused). A third-party host
  cannot carry a multi-stream test.
- DNS through the tunnel costs ~2.2 s on the first lookup (`time_namelookup`); `bytes / time_total`
  counts it as transfer time.

## What this means for fairness (to be measured properly in the VM lab)

1. A node's score depends on where it is relative to one fixed speed host. A node far from Ashburn
   scores low even when its tunnel is fast. This is the largest error seen so far, ~45–55× on this node.
2. One stream on a long path measures the path's loss and reordering, not the node's capacity.
3. The fix direction: verified-content origins we control, chosen near the node, multi-stream,
   time-bounded, steady state, with DNS and setup excluded. Our instruments
   (`audit/speed-lab.js`, `scripts/bwlab/origin.mjs`) already measure all of these in one session.

Caveat: this node exits through WSL NAT on a home connection, so its path is worse than a
datacenter node's. The VM lab (plan Part D3) repeats this on clean datacenter paths in several regions.
