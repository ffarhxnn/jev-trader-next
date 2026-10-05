import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseDepthJsonl, parseTradeJsonl, assertReceiptVerifiedReplay } from "../src/research";
import { prepareSinglePlacementAudit } from "../src/single-placement-audit";
import { replaySinglePlacement, type SinglePlacementReplayOptions } from "../src/single-placement-replay";
import { KURU_MAINNET_MON_USDC_MARKET } from "../src/kuru-mainnet-readiness";

const args = Bun.argv.slice(2);
if (args.includes("--help") || args.length < 3) {
  console.log("Usage: bun --no-env-file scripts/single-placement-replay.ts <l2.jsonl> <receipt-trades.jsonl> <paper-audit.jsonl> --start-iso <UTC ISO> --end-iso <UTC ISO> --order-latency-ms N --receipt-confirmation-delay-ms N --gas-usd-per-update N [--starting-cash-usd 100] [--starting-mon 0] [--order-size-mon 200] [--position-cap-mon 1000] [--max-loss-usd 20] [--inside-ticks 1] [--max-spread-bps 50] [--minimum-fills 20] [--minimum-window-seconds 600]");
  process.exit(args.includes("--help") ? 0 : 2);
}
const flags = new Set(["--start-iso", "--end-iso", "--order-latency-ms", "--receipt-confirmation-delay-ms", "--gas-usd-per-update",
  "--starting-cash-usd", "--starting-mon", "--order-size-mon", "--position-cap-mon", "--max-loss-usd", "--inside-ticks", "--max-spread-bps", "--minimum-fills", "--minimum-window-seconds"]);
const options = new Map<string, string>();
for (let i = 3; i < args.length; i += 2) {
  const flag = args[i]!, value = args[i + 1];
  if (!flags.has(flag) || options.has(flag) || !value || value.startsWith("--")) throw new Error("Unknown, duplicate, or incomplete single-placement replay option.");
  options.set(flag, value);
}
const numeric = (flag: string, fallback?: number) => {
  if (!options.has(flag) && fallback === undefined) throw new Error(`${flag} requires an explicit scenario assumption.`);
  const value = options.has(flag) ? Number(options.get(flag)) : fallback!;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} requires a finite nonnegative number.`);
  return value;
};
const iso = (flag: string) => {
  const value = options.get(flag);
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error(`${flag} requires an ISO timestamp with an explicit timezone.`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${flag} requires a valid timestamp.`);
  return time;
};
const start = iso("--start-iso"), end = iso("--end-iso");
if (end <= start) throw new Error("Replay end must follow its start.");
const files = args.slice(0, 3).map(path => {
  if (!path.endsWith(".jsonl")) throw new Error("Replay inputs must be public-data JSONL files.");
  const contents = readFileSync(resolve(path), "utf8");
  return { name: basename(path), contents, sha256: createHash("sha256").update(contents).digest("hex"), sizeBytes: Buffer.byteLength(contents) };
});
const prepared = prepareSinglePlacementAudit(files[2]!.contents, parseDepthJsonl(files[0]!.contents), start, end, true);
const first = prepared.snapshots[0]!, last = prepared.snapshots.at(-1)!;
if (first.chainId !== 143 || first.market?.toLowerCase() !== KURU_MAINNET_MON_USDC_MARKET.toLowerCase()) {
  throw new Error("This runner requires the pinned Kuru MON-USDC market on Monad mainnet.");
}
const tape = parseTradeJsonl(files[1]!.contents);
if (!tape.coverage.some(span => span.startTimestamp <= first.timestamp && span.endTimestamp > last.timestamp)) {
  throw new Error("Receipt trade tape must cover the complete selected L2/decision interval without a gap.");
}
const trades = tape.events.filter(event => event.timestamp > first.timestamp && event.timestamp <= last.timestamp);
const ignored = tape.ignored.filter(event => event.timestamp > first.timestamp && event.timestamp <= last.timestamp).length;
assertReceiptVerifiedReplay(trades, ignored, first.chainId, first.market);
if (trades.some(trade => trade.receiptFinalizedVerified !== true)) throw new Error("Single-placement runner requires newly reconstructed finalized canonical transaction-index evidence.");
const assumptions: SinglePlacementReplayOptions = {
  startingCash: numeric("--starting-cash-usd", 100), startingMon: numeric("--starting-mon", 0),
  orderSizeMon: numeric("--order-size-mon", 200), positionCapMon: numeric("--position-cap-mon", 1000),
  minimumOrderSizeMon: first.minSizeMon!, feeBps: first.makerFeeBps!, tickSize: first.tickSize!,
  insideTicks: numeric("--inside-ticks", 1), maxSpreadBps: numeric("--max-spread-bps", 50), maxLossUsd: numeric("--max-loss-usd", 20),
  gasUsdPerUpdate: numeric("--gas-usd-per-update"), orderLatencyMs: numeric("--order-latency-ms"),
  receiptConfirmationDelayMs: numeric("--receipt-confirmation-delay-ms"),
};
const minimumFills = numeric("--minimum-fills", 20);
if (!Number.isSafeInteger(minimumFills) || minimumFills < 1) throw new Error("The minimum fill floor must be a positive integer.");
const result = replaySinglePlacement(prepared.snapshots, trades, prepared.decisions, assumptions);
const minimumWindowSeconds = numeric("--minimum-window-seconds", 600);
const durationSeconds = (last.timestamp - first.timestamp) / 1000;
console.log(JSON.stringify({
  executionTimingModel: "SINGLE_PLACEMENT_DELAYED_RECEIPT_PROXY",
  inputFiles: files.map(({ name, sha256, sizeBytes }) => ({ name, sha256, sizeBytes })),
  source: { chainId: first.chainId, market: first.market, firstTimestamp: first.timestamp, lastTimestamp: last.timestamp,
    snapshots: prepared.snapshots.length, receiptVerifiedTrades: trades.length, finalizedCanonicalTrades: trades.length, decisions: prepared.decisions.length,
    selectedDecisionRows: prepared.selectedDecisionRows, completionsCensoredAtEnd: prepared.completionsCensoredAtEnd,
    inputSnapshotsAdded: prepared.inputSnapshotsAdded },
  validationStatus: result.executionStopped ? "UNRESOLVED_EXECUTION_PROXY" : durationSeconds < minimumWindowSeconds ? "INSUFFICIENT_CAPTURE_DURATION" : result.counts.fills < minimumFills ? "INSUFFICIENT_SAMPLE" : "FILL_FLOOR_MET_RESEARCH_ONLY",
  durationSeconds, minimumWindowSeconds,
  minimumFillFloor: minimumFills, holdoutScored: false, realMoneyReady: false,
  decisionEvidence: prepared.interpretation,
  costNote: "USD cost per submitted placement or protective cancel is a fixed scenario, retained on revert, unresolved outcome, and pending at end. It is not measured wallet gas. There is no end-window liquidation/cancel cost or provider-cost model. Inclusion and receipt waits are explicit scenarios, not observed transaction timing.",
  ...result,
}, null, 2));
