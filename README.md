# Sentinel Node Tester — Solana

The Sentinel Node Tester (the Cosmos one at test.sentinel.co) rebuilt for the **Solana** `dvpn`
program. Same dashboards, same API, same run lifecycle — the pages are the committed Cosmos pages
plus the wording edits in `scripts/dev/page-edits.txt` (tDVPN amounts, Solana Explorer, the DVPND
client, SPL Memo reports, plan access tickets, the Solana CLI guide). Underneath, every node is
tested on Solana: discovered on chain, probed through its signed metadata, and connected through a
real paid session inside a throwaway `dvpnd` client container.

| | |
|---|---|
| Program | `J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs` (devnet) |
| Token | tDVPN, Token-2022 mint `Hen2LVP6KooGaXEvdSyCHWghsEY4gLLn7wix8z6zHFSa`, 6 decimals, shown as tDVPN (DVPN on mainnet) |
| Client image | `snt-tester/dvpnd:devnet-cf4c372-ddv2` — `npm run build-client-image` (`docker/client.Dockerfile`): dvpnd cf4c372 (the program on chain since the 2026-10-21 redeploy; older clients cannot open channels) + every protocol's client tools |
| Protocols | WireGuard, V2Ray, Xray, OpenVPN, Hysteria2; AmneziaWG where the kernel has `nft_fib_ipv6` |
| Pages | `/admin` (operator), `/live` (public live view), `/` (public directory with `PUBLIC_MODE=true`), `/node/:addr` |

## Download

Latest release: [**Releases**](https://github.com/Sentinel-Bluebuilder/sentinel-solana-node-tester/releases/latest)

| What | Linux x86_64 | Linux arm64 |
|---|---|---|
| Node daemon `sentinel-dvpnd` | `sentinel-dvpnd-linux-amd64` | `sentinel-dvpnd-linux-arm64` |
| Node CLI `sentinel-dvpn` | `sentinel-dvpn-linux-amd64` | `sentinel-dvpn-linux-arm64` |

The Node Tester itself runs from source (see below). The release carries the daemon and CLI binaries it drives
(built from the Sentinel fork cut `final6.1`), `SHA256SUMS` and the third-party notices.
Some releases ship only the x86_64 binaries.

> **Devnet only, unsigned builds.** Tokens on Solana devnet have no value.

Verify: put `SHA256SUMS` and the files you downloaded in one folder, then
`sha256sum -c --ignore-missing SHA256SUMS`.

Build from source: `npm ci` then `npm test` (see the sections below for running).

Test results and known issues:
[sentinel-solana-dvpn-testing-tools](https://github.com/Sentinel-Bluebuilder/sentinel-solana-dvpn-testing-tools)
([known issues](https://github.com/Sentinel-Bluebuilder/sentinel-solana-dvpn-testing-tools/blob/main/docs/known-issues-rc1.md)).
## How a node is tested

1. **Discovery** — `getProgramAccounts` over Node accounts (deployed devnet sizes). Only live
   listings are testable (`listed_at + node_listing_ttl_seconds`), like active nodes on Cosmos.
2. **Online scan** — `GET /v1/metadata`: signature under `sentinel-dvpn/node-metadata/v1` must verify,
   claims must match the account, the TLS cert must match the advertised pin. Nodes that fail are
   left out of the run, exactly as the Cosmos tester drops offline nodes.
3. **Session** — a client container runs `dvpnd` with the tester wallet, in one of three modes:
   - **P2P per GB** (default): `client start --new-channel --mode voucher` opens a channel and
     prepays with a signed voucher;
   - **P2P per hour** (`start --hours`): a stream channel escrowing one hour, closed right after the
     test so only the elapsed time is paid;
   - **Subscription plan** (`test-plan`, `test-sub-plan`): an access ticket signed by the plan's
     provider — no channel, no spend per session.

   Then `TEST_MB` are pulled through
   the tunnel (SOCKS for V2Ray/Xray) from `SPEED_URL` (Cloudflare by default), falling back to ranged
   OVH / Tele2 downloads (`SPEED_FALLBACK_URLS`); one request round trip through the tunnel gives the
   latency; the session stops; the container is deleted.
   By default (the steady method) it runs 4 time-bounded streams of verified bytes from our own
   pinned origin and reports the steady-state rate, which is far more accurate; the classic download
   above runs beside it and is the fallback (`SPEED_METHOD=classic` makes it the figure). See
   `docs/SPEED-METHOD.md` (`node cli.js speed` shows what is active) and the lab evidence in
   `docs/BANDWIDTH-TRUTH.md`.
4. **Score + persist** — Cosmos `TestResult` shape, Cosmos SQLite schema, failure logs, runs, batches.
   Failures that say nothing about the node are recorded as **skips**, never counted against it:
   the protocol cannot run on this machine (AmneziaWG on Docker Desktop), the plan has no free
   connection, every speed host refused the download through a working tunnel, or the client
   container died / could not start.
5. **Report** (opt-in, admin settings) — SNTR1 v3 SPL Memo per batch, readable by anyone with
   `getSignaturesForAddress(testerWallet)`.
6. **Refund** — with *auto-cancel* on (default), each channel is start-closed after the run; an hourly
   background sweep closes matured channels and withdraws the unspent escrow. Only channels the tester
   recorded are ever touched — the devnet wallet is shared with other projects.

**TEST RUN** = discovery + scan only: no channel, no memo, nothing spent. **Stop** removes the in-flight
container at once; the interrupted node is not recorded and is retried on resume.

## Run

```sh
npm install                 # also generates chain/idl/dvpn.devnet.json
cp .env.example .env        # SOLANA_RPC_URLS, TEST_KEYFILE, DVPND_IMAGE
npm run doctor              # Docker, client image, wallet, RPC — without the server
npm start                   # http://127.0.0.1:$PORT/admin  ·  /live   (PORT from .env, default 3001)
node cli.js help            # 62 commands, one route each
node cli.js start --addresses <pda>,<pda>   # a paid run limited to those nodes
node cli.js config          # every setting below, its live value and where it comes from
```

### Settings

Runtime settings change without a restart (CLI or the admin page); `.env` settings are read at boot.

| Setting | Source | Change with | Effect |
|---|---|---|---|
| `gigabytes` | runtime | `settings gigabytes=N` · P2P settings drawer | GB prepaid per per-GB session (client `prepay_bytes`) |
| `maxPriceBase` | runtime | `settings maxPriceBase=N` · drawer | skip nodes priced above N base units/GB; 0 = no cap |
| `autoCancelAfterTest` | runtime | `settings autoCancelAfterTest=true\|false` · drawer | start-close every test channel after a run; off = `sweep` does it |
| `onchainEnabled` / `onchainBatchSize` / `onchainRegion` | runtime | `settings …` · On-Chain Reporting popup | SNTR1 report memos: on/off, nodes per memo, header region |
| `batchSize` | runtime | `settings batchSize=N` | no effect on Solana (Cosmos batch payment); kept for the shared UI |
| DNS | runtime (boot default `DNS_SERVERS`) | `dns <preset>` / `dns --servers a,b` · DNS dropdown | the client container's `dns_servers` |
| Broadcast Live | runtime | `broadcast toggle` · Broadcast button | public `/live` shows the run |
| `PORT`, `LISTEN_HOST`, `PUBLIC_MODE`, `ADMIN_TOKEN`, `ALLOW_PUBLIC_TEST` | `.env` | restart | server, public directory at `/`, admin login, public start |
| `SOLANA_NETWORK`, `SOLANA_RPC_URLS`, `TEST_KEYFILE`, `DVPND_IMAGE` | `.env` | restart | chain, RPC pool, tester wallet, client image |
| `TEST_MB`, `MAX_NODES`, `NODE_DELAY_MS`, `CLIENT_TIMEOUT_SEC` | `.env` | restart | MB per speed test, node limit (0 = all), pause between nodes, client timeout |
| `SPEED_URL`, `SPEED_FALLBACK_URLS`, `CONNECTIVITY_URL`, `INTERNET_CHECK_URLS` | `.env` | restart | speed sources, connectivity probe, the tester's own internet check |
| `MIN_CHANNEL_BALANCE_BASE`, `SWEEP_EVERY_MS` | `.env` | restart | low-balance pause threshold, background refund sweep interval |
| `NODE_URI_OVERRIDES`, `PROVIDER_API_OVERRIDES` | `.env` | restart | see below |

### Nodes the client cannot reach directly

`NODE_URI_OVERRIDES=<nodePda>=<host>[:<apiPort>],…` sends a node's traffic elsewhere: the client
container DNATs the node's address (API port → the override, every other TCP port and all UDP except
DNS → the override host) and runs with its kill switch off. `host.docker.internal` means "this
machine", and the tester's own probe then dials `127.0.0.1:<apiPort>`. Two uses:

- **WSL lab nodes** that advertise 127.0.0.1 / a LAN address (`scripts/dev/wsl-node.sh`,
  `scripts/dev/wsl-test-nodes.sh`).
- **Nodes on a box whose firewall passes only SSH**: `node scripts/dev/box-tunnel.mjs` carries the
  API and V2Ray/Xray ports over `ssh -L` and the WireGuard / OpenVPN / Hysteria2 UDP ports framed over
  TCP, then map each node to `host.docker.internal:<apiPort>`. Run it in the background and restart
  it when the session that started it ends.

`PROVIDER_API_OVERRIDES=<providerPda>=https://host:port` does the same for a plan provider.

### Hosting

`scripts/dev/box-deploy.sh deploy|env KEY=VAL…|restart|stop|logs [n]|remove` installs the tester on a Linux box under
`/home/ubuntu/snt-test/tester` as a systemd unit on `127.0.0.1:3021` (reach it with
`ssh -L 3021:127.0.0.1:3021 <box>`), with a random `ADMIN_TOKEN`. On Linux the client container can
run AmneziaWG. `box-test-nodes.sh` opens one test node per protocol on that box;
`box-snapshot.sh` / `box-restore.sh` record the box before and diff it after teardown.

## Tests

```sh
npm test                    # unit (offline) + route sweep (isolated copy, TEST RUNs only, never spends)
npm run test:e2e -- --url http://127.0.0.1:3001         # every CLI command, live devnet, spends a few channels
npm run test:e2e:finish -- --url http://127.0.0.1:3001  # after the 2 h grace: close + refund, verify on chain
npm run coverage            # docs/COVERAGE.md; exits 1 on any unmapped or unexercised command
npm run data-check          # read-only: saved runs vs runs index vs DB, failure logs, channels, leftovers
npm run data-check -- --repair 55 --write        # rebuild a damaged saved run from its DB rows (dry run without --write)
npm run data-check -- --fix-failures --write     # trim each run's failures.jsonl to its own failures
```

The e2e needs a node this machine's client can run (`--node`, default the shared WSL rig node from
`scripts/dev/wsl-node.sh`), a node that fails (`--node2`, default a demo node whose uri never
resolves, so nothing is paid), and a plan with a reachable provider (`--plan`, `--plan-node`). Its
runs touch only those nodes plus `--only a,b`, never every node the shared wallet owns (other
projects run nodes from it); `--all-nodes` widens them to the whole network, which opens channels
on other people's nodes. It also proves each setting by its effect: the price cap, GB per node and
DNS in the client config, auto-cancel off → the sweep closes the channel.

## Layout

```
server.js, *.html, sentinel.css           Cosmos tester at its committed HEAD + scripts/dev/patch-server.mjs / page-edits.txt (npm test fails on any other change)
fonts/                                    Cosmos tester, verbatim
core/db.js, core/auth.js, core/rate-limit.js, core/settings.js, audit/continuous.js   Cosmos, verbatim (+ small Solana edits that npm test pins)
core/{constants,chain,wallet,session,onchain-report,sdk-verify,countries,transport-cache}.js   Solana behind Cosmos names
protocol/{v3protocol,speedtest,diagnostics}.js, platforms/*   Solana behind Cosmos names
audit/pipeline.js        Cosmos run lifecycle, Solana engine; runs serialised
audit/node-test.js       one node → Cosmos TestResult
audit/session-runner.js  the client container script + transcript parser
audit/docker.js          docker CLI, client flags, capability probe, stop
audit/channels.js        start_close / close / withdraw for tracked test channels
lib/solana/*, lib/discovery.js, lib/onchain-report.js, lib/wallet.js, lib/speed.js, lib/db.js   Solana engine
routes/solana.js         /api/solana/* (doctor, channels, sweep, probe, reports) + background refund sweep
cli.js                   the CLI (scripts/cli-e2e.mjs drives every command against a live server)
scripts/dev/             page / server patchers, WSL lab nodes, box hosting + test nodes + SSH tunnel
```

Function-by-function mapping from the Cosmos tester: `docs/SOLANA-MAPPING.md`.

## License

The tester's code is under the **Sentinel dVPN License** (`LICENSE`), as are the vendored dvpn program IDL (`chain/idl/dvpn.source.json`), the file derived from it (`chain/idl/dvpn.devnet.json`) and the upstream `sentinel-dvpnd` / `sentinel-dvpn` binaries the client image is built from (not shipped here). See `NOTICE`.
