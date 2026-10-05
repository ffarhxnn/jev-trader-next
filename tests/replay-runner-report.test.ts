import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const project = resolve(dirname(import.meta.path), "..");
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "jev-replay-report-"));
  directories.push(directory);
  const market = `0x${"1".repeat(40)}`;
  const depth = join(directory, "synthetic-depth.jsonl");
  const tape = join(directory, "synthetic-tape.jsonl");
  writeFileSync(depth, Array.from({ length: 20 }, (_, i) => JSON.stringify({ timestamp: (i + 1) * 1_000,
    block: (i + 1) * 100, chainId: 143, market, tickSize: 0.01, minSizeMon: 1, makerFeeBps: 0,
    bids: [[99, 1]], asks: [[101, 1]] })).join("\n"), { mode: 0o600 });
  writeFileSync(tape, [JSON.stringify({ kind: "status", status: "connected", timestamp: 1_000 }),
    JSON.stringify({ kind: "trade", timestamp: 2_500, price: 99, size: 11, takerSide: "sell",
      transactionHash: `0x${"a".repeat(64)}`, receiptVerified: true, receiptBlock: 250,
      receiptLogIndex: 0, receiptChainId: 143, receiptMarket: market })].join("\n"), { mode: 0o600 });
  return { depth, tape };
}
function run(script: string, args: string[]) {
  // Disable Bun's automatic environment-file loading; fixtures require no key,
  // RPC, model provider, or running dashboard process.
  const child = Bun.spawnSync([process.execPath, "--no-env-file", join(project, "scripts", script), ...args], { cwd: project });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  expect(child.exitCode).toBe(0);
  return JSON.parse(child.stdout.toString());
}

test("backtest runner surfaces atomic timing, attempted costs, and diagnostics in its JSON report", () => {
  const f = fixture();
  const result = run("backtest.ts", [f.depth, "--trade-tape", f.tape, "--require-verified-receipts", "--order-latency-ms", "500",
    "--cash", "10000", "--order-size", "10", "--position-cap", "30", "--base-half-spread-bps", "0", "--volatility-multiplier", "0"]);
  expect(result.executionTimingModel).toBe("ATOMIC_DELAYED_TWO_SIDED_UPDATE_PROXY");
  expect(result.assumptions.replacementRule).toContain("changed old quotes remain executable");
  expect(result.assumptions.executionScope).toContain("root execution submits one placement");
  expect(result.assumptionSources.quoteActivationDelayMs).toContain("not measured transaction inclusion");
  expect(result.costNote).toContain("including reverts and pending-at-end");
  expect(typeof result.quoteUpdatesApplied).toBe("number");
  expect(typeof result.replacementBoundaryBlockedEvents).toBe("number");
});

test("walk-forward runner preserves timing assumptions and diagnostics in each split's replay", () => {
  const f = fixture();
  const result = run("walk-forward-replay.ts", [f.depth, f.tape, "--order-latency-ms", "500", "--train-fraction", "0.5", "--purge-ms", "1",
    "--starting-cash-usd", "10000", "--order-size-mon", "10", "--position-cap-mon", "30", "--spreads-bps", "0", "--minimum-training-fills", "1"]);
  expect(result.executionTimingModel).toBe("ATOMIC_DELAYED_TWO_SIDED_UPDATE_PROXY");
  expect(result.costNote).toContain("pending updates");
  const training = result.trainingSweep[0].result;
  expect(training.assumptions.quoteActivationDelayMs).toBe(500);
  expect(training.assumptions.replacementRule).toContain("one frozen pending atomic update");
  expect(typeof training.pendingQuoteUpdateAtEnd).toBe("boolean");
  expect(result.holdout?.selected.assumptions.executionScope).toContain("hypothetical two-sided");
  expect(typeof result.holdout?.selected.quoteUpdatesReverted).toBe("number");
});
