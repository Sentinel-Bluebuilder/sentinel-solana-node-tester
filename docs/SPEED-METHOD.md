# Speed method

How the tester measures a node's speed and latency, why, and how accurate it is.
Evidence: `test/bwlab/2026-10-21/FINDINGS.md` (raw data in the same folder). Full report: `docs/BANDWIDTH-TRUTH.md`.

## Two methods

| | Classic (`SPEED_METHOD=classic`, opt-out) | Steady (**default** since 2026-10-21) |
|---|---|---|
| What it downloads | one 10 MB file from `SPEED_URL` (a third-party speed host) | 4 parallel streams for 10 s from **our own origin** (`scripts/bwlab/origin.mjs`) |
| Figure | `bytes ÷ curl time_total` (includes DNS, TCP/TLS setup and first-byte wait) | median of 1 s windows after the TCP ramp (steady state), payload bytes only |
| Size | always 10 MB | grows with the link: 11 MB at 10 Mbit, ~230 MB at 200 Mbit; capped by the byte budget and the per-GB prepay |
| Content check | none (a node can answer the test itself) | per-test bytes keyed by HMAC(secret, seed) and hashed by the tester; TLS key pinned |
| Latency | one sample (first byte − TLS done) | idle: median of 10 TCP+TLS probes + jitter (IQR); loaded: probes during the download |
| Baseline | 10 MB direct from the host | same steady method direct from the host |
| Accuracy on known caps (5–200 Mbit) | 86 % of the cap at 5 Mbit, falling to 15–47 % at 200 Mbit | payload a constant 88–95 % of the cap (the protocol's real overhead), line rate 96–100 %, all six protocols; repeat CV 0.2–2.9 % |

## Production setup (2026-10-21)

- **Origin:** `https://<origin-host>` (GCP `snt-bw-demo-euw4`, europe-west4, the same e2-small as the demo node). systemd unit `snt-origin` runs `scripts/bwlab/origin.mjs` on **port 443** as user `snt-origin` (`/opt/snt-origin`, log `/var/log/snt-origin/origin.jsonl`, rotated at 50 MB).
- **Secret and pin:** a secrets directory outside the repo (`snt-speed-origin.{secret,pin}`) (never in the repo); the tester's `.env` points `SPEED_SECRET_FILE` at the secret.
- **Egress guard** (`lib/egress-guard.js`, deployed beside `origin.mjs` in `/opt/snt-origin/lib/`): the origin is public and its egress is paid. Every request must name its size (≤ 1 GB). It is reserved up front and settled to the bytes really sent when the request ends. Allowances per UTC day: 10 GB per IP and 30 GB in total (≈ $3.60 of egress); past either the answer is 429, and the tester falls back to classic for that test (`diag.speed.originBlocked`). `--lab` lifts the guard for lab origins.
- **Shared VM:** the origin shares the demo node's e2-small. Anything that eats its CPU slows every test, as the demo node's spinning dvpnd did on 2026-10-21 (the baseline fell to 51 Mbps). The tester now flags a baseline under half the recent median (`protocol/speedtest.js` `noteBaseline`): it logs a warning, never caches it, and accepts the new level after 3 in a row.
  - Fixed 2026-10-21: the guard used to keep the full reservation (4 × 150 MB per steady test, most never sent). #31's six nodes share one exit IP, which was refused after 7.75 GB really sent, so its later tests fell back to classic (~50 Mbps instead of ~580).
- **Baseline reuse:** the shared pipeline asks for a baseline before every node. A steady baseline is reused for `SPEED_BASELINE_TTL_SEC` (1800 s), so it costs one download per half hour, not per node.
- **Check it:** `node cli.js speed` (method in use, pinned origin check), `node cli.js speed-test` (fresh direct baseline), `node cli.js doctor` (lists a speed problem).
- **Fallbacks:** `SPEED_METHOD=classic` → classic. A missing or invalid origin setting, a typo in `SPEED_METHOD`, or an unreachable origin / wrong pin → classic with the reason in `speed`, `doctor` and the run log. A tester-side fault never counts against a node.
- **Limits of this setup:**
  - The origin shares its VM with the demo node `5CBc2eb3…`. A test of that one node downloads from its own host, so it reads above what a user elsewhere would get.
  - There is one origin, in Europe. Nodes in far regions read over a long path. 4 streams cover most of the slow-start loss, but a second region is the fix if far nodes need closer numbers.
- **Pinned requests never resume TLS sessions** (`PIN_AGENT` in `lib/speed-method.js`). A resumed session carries no server certificate, so before this fix every pinned request after the first read "pin mismatch" and the baseline fell back to classic. A unit test reproduces it.

The classic reading is still taken in every session and kept as `diag.speedMethod.classicMbps`, so the two can be compared on real nodes.

## How the steady method works

Inside the client container (the same script the lab measured, `audit/speed-lab.js` `LAB_SH`):

1. **Idle latency:** 10 HTTPS requests to `origin/p`, timed from TCP connect to first byte.
2. **Download:** 4 curl streams, each `--max-time 10` and `--pinnedpubkey <SPEED_PIN>`, URL `origin/d/<seed>.bin?s=<seed>&n=<cap>`. The origin sends AES-CTR bytes keyed by HMAC(secret, seed) — random, incompressible, and impossible to forge without the secret.
3. **Samples:** the container's interface byte counters every 100 ms; loaded-latency probes during the transfer; an `ss` snapshot for retransmits.
4. **Analysis** (`analyzeLab`):
   - 1 s windows; the ramp ends at the first window ≥ 80 % of the later median; the last partial window is dropped; the window also ends when a stream finishes early on its byte cap.
   - Figure = median of steady windows (p90 also kept). If the budget ran out before two whole windows (very fast link), the whole transfer after first byte is used and marked `basis: transfer` (a floor, not the capacity).
   - `falling` flag when the steady windows trend down (burst then throttle).
   - Each stream's SHA-256 is compared with what the origin must have sent.

Outcomes (`lib/speed-method.js` `steadyResult`, `audit/node-test.js`):

| Case | Result |
|---|---|
| All streams verified | `actualMbps` / `latencyMs` = steady figures; classic kept in `diag` |
| Hash mismatch, or curl exit 90 (wrong TLS key) | `SPEED_CONTENT_TAMPERED` (stage `download`): the node altered or answered the test |
| Nothing arrived, origin answers directly | `diag.speedMethod.originBlocked: true`; classic reading kept (owner decision whether this fails the node) |
| Nothing arrived, origin down too | classic reading kept; tester-side problem |
| Classic failed (speed host down), steady verified | the steady reading rescues the test |

## Byte budget and the per-GB prepay

A per-GB session ends with "credit exhausted" at its prepay (lab round 1). Per-stream cap = `min(SPEED_BUDGET_MB, 0.6 × prepay − 10 MB) ÷ streams`, so the whole test, including the classic 10 MB, stays below 60 % of the prepay. At the default 1 GB prepay and 600 MB budget: 4 × 150 MB. A fast node simply ends its streams early; the analyzer cuts the window there.

## Configuration

```
SPEED_METHOD=steady
SPEED_ORIGIN=https://<host>:<port>        # an origin.mjs instance
SPEED_PIN=sha256//<base64 SPKI hash>      # curl --pinnedpubkey format
SPEED_SECRET_FILE=<path>                  # or SPEED_SECRET; ≥ 32 chars, same as the origin's LAB_SECRET
SPEED_STREAMS=4  SPEED_SECONDS=10  SPEED_BUDGET_MB=600
```

A misconfigured steady method logs the reason and the tester uses the classic method. Run an origin:

```
LAB_SECRET=$(cat secret.txt) node scripts/bwlab/origin.mjs --port 443 --cert c.pem --key k.pem --log origin.jsonl
```

The pin: `openssl x509 -in c.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`.

## Why these choices

- **Our own origin, not a public speed host.** Hetzner Ashburn through a tunnel ran 3–36 Mbps while our origin ran 60–620 on the same session; Cloudflare refuses single requests over 25 MB and rate-limits after ~1 GB per exit IP. A third-party host puts its own limits into the node's score, and plain-HTTP hosts can be answered by the node.
- **Time-bounded, not size-bounded.** A fixed 10 MB ends inside TCP slow start on fast or far paths and is fooled by a node that bursts the first 100 MB then throttles (round 7).
- **4 streams.** One stream under-reads at long RTT (265 vs 619 Mbps at 139 ms); 8 add little and cost a few % at low caps; under loss, the stream count decides the figure, so it is fixed and published (FCC MBA does the same with 8).
- **Steady-state median, ramp discarded.** Ookla and FCC practice; the figure then matches the known cap within ±1.5 points of the protocol's overhead.
- **Latency over TCP+TLS to our origin, idle and loaded.** A node can answer ICMP itself; it cannot answer our pinned TLS. Loaded latency shows bufferbloat (WireGuard 103–159 ms under load vs 67 ms idle).

## Known limits

- The figure is payload: WireGuard nodes read ~12 % below the line rate, V2Ray ~6 %. Whether the 10 / 15 Mbps SLA means payload or line rate is an owner decision.
- **Line rate** (`diag.speedMethod.lineMbps`) is the steady rate of the client container's `eth0`, i.e. the tunnel's outer bytes. It reads 96–100 % of a known cap for all six protocols (round 10).
  - It always uses `eth0`, never the busiest interface: Hysteria2's `hy2-client` tun device counts more than arrives (105 % of the cap).
  - Uncapped or lossy, Hysteria2's line rate runs well above payload (retransmissions), so line rate alone is not a fair SLA figure for it.
- Under packet loss every TCP-based test reads the loss-limited rate for its stream count; the figure is fair between nodes only because the stream count is fixed.
- The `falling` flag also fires on honest lossy links (round 9b: 6 of 8 sessions at 1–3 % loss). It is logged and kept in `diag` only and must never change a verdict on its own.
- From a home connection the figure varies as much as the home line does (round 9a: CV 15 % vs the line's own 18 %), and a residential ISP may throttle UDP protocols. A fair verdict needs a tester on a clean datacenter link.
- The tester's own link is a ceiling. The baseline (same method, direct) shows it.
- Padding / usage inflation (#28 C1/C2) is a billing question, not a speed one; it is not covered here.
