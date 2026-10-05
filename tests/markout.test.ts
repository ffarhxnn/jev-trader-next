import { describe, expect, test } from "bun:test";
import { summarizeDecisionMarkouts } from "../src/markout";
import type { DepthSnapshot } from "../src/types";

const market = "0x065c9d28e428a0db40191a54d33d5b7c71a9c394";
const book = (timestamp: number, block: number, mid: number, extra: Partial<DepthSnapshot> = {}): DepthSnapshot => ({
  timestamp, block, chainId: 143, market, tickSize: 0.000001,
  bids: [[mid - 0.000001, 10]], asks: [[mid + 0.000001, 10]], ...extra,
});
const audit = (decisions: Record<string, unknown>[], mode = "paper") => [
  { kind: "session_start", mode, market },
  ...decisions.map((decision) => ({ kind: "decision", ...decision })),
].map((row) => JSON.stringify(row)).join("\n");

describe("decision markouts", () => {
  test("always-buy signals in a rising market have zero excess over the paired buy benchmark", () => {
    const result = summarizeDecisionMarkouts(audit([
      { timestamp: 1_100, bookReceivedAt: 1_000, block: 1, chainId: 143, mid: 100, action: "buy", buyProbability: 0.8 },
      { timestamp: 2_100, bookReceivedAt: 2_000, block: 2, chainId: 143, mid: 100, action: "buy" },
    ]), [book(1_000, 1, 100), book(2_000, 2, 100), book(6_000, 3, 101), book(7_000, 4, 102)]
      .map((snapshot) => JSON.stringify(snapshot)).join("\n"), { horizonsMs: [5_000], maxSnapshotSkewMs: 0 });
    const horizon = result.horizonResults[0]!;
    expect(horizon.fixedBenchmarks.alwaysBuy.observations).toBe(horizon.matched);
    expect(horizon.fixedBenchmarks.alwaysBuy.meanMarkoutBps).toBeCloseTo(150);
    expect(horizon.fixedBenchmarks.alwaysBuy.signalMinusBenchmarkMeanBps).toBe(0);
    expect(horizon.fixedBenchmarks.alwaysSell.positiveFraction).toBe(0);
    expect(horizon.chosenActionCalibration.observations).toBe(1);
    expect(horizon.chosenActionCalibration.neutralBrierScore).toBe(0.25);
    expect(horizon.chosenActionCalibration.brierScoreMinusNeutral).toBeCloseTo(-0.21);
  });

  test("paired fixed directions include flat observations in their denominators", () => {
    const decisions = ["buy", "sell", "buy", "sell"].map((action, i) => ({
      timestamp: 1_100 + i * 10_000, bookReceivedAt: 1_000 + i * 10_000, block: i * 2 + 1, chainId: 143, mid: 100, action, buyProbability: 0.8, sellProbability: 0.8,
    }));
    const snapshots = [101, 99, 100, 100].flatMap((mid, i) => [book(1_000 + i * 10_000, i * 2 + 1, 100), book(6_000 + i * 10_000, i * 2 + 2, mid)]);
    const horizon = summarizeDecisionMarkouts(audit(decisions), snapshots.map((snapshot) => JSON.stringify(snapshot)).join("\n"), { horizonsMs: [5_000], maxSnapshotSkewMs: 0 }).horizonResults[0]!;
    for (const benchmark of [horizon.fixedBenchmarks.alwaysBuy, horizon.fixedBenchmarks.alwaysSell]) {
      expect(benchmark.observations).toBe(4);
      expect(benchmark.flatObservations).toBe(2);
      expect(benchmark.meanMarkoutBps).toBeCloseTo(0);
      expect(benchmark.positiveFraction).toBe(0.25);
      expect(benchmark.signalMinusBenchmarkMeanBps).toBeCloseTo(50);
    }
    expect(horizon.chosenActionCalibration.brierScore).toBeCloseTo(0.34);
    expect(horizon.chosenActionCalibration.brierScoreMinusNeutral).toBeCloseTo(0.09);
  });

  test("fixed benchmarks exclude unmatched books and gap-censored horizons", () => {
    const result = summarizeDecisionMarkouts(audit([
      { timestamp: 1_100, bookReceivedAt: 1_000, block: 1, chainId: 143, mid: 100, action: "buy" },
      { timestamp: 11_100, bookReceivedAt: 11_000, block: 3, chainId: 143, mid: 100, action: "sell" },
      { timestamp: 11_100, bookReceivedAt: 11_000, block: 99, chainId: 143, mid: 90, action: "buy" },
    ]), [book(1_000, 1, 100), book(6_000, 2, 101), book(11_000, 3, 100), book(16_000, 4, 110, { gapBefore: true })]
      .map((snapshot) => JSON.stringify(snapshot)).join("\n"), { horizonsMs: [5_000, 15_000], maxSnapshotSkewMs: 0 });
    expect(result.horizonResults[0]!.missing).toBe(2);
    expect(result.horizonResults[0]!.fixedBenchmarks.alwaysBuy.observations).toBe(1);
    expect(result.horizonResults[0]!.fixedBenchmarks.alwaysBuy.meanMarkoutBps).toBeCloseTo(100);
    const empty = result.horizonResults[1]!;
    expect(empty.fixedBenchmarks.alwaysBuy.observations).toBe(empty.matched);
    expect(empty.fixedBenchmarks.alwaysBuy.meanMarkoutBps).toBeNull();
    expect(empty.fixedBenchmarks.alwaysSell.positiveFraction).toBeNull();
    expect(empty.chosenActionCalibration.neutralBrierScore).toBeNull();
    expect(empty.chosenActionCalibration.brierScoreMinusNeutral).toBeNull();
  });

  test("joins exact audited books and computes directional markouts without claiming P&L", () => {
    const result = summarizeDecisionMarkouts(audit([
      { timestamp: 1_100, bookReceivedAt: 1_000, block: 1, chainId: 143, mid: 100, action: "buy", buyProbability: 0.91, sellProbability: 0.09 },
      { timestamp: 2_100, bookReceivedAt: 2_000, block: 2, chainId: 143, mid: 100.1, action: "sell", buyProbability: 0.36, sellProbability: 0.64 },
    ]), [
      book(1_000, 1, 100), book(2_000, 2, 100.1), book(6_000, 3, 100.1),
      book(7_000, 4, 99.9), book(12_000, 5, 99.8),
    ].map((snapshot) => JSON.stringify(snapshot)).join("\n"), { horizonsMs: [5_000, 15_000], minimumDecisionCount: 1 });

    expect(result.audit.matchedBaselines).toBe(2);
    expect(result.horizonResults[0]!.matched).toBe(2);
    expect(result.horizonResults[0]!.meanDirectionalMarkoutBps).toBeGreaterThan(0);
    expect(result.horizonResults[0]!.byAction.buy.decisions).toBe(1);
    expect(result.horizonResults[0]!.byAction.buy.matched).toBe(1);
    expect(result.horizonResults[0]!.byAction.buy.meanDirectionalMarkoutBps).toBeGreaterThan(0);
    expect(result.horizonResults[0]!.byAction.sell.decisions).toBe(1);
    expect(result.horizonResults[0]!.byAction.sell.matched).toBe(1);
    expect(result.horizonResults[0]!.byAction.sell.meanDirectionalMarkoutBps).toBeGreaterThan(0);
    expect(result.horizonResults[0]!.byAction.sell.evidenceStatus).toBe("DESCRIPTIVE_ONLY");
    expect(result.horizonResults[0]!.byChosenActionProbability["high (>0.80)"].matched).toBe(1);
    expect(result.horizonResults[0]!.byChosenActionProbability["medium (0.60-0.80]"].matched).toBe(1);
    expect(result.horizonResults[0]!.chosenActionCalibration.observations).toBe(2);
    expect(result.horizonResults[0]!.chosenActionCalibration.meanChosenProbability).toBeCloseTo(0.775, 10);
    expect(result.horizonResults[0]!.chosenActionCalibration.observedPositiveFraction).toBe(1);
    expect(result.horizonResults[0]!.chosenActionCalibration.brierScore).toBeCloseTo(0.06885, 10);
    expect(result.horizonResults[0]!.chosenActionCalibration.calibrationGap).toBeCloseTo(-0.225, 10);
    expect(result.horizonResults[0]!.temporalUncertainty.timeBlocks).toBe(1);
    expect(result.horizonResults[0]!.temporalUncertainty.confidenceIntervals).toBeNull();
    expect(result.horizonResults[0]!.byChosenActionProbability["unavailable"].decisions).toBe(0);
    expect(result.horizonResults[0]!.evidenceStatus).toBe("DESCRIPTIVE_ONLY");
    expect(result.horizonResults[1]!.matched).toBe(0);
    expect(result.evidenceStatus).toBe("DESCRIPTIVE_MARKOUT_ONLY");
    expect(result.interpretation).toContain("not a fill model");
  });

  test("censors markouts across an explicit capture gap", () => {
    const result = summarizeDecisionMarkouts(audit([
      { timestamp: 1_100, bookReceivedAt: 1_000, block: 1, chainId: 143, mid: 100, action: "buy" },
    ]), [
      book(1_000, 1, 100), book(6_000, 2, 100.2, { gapBefore: true }),
    ].map((snapshot) => JSON.stringify(snapshot)).join("\n"), { horizonsMs: [5_000], minimumDecisionCount: 1 });
    expect(result.capture.segments).toBe(2);
    expect(result.horizonResults[0]!.matched).toBe(0);
    expect(result.horizonResults[0]!.missing).toBe(1);
  });

  test("uses a same-midpoint snapshot before book receipt when the recorder missed the exact block", () => {
    const result = summarizeDecisionMarkouts(audit([
      { timestamp: 1_100, bookReceivedAt: 1_000, block: 2, chainId: 143, mid: 100, action: "buy" },
    ]), [book(900, 1, 100), book(6_000, 3, 100.1)].map((snapshot) => JSON.stringify(snapshot)).join("\n"), { horizonsMs: [5_000], minimumDecisionCount: 1 });
    expect(result.audit.matchedBaselines).toBe(1);
    expect(result.audit.exactBlockBaselines).toBe(0);
    expect(result.audit.timestampMatchedBaselines).toBe(1);
    expect(result.horizonResults[0]!.matched).toBe(1);
  });

  test("requires matching verified chain, market, block and midpoint", () => {
    const result = summarizeDecisionMarkouts(audit([
      { timestamp: 1_100, bookReceivedAt: 1_000, block: 1, chainId: 143, mid: 100, action: "buy" },
    ]), [book(1_000, 1, 100, { chainId: 10143 })].map((snapshot) => JSON.stringify(snapshot)).join("\n"), { horizonsMs: [5_000] });
    expect(result.audit.unmatchedBaselines).toBe(1);
    expect(result.capture.verifiedSnapshots).toBe(0);
    expect(result.evidenceStatus).toBe("INSUFFICIENT_SAMPLE");
  });

  test("rejects demo audit logs", () => {
    expect(() => summarizeDecisionMarkouts(audit([], "demo"), "", { horizonsMs: [5_000] })).toThrow("actual paper-session");
  });

  test("keeps absent or invalid chosen-side probabilities in the unavailable bucket", () => {
    const result = summarizeDecisionMarkouts(audit([
      { timestamp: 1_100, bookReceivedAt: 1_000, block: 1, chainId: 143, mid: 100, action: "buy", buyProbability: 1.1 },
    ]), [book(1_000, 1, 100), book(6_000, 2, 100.1)].map((snapshot) => JSON.stringify(snapshot)).join("\n"), { horizonsMs: [5_000] });
    const unavailable = result.horizonResults[0]!.byChosenActionProbability.unavailable;
    expect(unavailable.decisions).toBe(1);
    expect(unavailable.matched).toBe(1);
    expect(unavailable.calibration.observations).toBe(0);
    expect(result.horizonResults[0]!.chosenActionCalibration.observations).toBe(0);
    expect(unavailable.evidenceStatus).toBe("INSUFFICIENT_SAMPLE");
    expect(result.interpretation).toContain("sample-limited estimates");
  });

  test("resamples contiguous time blocks and suppresses intervals with too few blocks", () => {
    const decisions: Record<string, unknown>[] = [];
    const snapshots: DepthSnapshot[] = [];
    const start = 1_000_000;
    for (let i = 0; i < 12; i++) {
      const timestamp = start + i * 60_000;
      decisions.push({ timestamp: timestamp + 100, bookReceivedAt: timestamp, block: i * 2 + 1, chainId: 143, mid: 100, action: "buy", buyProbability: 0.8, sellProbability: 0.2 });
      snapshots.push(book(timestamp, i * 2 + 1, 100), book(timestamp + 5_000, i * 2 + 2, i % 2 === 0 ? 100.1 : 99.9));
    }
    const auditText = audit(decisions);
    const depthText = snapshots.map((snapshot) => JSON.stringify(snapshot)).join("\n");
    const options = { horizonsMs: [5_000], dependenceBlockMs: 5_000, bootstrapReplicates: 200 };
    const result = summarizeDecisionMarkouts(auditText, depthText, options);
    const repeated = summarizeDecisionMarkouts(auditText, depthText, options);
    const uncertainty = result.horizonResults[0]!.temporalUncertainty;
    const interval = uncertainty.confidenceIntervals!.positiveFraction95!;
    expect(uncertainty.timeBlocks).toBe(12);
    expect(uncertainty.replicates).toBe(200);
    expect(interval.lower).toBeLessThanOrEqual(0.5);
    expect(interval.upper).toBeGreaterThanOrEqual(0.5);
    expect(repeated.horizonResults[0]!.temporalUncertainty).toEqual(uncertainty);
    expect(result.horizonResults[0]!.byChosenActionProbability["medium (0.60-0.80]"].temporalUncertainty.confidenceIntervals).not.toBeNull();
  });
});
