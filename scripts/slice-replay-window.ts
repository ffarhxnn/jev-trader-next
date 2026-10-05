import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDepthJsonl, parseTradeJsonl, selectDepthReplayRange, selectTradeFeedRowsForRange, selectTradeReplayRange, selectTradeReplayWindow } from "../src/research";

const args = Bun.argv.slice(2);
const paths = args.slice(0, 2);
if (args.includes("--help") || paths.length !== 2) {
  console.log("Usage: bun scripts/slice-replay-window.ts <l2-snapshots.jsonl> <trade-feed.jsonl> [--trade-window latest|longest | --start-iso <UTC ISO> --end-iso <UTC ISO>] [--minimum-window-seconds 600] [--out-prefix data/replay-window]");
  process.exit(args.includes("--help") ? 0 : 2);
}

function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

const minimumWindowSeconds = Number(option("--minimum-window-seconds", "0"));
if (!Number.isFinite(minimumWindowSeconds) || minimumWindowSeconds < 0) throw new Error("--minimum-window-seconds must be finite and nonnegative.");
const mode = option("--trade-window", "latest");
if (mode !== "latest" && mode !== "longest") throw new Error("--trade-window must be latest or longest.");
const hasStart = args.includes("--start-iso"), hasEnd = args.includes("--end-iso");
if (hasStart !== hasEnd) throw new Error("--start-iso and --end-iso must be provided together.");
if (hasStart && args.includes("--trade-window")) throw new Error("Use either --trade-window or explicit UTC bounds, not both.");
function parseUtcIso(name: string): number {
  const value = option(name, "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`${name} must be an ISO timestamp with an explicit UTC offset.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} is not a valid timestamp.`);
  return timestamp;
}
const requestedStartTimestamp = hasStart ? parseUtcIso("--start-iso") : undefined;
const requestedEndTimestamp = hasEnd ? parseUtcIso("--end-iso") : undefined;
const outputPrefix = resolve(option("--out-prefix", `data/replay-window-${new Date().toISOString().replace(/[:.]/g, "-")}`));

const depthText = readFileSync(resolve(paths[0]!), "utf8");
const tradeText = readFileSync(resolve(paths[1]!), "utf8");
const depth = parseDepthJsonl(depthText);
const tape = parseTradeJsonl(tradeText);
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
const selected = requestedStartTimestamp !== undefined && requestedEndTimestamp !== undefined
  ? selectTradeReplayRange(tape.coverage, verifiedSegments, requestedStartTimestamp, requestedEndTimestamp, minimumWindowSeconds * 1_000)
  : selectTradeReplayWindow(tape.coverage, verifiedSegments, mode, minimumWindowSeconds * 1_000);
if (!selected) throw new Error(requestedStartTimestamp !== undefined
  ? "No single uninterrupted verified-chain trade/L2 overlap meets the requested UTC range and minimum duration."
  : "No uninterrupted verified-chain trade/L2 overlap meets the requested minimum duration.");

const continuousDepth = selectDepthReplayRange(
  depth,
  selected.window.startTimestamp,
  selected.window.endTimestamp - 1,
  minimumWindowSeconds * 1_000,
);
if (!continuousDepth) throw new Error("Selected replay interval contains an unmarked L2 snapshot gap or market-metadata change; no replay was written.");

const coverage = tape.coverage.find((window) => window.startTimestamp <= selected.window.startTimestamp
  && window.endTimestamp >= selected.window.endTimestamp - 1);
if (!coverage) throw new Error("Selected L2 interval has no corresponding trade-feed connection window.");
const endTimestamp = selected.window.endTimestamp - 1;
const tradeRows = requestedStartTimestamp !== undefined
  ? selectTradeFeedRowsForRange(tradeText, coverage, selected.window)
  : tradeText.split(/\r?\n/).filter((line) => line.trim()).filter((line) => {
    const row = JSON.parse(line) as { timestamp?: unknown };
    return typeof row.timestamp === "number" && row.timestamp >= coverage.startTimestamp && row.timestamp <= endTimestamp;
  });
if (!tradeRows.length) throw new Error("Selected trade-feed connection window has no source rows.");

const depthPath = `${outputPrefix}-depth.jsonl`;
const tradePath = `${outputPrefix}-feed-trades.jsonl`;
writeFileSync(depthPath, `${continuousDepth.snapshots.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
writeFileSync(tradePath, `${tradeRows.join("\n")}\n`, { mode: 0o600 });
chmodSync(depthPath, 0o600);
chmodSync(tradePath, 0o600);

const selectedEvents = tape.events.filter((event) => event.timestamp >= selected.window.startTimestamp && event.timestamp <= endTimestamp);
const selectedIgnored = tape.ignored.filter((event) => event.timestamp >= selected.window.startTimestamp && event.timestamp <= endTimestamp);
console.log(JSON.stringify({
  source: { chainId: selected.snapshots[0]!.chainId, market: selected.snapshots[0]!.market, tradeWindow: requestedStartTimestamp !== undefined ? "timestamp-range" : mode },
  window: { start: new Date(selected.window.startTimestamp).toISOString(), end: new Date(endTimestamp).toISOString(), durationSeconds: (endTimestamp - selected.window.startTimestamp) / 1_000 },
  snapshots: continuousDepth.snapshots.length,
  tradeEvents: selectedEvents.length,
  ignoredFeedEvents: selectedIgnored.length,
  ignoredWithoutTransactionHash: selectedIgnored.filter((event) => !event.transactionHash).length,
  sourceRows: tradeRows.length,
  depthPath,
  tradePath,
  interpretation: "Derived owner-only slice of the selected continuous public-data window. Receipt verification is a separate required step before strict replay.",
}, null, 2));
