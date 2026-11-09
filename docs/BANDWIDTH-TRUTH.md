# Bandwidth truth: are the tester's numbers true and fair?

Lab study, 2026-10-20/21. Raw data and per-round detail: `test/bwlab/2026-10-21/FINDINGS.md` and the JSONL/transcripts next to it. Method reference: `docs/SPEED-METHOD.md`.

## Answer in one paragraph

**No, today's speed figure is not true and not fair.** It under-reads every node, by a factor that changes with the node's speed, its distance and its protocol. Measured against links whose real capacity we set ourselves, it reads 86–92 % of a 5 Mbit node but only 15–47 % of a 200 Mbit node (final round, all six protocols). From a home connection it reads a V2Ray node at 18.5 Mbps when the node delivers ~82. A node can also fool it: one that bursts the first 150 MB and then throttles scores 124 Mbps, and one that answers the speed test itself scores what it likes. The new **steady method** (built, unit-tested, opt-in with `SPEED_METHOD=steady`) reads a constant 88–95 % of the true capacity from 5 to 200 Mbit as payload, depending on the protocol. That share is the protocol's own overhead, which users really lose. Its line rate (the tunnel's own bytes) reads 96–100 % of the cap for all six protocols. Repeat spread is 0.2–2.9 % on datacenter links. It catches both attacks, and it flags a node that blocks the test.

## Before and after: all six protocols (final round, 2026-10-21)

Each session measured the same node both ways: before = today's 10 MB download, after = the steady method. Cells show the share of the known true speed (the cap we set on the node's uplink). Full table with Mbps, repeats and failures: `test/bwlab/2026-10-21/final-table.md` (round 10).

| Protocol | 25 Mbit: before → after (line) | 100 Mbit: before → after (line) | 200 Mbit: before → after (line) | Uncapped: before → after, Mbps |
|---|---|---|---|---|
| WireGuard | 54 % → 97 % | 34 % → 98 % | 15 % → 98 % | 33 → 591 |
| AmneziaWG | 74 % → 97 % | 44 % → 98 % | 32 % → 98 % | 71 → 385 |
| V2Ray | 85 % → 97 % | 63 % → 96 % | 44 % → 96 % | 128 → 746 |
| Xray | 86 % → 98 % | 62 % → 96 % | 45 % → 96 % | 123 → 794 |
| OpenVPN | 77 % → 97 % | 50 % → 98 % | 36 % → 98 % | 52 → 371 |
| Hysteria2 | 82 % → 100 % | 54 % → 100 % | 47 % → 100 % | 92 → 306 |

- **Before:** the reading depends on the node's speed and protocol, from 86 % down to 15 % of the truth. It even ranks protocols the wrong way round (uncapped Hysteria2 92 vs WireGuard 33, when WireGuard delivers 591 and Hysteria2 306).
- **After:** the line rate is 96–100 % of the truth for every protocol at every speed, and repeats agree within 1 %. The payload figure (what users can use) is a constant 88–95 %, each protocol's own overhead.
- **Long distance (+100 ms):** before reads 6–27 % of after.
- **1 % loss:** TCP protocols fall to 7–22 Mbps while Hysteria2 holds 308. That is a real difference between protocols, and only the new method shows it.
- **Remaining 0–4 %:** the node's own acknowledgements to the origin share the capped uplink. That is not an error in what the user receives.

## How truth was established

- **Our own machines only:** GCP project `ddv-node-test-5821`, VMs `snt-bw-*`:
  - a lab node VM with a WireGuard and a V2Ray node registered on devnet under a fresh lab key;
  - origins in us-east1 and europe-west4 serving per-test random bytes over pinned TLS;
  - a datacenter client in us-east1;
  - the laptop on its home connection as the real-user vantage.
- **Known capacity:** a `tbf` rate cap on the node VM's uplink (5–200 Mbit). Truth on a capped link = the cap × the protocol's payload share; three independent methods measured the same share.
- **Known conditions:** `netem` loss (1 %, 3 %) and delay (+100 ms) on the same uplink.
- **Verified bytes:** every figure in the new method counts only bytes that hash to what our origin sent.
- **Real sessions:** every test is a real paid devnet session through the production code path (`audit/node-test.js`), not a simulation.

## Results

### 1. Accuracy against known caps (round 6, shipped code, 3 repeats)

| Cap (Mbit) | WireGuard new (% of cap) | WireGuard old | V2Ray new (% of cap) | V2Ray old |
|---|---|---|---|---|
| 10 | 8.77 (88 %) | 8.16 (82 %) | 9.23 (92 %) | 9.07 (91 %) |
| 25 | 22.12 (88 %) | 18.10 (72 %) | 23.43 (94 %) | 21.28 (85 %) |
| 50 | 43.81 (88 %) | 31.09 (62 %) | 46.97 (94 %) | 36.26 (73 %) |
| 100 | 89.17 (89 %) | 45.20 (45 %) | 94.59 (95 %) | 62.30 (62 %) |
| 200 | 177.83 (89 %) | 58.82 (29 %) | 187.99 (94 %) | 92.06 (46 %) |

The old method compresses fast nodes together: it never sees the difference between 100 and 200 Mbit.

### 2. Uncapped nodes, two vantages

| Vantage → node | Old | New | Truth |
|---|---|---|---|
| Datacenter us-east1 → V2Ray (round 2) | 128 | ~600 | node VM iperf3 603 (1 stream) / 972 (8) |
| Datacenter → WireGuard, MSS clamped (round 5) | 45 | 469 | |
| Home → V2Ray (round 9a, 290 ms RTT) | 18.5 (CV 1.4 %) | 81.9 (CV 15 %) | home line direct, same method: 49–85 |
| Home → WireGuard (round 9a) | 3.8 | 6.5 | 145+ from a datacenter: the home ISP's UDP handling |

### 3. Loss and delay (round 5, lab block; round 9b, shipped steady method)

Each cell is the classic reading → the steady reading on the shipped code (round 9b, 2 repeats, every stream verified). The last column is round 5's lab block with 4 streams, an independent check.

| Condition | WireGuard | V2Ray | Lab block, 4 streams (WG / V2Ray) |
|---|---|---|---|
| none (round 5; new = lab block) | 45 → 469 | 129 → 614 | |
| 1 % loss | 1.7–2.4 → 7.3–8.3 | 4.6–108 → 21.8–23.2 | 7.1 / 21.7 |
| 3 % loss | 0.9–1.0 → 3.7–3.9 | 2.4–3.0 → 10.4–11.4 | 4.1 / 10.0 |
| +100 ms (RTT 268 ms) | 10.4–11.5 → 41–55 | 27–30 → 281–368 | 44 / 439 |

- **The old method is unrepeatable under loss.** V2Ray at 1 % loss read 108, 11.9 and 4.6 in three sessions. The steady method read 21.8–23.2.
- **The old method is badly biased by distance.** At +100 ms it reads V2Ray at 1/12 of the steady figure.
- **The test sizes itself:** 5–14 MB on lossy WireGuard, 289–362 MB on fast long-RTT V2Ray.
- **Idle latency** stays exact: 67–68 ms clean or lossy, 267–268 ms with +200 ms of added RTT.
- **The `falling` flag also fires on honest lossy links** (6 of 8 sessions). It is diagnostic only and never changes a verdict. It must stay that way.

### 4. Adversarial nodes (rounds 7–8)

| Attack, played by our own lab node | Old method | Steady method |
|---|---|---|
| Burst then throttle (150 MB at full speed, then 20 Mbit) | 124–126 / 57 Mbps: fooled | 16–19 Mbps, `falling` flagged 3/3 |
| Fake TLS origin, zeros at LAN speed | 52–125 Mbps recorded | `SPEED_CONTENT_TAMPERED` 4/4: node fails |
| Block the origin | 65 / 125 Mbps recorded | `originBlocked` flagged; classic reading kept (owner decision) |
| False flags on honest nodes | n/a | 0 after fix 746a470 |

### 5. Latency

- **Old:** one sample (first byte − TLS done).
- **New:** idle latency is the median of 10 TCP+TLS probes to our origin through the tunnel; jitter ≤ 2 ms on datacenter paths, 0.6–12 ms from home. Loaded latency is measured during the download: WireGuard 103–159 ms vs 67 ms idle, the node's bufferbloat. ICMP is never used, so a node can't answer the probe itself.

### 6. Cost and bytes per test

- The steady test grows with the link: 11 MB at 10 Mbit, ~230 MB at 200 Mbit, at most 600 MB.
- A per-GB session ends at its prepay ("credit exhausted", round 1), so the test is capped below 60 % of the prepay.
- At the default 1 GB prepay the user pays the same either way: an unused prepay is redeemed in full by the node (#28 F5; seen on 110 tester channels). So the larger test costs nothing extra on chain.

## What is unfair today, and to whom

1. **To fast nodes:** the old figure falls further behind the faster the node is (round 4/6).
2. **To far nodes:** the under-read grows with RTT; at +100 ms the old method reads 6–25 % of what the node delivers (round 5).
3. **To honest nodes vs cheaters:** burst-then-throttle and test interception score as fast nodes under the old method.
4. **To nodes under loss, both ways:** a short 10 MB test over-reads a lossy node (V2Ray at 1 % loss: 108 Mbps vs 5.5 sustained). Under loss every figure depends on the stream count, so the count must be fixed and published (the new method: 4).
5. **To UDP protocols, from a home tester:** a residential ISP's UDP handling made WireGuard read 5–15 Mbps from the laptop for a node that does 145+ from a datacenter. The tester's location decides that verdict.
6. **To nodes, for tester-side faults:** a devnet RPC failure at session start is recorded as the node's `SESSION_START_FAIL` / `DAEMON_NOT_READY` (20 sessions across rounds 2–9a: 2 + 2 + 13 + 3).
7. **To WireGuard nodes on 1460-MTU clouds:** dvpnd's MTU 1420 fragments; capacity fell from ~470 to 0.03–57 Mbps (round 3). The tester is right to score them low, but the cause is a dvpnd default; #28's patches 0005/0010 fix it.

## Decisions for the owner (nothing below is changed without approval)

1. ~~Production origin~~ **Done 2026-10-21 (owner: "switch on the new speed method"):** `https://<origin-host>:443` on the demo VM (europe-west4), egress-guarded (10 GB/IP, 30 GB total a day). One origin in Europe: far nodes read over a long path; a second origin region is a later choice.
2. **SLA unit:** payload (what users get; the new figure) or line rate? A node with exactly 10 Mbit capacity reads 8.8–9.3 Mbps of payload and can never pass "≥ 10 Mbps".
3. **Origin blocking:** should a node that blocks the speed origin (while the origin answers directly) fail?
4. **Tester-side start failures:** should RPC / daemon-start failures stop counting against nodes?
5. ~~Switch the default~~ **Done 2026-10-21:** steady is the default; `SPEED_METHOD=classic` opts out. See `docs/SPEED-METHOD.md` (Production setup).

## Not covered

- **Far client:** a Europe client run (europe-west4 → us-central1 node) started at 13:04 UTC, and every session failed at channel open. The devnet program was redeployed at 12:37 UTC by its upgrade authority (#31's report: new grant-based design), so the dvpnd client in use can no longer open channels. Far paths are still covered by the europe-west4 origin (round 2), +100 ms delay (rounds 5, 9b, 10), and the Europe demo node's one session before the redeploy (581 Mbps verified, 102 ms).
- **Since 12:37 UTC no new paid session works with the current client image**, on any node. Every number in this report was measured before then (round 10 ended 10:58 UTC).
- Per-hour billing reconciliation to the unit, report-memo decoding, and padding / usage-inflation attacks (#28 C1/C2) were not run. They are billing questions; #28's lab covers the protocol side.

## Cost of this study

- Four VMs for ~8 h: ≈ $1.40.
- Egress: estimated $2–4 (mostly inside the US, a few GB to the laptop).
- Total about $3–5, under the $40 guard.
- Chain: devnet only; lab keys refunded to the test wallet at teardown.
