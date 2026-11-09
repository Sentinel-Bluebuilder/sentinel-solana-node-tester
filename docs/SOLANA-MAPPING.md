# Cosmos → Solana function map

The Solana tester is a fork of the Cosmos tester (an internal document (not published)): server, pages, SQLite
schema, continuous loop, run/batch bookkeeping and the whole HTTP/SSE contract are the Cosmos code.
Every Cosmos module that touched the chain or the host network is replaced by a Solana module **under
the same name and exports**, so the shared code runs unchanged. Program facts:
an internal document (not published) (03 program, 11 API, 14 devnet layout compat, 25 building an app).

## Kept verbatim

| File | Notes |
|---|---|
| `admin.html`, `public.html`, `live.html`, `node.html`, `about.html`, `about-modal.js`, `sentinel.css`, `fonts/` | Cosmos pages at the Cosmos repo's committed HEAD (never its working copy) + `scripts/dev/page-edits.txt` (applied by `patch-pages.mjs`): wording only — tDVPN amounts, Solana Explorer, the DVPND client, base units, SPL Memo reports, plan access tickets, the Solana CLI guide. The route sweep rebuilds the pages from the Cosmos copy and also fails on leftover Cosmos wording |
| `server.js` | Cosmos server at HEAD + `scripts/dev/patch-server.mjs` (exact edits: SDK switch reports dvpnd, no npm SDK lookups, wallet balance, tDVPN amounts, key-file wording, client label, Docker/image health check, Solana address redaction on public errors, Solana routes, run numbering, plan ids as addresses) |
| `core/db.js`, `core/auth.js`, `core/rate-limit.js`, `core/types.js`, `core/settings.js` (checked against Cosmos HEAD by `npm test`) | `autoCancelAfterTest` defaults on (closes test channels) |
| `audit/continuous.js` | wallet check reads `TEST_KEYFILE`; client label `dvpnd`; subscription mode checks the plan's provider (listed + signed metadata), not a fee grant |

## Replaced (same names, Solana behind them)

| Cosmos module | Cosmos mechanism | Solana module |
|---|---|---|
| `core/constants.js` | mnemonic, LCD/RPC lists, udvpn | `TEST_KEYFILE` marker as `MNEMONIC`, Solana RPC pool, paths unchanged |
| `core/wallet.js` | CosmJS wallet + Stargate client | `TEST_KEYFILE` keypair; `getBalance` = tDVPN base units (6 dp, same scale) + lamports |
| `core/chain.js` `getAllNodes` | LCD/RPC active nodes | `getProgramAccounts` Node accounts, live listings only, Cosmos node shape (`_sol` carries the Solana node) |
| `protocol/v3protocol.js` `nodeStatusV3` | `GET /status` | signed `/v1/metadata`: signature, claims vs account, TLS pin; Cosmos status shape |
| `audit/node-test.js` | host WireGuard / V2Ray, 3 SDKs | one paid session in a `dvpnd` client container (`audit/session-runner.js`) → Cosmos `TestResult` |
| `core/chain.js` plan helpers | `QueryPlans`, subscriptions, fee grants | Plan / Subscription accounts, provider roster API, provider-listed check (`lib/plans.js`) |
| `core/session.js` batch payment / cancel | `MsgStartSession` batches, `MsgCancelSession` | none per batch: the client daemon opens one voucher channel per test; cancel = `start_close_channel` → `close_channel` → `withdraw_user_balance` (`audit/channels.js`, hourly background sweep) |
| `core/onchain-report.js` | self-send memo ≤ 256 chars, `tx_search` | SPL Memo `SNTR1|v3` ≤ 900 chars, `getSignaturesForAddress` (adapter keeps `{txhash, height, payload}`) |
| `protocol/speedtest.js` | multi-target adaptive | baseline: `SPEED_URL` (Cloudflare by default) then ranged OVH / Tele2 (`SPEED_FALLBACK_URLS`); in-tunnel download uses the same list |
| `platforms/*/wireguard.js`, `v2ray.js` | host tunnels | shims: no host tunnel ever; `killAllV2Ray` (called by `/api/stop`) removes the in-flight client container |
| `core/sdk-verify.js` | npm SDK tarball vs GitHub | `dvpnd version` from the client image |
| `core/transport-cache.js` | learned V2Ray transports | empty (the client picks transports from signed metadata) |
| `protocol/diagnostics.js` | host VPN interference pause | always clear (tunnels live in containers) |

## Behaviour notes

- **Stop** removes the in-flight container; the node is not recorded (retried on resume) — the Cosmos
  semantics. Runs are serialised so a start right after a stop waits for the old pipeline to unwind.
- **Spend** = the prepay voucher the client signs (`ceil(prepayBytes × price / 1e9)`); escrow is locked
  per channel and refunded by the sweep. Before every paid node the real token + SOL balance is read.
- **P2P per hour** (`start --hours`, the Cosmos "Per Hour" route): each test opens a **stream** channel
  escrowing 1 hour of the node's `channel_price_per_hour`, and the tester closes it right after the
  session — stream channels have no grace and bill until closed, so only the elapsed time is paid
  (`close_channel` settles it; the amounts come from the `ChannelClosed` event). Nodes with no
  hourly price are skipped, as on Cosmos.
- **Subscription plans** (`/api/test-plan`, `/api/test-sub-plan`, the Sub. Plan picker). Mapping:
  planId = Plan PDA, subscriptionId = Subscription PDA, granter = Provider PDA. Cosmos starts each
  plan session with a fee-granted `MsgStartSession`; Solana uses an **access ticket**: the client
  signs a ticket request, the node forwards it to the provider, the provider checks the subscription
  and its roster and signs. No tx, no gas, no channel per session. The plan's node set is the
  provider's roster (`GET /v1/plans/{plan}/nodes`), read only after the provider's signed metadata,
  owner and TLS pin check out (`lib/plans.js`). `test-plan` subscribes first (closing the tester's
  own expired subscription to that plan, which occupies the PDA). The picker's badge
  reads OWN PROVIDER / PROVIDER VERIFIED / PROVIDER UNVERIFIED — there is no fee grant on Solana. Lab providers that
  advertise 127.0.0.1 need `PROVIDER_API_OVERRIDES`.
- **Plan connection limit:** the provider counts every unexpired ticket against the plan's
  `max_connections`. A ticket lasts until min(issue + provider `max_ttl_seconds` (default 86400), subscription
  expiry), so a 1-connection plan admits one session per subscription per ticket lifetime: 1 h on a
  1 h plan, up to 24 h on a longer one. The node
  reports that refusal (HTTP 409 `peer_limit_reached` at the provider) as a generic `ticket_invalid`;
  the tester asks the provider and records `PLAN_CONNECTION_LIMIT` as a skip, not a failure.
- **Not the node's fault → skip** (`isNodeFault` in `audit/pipeline.js`): `PROTOCOL_UNSUPPORTED`,
  `PLAN_CONNECTION_LIMIT`, `SPEED_SOURCE_UNAVAILABLE` (the tunnel carried the request, every speed
  host refused it), `CLIENT_EXITED` (after one retry) and `DOCKER_UNAVAILABLE`. Skips are not counted
  as failures and are not reported on chain; `retest-fails` still retests them.
- **Online scan refuses untrustworthy metadata** before any channel opens: a bad signature, claims
  that do not match the account, or a TLS certificate that does not match the `tls_sha256` pin in the
  signed metadata (the client would refuse that node at session start).
- **SDK comparison** does not apply: Solana has one client implementation (`dvpnd`); the Rust crates
  have no session client. The SDK switch stays pinned to `dvpnd`.
- **Lab / tunnelled nodes:** `NODE_URI_OVERRIDES` maps a node that advertises 127.0.0.1 / a LAN
  address, or one reached through `scripts/dev/box-tunnel.mjs`; the client container DNATs to it (with
  `route_localnet`) and runs with its kill switch off. `host.docker.internal` = this machine, which the
  tester's own probe dials as `127.0.0.1`.
- **Refund sweeps run one at a time** (the hourly timer, the after-run sweep and `sweep` queue), so
  two never send `close_channel` for the same channel.

## Verified on devnet

Latest (2026-10-21): all 62 CLI commands, **123/123** assertions (`scripts/cli-e2e.mjs`) against nodes
on a remote box over the SSH tunnel — paid sessions verified on chain by an independent RPC, report
memos decoded from `getSignaturesForAddress`, stop/resume, retests, loop, run save/load/delete, plan
(ticket) runs, sweep scoping, continuous public loop with `/live` SSE, and every setting by its effect
(price cap, GB per node and DNS in the client config, auto-cancel off → sweep). Offline: unit + route sweep
(`npm test`), coverage 0 problems.

All six protocols pass paid sessions over the internet (2026-10-20, per-hour stream channels, an
all-protocol node set on a cloud VM): WireGuard, V2Ray, Xray, OpenVPN and Hysteria2 from Docker
Desktop, and AmneziaWG too from the box-hosted tester (a Linux kernel). Earlier (2026-10-19) on WSL
lab nodes: multi-node stop + resume, refund close + withdraw on chain, live low-balance pause,
admin-token auth in `PUBLIC_MODE`. Per-run numbers: the handoff.
