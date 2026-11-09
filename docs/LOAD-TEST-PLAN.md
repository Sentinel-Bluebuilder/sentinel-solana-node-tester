# Load test plan: how many real users can a node carry?

Status: **plan, not built** (owner question 2026-10-21: "20 concurrent users at 10 Mbps, when does a node get cut from the front end").
The speed work so far (BANDWIDTH-TRUTH, SPEED-METHOD) measures **one** user. This plan measures many.

## What we know already
- **The tester measures one new user.** It runs one session (4 streams × 10 s) and gives one verdict (`audit/node-test.js`):
  - pass at ≥ 10 Mbps;
  - pass 15 at ≥ 15 Mbps when the tester's line is ≥ 30;
  - "baseline" pass at ≥ 50 % of the tester's direct speed.
  - It records the node's `peers` but never uses it.
- **On a busy node, the test reads what is left over.** Other users' traffic shares the node's link and CPU. So a busy node reads lower, and is "cut" (fails 10 Mbps) once its spare capacity for one more user drops below 10 Mbps.
- **Cosmos data: the peer count does not show load.**
  - Data: 24,500 saved rows of the Cosmos tester (130 runs), read-only, 2026-10-21. 830 nodes were tested at different peer counts.
  - Each node's speed, measured against its own median, is the same with fewer users than usual (n 2515, **100 %**) as with more (n 2940, **100 %**). That holds for both V2Ray and WireGuard.
  - Across nodes there is no trend either: 1–4 peers, median 6.0 Mbps; 50–99 peers, median 7.5 Mbps. Peers p90 = 10, max 177.
  - So "peers" counts connected sessions, mostly idle; it is not traffic. Those numbers also come from the old 10 MB method, which reads mostly the path.
  - **Real load can only be learned by making it, on nodes we own.**
- **Chain:** a channel PDA is `["channel", owner, channel_id]`, so one lab wallet can hold many channels to one node; N users need one funded key, not N. A `dvpnd` client runs one session, so one client container per user.
- **Node limit:** `[sessions] max_peers` = 250 by default (sentinel-solana `docs/26-RUNNING-A-NODE.md`).
- **Suspected limits to prove or disprove:**
  - OpenVPN is a single-threaded server process (one core caps every user);
  - Xray/V2Ray and Hysteria2 are userspace crypto in Go (CPU per Mbps);
  - WireGuard is in the kernel (cheapest);
  - AmneziaWG userspace or kernel per build;
  - per-session `dvpnd` metering and heartbeats (every 5 s per peer);
  - conntrack and NAT for many short connections.

## Questions
1. **Capacity:** per protocol and node size, how many users at 10 Mbps each still get 10 Mbps?
2. **Cut point:** at each user count, what does the tester's real single-user test read? At which count does the node first fail ≥ 10 Mbps?
3. **Limits:** what runs out first — link, a CPU core, softirq, RAM, conntrack, `dvpnd` itself?
4. **Fairness between users:** does one greedy user (bulk download) starve paced users? Does the tester's 4-stream test take more than one user's fair share?
5. **Billing under load:** with 20 users, does each session's billed bytes still match what it received?
6. **Latency under load:** what happens to idle latency (RPM-style probes) as users are added?

## Lab (our VMs only, `snt-bw-` prefix, project rules as in BANDWIDTH-TRUTH)
| VM | Size | Role |
|---|---|---|
| `snt-bw-load-node-s` | e2-small (2 shared vCPU, 2 GB) | six `dvpnd` nodes, one per protocol; a typical cheap operator box |
| `snt-bw-load-node-m` | e2-standard-4 | same six; shows how capacity scales with cores |
| `snt-bw-load-client` | e2-standard-8 (32 GB) | up to 50 client containers + the tester itself |
| origin | on the client VM's zone, `--lab` | per-test HMAC bytes, as today |

- **All in one zone, using internal IPs:** in-zone traffic costs nothing, so a 50-user × 10 Mbps step costs CPU time, not egress. Cost ≈ $1–1.5/h of VMs; ≈ $10–15 for the full matrix. The ~$40 guard stays.
- **Control:**
  - client VM CPU stays < 70 % in every step, otherwise split the users across two client VMs;
  - an origin-direct run proves the client side carries the load without any tunnel.

## Users (traffic profiles)
| Profile | Model | Measures |
|---|---|---|
| `stream10` | paced 10 Mbps download (`curl --limit-rate 1250k` from the origin, kept up for the step) | "does each user still get 10 Mbps" |
| `browse` | bursts of 0.2–3 MB every 3–20 s, new TLS connections each time | connection churn, conntrack, handshake CPU, page-load time |
| `call` | 2 Mbps each way, small packets (UDP where the protocol carries UDP) | jitter and loss under load |
| `bulk` | unlimited download, 1 stream | the greedy neighbour (fairness, Q4) |
| tester | the real tester session (steady, 4 streams × 10 s), run as user N+1 | the cut point (Q2) |

Default mix for the main ramp: all `stream10`. Second pass: 60 % `browse`, 30 % `stream10`, 10 % `call`, plus 1 `bulk`.

## Method
1. **Ramp** per protocol and node size: 1 → 2 → 5 → 10 → 15 → 20 → 30 → 40 → 50 users.
   - Sessions stay open across steps. Users are added with chain txs ≥ 7 s apart, so 50 users ≈ 6 min of opens.
   - Each step holds 120 s.
   - The tester's real single-user test runs in the last 30 s of each step.
2. **Per user, per second:** delivered payload bytes (verified HMAC), stalls (> 1 s with no bytes), probe RTT; session start or stop failures with their codes.
3. **Per node, per second** (`scripts/bwlab/node-sampler.sh`): CPU per core and per process (`dvpnd`, openvpn, xray/v2ray, hysteria, wg/awg), softirq, RSS, conntrack count, NIC/qdisc drops, per-peer `dvpnd` usage.
4. **Knee** = the largest N where all of these hold:
   - ≥ 95 % of `stream10` users get ≥ 9.5 Mbps of payload (payload is 86–94 % of the wire);
   - p95 loaded RTT < idle + 100 ms;
   - no failed session.

   Report the knee as users at 10 Mbps, per protocol, per vCPU, and name the limit that ran out first.
5. **Cut point** = the first N where the tester's reading is below 10 Mbps. Compare it with the knee:
   - **cut before the knee:** the tester fails a node that still serves its users (unfair to the operator);
   - **cut after the knee:** the tester passes a node whose users already suffer (unfair to users).
6. **Billing check** at 20 users: each channel's redeemed amount vs the bytes that user received (same join as BANDWIDTH-TRUTH Q3).

## Cost on chain (devnet)
- One lab key; one channel per user per protocol.
- **Plan for 30 users first:** 6 × 30 = 180 opens ≈ 21 min of txs. About 0.004 SOL rent per channel is locked until close, so ≈ 0.7 SOL. tDVPN only on devnet.
- The 50-user steps run on the two protocols with the most headroom.
- Every channel is closed and withdrawn after the grace; the lab key's funds go back to the test wallet.

## Build steps
1. Node scripts on the cf4c372 config: `[api] hosts`, `[sessions] …`, `[redeem] threshold_base_units` (the converter: scratch `demo-migrate.sh`).
2. `scripts/bwlab/node-sampler.sh` (1 Hz JSON lines).
3. `scripts/bwlab/load.mjs`: opens N client containers from the current client image, with a profile per user and 1 Hz per-user lines. It reuses `CLIENT_SCRIPT`'s session start and replaces the speed test with the profile.
4. `scripts/bwlab/load-report.mjs`: knee, cut point, limits, fairness and billing tables from the raw lines.
5. Unit tests for the parsers and the knee and cut-point rules; one dry run with 2 users; then the matrix.

## What could change in the tester afterwards (owner decisions)
- Show users (peers) and the measured spare capacity next to the verdict, so a busy node that is merely full is not shown like a broken one.
- Use the knee table to calibrate a per-node "users it can still take at 10 Mbps" estimate from the single-user reading and the node's protocol and size.
- Whether the tester's 4-stream test should be one user's share (1 stream) when the node is busy. The data in Q4 decides.
