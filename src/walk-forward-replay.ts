import { defaultBacktestOptions, replayDepth, type BacktestOptions, type BacktestResult } from "./research";
import type { DepthSnapshot, TradeEvent } from "./types";

export interface ReplayWalkForwardOptions {
  trainFraction: number;
  purgeMs: number;
  spreadsBps: number[];
  benchmarkSpreadBps: number;
  minimumTrainingFills: number;
  replay: BacktestOptions;
}

export interface ReplayWalkForwardResult {
  evidenceStatus: "EXPLORATORY_CHRONOLOGICAL_HOLDOUT" | "INSUFFICIENT_TRAINING_FILLS";
  interpretation: string;
  split: {
    cutoffTimestamp: number;
    purgeMs: number;
    train: { startTimestamp: number; endTimestamp: number; snapshots: number; trades: number };
    purged: { startTimestamp: number; endTimestamp: number; snapshots: number; trades: number };
    holdout: { startTimestamp: number; endTimestamp: number; snapshots: number; trades: number };
  };
  trainingSweep: Array<{ spreadBps: number; result: BacktestResult }>;
  minimumTrainingFillsPerSpread: number;
  selectedSpreadBps: number | null;
  holdout: null | {
    resetAccountAtBoundary: true;
    selected: BacktestResult;
    fixedBenchmarkSpreadBps: number;
    fixedBenchmark: BacktestResult;
  };
}

export const defaultReplayWalkForwardOptions: ReplayWalkForwardOptions = {
  trainFraction: 0.7,
  purgeMs: 60_000,
  spreadsBps: [0, 4, 8, 16, 32],
  benchmarkSpreadBps: 8,
  minimumTrainingFills: 20,
  replay: defaultBacktestOptions,
};

/** Select parameters using earlier data only, then replay the frozen choice on a purged chronological holdout. */
export function replayWalkForward(snapshots: DepthSnapshot[], trades: TradeEvent[], options: ReplayWalkForwardOptions = defaultReplayWalkForwardOptions): ReplayWalkForwardResult {
  if (!Number.isFinite(options.trainFraction) || options.trainFraction <= 0 || options.trainFraction >= 1
    || !Number.isSafeInteger(options.purgeMs) || options.purgeMs < 1
    || !Array.isArray(options.spreadsBps) || !options.spreadsBps.length
    || options.spreadsBps.some((spread) => !Number.isFinite(spread) || spread < 0)
    || new Set(options.spreadsBps).size !== options.spreadsBps.length
    || !Number.isFinite(options.benchmarkSpreadBps) || options.benchmarkSpreadBps < 0
    || !Number.isSafeInteger(options.minimumTrainingFills) || options.minimumTrainingFills < 1) {
    throw new Error("Invalid chronological replay split or spread grid.");
  }
  if (snapshots.length < 6) throw new Error("At least six snapshots are required for a purged chronological replay split.");
  for (let i = 1; i < snapshots.length; i++) {
    if (snapshots[i]!.timestamp <= snapshots[i - 1]!.timestamp) throw new Error("Replay snapshots must be chronological.");
    if (snapshots[i]!.gapBefore) throw new Error("Walk-forward replay requires one uninterrupted L2 segment.");
    if (snapshots[i]!.chainId !== snapshots[0]!.chainId || snapshots[i]!.market !== snapshots[0]!.market
      || snapshots[i]!.tickSize !== snapshots[0]!.tickSize || snapshots[i]!.makerFeeBps !== snapshots[0]!.makerFeeBps
      || snapshots[i]!.minSizeMon !== snapshots[0]!.minSizeMon) {
      throw new Error("Walk-forward replay requires stable chain, market, tick, minimum size, and fee metadata.");
    }
  }
  for (let i = 1; i < trades.length; i++) if (trades[i]!.timestamp < trades[i - 1]!.timestamp) throw new Error("Replay trades must be chronological.");

  const cutoffIndex = Math.floor(snapshots.length * options.trainFraction);
  if (cutoffIndex <= 0 || cutoffIndex >= snapshots.length) throw new Error("The requested chronological split leaves an empty side.");
  const cutoff = snapshots[cutoffIndex]!.timestamp;
  const trainEnd = cutoff - options.purgeMs;
  const holdoutStart = cutoff + options.purgeMs;
  const trainSnapshots = snapshots.filter((row) => row.timestamp < trainEnd);
  const holdoutSnapshots = snapshots.filter((row) => row.timestamp >= holdoutStart);
  const purgedSnapshots = snapshots.filter((row) => row.timestamp >= trainEnd && row.timestamp < holdoutStart);
  if (trainSnapshots.length < 2 || holdoutSnapshots.length < 2) throw new Error("The purge interval leaves too few snapshots for training or holdout replay.");
  const trainTrades = trades.filter((row) => row.timestamp > trainSnapshots[0]!.timestamp && row.timestamp <= trainSnapshots.at(-1)!.timestamp);
  const holdoutTrades = trades.filter((row) => row.timestamp > holdoutSnapshots[0]!.timestamp && row.timestamp <= holdoutSnapshots.at(-1)!.timestamp);
  const purgedTrades = trades.filter((row) => row.timestamp > trainSnapshots.at(-1)!.timestamp && row.timestamp <= holdoutSnapshots[0]!.timestamp);
  const baseOptions = {
    ...options.replay,
    tickSize: snapshots[0]!.tickSize ?? options.replay.tickSize,
    feeBps: snapshots[0]!.makerFeeBps ?? options.replay.feeBps,
    minimumOrderSizeMon: Math.max(snapshots[0]!.minSizeMon ?? 0, options.replay.minimumOrderSizeMon ?? 0),
  };
  const trainingSweep = options.spreadsBps.map((spreadBps) => ({
    spreadBps,
    result: replayDepth(trainSnapshots, { ...baseOptions, baseHalfSpreadBps: spreadBps }, trainTrades),
  }));
  const span = (rows: DepthSnapshot[]) => ({ startTimestamp: rows[0]!.timestamp, endTimestamp: rows.at(-1)!.timestamp });
  const split = {
    cutoffTimestamp: cutoff, purgeMs: options.purgeMs,
    train: { ...span(trainSnapshots), snapshots: trainSnapshots.length, trades: trainTrades.length },
    purged: purgedSnapshots.length ? { ...span(purgedSnapshots), snapshots: purgedSnapshots.length, trades: purgedTrades.length } : { startTimestamp: trainEnd, endTimestamp: holdoutStart, snapshots: 0, trades: purgedTrades.length },
    holdout: { ...span(holdoutSnapshots), snapshots: holdoutSnapshots.length, trades: holdoutTrades.length },
  };
  const eligible = trainingSweep.filter((item) => item.result.fills >= options.minimumTrainingFills);
  if (!eligible.length) return {
    evidenceStatus: "INSUFFICIENT_TRAINING_FILLS",
    interpretation: `No spread had the required ${options.minimumTrainingFills} training fills, so no parameter was selected and the holdout was not scored. The training replay is a low-sample public-data queue proxy, not profitability evidence.`,
    split, trainingSweep, minimumTrainingFillsPerSpread: options.minimumTrainingFills, selectedSpreadBps: null, holdout: null,
  };
  // Select only among candidates with enough training executions; holdout results never influence selection.
  const selected = eligible.reduce((best, item) => item.result.netPnlUsd > best.result.netPnlUsd ? item : best);
  const holdoutReplayOptions = { ...baseOptions, baseHalfSpreadBps: selected.spreadBps };
  const selectedHoldout = replayDepth(holdoutSnapshots, holdoutReplayOptions, holdoutTrades);
  const benchmarkHoldout = replayDepth(holdoutSnapshots, { ...baseOptions, baseHalfSpreadBps: options.benchmarkSpreadBps }, holdoutTrades);
  return {
    evidenceStatus: "EXPLORATORY_CHRONOLOGICAL_HOLDOUT",
    interpretation: "The spread is selected on the earlier training segment after meeting the minimum training-fill gate, then frozen for the later holdout. Account, resting quotes, and pending atomic updates reset at the boundary; end-window liquidation and cancellation costs are excluded. One serially related public-data split is exploratory only; it does not establish stable expectancy, queue priority, live execution, or profitability.",
    split, trainingSweep, minimumTrainingFillsPerSpread: options.minimumTrainingFills, selectedSpreadBps: selected.spreadBps,
    holdout: { resetAccountAtBoundary: true, selected: selectedHoldout, fixedBenchmarkSpreadBps: options.benchmarkSpreadBps, fixedBenchmark: benchmarkHoldout },
  };
}
