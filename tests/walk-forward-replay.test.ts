import { describe, expect, test } from "bun:test";
import { defaultBacktestOptions } from "../src/research";
import { replayWalkForward } from "../src/walk-forward-replay";
import type { DepthSnapshot, TradeEvent } from "../src/types";

const market = `0x${"1".repeat(40)}`;
const books = (): DepthSnapshot[] => Array.from({ length: 40 }, (_, i) => ({
  timestamp: (i + 1) * 1_000, block: i + 1, chainId: 143, market, tickSize: 0.01, makerFeeBps: 0,
  bids: [[99.99, 100] as [number, number]], asks: [[100.01, 100] as [number, number]],
}));
const trade = (timestamp: number, side: "buy" | "sell", size = 110): TradeEvent => ({ timestamp, price: 99.99, size, takerSide: side });

describe("chronological queue-replay validation", () => {
  test("selects spread on training data, purges the boundary, and freezes it for the holdout", () => {
    const snapshots = books();
    const trainingFill = trade(2_000, "sell");
    const base = replayWalkForward(snapshots, [trainingFill], {
      trainFraction: 0.5, purgeMs: 2_000, spreadsBps: [0, 8], benchmarkSpreadBps: 8, minimumTrainingFills: 1,
      replay: { ...defaultBacktestOptions, startingCash: 10_000, orderSizeMon: 10, positionCapMon: 20,
        tickSize: 0.01, feeBps: 0, gasUsdPerUpdate: 0, baseHalfSpreadBps: 8, quoteRefreshMs: 1_000 },
    });
    expect(base.split).toMatchObject({
      train: { snapshots: 18, trades: 1 }, purged: { snapshots: 4 }, holdout: { snapshots: 18, trades: 0 },
    });
    expect(base.trainingSweep.find((row) => row.spreadBps === 0)?.result.fills).toBe(1);
    expect(base.trainingSweep.find((row) => row.spreadBps === 8)?.result.fills).toBe(0);
    expect(base.selectedSpreadBps).toBe(0);

    const alteredHoldout = snapshots.map((row, i) => i >= 22 ? { ...row, bids: [[99.8, 100] as [number, number]], asks: [[99.82, 100] as [number, number]] } : row);
    const rerun = replayWalkForward(alteredHoldout, [trainingFill, trade(24_000, "buy", 50)], {
      trainFraction: 0.5, purgeMs: 2_000, spreadsBps: [0, 8], benchmarkSpreadBps: 8, minimumTrainingFills: 1,
      replay: { ...defaultBacktestOptions, startingCash: 10_000, orderSizeMon: 10, positionCapMon: 20,
        tickSize: 0.01, feeBps: 0, gasUsdPerUpdate: 0, baseHalfSpreadBps: 8, quoteRefreshMs: 1_000 },
    });
    expect(rerun.selectedSpreadBps).toBe(base.selectedSpreadBps);
    expect(rerun.holdout?.resetAccountAtBoundary).toBe(true);
    expect(rerun.evidenceStatus).toBe("EXPLORATORY_CHRONOLOGICAL_HOLDOUT");
  });

  test("does not select or score a holdout when all training spreads miss the execution sample floor", () => {
    const result = replayWalkForward(books(), [trade(2_000, "sell")], {
      trainFraction: 0.5, purgeMs: 2_000, spreadsBps: [0, 8], benchmarkSpreadBps: 8, minimumTrainingFills: 2,
      replay: { ...defaultBacktestOptions, startingCash: 10_000, orderSizeMon: 10, positionCapMon: 20,
        tickSize: 0.01, feeBps: 0, gasUsdPerUpdate: 0, baseHalfSpreadBps: 8, quoteRefreshMs: 1_000 },
    });
    expect(result.trainingSweep.map((row) => row.result.fills)).toEqual([1, 0]);
    expect(result.evidenceStatus).toBe("INSUFFICIENT_TRAINING_FILLS");
    expect(result.selectedSpreadBps).toBeNull();
    expect(result.holdout).toBeNull();
  });

  test("uses the captured market minimum and can raise it for conservative replay", () => {
    const snapshots = books().map((row) => ({ ...row, minSizeMon: 200 }));
    const result = replayWalkForward(snapshots, [], {
      trainFraction: 0.5, purgeMs: 2_000, spreadsBps: [0], benchmarkSpreadBps: 8, minimumTrainingFills: 1,
      replay: { ...defaultBacktestOptions, startingCash: 20, startingMon: 600, orderSizeMon: 300, positionCapMon: 1_000,
        minimumOrderSizeMon: 250, tickSize: 0.01, feeBps: 0, gasUsdPerUpdate: 0, quoteRefreshMs: 1_000 },
    });
    expect(result.trainingSweep[0]?.result.assumptions).toMatchObject({ minimumOrderSizeMon: 250, orderSizeMon: 300 });
    expect(() => replayWalkForward(snapshots.map((row, i) => i ? { ...row, minSizeMon: 201 } : row), [], {
      trainFraction: 0.5, purgeMs: 2_000, spreadsBps: [0], benchmarkSpreadBps: 8, minimumTrainingFills: 1,
      replay: { ...defaultBacktestOptions, orderSizeMon: 200, positionCapMon: 1_000 },
    })).toThrow("stable chain");
  });

  test("rejects split boundaries, gaps, unstable market metadata, and invalid spread grids", () => {
    const snapshots = books();
    const options = { trainFraction: 0.5, purgeMs: 60_000, spreadsBps: [0, 8], benchmarkSpreadBps: 8, minimumTrainingFills: 1, replay: defaultBacktestOptions };
    expect(() => replayWalkForward(snapshots.slice(0, 5), [], options)).toThrow("six snapshots");
    expect(() => replayWalkForward(snapshots.map((row, i) => i === 4 ? { ...row, gapBefore: true } : row), [], options)).toThrow("uninterrupted");
    expect(() => replayWalkForward(snapshots.map((row, i) => i === 4 ? { ...row, market: `0x${"2".repeat(40)}` } : row), [], options)).toThrow("stable chain");
    expect(() => replayWalkForward(snapshots, [], { ...options, spreadsBps: [8, 8] })).toThrow("Invalid chronological");
    expect(() => replayWalkForward(snapshots, [], { ...options, purgeMs: 30_000 })).toThrow("purge interval");
    expect(() => replayWalkForward(snapshots, [], { ...options, minimumTrainingFills: 0 })).toThrow("Invalid chronological");
  });
});
