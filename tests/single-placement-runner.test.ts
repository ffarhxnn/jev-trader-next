import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { KURU_MAINNET_MON_USDC_MARKET } from "../src/kuru-mainnet-readiness";

const project = resolve(dirname(import.meta.path), "..");
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(legacy = false, finalized = true) {
  const directory = mkdtempSync(join(tmpdir(), "jev-single-placement-cli-"));
  directories.push(directory);
  const snapshots = Array.from({ length: 20 }, (_, i) => ({ timestamp: (i + 1) * 1000, block: (i + 1) * 100,
    chainId: 143, market: KURU_MAINNET_MON_USDC_MARKET, tickSize: 0.000001, sizePrecision: 1e10,
    minSizeMon: 200, makerFeeBps: 0, takerFeeBps: 0, captureIntervalMs: 1000, bids: [[0.03, 42]], asks: [[0.030002, 71]] }));
  const depth = join(directory, "synthetic-depth.jsonl"), tape = join(directory, "synthetic-trades.jsonl"), audit = join(directory, "synthetic-audit.jsonl");
  writeFileSync(depth, snapshots.map(row => JSON.stringify(row)).join("\n"), { mode: 0o600 });
  writeFileSync(tape, [JSON.stringify({ kind: "status", status: "connected", timestamp: 1000 }),
    JSON.stringify({ kind: "trade", timestamp: 3500, price: 0.030001, size: 50, takerSide: "sell",
      rawPrice: "30001000000000000", rawSize: "500000000000", transactionHash: `0x${"a".repeat(64)}`,
      receiptVerified: true, ...(finalized ? { receiptFinalizedVerified: true } : {}), receiptBlock: 350, receiptLogIndex: 0, receiptChainId: 143, receiptMarket: KURU_MAINNET_MON_USDC_MARKET }),
    JSON.stringify({ kind: "gap", timestamp: 20001, reason: "fixture end" })].join("\n"), { mode: 0o600 });
  writeFileSync(audit, [...snapshots.map(inputSnapshot => ({ kind: "book_observed", timestamp: inputSnapshot.timestamp,
    observedAt: inputSnapshot.timestamp, publishedAt: inputSnapshot.timestamp + 50, inputSnapshot })), { kind: "decision", timestamp: 1100, bookReceivedAt: 1000,
    block: 100, chainId: 143, bestBid: 0.03, bestAsk: 0.030002, mid: (0.03 + 0.030002) / 2, spreadBps: 0.666644,
    action: "buy", model: "test stand-in", decisionSource: "local demo heuristic", ...(legacy ? {} : { inputSnapshot: snapshots[0] }) }].map(row => JSON.stringify(row)).join("\n"), { mode: 0o600 });
  return [depth, tape, audit];
}
function run(paths: string[], extra: string[]) {
  return Bun.spawnSync([process.execPath, "--no-env-file", join(project, "scripts/single-placement-replay.ts"), ...paths,
    "--start-iso", "1970-01-01T00:00:01Z", "--end-iso", "1970-01-01T00:00:20Z", ...extra], { cwd: project });
}
const scenarios = ["--order-latency-ms", "500", "--receipt-confirmation-delay-ms", "1000", "--gas-usd-per-update", "0.01", "--minimum-window-seconds", "0"];

test("single-placement runner preserves receipt waits, exact input lineage, costs, and insufficient-sample status", () => {
  const child = run(fixture(), scenarios);
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  const result = JSON.parse(child.stdout.toString());
  expect(result.executionTimingModel).toBe("SINGLE_PLACEMENT_DELAYED_RECEIPT_PROXY");
  expect(result.validationStatus).toBe("INSUFFICIENT_SAMPLE");
  expect(result.realMoneyReady).toBe(false);
  expect(result.holdoutScored).toBe(false);
  expect(result.counts.fills).toBe(1);
  expect(result.endingMon).toBe(50);
  expect(result.gasCostsUsd).toBe(0.01);
  expect(result.assumptions.receiptConfirmationDelayMs).toBe(1000);
  expect(result.source.decisions).toBe(1);
  expect(result.source.inputSnapshotsAdded).toBe(0);
  expect(result.inputFiles).toHaveLength(3);
  expect(result.inputFiles.every((f: { sha256: string }) => /^[\da-f]{64}$/.test(f.sha256))).toBe(true);
  expect(result.decisionEvidence).toContain("model is not rerun");
  expect(result.decisionEvidence).toContain("Strict lineage");
  expect(result.costNote).toContain("not observed transaction timing");
  const short = run(fixture(), scenarios.slice(0, 6));
  expect(short.exitCode).toBe(0);
  expect(JSON.parse(short.stdout.toString()).validationStatus).toBe("INSUFFICIENT_CAPTURE_DURATION");
});

test("runner always requires same-audit observed lineage and rejects supplied-depth omissions", () => {
  const legacy = fixture();
  writeFileSync(legacy[2]!, readFileSync(legacy[2]!, "utf8").split("\n").filter(line => JSON.parse(line).kind === "decision").join("\n"));
  const absent = run(legacy, scenarios);
  expect(absent.exitCode).not.toBe(0);
  expect(absent.stderr.toString()).toContain("Missing observed-book timeline");
  const missing = fixture();
  const lines = readFileSync(missing[0]!, "utf8").split("\n"); lines.splice(1, 1);
  writeFileSync(missing[0]!, lines.join("\n"));
  const omitted = run(missing, scenarios);
  expect(omitted.exitCode).not.toBe(0);
  expect(omitted.stderr.toString()).toContain("exactly match every observed book");
});

test("single-placement runner refuses legacy inferred inputs, implicit timing, and duplicate flags", () => {
  const old = run(fixture(true), scenarios);
  expect(old.exitCode).not.toBe(0);
  expect(old.stderr.toString()).toContain("no complete recorded input snapshot");
  const missing = run(fixture(), []);
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr.toString()).toContain("explicit scenario assumption");
  const duplicate = run(fixture(), [...scenarios, "--order-latency-ms", "0"]);
  expect(duplicate.exitCode).not.toBe(0);
  expect(duplicate.stderr.toString()).toContain("duplicate");
  const provisional = run(fixture(false, false), scenarios);
  expect(provisional.exitCode).not.toBe(0);
  expect(provisional.stderr.toString()).toContain("finalized canonical transaction-index evidence");
});
