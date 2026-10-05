import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseDepthJsonl, selectDepthReplayRange } from "../src/research";
import { KURU_MAINNET_MON_USDC_MARKET } from "../src/kuru-mainnet-readiness";

const args = Bun.argv.slice(2);
if (args.includes("--help") || args.length < 1) {
  console.log("Usage: bun scripts/slice-depth-window.ts <l2-snapshots.jsonl> --start-iso <UTC ISO> --end-iso <UTC ISO> [--minimum-window-seconds 600] [--out data/depth-window.jsonl]");
  process.exit(args.includes("--help") ? 0 : 2);
}

function option(name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function parseUtcIso(name: string): number {
  const value = option(name);
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`${name} must be an ISO timestamp with an explicit UTC offset.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} is not a valid timestamp.`);
  return timestamp;
}

const inputPath = resolve(args[0]!);
const startTimestamp = parseUtcIso("--start-iso");
const endTimestamp = parseUtcIso("--end-iso");
const minimumSeconds = Number(option("--minimum-window-seconds", "600"));
if (!Number.isFinite(minimumSeconds) || minimumSeconds < 0) throw new Error("--minimum-window-seconds must be finite and nonnegative.");
const outPath = resolve(option("--out", "data/depth-window.jsonl")!);
const allSnapshots = parseDepthJsonl(readFileSync(inputPath, "utf8"));
const selected = selectDepthReplayRange(allSnapshots, startTimestamp, endTimestamp, minimumSeconds * 1_000);
if (!selected) throw new Error("No single continuous verified L2 segment meets the requested UTC range and minimum duration.");
if (selected.snapshots.some((row) => row.chainId !== 143 || row.market?.toLowerCase() !== KURU_MAINNET_MON_USDC_MARKET.toLowerCase())) {
  throw new Error("Depth-only replay slicing requires continuous verified Monad mainnet data from the pinned Kuru MON-USDC market.");
}

mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
writeFileSync(outPath, `${selected.snapshots.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
chmodSync(outPath, 0o600);
console.log(JSON.stringify({
  evidenceStatus: "CONTINUOUS_L2_SLICE_REQUIRES_CHAIN_TRADE_RECONSTRUCTION",
  chainId: selected.snapshots[0]!.chainId,
  market: selected.snapshots[0]!.market,
  window: {
    start: new Date(selected.window.startTimestamp).toISOString(),
    end: new Date(selected.window.endTimestamp - 1).toISOString(),
    durationSeconds: (selected.window.endTimestamp - 1 - selected.window.startTimestamp) / 1_000,
  },
  snapshots: selected.snapshots.length,
  fromBlock: selected.snapshots[0]!.block,
  toBlock: selected.snapshots.at(-1)!.block,
  outputPath: outPath,
  nextRequiredStep: "Run reconstruct-receipt-trades.ts on this depth file; do not replay from WebSocket events or treat this slice alone as trade evidence.",
}, null, 2));
