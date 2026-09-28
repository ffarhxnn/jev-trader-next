# Jev Trader Next

A fresh, loopback-only dashboard for observing the Monad Kuru MON-USDC book and testing model decisions in a paper ledger. The default setup is a deterministic synthetic demo with a clearly labeled local heuristic. Optional Jev mode uses only OpenCode Zen's fixed free `jev-1.13-free` model. This project has no wallet, private-key setting, signer, transaction encoder, or order submission path.

## Run the offline demo

Install Bun, then from this directory:

```sh
cp .env.example .env
bun install
bun run dev
```

Open <http://127.0.0.1:3015>. The demo needs no network or credentials. Its prices and decisions are generated locally and are not MON market data or evidence about returns.

## Optional live-book Jev paper mode

This mode reads the public MON-USDC order book through Monad JSON-RPC, asks the exact free Jev model through OpenCode Zen, and simulates quotes and fills locally. It never submits orders. Add settings to the untracked `.env` file:

```dotenv
APP_MODE=paper
MODEL=jev
OPENCODE_API_KEY=your-server-side-key
```

The code rejects paid or alternate model IDs, live execution configuration, non-loopback server hosts, invalid decisions, and crossing paper quotes. Provider credentials stay on the server and are never sent to the browser. A failed Jev call does not fall back to a demo model; public book monitoring continues and the dashboard shows the failure.

Jev requests are spaced by 10 seconds by default. `JEV_DECISION_INTERVAL_MS` accepts 1,000 to 120,000 milliseconds. HTTP 429 responses honor `Retry-After`; when absent, retries back off for 60, 120, then 300 seconds. A retry is only an attempt: the provider may continue to reject requests, and the app does not assume a quota reset schedule. Book monitoring continues during cadence waits and cooldowns.

## Paper assumptions and risk

The quote engine joins or improves the current touch when a one-tick improvement remains strictly inside the opposite touch. It keeps at most one simulated order and only considers it fillable on a later observation when the public midpoint crosses its limit. This fill proxy does not model queue position, taker prints, depth consumed, latency, rebates, or adverse selection. The UI labels each fill with that assumption.

The paper ledger marks equity as cash plus signed MON inventory at the latest midpoint, subtracts modeled fees once, limits inventory, checks affordability for buy quotes, and latches a mark-to-market loss stop. Short inventory is idealized and does not include borrow, margin calls, or liquidation. Default paper fees are zero and can be set with `PAPER_FEE_BPS`; displayed simulation P&L is not a profitability claim.

## Verification

```sh
bun test
bun run typecheck
```

Tests use mocked provider responses and deterministic books. They do not call OpenCode Zen or place transactions. The Kuru adapter uses the public Kuru SDK to read the order book. The SSE endpoint and snapshot API are read-only and the server binds to `127.0.0.1`.
