import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { KuruBookReader } from "../src/book";
import { hasL2CaptureGap } from "../src/capture";
import { config } from "../src/config";
import { KuruTradeFeed } from "../src/trade-feed";

const SAFE_ERROR_KINDS = new Set(["Error", "TypeError", "SyntaxError", "CALL_EXCEPTION", "SERVER_ERROR", "NETWORK_ERROR", "TIMEOUT", "UNKNOWN_ERROR", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"]);

function numberArg(args: string[], name: string, fallback: number) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} requires a positive number.`);
  return value;
}

function safeErrorKind(error: unknown) {
  const value = error as { code?: unknown; name?: unknown };
  const candidate = typeof value?.code === "string" ? value.code : value?.name;
  return typeof candidate === "string" && SAFE_ERROR_KINDS.has(candidate) ? candidate : "Error";
}

const args = Bun.argv.slice(2);
const intervalMs = numberArg(args, "--interval-ms", 1_000);
const durationMinutes = args.includes("--minutes") ? numberArg(args, "--minutes", 0) : 0;
const outputArg = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
if (args.includes("--out") && !outputArg) throw new Error("--out requires a file path.");
const now = new Date();
const defaultName = `kuru-l2-${now.toISOString().slice(0, 10)}.jsonl`;
const output = resolve(outputArg ?? `data/${defaultName}`);
const tradesArg = args.includes("--trades-out") ? args[args.indexOf("--trades-out") + 1] : undefined;
if (args.includes("--trades-out") && !tradesArg) throw new Error("--trades-out requires a file path.");
const tradesOutput = resolve(tradesArg ?? output.replace(/\.jsonl$/i, "-trades.jsonl"));
mkdirSync(dirname(output), { recursive: true });
mkdirSync(dirname(tradesOutput), { recursive: true });

const reader = new KuruBookReader();
const stopAt = durationMinutes ? Date.now() + durationMinutes * 60_000 : Infinity;
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
console.log(`Recording read-only Kuru L2 snapshots to ${output}. Press Ctrl-C to stop.`);
console.log(`Recording public Kuru trade prints to ${tradesOutput}. No wallet or signing key is used.`);

const appendTradeRecord = (record: Record<string, unknown>) => appendFileSync(tradesOutput, `${JSON.stringify(record)}\n`, { mode: 0o600 });
const tradeFeed = new KuruTradeFeed(
  reader,
  (trade) => appendTradeRecord({ kind: "trade", ...trade }),
  (healthy) => {
    appendTradeRecord(healthy
      ? { kind: "status", status: "connected", timestamp: Date.now() }
      : { kind: "gap", timestamp: Date.now(), reason: "Kuru WebSocket disconnected or became silent" });
    if (healthy) console.log("Kuru trade feed connected.");
  },
  (evidence) => appendTradeRecord({ kind: "ignored", ...(evidence ?? { timestamp: Date.now(), reason: "unparseable public Kuru trade" }) }),
);
tradeFeed.start();

let recorded = 0;
let rpcFailures = 0;
let gapBefore = existsSync(output) && statSync(output).size > 0;
let lastSnapshotTimestamp: number | null = null;
let retryDelayMs = intervalMs;
while (!stopping && Date.now() < stopAt) {
  const started = Date.now();
  try {
    const snapshot = await reader.readDepth();
    snapshot.captureIntervalMs = intervalMs;
    if (hasL2CaptureGap(lastSnapshotTimestamp, snapshot.timestamp, intervalMs)) {
      gapBefore = true;
      console.warn(`L2 capture gap detected before block ${snapshot.block}; marking this snapshot as a new segment.`);
    }
    if (gapBefore) snapshot.gapBefore = true;
    appendFileSync(output, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    gapBefore = false;
    lastSnapshotTimestamp = snapshot.timestamp;
    rpcFailures = 0;
    retryDelayMs = intervalMs;
    recorded++;
    if (recorded === 1 || recorded % 60 === 0) console.log(`Recorded ${recorded} snapshots; block ${snapshot.block}.`);
  } catch (error) {
    gapBefore = true;
    rpcFailures++;
    retryDelayMs = Math.min(60_000, intervalMs * 2 ** Math.min(rpcFailures, 6));
    console.error(`Snapshot ${recorded + 1} failed (${safeErrorKind(error)}); retrying in ${retryDelayMs} ms.`);
  }
  const remaining = retryDelayMs - (Date.now() - started);
  if (remaining > 0) await Bun.sleep(Math.min(remaining, 60_000));
}
stopping = true;
console.log(`Stopped after ${recorded} snapshots. Output: ${output}`);
tradeFeed.close();
