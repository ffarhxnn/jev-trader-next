# Jev Trader Next

A fresh, loopback-only dashboard for observing the Monad Kuru MON-USDC book and testing model decisions in a paper ledger. The default setup is a deterministic synthetic demo with a clearly labeled local heuristic. Paper mode supports collection with decisions paused, Jev through OpenCode Zen, OpenCode Go hosted models, and an opt-in Gemini API adapter. Provider calls are disabled unless explicitly enabled; failures never silently switch models. The app has no wallet or private-key setting and no order-submission path. A separate legacy-testnet-only helper can prepare unsigned Kuru calldata; it is not connected to the app and cannot sign or submit transactions.

## Run the offline demo

Install Bun, then from this directory:

```sh
cp .env.example .env
bun install
bun run dev
```

Open <http://127.0.0.1:3015>. The demo needs no network or credentials. Its prices and decisions are generated locally and are not MON market data or evidence about returns.

## Optional live-book Jev paper mode

This mode reads the public MON-USDC order book through Monad JSON-RPC, subscribes to Kuru's public trade WebSocket, asks Jev through OpenCode Zen, and simulates quotes and fills locally. It never submits orders. Add settings to the untracked `.env` file:

```dotenv
APP_MODE=paper
MODEL=jev
OPENCODE_API_KEY=your-server-side-key
JEV_REQUESTS_ENABLED=1
MODEL_MAX_REQUESTS_PER_UTC_DAY=3
```

Jev provider requests are disabled by default, so configuring the model alone will only monitor the live book and show that decisions are paused. Set `JEV_REQUESTS_ENABLED=1` to deliberately permit requests, and set `MODEL_MAX_REQUESTS_PER_UTC_DAY` to a positive limit first. The app counts attempts per provider model and UTC date, persists the count in an owner-only file, and blocks further calls when the limit is reached. Failed requests count too. This is a request-count limit, not a dollar spending cap; provider-side billing limits are still needed for any paid model. The free Jev model is the default, but its availability is limited-time. To intentionally use paid Jev instead, add `JEV_MODEL_ID=jev-1.13` and `JEV_ALLOW_PAID=1` after configuring a provider spending cap. Check current provider pricing before enabling calls. The app never falls back to paid Jev automatically. It rejects unsupported models, paid Jev without the explicit opt-in, live execution configuration, non-loopback server hosts, invalid decisions, and crossing paper quotes. Provider credentials stay on the server and are never sent to the browser. A failed Jev call does not fall back to a demo model; public book monitoring continues and the dashboard shows the failure.

Jev requests are spaced by 10 seconds by default. `JEV_DECISION_INTERVAL_MS` accepts 1,000 to 120,000 milliseconds. HTTP 429 responses honor `Retry-After`; when absent, retries back off for 60, 120, then 300 seconds. Retry time, failure count, and the last request timestamp are persisted in owner-only `data/jev-provider-state.json` so restarting the local app does not immediately retry a rate-limited account. The state file contains no API key or response content. A retry is only an attempt: the provider may continue to reject requests, and the app does not assume a quota reset schedule. Book monitoring continues during cadence waits and cooldowns.

For a local, no-model-API paper execution smoke test against the real public book, set `APP_MODE=paper`, `MODEL=demo`, and `PAPER_LOCAL_DEMO_ENABLED=1`. This enables only the built-in momentum heuristic, not Jev; provider request switches remain off and its output is not strategy evidence. The extra opt-in is required because this heuristic is not a substitute for the intended Jev strategy.

## Optional OpenCode Go paper mode

The OpenCode Go adapter supports chat-completions and Responses APIs. Verify model availability and account limits before enabling requests. Its API key is configured separately from the desktop app login. [Provider documentation](https://opencode.ai/docs/go/).

To prepare the adapter, copy an API key from your OpenCode Go account and set these values in the untracked `.env` file. Kimi K3 is the default. For Muse Spark Contributor, set `OPENCODE_GO_MODEL_ID=muse-spark-1.3-contributor` and `OPENCODE_GO_PROTOCOL=responses`. This is still paper research; model decisions are not evidence of a trading edge.

```dotenv
APP_MODE=paper
MODEL=opencode-go
OPENCODE_GO_API_KEY=your-server-side-key
OPENCODE_GO_MODEL_ID=kimi-k3
OPENCODE_GO_PROTOCOL=chat
OPENCODE_GO_REQUESTS_ENABLED=1
MODEL_DECISION_INTERVAL_MS=10000
MODEL_MAX_REQUESTS_PER_UTC_DAY=3
```

Leave `OPENCODE_GO_REQUESTS_ENABLED=0` (or set `MODEL=paused`) to capture the live market without sending provider calls. Before enabling calls, set `MODEL_MAX_REQUESTS_PER_UTC_DAY` to your chosen cap. Attempts are counted before network I/O and persisted per model; they remain consumed on failure or restart. This bounds request count, not dollar cost or provider-plan quota, so check provider terms and limits too. Decisions are schema-checked, calls are spaced by the configured cadence, and HTTP 429 responses trigger a cooldown. Provider failure pauses decisions; it does not fall back to Jev, the demo heuristic, or another provider. Keys remain server-side. Go model calls are opt-in. Use `MODEL=paused` for collection only.

Gemini API is also wired through the same `DecisionModel` interface. It uses a separate Google AI Studio API key; a Google One plan covers Gemini app benefits but does not itself provide Gemini API quotas or billing. Eligible Gemini models may have free API usage subject to changing rate limits and availability. See [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) and [billing](https://ai.google.dev/gemini-api/docs/billing).

## Latest validation

The first uninterrupted 10-minute forward replay completed on 2026-10-01. Its 57 local-heuristic decisions were checked against 398 finalized receipt-backed public trades. Every latency scenario produced one proxy fill, below the predeclared 20-fill floor. Modeled update costs outweighed the mark-to-market gain; the three-second scenario also stopped on an unresolved cancellation race. These results do not support live trading or profitability. The [execution-readiness record](docs/execution-readiness.md) includes the assumptions, sample limits and remaining execution gaps.

The collection-timing correction and whitelisted trade audit records were applied after the test completed; the frozen test window remains unchanged.

## Paper assumptions and risk

The quote engine joins or improves the current touch when a one-tick improvement remains strictly inside the opposite touch. Kuru paper mode keeps at most one simulated order, estimates queue ahead from visible size at the quote price, and requires an opposite-side public Kuru trade at that exact price to fill it. A disconnected or silent trade feed cancels the quote, blocks new decisions, and marks the dashboard degraded. `KURU_WS_STALE_AFTER_MS` (60 seconds by default) closes and reconnects a socket that has received no valid server message; snapshots and event updates renew that deadline even when no trade occurred. The recorder uses the same feed logic and writes a `gap` marker for silent or disconnected intervals, so replay will not treat those spans as continuous trade coverage. Repeated Kuru block numbers are ignored; if the head does not advance within `BOOK_STALE_AFTER_MS` (5 seconds by default), the quote is canceled until a newer block arrives. The dashboard reports received and ignored trade counts, plus the latest trade age. This remains an approximation: it cannot identify FIFO position or distinguish later arrivals from cancellations at the same level, and it does not model hidden liquidity, message delay, rebates, or adverse selection. The UI labels fills with the modelled trade and queue assumption. The offline demo still uses a labeled midpoint-cross proxy.

The paper ledger marks equity as cash plus MON inventory at the latest midpoint, subtracts modeled fees once, limits inventory, checks affordability for buy quotes, and latches a mark-to-market loss stop. In paper mode, the loss-stop latch is saved owner-only and survives a process restart; corrupt or mismatched latch state blocks startup. To clear it after reviewing the stop, stop the app and run `bun run risk:reset -- --acknowledge-paper-reset`, then restart paper mode. Short selling is disabled: sell quotes are limited to MON already held, pending separate validation of Kuru margin and borrow behavior. In live-book mode, the ledger uses the Kuru maker fee read with market parameters and pauses if that fee is unavailable; `PAPER_FEE_BPS` is an optional explicit scenario override. Displayed simulation P&L is not a profitability claim.

Each `APP_MODE=paper` session writes an append-only `data/paper-audit-*.jsonl` file with model decisions and their exact public input snapshots, accepted `book_observed` snapshots, resting or canceled quote states, fills, inventory, fees, and safety-state changes. Observed books retain their actual `receivedAt` time separately from audit publication time. Files are local, ignored by Git, and created with owner-only permissions. Prompts, provider responses, and API keys are not recorded. This history supports review of the actual Jev paper strategy; the separate L2 replay below remains an independent quote experiment.

Trade connections also enforce ownership throughout stop and reconnect. Late
callbacks from closed or replaced sockets cannot restore health, deliver trades,
or alter the replacement's timers. Repeated start calls share one connection
attempt, and stop invalidates any pending parameter read. The freshness deadline
also covers silent initial connections and missing subscription acknowledgments;
failed sends and transport closes retire safely. New paper sessions record the
connection policy and its deadline. These checks do not prove active-server
message completeness or chain confirmation.

Paper Kuru books also expire independently of the polling loop. A watchdog
checks the five-second advancing-book deadline, and trade handling and completed
model requests repeat the check before consuming queue, recording a fill, or
creating a quote. An expired book cancels the simulated order and clears the
stale signal; only a newer accepted block restores quoting. Watchdog publication
does not create a new book observation. Session starts record the freshness
policy and deadline so earlier logs cannot imply this protection. Synthetic
demo timing is unchanged.

Measure decision markouts against verified Kuru snapshots, including a chronological holdout split with a 64-second purge around its boundary:

```sh
bun run markout -- data/paper-audit-YYYY-MM-DDTHH-MM-SS-sssZ.jsonl data/kuru-l2-YYYY-MM-DD.jsonl
bun run markout:walk-forward -- data/paper-audit-YYYY-MM-DDTHH-MM-SS-sssZ.jsonl data/kuru-l2-YYYY-MM-DD.jsonl
```

The report includes per-horizon chosen-confidence diagnostics against whether the directional markout is positive, including mean confidence, observed positive fraction, Brier score, and sample count. It also computes deterministic time-block bootstrap intervals with blocks three times the longest horizon and suppresses intervals when fewer than ten blocks are available. The holdout check uses only decisions after the purged split and remains descriptive. It does not establish profitability, calibration, or execution quality.

Summarize one or more sessions without exposing prompts or credentials:

```sh
bun scripts/paper-report.ts data/paper-audit-YYYY-MM-DDTHH-MM-SS-sssZ.jsonl
```

The report is descriptive only. Sessions explicitly marked aborted are excluded from validation summaries, and unbacked sell quotes are counted as an invariant violation.

## Read-only L2 research

Capture public Kuru L2 snapshots locally (this uses the read-only RPC adapter and never asks for a wallet):

```sh
bun run record:l2 -- --interval-ms 1000 --minutes 60
```

The recorder writes both an L2 JSONL file and a matching `-trades.jsonl` file under ignored `data/`. Omit `--minutes` to keep recording until Ctrl-C; use `--out path.jsonl` and `--trades-out path.jsonl` to choose paths. It polls public L2 snapshots and subscribes to Kuru's read-only trade WebSocket. The snapshot file includes timestamp, block, visible bid/ask price levels, market address, tick size, quantity scale, and market fee parameters. The trade tape stores public trade price, size, taker side, connection markers, receipt time, and when provided, the public transaction hash and raw source timestamp. Source timestamp units are not assumed; replay chronology continues to use local receipt time. Trader addresses are discarded. A trade missing a reliable side remains ignored for queue fills, but the recorder keeps its valid transaction hash and raw price/size when available so successful chain receipts can later provide an audited side. Paper fill candidates retain matching trade provenance, but this does not verify a fill against a chain receipt.

For a reproducible interval, slice both captures to explicit ISO timestamps with a timezone, for example:

```sh
bun run slice:replay -- data/l2.jsonl data/trades.jsonl --start-iso 2026-09-30T18:00:00Z --end-iso 2026-09-30T19:00:00Z --minimum-window-seconds 600 --out-prefix data/replay-window
```

The slicer selects only one uninterrupted verified-chain L2/trade-feed overlap inside those inclusive bounds. It fails closed if the requested interval crosses multiple feed sessions or gaps; otherwise it reports the exact observed snapshot bounds used.

Replay a capture with the independent inventory-skewed, volatility-adjusted quote experiment:

```sh
bun run backtest -- data/kuru-l2-YYYY-MM-DD.jsonl --trade-tape data/kuru-l2-YYYY-MM-DD-trades.jsonl
```

Reconcile captured public Kuru trade hashes against Monad receipts without signing or submitting transactions:

```sh
bun run verify:receipts -- data/kuru-l2-YYYY-MM-DD-trades.jsonl data/kuru-l2-YYYY-MM-DD.jsonl
```

The report verifies the RPC chain and receipt success, then reconciles each feed event's total raw size, aggressor side, and volume-weighted raw price against the configured market's Kuru `Trade` logs. It permits at most two WAD-price units of integer conversion error. A match confirms only the public trade event in a successful receipt; it does not prove a local paper order filled, had queue priority, or would execute live. Add `--expanded-tape data/kuru-receipt-trades.jsonl` to create a replay tape from verified, per-log price and fill-size events. Rows without a fully matching receipt are excluded as ignored rather than being treated as exact-price prints.

Replay the receipt-enriched tape with the same queue-aware research simulator:

```sh
bun run backtest -- data/kuru-l2-YYYY-MM-DD.jsonl --trade-tape data/kuru-receipt-trades.jsonl
```

With `--trade-tape`, replay selects the longest uninterrupted feed session overlapping at least two snapshots. A simulated order first queues behind visible size at its price and can fill only from opposite-side Kuru trades at that exact price. Unknown-side trades do not deplete modeled queue; `ignoredTradeEvents` reports unresolved feed records. Queue cancellations and hidden/sequence state are not modeled, so the assumed queue may be too large or too small; full live fill behavior still is not established. Without `--trade-tape`, the replay falls back to the looser one-tick midpoint cross-through proxy. Quotes are reconsidered at the configured refresh cadence (default 10 seconds), rather than being replaced on every recorded snapshot. `--order-latency-ms` delays an atomic hypothetical replacement (default 0; try sensitivity values such as 250, 500, 1,000, and 2,000 ms). Old quotes remain executable while a frozen update is pending; cancellation and activation apply together after the delay, and unchanged quotes retain queue priority. Resource changes or known crossing prices revert the update while retaining its assumed cost. Boundary-time events touching old/new prices are censored. This remains a hypothetical lifecycle model; it does not establish deployment-specific cancellation behavior. `quoteUpdates` counts simulated quote batches; `--gas-usd-per-update` applies a fixed cost assumption per changed batch (default $0), and `gasBlockedUpdates` counts batches skipped when available cash cannot cover that cost. This is a sensitivity knob, not a measured on-chain gas estimate. The output includes assumptions, inventory, fills, per-fill quote/queue/trade provenance, gross/net mark-to-market P&L, and `RESEARCH_PROXY_ONLY`. Kuru's captured maker fee is used unless `--fee-bps` overrides it; use a higher value for fee sensitivity (for example `--fee-bps 10`). Rebates, slippage, and borrow/margin costs are excluded. Treat results as a screening tool, not a profitability estimate. Starting scenario defaults (cash, inventory, quote size, spread, refresh cadence) are explicit in the output and can be changed with `--cash`, `--starting-mon`, `--order-size`, `--position-cap`, `--base-half-spread-bps`, `--volatility-multiplier`, and `--quote-refresh-ms`.

In paper mode, quotes and model decisions are blocked when the observed book spread is invalid or exceeds `MAX_MARKET_SPREAD_BPS` (default 50 bps). Any resting paper quote is canceled while this gate is active. The live-order process applies the same default before asking the model or submitting an order.

## Single-placement decision replay

Use the same paper audit's accepted book timeline and recorded decisions. Every selected depth row must match that audit's observed sequence exactly, including book fields, market metadata, capture cadence, and gap markers. The runner rejects omissions, inserted rows, and substituted observations; each selected decision's exact input must already appear in the timeline. The extractor reads only explicit `book_observed` rows, preserves their receipt order, marks capture gaps, and rejects contradictory timestamps, block rollback, or changed market metadata. Legacy decision rows cannot substitute for missing observed-book records. It writes a new owner-only public-depth file and refuses to overwrite an existing output.

Run from `jev-trader-next/` with a captured session and an explicit uninterrupted interval:

```sh
bun --no-env-file scripts/extract-paper-books.ts data/paper-audit-session.jsonl data/paper-books.jsonl
bun --no-env-file scripts/slice-depth-window.ts data/paper-books.jsonl --start-iso 2026-10-01T09:10:00Z --end-iso 2026-10-01T09:25:00Z --minimum-window-seconds 600 --out data/paper-window-depth.jsonl
bun --no-env-file scripts/reconstruct-receipt-trades.ts data/paper-window-depth.jsonl data/paper-window-receipt-trades.jsonl
bun --no-env-file scripts/single-placement-replay.ts data/paper-window-depth.jsonl data/paper-window-receipt-trades.jsonl data/paper-audit-session.jsonl --start-iso 2026-10-01T09:10:00Z --end-iso 2026-10-01T09:25:00Z --order-latency-ms 250 --receipt-confirmation-delay-ms 1000 --gas-usd-per-update 0.01
```

The timestamps and timing/cost values above are examples, not measured execution assumptions. Receipt reconstruction uses public read-only RPC; extraction and replay are local file operations. Confirm the slicer's actual output path and observed bounds before reconstruction. The replay requires complete receipt-tape coverage, successful finalized canonical transaction-index evidence, and each supplied decision's exact recorded input already present in the same audit's observed-book timeline. Do not mix asynchronous recorder books with decision books, or sort/drop block regressions to force a score.

This models one placement per batch with delayed inclusion and receipt confirmation. Inclusion delay, receipt delay, and USD cost per submitted placement or protective cancel are required explicit scenarios; costs remain charged on reverts, unresolved outcomes, and pending updates at the interval end. The default duration floor is 600 seconds and the fill floor is 20. Reports always remain execution proxies with `realMoneyReady=false` and `holdoutScored=false`, including when the fill floor is met. They do not include end-window liquidation/cancel costs or provider costs. Completed buy/sell/hold actions are fixed inputs: the model is not rerun against simulated inventory or execution history, and audit completion time is not proven chain inclusion time. A local heuristic session does not establish provider-backed strategy performance, FIFO priority, or live fills. See [execution readiness](docs/execution-readiness.md) for current and dated historical evidence.

Each markout horizon includes fixed always-buy and always-sell comparisons on the same matched decisions, plus a neutral 0.5 probability Brier comparison. These are descriptive price-direction checks, exclude unmatched/gap-censored observations, and do not measure trading returns or select a strategy.

Paper audit files also retain whitelisted public provenance for accepted and ignored trades, along with trade-feed health transitions. Missing trade direction stays unknown until receipt reconciliation; the producer never treats an omitted flag as a sell or invents a fill.

## Bounded forward validation

For a predeclared protocol stored beside its source audit, run the bounded watcher with an explicit Bun executable:

```sh
env -i PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin python3 scripts/run-forward-validation.py data/single-placement-owned-feed-forward-protocol-2026-10-01.json --bun-path /path/to/bun --max-wait-seconds 21600 --poll-seconds 60
```

It selects the first continuous 600-second interval independently of outcomes, freezes matching audit/depth files with hash bindings, reconstructs finalized public receipts for that same window, and runs the protocol's four fixed latency scenarios locally. An exclusive lock prevents duplicate runs. Public-data reconstruction has at most three bounded attempts; the watcher stops after six hours and never restarts the app. Check the new `data/forward-validation-*/status.json` for progress. This uses local files and public read-only RPC, with no provider calls or signed transactions. Reports always keep `holdoutScored=false` and `realMoneyReady=false`.

## Verification

Verify a Kuru market over a read-only RPC with `bun run verify:market -- --rpc <rpc-url> --chain-id <143|10143> --market <address>`. Add `--require-two-sided` to exit nonzero unless positive depth is present on both sides and the book is uncrossed. This qualifies only the observed book; it does not verify an order lifecycle or enable execution.

`src/kuru-v1-testnet-execution.ts` contains an isolated unsigned-order planner for the allowlisted legacy Kuru testnet market. Its controls and limits are documented in `docs/execution-readiness.md`. It is not a live-trading adapter, and the market still needs a two-sided book and an observed end-to-end testnet order lifecycle before execution readiness can be assessed.

```sh
bun test
bun run typecheck
```

Tests use mocked provider responses and deterministic books. They do not call OpenCode Zen or place transactions. The Kuru adapter uses the public Kuru SDK to read the order book. The SSE endpoint and snapshot API are read-only and the server binds to `127.0.0.1`.
