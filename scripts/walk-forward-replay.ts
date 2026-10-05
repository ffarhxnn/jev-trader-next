import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertReceiptVerifiedReplay, parseDepthJsonl, parseTradeJsonl, selectTradeReplayWindow } from "../src/research";
import { defaultReplayWalkForwardOptions, replayWalkForward } from "../src/walk-forward-replay";

const args = Bun.argv.slice(2);
const paths = args.slice(0, 2);
if (args.includes("--help") || paths.length !== 2) {
  console.log("Usage: bun scripts/walk-forward-replay.ts <l2-snapshots.jsonl> <receipt-expanded-trades.jsonl> [--trade-window longest|latest] [--minimum-window-seconds 600] [--train-fraction 0.7] [--purge-ms 60000] [--spreads-bps 0,4,8,16,32] [--minimum-training-fills 20] [--benchmark-spread-bps 8] [--starting-cash-usd 20] [--starting-mon 600] [--order-size-mon 200] [--minimum-order-size-mon 200] [--position-cap-mon 1000] [--gas-usd-per-update 0.01] [--order-latency-ms 0]");
  process.exit(args.includes("--help") ? 0 : 2);
}

function numericOption(name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a finite number.`);
  return value;
}

const depth = parseDepthJsonl(readFileSync(resolve(paths[0]!), "utf8"));
const tape = parseTradeJsonl(readFileSync(resolve(paths[1]!), "utf8"));
const segments: typeof depth[] = [];
let segment: typeof depth = [];
for (const snapshot of depth) {
  const previous = segment.at(-1);
  if (previous && (snapshot.gapBefore || snapshot.chainId !== previous.chainId || snapshot.market !== previous.market
    || snapshot.tickSize !== previous.tickSize || snapshot.minSizeMon !== previous.minSizeMon || snapshot.makerFeeBps !== previous.makerFeeBps)) {
    segments.push(segment);
    segment = [];
  }
  segment.push(snapshot);
}
if (segment.length) segments.push(segment);
const verifiedSegments = segments.filter((rows) => rows.every((row) => row.chainId === 143 && Boolean(row.market)));
const modeIndex = args.indexOf("--trade-window");
const windowMode = modeIndex < 0 ? "latest" : args[modeIndex + 1];
if (windowMode !== "longest" && windowMode !== "latest") throw new Error("--trade-window must be longest or latest.");
const minimumWindowSeconds = numericOption("--minimum-window-seconds", 0);
if (minimumWindowSeconds < 0) throw new Error("--minimum-window-seconds must be nonnegative.");
const selected = selectTradeReplayWindow(tape.coverage, verifiedSegments, windowMode, minimumWindowSeconds * 1_000);
if (!selected) throw new Error("No uninterrupted verified-chain trade/L2 overlap was found.");
const start = selected.snapshots[0]!.timestamp;
const end = selected.snapshots.at(-1)!.timestamp;
const trades = tape.events.filter((event) => event.timestamp > start && event.timestamp <= end);
const ignored = tape.ignored.filter((event) => event.timestamp > start && event.timestamp <= end).length;
assertReceiptVerifiedReplay(trades, ignored, selected.snapshots[0]!.chainId, selected.snapshots[0]!.market);
const capturedMinimumOrderSize = selected.snapshots[0]!.minSizeMon;
if (capturedMinimumOrderSize === undefined && !args.includes("--minimum-order-size-mon")) {
  throw new Error("This capture does not record Kuru's minimum order size; pass --minimum-order-size-mon from a verified market-parameter read.");
}
const minimumOrderSizeMon = numericOption("--minimum-order-size-mon", capturedMinimumOrderSize ?? 0);
const orderSizeMon = numericOption("--order-size-mon", defaultReplayWalkForwardOptions.replay.orderSizeMon);
if (orderSizeMon < minimumOrderSizeMon) {
  throw new Error(`--order-size-mon (${orderSizeMon}) is below the verified market minimum (${minimumOrderSizeMon}); supply executable order and account assumptions.`);
}

const spreadsIndex = args.indexOf("--spreads-bps");
const spreadsValue = spreadsIndex < 0 ? undefined : args[spreadsIndex + 1];
if (spreadsIndex >= 0 && !spreadsValue) throw new Error("--spreads-bps requires a comma-separated list.");
const spreadsBps = spreadsValue === undefined ? defaultReplayWalkForwardOptions.spreadsBps : spreadsValue.split(",").map(Number);
if (spreadsBps.some((value) => !Number.isFinite(value))) throw new Error("--spreads-bps must be a comma-separated list of finite numbers.");
const result = replayWalkForward(selected.snapshots, trades, {
  ...defaultReplayWalkForwardOptions,
  trainFraction: numericOption("--train-fraction", defaultReplayWalkForwardOptions.trainFraction),
  purgeMs: numericOption("--purge-ms", defaultReplayWalkForwardOptions.purgeMs),
  minimumTrainingFills: numericOption("--minimum-training-fills", defaultReplayWalkForwardOptions.minimumTrainingFills),
  benchmarkSpreadBps: numericOption("--benchmark-spread-bps", defaultReplayWalkForwardOptions.benchmarkSpreadBps),
  spreadsBps,
  replay: {
    ...defaultReplayWalkForwardOptions.replay,
    startingCash: numericOption("--starting-cash-usd", defaultReplayWalkForwardOptions.replay.startingCash),
    startingMon: numericOption("--starting-mon", defaultReplayWalkForwardOptions.replay.startingMon),
    orderSizeMon,
    minimumOrderSizeMon,
    positionCapMon: numericOption("--position-cap-mon", defaultReplayWalkForwardOptions.replay.positionCapMon),
    gasUsdPerUpdate: numericOption("--gas-usd-per-update", defaultReplayWalkForwardOptions.replay.gasUsdPerUpdate),
    quoteActivationDelayMs: numericOption("--order-latency-ms", defaultReplayWalkForwardOptions.replay.quoteActivationDelayMs ?? 0),
  },
});
console.log(JSON.stringify({ executionTimingModel: "ATOMIC_DELAYED_TWO_SIDED_UPDATE_PROXY", costNote: "Every submitted update retains its fixed gas scenario cost, including reverted or pending-at-end attempts. Training and holdout reset account, active quotes, and pending updates; no end-window liquidation or cancellation is priced.", source: { chainId: selected.snapshots[0]!.chainId, market: selected.snapshots[0]!.market, tradeWindow: selected.window, receiptVerifiedEvents: trades.length }, ...result }, null, 2));
