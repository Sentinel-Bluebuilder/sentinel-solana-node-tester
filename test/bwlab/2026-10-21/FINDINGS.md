# Bandwidth lab, round 1: GCP lab nodes (2026-10-21, 00:00–00:25 UTC)

**Setup** (GCP project `ddv-node-test-5821`, VMs `snt-bw-*` only):
- **Node VM:** `snt-bw-node`, us-central1-a, e2-standard-2. Runs WireGuard `47mb7yyV…` and V2Ray `Gc52KJ21…`, owned by the fresh lab key `JCPgUDoQ…`.
- **Origins:** `scripts/bwlab/origin.mjs` + iperf3 on `snt-bw-origin-use1` (us-east1) and `-euw4` (europe-west4), e2-small.
- **Clients:**
  - the laptop (home connection);
  - `snt-bw-client-use1` (us-east1, datacenter), a copy of this repo on Node 24 with the same client image, paying from a second fresh lab key `9keJQsWZ…`.
- **Sessions:** per-GB, 1 GB prepay.
- **Data:** laptop sessions in `sessions.jsonl` here; datacenter-client sessions in `test/bwlab/vm/` on that VM (copied here as `sessions-dc-use1.jsonl`).

## Results (Mbps; "steady" = median of 1 s windows after the ramp, payload bytes; every lab stream's content verified)

| Client → node → origin | Tester today (10 MB, Hetzner Ashburn) | 1 stream steady | 4 streams | 8 streams | Ground truth |
|---|---|---|---|---|---|
| laptop → WireGuard → us-east1 | **4.46** | 21.5 | 11.3 | 7.9 | laptop direct, no tunnel: 70 / 75 / 97 (1/4/8 streams) |
| laptop → V2Ray → us-east1 | **11.64** | 14.6 | 82.4 | **104.0** | same |
| DC us-east1 → WireGuard → us-east1 | **37.11** | 60.6 | **144.5** | 129.6 | client direct iperf3: 957 / 990 / 990 |
| DC us-east1 → V2Ray → us-east1 | **128.41** | **623.7** | 593.3 | (prepay ran out) | node VM direct iperf3: 603 (1) / 972 (8) |

## Findings

1. **The tester under-reads every node, by 4–9×, and by a different factor per node and protocol.**
   - Laptop: V2Ray 11.6 vs ~104; WireGuard 4.5 vs ~21.
   - Datacenter: WireGuard 37 vs ~145; V2Ray 128 vs ~620.

   Because the error is not a constant factor, rankings and pass/fail verdicts between nodes are not fair today.
2. **The causes, each seen directly:**
   - **A third-party host far from the node path.** Hetzner Ashburn through the tunnel runs at 3.4–36 Mbps while our origin runs 60–620 on the same session.
   - **A single 10 MB transfer.** It ends inside slow start on long paths (ramp 1–3 s at 270–310 ms RTT).
   - **DNS and setup counted as transfer time** (~2.2 s of DNS through the tunnel on the rig node).
3. **The tester's own network decides some verdicts.** From the home connection, WireGuard collapses with parallel streams: 21 → 11 → 8 Mbps with 1/4/8 streams, with retransmits. From a datacenter, the same node does 145 Mbps. The home ISP's handling of UDP penalises UDP protocols (WireGuard here) relative to TCP ones (V2Ray). A tester on such a link would rank WireGuard nodes below V2Ray nodes that are no better.
4. **The prepay is a hard ceiling for per-GB tests.**
   - V2Ray moved ~1.5 GB in 20 s.
   - The node then closed the session ("credit exhausted", node log 00:19:00Z).
   - The client did not top up; its status still said `active` and `spent` was exactly 1 GB.
   - Every later request failed (curl exit 35).

   A dynamic, time-bounded test must stop below `prepay − node grace` (plan D2a), or a fast node will fail its own speed test.
5. **Content integrity works end to end.**
   - Every lab stream through both protocols hashed to the expected bytes.
   - A tampered hash is caught (unit test).
   - Pinned TLS refuses a wrong key (curl exit 90).

   Round 1's laptop session was first recorded as `verified: false`: the origin's secret file had a Windows line ending, and the VM keyed with `secret\r`. Re-verified with that key it is `true` for every stream. Fixed by trimming the secret in `contentKey`.

## Not yet known (next rounds)

- Repeatability: ≥ 5 repeats per cell.
- Far clients and origins: europe-west4, asia.
- Loss and delay: netem on the node VM.
- Capped links: tbf.
- The other four protocols.
- Whether Cloudflare's multi-stream endpoint can stand in for our own origins in production.
- Why WireGuard tops out at ~145 Mbps where V2Ray reaches ~620 on the same VM.

# Round 2: repeats, a European origin (2026-10-21, 00:22–00:36 UTC)

`node scripts/bwlab/report.mjs test/bwlab/2026-10-21/sessions-dc-use1.jsonl --prefix R2`. The client is the datacenter VM in us-east1; the node is in us-central1.

| Cell | Tester median (CV) | 1 stream steady (CV) | 4 streams steady (CV) | Tester's share of best |
|---|---|---|---|---|
| V2Ray, origin us-east1 (RTT 68 ms) | 128 (4 %) | 597 (2 %) | 604 (35 %) | 21 % |
| V2Ray, origin europe-west4 (RTT 139 ms) | 126 (5 %) | 265 (2 %) | 619 (5 %) | 20 % |
| WireGuard, origin us-east1 | 19 (31 %) | 34 (89 %) | 36 (141 %) | 54 % |
| WireGuard, origin europe-west4 | 25 (79 %) | 47 (40 %) | 93 (113 %) | 27 % |

- **On a clean path, the tester is stable but wrong.** For V2Ray it reads ~20 % of the node's capacity every time.
- **One stream under-reads on long paths:** 265 Mbps vs 619 Mbps at 139 ms. Four time-bounded streams reach capacity on both origins.
- **The WireGuard spread comes from the node, not from noise** (round 3).
- **Two sessions failed before the session started:** the devnet RPC returned `-32004 Block not available` on the client daemon's clock check. That is an RPC fault, not the node, and it is recorded as `DAEMON_NOT_READY`.
- **Cloudflare can't carry the test.** It returns 403 for any single request over 25 MB, and 429 after ~1 GB from one exit IP (seen through the node and directly from it).

# Round 3: WireGuard MTU on a 1460-byte uplink (2026-10-21, 00:38–00:47 UTC; clamped rerun 00:49)

dvpnd sets the WireGuard MTU to 1420. Add 60 bytes of outer headers and a full packet is 1480 bytes, larger than GCP's 1460 MTU.

| | Fragments created on the node | Tester today | 1 stream | 4 streams |
|---|---|---|---|---|
| A: as shipped (3 sessions) | 459,426 | 11–15 | 0.02–53 | 0.03–57 |
| B: MSS clamped to 1340 on the node (3 sessions) | **0** | 55–81 | 183–346 | **351–473** |

- The client counted 11,414 failed reassemblies in rounds 1–2.
- The lab node keeps the clamp for later rounds, so WireGuard truth is stable.
- Sent to #28 as a dvpnd finding (MTU from the uplink, or clamp MSS to PMTU).

**What this means for fairness:** a WireGuard node on a 1460-MTU network is really slow for its users, so the tester is right to score it low. The cause, though, is a default the operator can't see.

#28 replied: its patch 0005 (in an internal document (not published)) already sets the WG/AWG MTU to the uplink MTU minus 80. On #28's own lab, with a 1460 uplink that drops fragments, that took WireGuard from 0 to 1.5–1.6 Gbps. Patch 0010 does the same for OpenVPN (`mssfix`). The devnet build we test (`dfe36c7`) does not carry either patch yet; #31 is hand-porting them.

# Round 4: known caps, the ground truth (2026-10-21, 00:49–01:20 UTC)

`tbf` on the lab node VM's uplink caps everything the node sends to clients. Setup:
- **Cap:** 5 / 10 / 25 / 50 / 100 / 200 Mbit
- **Protocols:** WireGuard (MSS clamped) and V2Ray
- **Path:** datacenter client in us-east1 → node in us-central1 → origin in us-east1
- **Repeats:** 2 per cell

The figures are re-analysed from raw transcripts with the current analyzer. `r4-report.json` is the output of `report.mjs … --prefix R4 --reanalyze --json`. Values are Mbps of verified payload, with the share of the wire cap in brackets.

| Cap | Tester today | 1 stream | 4 streams | 8 streams |
|---|---|---|---|---|
| 5, WG | 4.3 (86 %) | 4.4 (88 %) | 4.3 (86 %) | 4.2 (84 %) |
| 5, V2Ray | 4.6 (92 %) | 4.6 (92 %) | 4.5 (90 %) | 4.4 (88 %) |
| 10, WG | 8.3 (83 %) | 8.7 (87 %) | 8.7 (87 %) | 8.6 (86 %) |
| 10, V2Ray | 9.1 (91 %) | 9.3 (93 %) | 9.2 (92 %) | 9.0 (90 %) |
| 25, WG | **10.2 (41 %)** | 22.2 (89 %) | 21.8 (87 %) | 21.5 (86 %) |
| 25, V2Ray | 21.2 (85 %) | 23.5 (94 %) | 23.3 (93 %) | 23.0 (92 %) |
| 50, WG | 32.3 (65 %) | 40.0 (80 %) | 41.3 (83 %) | 43.8 (88 %) |
| 50, V2Ray | 38.2 (76 %) | 47.2 (94 %) | 47.2 (94 %) | 46.9 (94 %) |
| 100, WG | 51.6 (52 %) | 86.1 (86 %) | 88.2 (88 %) | 86.8 (87 %) |
| 100, V2Ray | 62.8 (63 %) | 95.1 (95 %) | 94.3 (94 %) | 94.5 (95 %) |
| 200, WG | **52.3 (26 %)** | 158.2 (79 %) | 167.8 (84 %) | 176.8 (88 %) |
| 200, V2Ray | 90.4 (45 %) | 117.1 (59 %) | 188.8 (94 %) | 189.8 (95 %) |

## Findings

1. **The steady multi-stream method gives a constant share of the cap at every speed: ~87 % for WireGuard, ~94 % for V2Ray.** That share is each protocol's real overhead, so the reading is what a user gets. It is accurate from 5 to 200 Mbps; every stream's content verified.
2. **The tester today drifts from ~86–92 % at 5 Mbps down to 26–45 % at 200 Mbps.** The faster the node, the bigger the under-read, so it compresses the ranking of fast nodes and never sees the difference between 100 and 200 Mbps.
3. **One bad third-party moment fails a node.** At the 25 Mbps cap, one WireGuard session's tester download from Hetzner crawled at ~1 Mbps for 81 s (per-second trace). It read 0.99 Mbps while our origin moved 22 Mbps through the same tunnel minutes later.
4. **A single stream is fine up to ~100 Mbps at 68 ms but falls off above that** (V2Ray 59 % at 200). Four streams hold up throughout; eight add little and cost a few % at low caps.
5. **SLA threshold note for the owner:** payload is 86–94 % of wire, so a node with exactly 10 Mbps of capacity reads 8.7–9.3 Mbps and can never pass "≥ 10 Mbps". The measurement is right. The question is whether the SLA is meant in payload or line rate. Thresholds are unchanged.
6. **Lab analyzer fix:** a counter line split by a parallel probe's output gave NaN for one interface, and some methods read "no steady value". The sampler now writes each line in one write, and the parser drops damaged values (unit test added). The table above is re-analysed with the fix.

# Round 5: loss and delay (2026-10-21, 01:23–01:48 UTC)

`netem` on the lab node VM's uplink (everything the node sends: to clients and to the origin). Setup:
- **Conditions:** none / 1 % loss / 3 % loss / +100 ms delay (RTT 68 → 268 ms)
- **Protocols:** WireGuard (MSS clamped) and V2Ray
- **Path:** datacenter client in us-east1 → node in us-central1 → origin in us-east1
- **Repeats:** 2 per cell

The figures are re-analysed from raw transcripts; `r5-report.json` is the output of `report.mjs … --prefix R5 --reanalyze --json`. Values are Mbps of verified payload.

| Condition | Tester today | 1 stream | 4 streams | 8 streams |
|---|---|---|---|---|
| none, WG | 45.1 | 352.8 | 469.4 | 413.5 |
| none, V2Ray | 128.9 | 615.7 | 613.5 | 494.6 |
| 1 % loss, WG | 2.1 | 1.6 | 7.1 | 15.1 |
| 1 % loss, V2Ray | **107.9** | **5.5** | 21.7 | 44.2 |
| 3 % loss, WG | 1.0 | 1.0 | 4.1 | 7.3 |
| 3 % loss, V2Ray | 2.6 | 2.5 | 10.0 | 21.4 |
| +100 ms, WG | 10.8 | 39.5 | 44.1 | 39.3 |
| +100 ms, V2Ray | 27.0 | 146.6 | 438.9 | 192.8 |

Two sessions (3 % loss V2Ray r2, +100 ms WG r2) failed before the session started with the devnet RPC's `-32004 Block not available` (see finding 4).

## Findings

1. **A short fixed download over-reads a lossy node.** Under 1 % loss, V2Ray's 10 MB tester download finished in 0.35 s of transfer and read 99–117 Mbps. A sustained stream through the same tunnel held 3–8 Mbps per connection. The tester passes the node with high marks while its users get a few Mbps on anything sustained.
   - This is the same blind spot a "burst then throttle" node would use (plan D2b).
   - A time-bounded steady-state read is not fooled.
2. **Under loss, the reading depends on how many streams the test opens.** Each lossy TCP connection is capped on its own (≈ MSS / (RTT·√loss)), so throughput grows almost linearly with streams: V2Ray at 3 % loss reads 2.5 → 10 → 21 Mbps with 1/4/8 streams. A fair method must fix the stream count and publish it, as FCC MBA does (8). Otherwise a node's score is an artefact of the method.
3. **The tester's under-read grows with RTT.** At +100 ms it reads 11 Mbps (WG) and 27 Mbps (V2Ray), against 44 and 439 Mbps steady with 4 streams: 6–25 % of what the node delivers. Far-away nodes are scored as slow nodes.
4. **Tester-side failures are blamed on the node.** The client daemon's start-up clock check failed four times in rounds 2–5 on the public devnet RPC (`-32004`). `DAEMON_NOT_READY` is not in `NOT_NODE_FAULTS` (`audit/pipeline.js`), so after its one retry the failure is recorded against the node.
   - Proposed: treat a clock/RPC-only daemon start-up failure as not the node's fault.
   - That changes what counts against a node, so it waits for the owner.
5. **At long RTT, 10 s is not long enough for many streams.** 8-stream V2Ray at +100 ms read 103 and 283 Mbps in two runs, while 4 streams read 383–495. The steady window needs either a longer test at high RTT or the ramp detection must allow more time; this goes into the D4 method loop.

# Round 6: the shipped steady method against known caps (2026-10-21, 02:00–02:50 UTC)

This round runs the production code path itself, not the lab block:
- `SPEED_METHOD=steady` (`lib/speed-method.js`, commit 6d7697f + fixes 3900625, 746a470), run as `session.mjs --steady`.
- **Method:** 4 streams for 10 s from our origin in us-east1, with content verified.
- **Path:** datacenter client in us-east1 → node in us-central1 (`tbf` cap on its uplink).
- **Repeats:** 3 per cell.

Rows are re-analysed from raw transcripts with the current analyzer (`r6-sessions.jsonl`). "Old" is the classic 10 MB download that ran in the same session.

| Cap (Mbit) | WG new | % of cap | WG old | V2Ray new | % of cap | V2Ray old |
|---|---|---|---|---|---|---|
| 10 | 8.77 (CV 0.3 %) | 87.7 | 8.16 (82 %) | 9.23 (CV 0.4 %) | 92.3 | 9.07 (91 %) |
| 25 | 22.12 (CV 2.9 %) | 88.5 | 18.10 (72 %) | 23.43 (CV 0.2 %) | 93.7 | 21.28 (85 %) |
| 50 | 43.81 (CV 1.9 %) | 87.6 | 31.09 (62 %, CV 14 %) | 46.97 (n = 1) | 93.9 | 36.26 (73 %) |
| 100 | 89.17 (CV 0.2 %) | 89.2 | 45.20 (45 %) | 94.59 (CV 0.3 %) | 94.6 | 62.30 (62 %) |
| 200 | 177.83 (CV 0.7 %) | 88.9 | 58.82 (29 %, CV 13 %) | 187.99 (CV 0.5 %) | 94.0 | 92.06 (46 %) |

- Idle latency (median of 10): 66.5–68.8 ms, jitter (IQR) 0.7–1.9 ms.
- Loaded latency during the test: WireGuard 103–159 ms, V2Ray 80–107 ms. This is the bufferbloat under load, a figure the old tester never had.
- Bytes per test: 11 MB at 10 Mbit up to 226 MB at 200 Mbit. The test grows with the link (D2a) and stays inside the 590 MB cap.

## Against the plan's D4 targets

| Target | Result |
|---|---|
| Capped links: median error ≤ ±3 %, p95 ≤ ±7 % | **Met.** Truth on a capped link is the cap × the protocol's payload share (WireGuard ~88 %, V2Ray ~94 %; round 4 measured the same shares with three independent methods). Every cell sits within ±1.5 points of its protocol's share. Against the raw wire cap, the reading is 6–12 % lower by exactly that overhead, which users really do lose. |
| Repeat CV ≤ 5 % | **Met:** 0.2–2.9 % (old method up to 14 %). |
| Idle latency within ±5 ms of the ICMP/TCP median | **Met** for TCP: 10-probe median, jitter ≤ 2 ms. |
| Same pass/slow/fail verdict as truth | Pending owner decision: it depends on whether the 10/15 Mbps SLA means payload or line rate (round 4, finding 5). |
| Content verified, no false flags | **Met:** every stream verified; 0 falling flags on honest nodes after fix 746a470. |

## Failures in this round that were not the node's

- **Before 02:20:** two runs aborted on our own bug. The client script read unset `LAB_TRACE` / `LAB_TRACE_PID` under `set -u`.
  - That bug would have failed every production session after the next server restart; the running server predates it.
  - Fixed in 3900625, with a test covering every `LAB_` variable.
- **From ~02:20 UTC:** the Helius devnet key returned "max usage reached" (#31 saw the same on its nodes).
  - The lab nodes and the client VM were moved to `api.devnet.solana.com`.
  - That endpoint then rate-limits the nodes' own chain reads (`429 Connection rate limits exceeded`), so a session start fails with `internal error`.
  - 13 of 46 sessions in the round failed this way, plus 6 on the client running out of escrow. Missing `n` above are these.
  - **The tester records an RPC-side start failure as the node's `SESSION_START_FAIL`.** Like `DAEMON_NOT_READY` (round 5, finding 4), that blames the node for an infrastructure fault. Owner decision.

# Rounds 7–8: adversarial nodes (plan D2b) (2026-10-21, 02:45–03:40 UTC)

Our own lab node VM plays each attack. Nothing touches any other node.
- **Scripts:** `scripts/bwlab/conds.sh` (shaping) and `scripts/bwlab/adversary/mitm.sh` (interception).
- **Sessions:** the shipped steady method (`session.mjs --steady`), datacenter client in us-east1, origin in us-east1.

| Attack (on the lab node) | Old method (10 MB) | Steady method | Caught? |
|---|---|---|---|
| **Burst then throttle**: `tbf rate 20mbit burst 150mb` (full speed for the first 150 MB, then 20 Mbit) | V2Ray 124–126, WG 57 Mbps: fooled, the whole test fits in the burst | V2Ray 18.8, WG 16.1 Mbps, `falling` flagged in 3/3 | **Yes**: reads the throttled rate users get after the first seconds |
| **TLS interception / fake content**: NAT the origin's IP:port to a fake HTTPS server on the node (own key, fast zeros). WG: PREROUTING on `snt-wg0`; V2Ray: OUTPUT | 52–125 Mbps recorded as normal | `SPEED_CONTENT_TAMPERED` in 4/4 sessions (WG 2, V2Ray 2): curl refuses the key (exit 90) | **Yes**: the node fails, no speed recorded |
| **Block the origin**: same NAT, nothing listening | 65 / 125 Mbps recorded | nothing arrives; the tester checks the origin directly, finds it up, flags `originBlocked: true`, and keeps the classic reading | **Detected, not punished**: the classic reading still stands (see below) |

## Findings

1. **The old method can't tell an honest node from either attack.** A node that bursts the first ~100 MB, or that answers the speed test itself, scores as fast as it likes.
2. **The steady method defeats both.**
   - The throttle is seen because it measures 10 s of steady state, not the first 10 MB.
   - Interception is caught because our origin's bytes are keyed per test and its TLS key is pinned. A node cannot produce valid bytes without the origin's secret, and it can't present our key.
3. **Blocking the origin is the remaining gap.** A node that refuses our origin falls back to the classic reading, which a burst node fools.
   - Today the tester flags it (`diag.speedMethod.originBlocked`) and logs it, with no change to verdicts.
   - **Owner decisions:**
     - Should a node that blocks the speed origin (while the origin answers directly) fail?
     - Should the production origin listen on 443, so that an honest node's port policy can't block it? Honest nodes may restrict odd ports like 8443.
   - Recommended: origin on 443, and a block counts as a node fault.
4. **Accidental finding:** an earlier MITM attempt whose fake server had died produced the "block" case. That's how the gap was found.

Not yet run: the padding / usage-inflation attacks (#28 C1/C2) need billing counters on the node, and the location-spoof check needs nodes in several regions.

# Round 9a: the home vantage with the shipped steady method (2026-10-21, 07:06–07:20 UTC)

The laptop on its home connection is the real-user vantage (plan D3). Setup:
- **Method:** `session.mjs --steady` (production code path).
- **Path:** laptop → lab node in us-central1 → origin in us-east1. Idle RTT through the tunnel: 281–293 ms.
- **Repeats:** 5 per protocol, each with a direct steady baseline from the laptop (`measureSteadyBaseline`, same 4 × 10 s method, no tunnel).
- **Data:** `r9-laptop.jsonl`.

| | Steady (new) | Classic (old, same session) | n |
|---|---|---|---|
| Laptop direct, no tunnel | median 70.9 (48.7–84.7, CV 18 %) | | 5 |
| V2Ray | median **81.9** (58.8–83.7, CV 15 %) | 18.5 (CV 1.4 %) | 3 |
| WireGuard | median 6.5 (4.7–14.6) | 3.8 | 4 |

3 of 10 sessions failed before the session started: `SESSION_START_FAIL … internal error`. That is the public devnet RPC rate-limiting the lab node (round 6), not its speed.

## Findings

1. **From a home connection, the classic method reports V2Ray at 18.5 Mbps when it delivers ~82, the whole home line.** The classic figure is very stable (CV 1.4 %) and wrong by 4.4×. A 290 ms path with a single 10 MB download never leaves slow start; repeating it doesn't help.
2. **The steady method reads what the user's own line can do through the node.** The direct baseline taken minutes apart runs 49–85 Mbps. The node figure sits in the same range: V2Ray adds nothing measurable to a 70–80 Mbps home line.
3. **The spread of the new figure (CV 15 %) is the home line's own spread (CV 18 %), not the method's.** The repeat target (CV ≤ 5 %) holds on datacenter links (round 6: 0.2–2.9 %) and cannot hold on a residential line that varies by itself. This is why the tester compares each node with a baseline taken at the same time; the baseline uses the same method (`protocol/speedtest.js`).
4. **WireGuard from this home line stays low (5–15 Mbps) with either method**, the ISP UDP handling first seen in round 1. One run was flagged `falling` (14.6 Mbps then slowing): the method reports what it saw instead of averaging it away. Both the old and new methods agree the node is slow from here, and the datacenter client measured the same node at 88 % of its cap (round 6). So the WireGuard figure belongs to the tester's location, not the node. A fair verdict needs a tester on a clean network; the owner should know a home-hosted tester under-scores UDP protocols.

# Round 9b: the shipped steady method under loss and delay (2026-10-21, 07:31–07:47 UTC)

Round 5's conditions, now run on the production code path (`conds.sh` with `BATCH_EXTRA=--steady`). Setup:
- **Conditions:** `netem` on the lab node VM's uplink.
- **Path:** datacenter client in us-east1 → node in us-central1 → origin in us-east1.
- **Repeats:** 2 per cell.
- **Data:** `r9b-sessions.jsonl`.

All 12 sessions started, and every stream verified.

| Condition | WG new | WG classic | V2Ray new | V2Ray classic | Round 5 lab block, 4 streams (WG / V2Ray) |
|---|---|---|---|---|---|
| 1 % loss | 7.3, 8.3 | 2.4, 1.7 | 23.2, 21.8 | 11.9, 4.6 (108 in round 5) | 7.1 / 21.7 |
| 3 % loss | 3.7, 3.9 | 1.0, 0.9 | 11.4, 10.4 | 3.0, 2.4 | 4.1 / 10.0 |
| +100 ms (RTT 268 ms) | 54.9, 41.4 | 11.5, 10.4 | 368, 281 | 27.1, 29.5 | 44.1 / 439 |

## Findings

1. **The production method reproduces the lab's 4-stream figures under every condition** (within ~10 % under loss).
   - At +100 ms it reads 12–14× what the classic method reads for V2Ray, and 4–5× for WireGuard.
   - The test grew to 289–362 MB on the fast long-RTT path and stayed at 5–14 MB on lossy WireGuard. That is the dynamic size working as designed.
2. **The classic method is unrepeatable under loss.** V2Ray at 1 % loss read 108 (round 5), then 11.9 and 4.6 here: a 23× spread for the same condition. The steady method read 21.8–23.2.
3. **The `falling` flag also fires on honest lossy links** (6 of 8 loss sessions; 0 of 4 under delay; 0 on clean links in round 6). Lossy TCP slows in bursts. The flag is diagnostic only: it is logged and kept in `diag`, and it never changes a verdict. It must stay that way. A burst-then-throttle node is still caught, because the steady median itself reads the throttled rate (round 7).
4. **Idle latency stays exact under loss:** 67–68 ms, jitter ≤ 2.5 ms, the same as the clean path. With +100 ms it reads 267–268 ms: the delay applies on both legs that leave the node (to the origin and back to the client), so expected 68 + 200 = 268 ms; the readings are within 1 ms.

# Round 10: final before/after matrix, all six protocols (2026-10-21, 09:47–13:03 UTC)

This is the owner's "before and after" round. Every session ran the shipped steady method AND the classic 10 MB download, so "old" and "new" are the same node, same session and same condition.
- **Lab node:** `snt-bw-node`, us-central1. Kernel 6.8 for AmneziaWG; MSS clamp 1340 on the WireGuard, AmneziaWG and OpenVPN interfaces.
- **Client:** datacenter VM in us-east1. **Origin:** us-east1.
- **Conditions** on the node's uplink: tbf caps of 25/100/200 Mbit, none, 1 % loss, +100 ms.
- **Repeats:** 3 for caps and none, 2 for loss and delay.
- **Driver:** `scripts/bwlab/matrix.sh`, run on the client VM. **Data:** `final-sessions.jsonl` + raw transcripts.
- **Table:** `node scripts/bwlab/final.mjs final-sessions.jsonl --secret-file <secret> --md` (`final-table.md`). Every new figure is re-analyzed from the raw transcript with the current analyzer.

The direct link between the two VMs measured 754 Mbps (1 stream) / 3.88 Gbps (8 streams) with iperf3. Uncapped nodes are therefore limited by the node VM's CPU, not the link.

Cells: median Mbps (share of the cap). "Line" = the steady rate at the client container's `eth0`, i.e. outer tunnel bytes.

### cap25 (truth: 25 Mbit line rate)

| Protocol | Old (classic) | New payload | New line rate | New CV | Sessions ok / failed | Verified |
| --- | --- | --- | --- | --- | --- | --- |
| WireGuard | 13.6 (54 %) | 22.0 (88 %) | 24.4 (97 %) | 0.2 % | 3 / 0 | all |
| AmneziaWG | 18.6 (74 %) | 22.0 (88 %) | 24.3 (97 %) | 0.2 % | 3 / 0 | all |
| V2Ray | 21.3 (85 %) | 23.4 (94 %) | 24.3 (97 %) | 0.0 % | 3 / 0 | all |
| Xray | 21.4 (86 %) | 23.6 (95 %) | 24.4 (98 %) | 0.2 % | 3 / 0 | all |
| OpenVPN | 19.1 (77 %) | 22.3 (89 %) | 24.3 (97 %) | 0.9 % | 3 / 0 | all |
| Hysteria2 | 20.5 (82 %) | 23.5 (94 %) | 24.9 (100 %) | 0.2 % | 3 / 0 | all |

### cap100 (truth: 100 Mbit line rate)

| Protocol | Old (classic) | New payload | New line rate | New CV | Sessions ok / failed | Verified |
| --- | --- | --- | --- | --- | --- | --- |
| WireGuard | 33.7 (34 %) | 88.8 (89 %) | 97.9 (98 %) | 0.7 % | 2 / 1 | all |
| AmneziaWG | 43.6 (44 %) | 89.0 (89 %) | 97.7 (98 %) | 0.2 % | 3 / 0 | all |
| V2Ray | 63.0 (63 %) | 94.1 (94 %) | 96.1 (96 %) | 0.1 % | 2 / 1 | all |
| Xray | 62.3 (62 %) | 94.8 (95 %) | 96.2 (96 %) | 0.2 % | 3 / 0 | all |
| OpenVPN | 49.9 (50 %) | 90.1 (90 %) | 97.7 (98 %) | 0.7 % | 3 / 0 | all |
| Hysteria2 | 54.2 (54 %) | 94.2 (94 %) | 99.7 (100 %) | 0.4 % | 2 / 0 | all |

### cap200 (truth: 200 Mbit line rate)

| Protocol | Old (classic) | New payload | New line rate | New CV | Sessions ok / failed | Verified |
| --- | --- | --- | --- | --- | --- | --- |
| WireGuard | 30.5 (15 %) | 179 (89 %) | 196 (98 %) | 4.9 % | 3 / 0 | all |
| AmneziaWG | 63.3 (32 %) | 179 (90 %) | 197 (98 %) | 0.4 % | 3 / 0 | all |
| V2Ray | 88.1 (44 %) | 189 (94 %) | 192 (96 %) | 0.1 % | 3 / 0 | all |
| Xray | 90.6 (45 %) | 190 (95 %) | 192 (96 %) | 0.2 % | 3 / 0 | all |
| OpenVPN | 71.9 (36 %) | 181 (91 %) | 196 (98 %) | 0.3 % | 3 / 0 | all |
| Hysteria2 | 93.5 (47 %) | 189 (95 %) | 199 (100 %) | 0.2 % | 3 / 0 | all |

### none

| Protocol | Old (classic) | New payload | New line rate | New CV | Sessions ok / failed | Verified |
| --- | --- | --- | --- | --- | --- | --- |
| WireGuard | 32.7 | 591 | 653 | 7.1 % | 3 / 0 | all |
| AmneziaWG | 71.4 | 385 | 429 | 4.2 % | 3 / 0 | all |
| V2Ray | 128 | 746 | 759 | 5.5 % | 3 / 0 | all |
| Xray | 123 | 794 | 802 | 5.3 % | 3 / 0 | all |
| OpenVPN | 52.2 | 371 | 403 | 7.2 % | 3 / 0 | all |
| Hysteria2 | 91.5 | 306 | 405 | 1.5 % | 3 / 0 | all |

### loss1

| Protocol | Old (classic) | New payload | New line rate | New CV | Sessions ok / failed | Verified |
| --- | --- | --- | --- | --- | --- | --- |
| WireGuard | 2.1 | 7.2 | 8.0 | — | 1 / 1 | all |
| AmneziaWG | 1.5 | 7.9 | 8.8 | 11.8 % | 2 / 0 | all |
| V2Ray | 8.1 | 22.1 | 22.9 | 7.3 % | 2 / 0 | all |
| Xray | 6.6 | 21.1 | 21.8 | 3.7 % | 2 / 0 | all |
| OpenVPN | 2.0 | 7.6 | 8.3 | 7.7 % | 2 / 0 | all |
| Hysteria2 | 87.8 | 308 | 417 | 0.2 % | 2 / 0 | all |

### delay100

| Protocol | Old (classic) | New payload | New line rate | New CV | Sessions ok / failed | Verified |
| --- | --- | --- | --- | --- | --- | --- |
| WireGuard | 5.7 | 44.7 | 49.2 | 0.2 % | 2 / 0 | all |
| AmneziaWG | 9.8 | 43.3 | 47.4 | 2.8 % | 2 / 0 | all |
| V2Ray | 23.8 | 385 | 393 | 5.1 % | 2 / 0 | all |
| Xray | 24.4 | 328 | 330 | 2.4 % | 2 / 0 | all |
| OpenVPN | 13.0 | 45.5 | 49.3 | 4.7 % | 2 / 0 | all |
| Hysteria2 | 26.5 | 102 | 111 | 0.6 % | 2 / 0 | all |

## Findings

1. **On known caps the new line rate reads 96–100 % of the truth for all six protocols at 25, 100 and 200 Mbit.** The payload figure reads a constant 88–95 %, the protocol's overhead. Repeat CV is ≤ 0.9 %, except WireGuard at 200 Mbit (4.9 %).
2. **The old method reads 54–86 % at 25 Mbit, 34–63 % at 100 and 15–47 % at 200.** It gets worse the faster the node, and by a different amount per protocol. At 200 Mbit it scores WireGuard at 15 % and Hysteria2 at 47 % of the same link.
3. **Uncapped, the nodes deliver 306–802 Mbps (CPU-bound on an e2-standard-2); the old method reads 33–128 Mbps** (5–21 %). It ranks Hysteria2 (92 old) above WireGuard (33 old), while the new method finds WireGuard faster (591 vs 306).
4. **At +100 ms the old method reads 6–27 % of the new figure** (V2Ray 24 vs 385).
5. **Under 1 % loss, Hysteria2 keeps 308 Mbps while every TCP-based protocol falls to 7–22.** That is a real protocol property: Hysteria2's congestion control ignores loss, and the new method shows it. The old method read 88. For Hysteria2 the line rate runs well above payload when uncapped or lossy (405–417 vs 306–308), which is retransmission traffic that delivers nothing. **So the SLA should be judged on payload, not line rate** (owner decision; recorded, not changed).
6. **Size per test:** 26–29 MB at 25 Mbit, 103–115 MB at 100, 196–228 MB at 200, 345–600 MB uncapped. It always stays under the 600 MB budget and 60 % of the prepay.
7. **The `falling` flag fired 7 times under 1 % loss and once at +100 ms; 0 times on clean or capped links.** It stays diagnostic only.
8. **Failures (3 of 95 rows, plus 1 session that wrote no row):**
   - two session starts failed: one devnet RPC `internal error`, and one node-metadata fetch through the capped uplink;
   - one V2Ray session where 1 of 4 streams never connected. The method correctly refused to claim a verified figure and kept the classic reading. The other three streams read 94.2, the right answer;
   - one Hysteria2 cap100 repeat left no JSONL row.

# Round 10b: Europe client (void) and the program redeploy (2026-10-21, 13:04–13:10 UTC)

- **The Europe client run (round E) is void.** All 16 sessions it tried failed at `open_channel` with `SESSION_START_FAIL`.
  - **Cause:** the devnet program `J52dyXW3…` was redeployed at 12:37:39 UTC by its upgrade authority (#31's report: grant-based design; `dvpnd` dfe36c7's `open_channel` fails with Custom 102).
  - **Not affected:** round 10's 95 rows were all taken before 10:58 UTC.
- **The tester's own cleanup still works on the new program:** `start_close_channel` transactions after 13:09 UTC succeed.
- **The lab node tool (`dvpnctl` from the old build) can't close nodes:** `close_node` fails with Custom 3002 (account discriminator mismatch).
  - Six lab node bonds (6 tDVPN, owner `JCPgUDoQ…`) and the demo node's bond stay locked until the tools are migrated (owner decision, per #31).
  - Node ids and PDAs are saved in the scratchpad `bwlab/lab-nodes-final.tsv`. The owner key keeps 0.055 SOL for the close fees.
