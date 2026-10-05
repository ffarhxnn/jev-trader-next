import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertReceiptVerifiedReplay, defaultBacktestOptions, parseDepthJsonl, parseTradeJsonl, replayDepth, selectTradeReplayWindow, tradeReplayEvidenceStatus, type BacktestOptions } from "../src/research";

const args = Bun.argv.slice(2);
const inputArg = args.find((arg) => !arg.startsWith("--"));
if (!inputArg || inputArg === "--help") {
  console.log("Usage: bun run backtest -- <l2-snapshots.jsonl> [--trade-tape path.jsonl] [--trade-window longest|latest] [--require-verified-receipts] [--fee-bps N] [--gas-usd-per-update N] [--order-latency-ms N] [--tick-size N] [--cash N] [--starting-mon N] [--order-size N] [--minimum-order-size-mon N] [--position-cap N] [--base-half-spread-bps N] [--volatility-multiplier N] [--quote-refresh-ms N]");
  process.exit(inputArg === "--help" ? 0 : 2);
}

function option(name: string, fallback: number) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} requires a non-negative number.`);
  return value;
}

const input = resolve(inputArg);
let snapshots = parseDepthJsonl(readFileSync(input, "utf8"));
let tradeEvents: ReturnType<typeof parseTradeJsonl>["events"] | undefined;
let ignoredTradeEvents = 0;
const requireVerifiedReceipts = args.includes("--require-verified-receipts");
if (requireVerifiedReceipts && !args.includes("--trade-tape")) throw new Error("--require-verified-receipts requires --trade-tape.");
let tradeFeedCoverage: { startTimestamp: number; endTimestamp: number } | null = null;
const bookSegments: typeof snapshots[] = [];
let currentSegment: typeof snapshots = [];
for (const snapshot of snapshots) {
  const previous = currentSegment.at(-1);
  const parametersChanged = previous && (snapshot.chainId !== previous.chainId || snapshot.market !== previous.market
    || snapshot.tickSize !== previous.tickSize || snapshot.minSizeMon !== previous.minSizeMon || snapshot.makerFeeBps !== previous.makerFeeBps);
  if ((snapshot.gapBefore || parametersChanged) && currentSegment.length) { bookSegments.push(currentSegment); currentSegment = []; }
  currentSegment.push(snapshot);
}
if (currentSegment.length) bookSegments.push(currentSegment);
const verifiedBookSegments = bookSegments.filter((segment) => segment.every((snapshot) => snapshot.chainId === 143 && Boolean(snapshot.market)));
if (!verifiedBookSegments.length) throw new Error("No uninterrupted capture segment has verified Monad chain 143 and a recorded market address.");
if (args.includes("--trade-tape")) {
  const tapeArg = args[args.indexOf("--trade-tape") + 1];
  if (!tapeArg) throw new Error("--trade-tape requires a JSONL path.");
  const tape = parseTradeJsonl(readFileSync(resolve(tapeArg), "utf8"));
  const modeIndex = args.indexOf("--trade-window");
  const windowMode = modeIndex < 0 ? "longest" : args[modeIndex + 1];
  if (windowMode !== "longest" && windowMode !== "latest") throw new Error("--trade-window must be longest or latest.");
  const selected = selectTradeReplayWindow(tape.coverage, verifiedBookSegments, windowMode);
  if (!selected) throw new Error("No uninterrupted Kuru trade-feed window contains at least two L2 snapshots.");
  snapshots = selected.snapshots;
  tradeFeedCoverage = selected.window;
  tradeEvents = tape.events.filter((event) => event.timestamp > snapshots[0]!.timestamp && event.timestamp <= snapshots.at(-1)!.timestamp);
  ignoredTradeEvents = tape.ignored.filter((event) => event.timestamp > snapshots[0]!.timestamp && event.timestamp <= snapshots.at(-1)!.timestamp).length;
  if (requireVerifiedReceipts) assertReceiptVerifiedReplay(tradeEvents, ignoredTradeEvents, snapshots[0]!.chainId, snapshots[0]!.market);
} else {
  verifiedBookSegments.sort((a, b) => b.length - a.length);
  snapshots = verifiedBookSegments[0] ?? [];
}
const capturedTickSize = snapshots[0]?.tickSize;
const capturedMakerFee = snapshots[0]?.makerFeeBps;
const capturedChainId = snapshots[0]?.chainId;
for (const [index, snapshot] of snapshots.entries()) {
  if (snapshot.market !== snapshots[0]?.market || snapshot.chainId !== capturedChainId || snapshot.tickSize !== capturedTickSize || snapshot.minSizeMon !== snapshots[0]?.minSizeMon || snapshot.makerFeeBps !== capturedMakerFee) {
    throw new Error(`Market address, chain id, tick size, minimum order size, or maker fee changed within the capture at row ${index + 1}; split the file before replay.`);
  }
}
const assumptions: BacktestOptions = {
  ...defaultBacktestOptions,
  feeBps: option("--fee-bps", capturedMakerFee ?? defaultBacktestOptions.feeBps),
  gasUsdPerUpdate: option("--gas-usd-per-update", defaultBacktestOptions.gasUsdPerUpdate),
  tickSize: option("--tick-size", capturedTickSize ?? defaultBacktestOptions.tickSize),
  startingCash: option("--cash", defaultBacktestOptions.startingCash),
  startingMon: option("--starting-mon", defaultBacktestOptions.startingMon),
  orderSizeMon: option("--order-size", defaultBacktestOptions.orderSizeMon),
  minimumOrderSizeMon: option("--minimum-order-size-mon", snapshots[0]?.minSizeMon ?? 0),
  positionCapMon: option("--position-cap", defaultBacktestOptions.positionCapMon),
  baseHalfSpreadBps: option("--base-half-spread-bps", defaultBacktestOptions.baseHalfSpreadBps),
  volatilityMultiplier: option("--volatility-multiplier", defaultBacktestOptions.volatilityMultiplier),
  quoteRefreshMs: option("--quote-refresh-ms", defaultBacktestOptions.quoteRefreshMs),
  quoteActivationDelayMs: option("--order-latency-ms", defaultBacktestOptions.quoteActivationDelayMs ?? 0),
};
const result = replayDepth(snapshots, assumptions, tradeEvents);
const executionEvidenceStatus = tradeReplayEvidenceStatus(args.includes("--trade-tape"), tradeEvents?.length ?? 0, ignoredTradeEvents);
const interpretation = executionEvidenceStatus === "NO_REPLAYABLE_TRADES_IN_SELECTED_WINDOW"
  ? "No replayable trade events overlap the selected L2 window; zero simulated fills are not evidence of no fills or execution quality. The selected window contains ignored trade-feed records."
  : executionEvidenceStatus === "NO_TRADE_EVENTS_IN_SELECTED_WINDOW"
    ? "No trade events overlap the selected L2 window; zero simulated fills are not evidence of no fills or execution quality."
    : "Research proxy only. Public snapshots do not show your queue position or confirm maker fills; this output is not evidence of live profitability.";
console.log(JSON.stringify({ input, executionTimingModel: "ATOMIC_DELAYED_TWO_SIDED_UPDATE_PROXY", tradeEventsReplayed: tradeEvents?.length ?? null, ignoredTradeEvents, executionEvidenceStatus, receiptVerificationStatus: requireVerifiedReceipts ? "ALL_SELECTED_EVENTS_RECEIPT_VERIFIED" : "NOT_REQUIRED", tradeFeedCoverageUsed: tradeFeedCoverage, ...result, interpretation, costNote: "Gas is a fixed USD scenario cost per submitted atomic update (default $0), including reverts and pending-at-end attempts; no end-window cancellation or liquidation is priced. Rebates, slippage, and margin or borrow costs are excluded.", capturedMarketParameters: { chainId: capturedChainId ?? null, market: snapshots[0]?.market ?? null, tickSize: capturedTickSize ?? null, minSizeMon: snapshots[0]?.minSizeMon ?? null, makerFeeBps: capturedMakerFee ?? null, takerFeeBps: snapshots[0]?.takerFeeBps ?? null }, assumptionSources: { quoteActivationDelayMs: args.includes("--order-latency-ms") ? "command-line atomic update latency scenario; not measured transaction inclusion" : "zero-latency default; not measured transaction inclusion", replacementTiming: "old affected quotes rest until the frozen batch applies; exact-time boundary trades censored; changed quote queue uses latest prior L2", chainId: capturedChainId === undefined ? "not recorded in this capture" : "verified RPC chain id recorded per snapshot", tickSize: args.includes("--tick-size") ? "command-line override" : capturedTickSize === undefined ? "default assumption" : "recorded Kuru market parameter", minimumOrderSizeMon: args.includes("--minimum-order-size-mon") ? "command-line override" : snapshots[0]?.minSizeMon === undefined ? "default assumption; market minimum not recorded" : "recorded Kuru market parameter", feeBps: args.includes("--fee-bps") ? "command-line override" : capturedMakerFee === undefined ? "10 bps stress default" : "recorded Kuru market fee", gasUsdPerUpdate: args.includes("--gas-usd-per-update") ? "command-line scenario assumption" : "zero-cost default; set a measured or stress value" } }, null, 2));
