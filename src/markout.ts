import { parseDepthJsonl } from "./research";
import type { Action, DepthSnapshot } from "./types";

interface AuditedDecision {
  timestamp: number;
  bookReceivedAt: number;
  block: number;
  chainId: number | null;
  mid: number;
  action: Action;
  confidence: number | null;
}

interface SegmentedSnapshot {
  snapshot: DepthSnapshot;
  segment: number;
}

export interface MarkoutOptions {
  horizonsMs?: number[];
  maxSnapshotSkewMs?: number;
  minimumDecisionCount?: number;
  dependenceBlockMs?: number;
  bootstrapReplicates?: number;
}

function midpoint(snapshot: DepthSnapshot) {
  return (snapshot.bids[0]![0] + snapshot.asks[0]![0]) / 2;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function summarizeCalibration(probabilities: number[], outcomes: number[]) {
  if (!probabilities.length) return { observations: 0, meanChosenProbability: null, observedPositiveFraction: null, brierScore: null, calibrationGap: null, neutralChosenProbability: 0.5, neutralBrierScore: null, brierScoreMinusNeutral: null };
  const meanChosenProbability = probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length;
  const observedPositiveFraction = outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length;
  const brierScore = probabilities.reduce((sum, probability, index) => sum + (probability - outcomes[index]!) ** 2, 0) / probabilities.length;
  return {
    observations: probabilities.length,
    meanChosenProbability,
    observedPositiveFraction,
    brierScore,
    calibrationGap: meanChosenProbability - observedPositiveFraction,
    neutralChosenProbability: 0.5,
    neutralBrierScore: 0.25,
    brierScoreMinusNeutral: brierScore - 0.25,
  };
}

interface MarkoutObservation { cluster: string; directionalReturn: number; confidence: number | null; action: "buy" | "sell" }

function fixedBenchmarks(observations: MarkoutObservation[]) {
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const signalMean = mean(observations.map((item) => item.directionalReturn));
  const rawReturns = observations.map((item) => item.action === "buy" ? item.directionalReturn : -item.directionalReturn);
  const summarize = (returns: number[]) => {
    const meanMarkoutBps = mean(returns);
    return {
      observations: returns.length,
      flatObservations: returns.filter((value) => value === 0).length,
      meanMarkoutBps,
      positiveFraction: returns.length ? returns.filter((value) => value > 0).length / returns.length : null,
      signalMinusBenchmarkMeanBps: signalMean === null || meanMarkoutBps === null ? null : signalMean - meanMarkoutBps,
    };
  };
  return { interpretation: "Descriptive fixed benchmarks on exactly the same matched observations; flat returns are non-positive. These are not trading returns, holdout proof, or strategy selection.", alwaysBuy: summarize(rawReturns), alwaysSell: summarize(rawReturns.map((value) => -value)) };
}

function temporalUncertainty(observations: MarkoutObservation[], blockMs: number, replicates: number, seed: number) {
  const clusters = new Map<string, MarkoutObservation[]>();
  for (const observation of observations) {
    const cluster = clusters.get(observation.cluster) ?? [];
    cluster.push(observation);
    clusters.set(observation.cluster, cluster);
  }
  const blockCount = clusters.size;
  if (blockCount < 10) return { blockMs, timeBlocks: blockCount, method: "contiguous_time_block_bootstrap", replicates: 0, confidenceIntervals: null };

  const clusterValues = [...clusters.values()];
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
  const samples = { mean: [] as number[], positive: [] as number[], brier: [] as number[], gap: [] as number[] };
  for (let iteration = 0; iteration < replicates; iteration++) {
    const draw: MarkoutObservation[] = [];
    for (let i = 0; i < blockCount; i++) draw.push(...clusterValues[Math.floor(random() * blockCount)]!);
    const returns = draw.map((item) => item.directionalReturn);
    const calibrated = draw.filter((item) => item.confidence !== null);
    const positives = returns.filter((value) => value > 0).length / returns.length;
    samples.mean.push(returns.reduce((sum, value) => sum + value, 0) / returns.length);
    samples.positive.push(positives);
    if (calibrated.length) {
      const outcomes = calibrated.map((item) => item.directionalReturn > 0 ? 1 : 0);
      const probabilities = calibrated.map((item) => item.confidence!);
      const calibration = summarizeCalibration(probabilities, outcomes);
      samples.brier.push(calibration.brierScore!);
      samples.gap.push(calibration.calibrationGap!);
    }
  }
  const interval = (values: number[]) => {
    if (!values.length) return null;
    values.sort((a, b) => a - b);
    const at = (p: number) => values[Math.floor((values.length - 1) * p)]!;
    return { lower: at(0.025), upper: at(0.975) };
  };
  return {
    blockMs,
    timeBlocks: blockCount,
    method: "contiguous_time_block_bootstrap",
    replicates,
    confidenceIntervals: {
      meanDirectionalMarkoutBps95: interval(samples.mean),
      positiveFraction95: interval(samples.positive),
      brierScore95: interval(samples.brier),
      calibrationGap95: interval(samples.gap),
    },
  };
}

const CONFIDENCE_BUCKETS = ["low (<=0.60)", "medium (0.60-0.80]", "high (>0.80)", "unavailable"] as const;
type ConfidenceBucket = typeof CONFIDENCE_BUCKETS[number];

function confidenceBucket(confidence: number | null): ConfidenceBucket {
  if (confidence === null) return "unavailable";
  if (confidence <= 0.6) return CONFIDENCE_BUCKETS[0];
  if (confidence <= 0.8) return CONFIDENCE_BUCKETS[1];
  return CONFIDENCE_BUCKETS[2];
}

function readAudit(contents: string) {
  let mode: unknown;
  let market: unknown;
  const decisions: AuditedDecision[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid audit JSON on line ${index + 1}.`); }
    if (!value || typeof value !== "object") throw new Error(`Invalid audit record on line ${index + 1}.`);
    const record = value as Record<string, unknown>;
    if (record.kind === "session_start") {
      mode = record.mode;
      market = typeof record.market === "string" ? record.market.toLowerCase() : null;
    }
    if (record.kind !== "decision") continue;
    if (!Number.isFinite(record.timestamp) || !Number.isFinite(record.bookReceivedAt)
      || !Number.isSafeInteger(record.block) || !Number.isFinite(record.mid) || Number(record.mid) <= 0
      || !["buy", "sell", "hold"].includes(String(record.action))) {
      throw new Error(`Invalid audited decision on line ${index + 1}.`);
    }
    const chainId = Number.isSafeInteger(record.chainId) && Number(record.chainId) > 0 ? Number(record.chainId) : null;
    const buyProbability = Number.isFinite(record.buyProbability) && Number(record.buyProbability) >= 0 && Number(record.buyProbability) <= 1
      ? Number(record.buyProbability) : null;
    const sellProbability = Number.isFinite(record.sellProbability) && Number(record.sellProbability) >= 0 && Number(record.sellProbability) <= 1
      ? Number(record.sellProbability) : null;
    decisions.push({
      timestamp: Number(record.timestamp), bookReceivedAt: Number(record.bookReceivedAt),
      block: Number(record.block), chainId, mid: Number(record.mid), action: record.action as Action,
      confidence: record.action === "buy" ? buyProbability : record.action === "sell" ? sellProbability : null,
    });
  }
  if (mode !== "paper") throw new Error("Markout analysis requires an actual paper-session audit file.");
  if (typeof market !== "string" || !/^0x[0-9a-f]{40}$/.test(market)) throw new Error("Audit file is missing a valid Kuru market address.");
  return { market, decisions };
}

/**
 * Measure observed price direction after Jev decisions. This is a descriptive
 * signal check, not a fill, P&L, or strategy profitability simulator.
 */
export function summarizeDecisionMarkouts(auditContents: string, depthContents: string, options: MarkoutOptions = {}) {
  const horizons = options.horizonsMs ?? [5_000, 15_000, 60_000];
  const maxSkewMs = options.maxSnapshotSkewMs ?? 2_000;
  const minimumDecisionCount = options.minimumDecisionCount ?? 200;
  // Keep a matched markout window well inside its temporal resampling block.
  const dependenceBlockMs = options.dependenceBlockMs ?? Math.max(...horizons) * 3;
  const bootstrapReplicates = options.bootstrapReplicates ?? 1_000;
  if (!horizons.length || horizons.some((h) => !Number.isSafeInteger(h) || h < 1_000)
    || !Number.isSafeInteger(maxSkewMs) || maxSkewMs < 0
    || !Number.isSafeInteger(minimumDecisionCount) || minimumDecisionCount < 1
    || !Number.isSafeInteger(dependenceBlockMs) || dependenceBlockMs < Math.max(...horizons)
    || !Number.isSafeInteger(bootstrapReplicates) || bootstrapReplicates < 100 || bootstrapReplicates > 10_000) {
    throw new Error("Invalid markout horizon, snapshot tolerance, or minimum sample count.");
  }

  const audit = readAudit(auditContents);
  const rawSnapshots = parseDepthJsonl(depthContents);
  let segment = 0;
  const snapshots: SegmentedSnapshot[] = [];
  for (const snapshot of rawSnapshots) {
    if (snapshot.gapBefore) segment++;
    if (snapshot.chainId === 143 && snapshot.market?.toLowerCase() === audit.market) snapshots.push({ snapshot, segment });
  }
  for (let i = 1; i < snapshots.length; i++) {
    if (snapshots[i]!.snapshot.timestamp <= snapshots[i - 1]!.snapshot.timestamp) throw new Error("Verified Kuru snapshot timestamps must increase.");
  }

  const byBlock = new Map<number, SegmentedSnapshot[]>();
  const bySegment = new Map<number, DepthSnapshot[]>();
  const segmentStarts = new Map<number, number>();
  for (const item of snapshots) {
    const matches = byBlock.get(item.snapshot.block) ?? [];
    matches.push(item);
    byBlock.set(item.snapshot.block, matches);
    const inSegment = bySegment.get(item.segment) ?? [];
    inSegment.push(item.snapshot);
    bySegment.set(item.segment, inSegment);
    if (!segmentStarts.has(item.segment)) segmentStarts.set(item.segment, item.snapshot.timestamp);
  }

  const directional = audit.decisions.filter((d) => d.action !== "hold");
  let matchedBaselines = 0;
  let unmatchedBaselines = 0;
  let exactBlockBaselines = 0;
  let timestampMatchedBaselines = 0;
  const valuesByHorizon = new Map(horizons.map((h) => [h, [] as number[]]));
  const observationsByHorizon = new Map(horizons.map((h) => [h, [] as MarkoutObservation[]]));
  const valuesByAction = new Map(horizons.map((h) => [h, { buy: [] as number[], sell: [] as number[] }]));
  const missingByHorizon = new Map(horizons.map((h) => [h, 0]));
  const missingByAction = new Map(horizons.map((h) => [h, { buy: 0, sell: 0 }]));
  const confidenceByHorizon = new Map(horizons.map((h) => [h, new Map(CONFIDENCE_BUCKETS.map((bucket) => [bucket, { decisions: 0, values: [] as number[], probabilities: [] as number[], outcomes: [] as number[] }]))]));

  for (const decision of directional) {
    for (const horizon of horizons) confidenceByHorizon.get(horizon)!.get(confidenceBucket(decision.confidence))!.decisions++;
    const candidates = decision.chainId === 143 ? byBlock.get(decision.block) ?? [] : [];
    const midMatches = (candidate: SegmentedSnapshot) => Math.abs(midpoint(candidate.snapshot) - decision.mid)
      <= Math.max((candidate.snapshot.tickSize ?? 0.000001) * 0.51, decision.mid * 1e-8);
    let baseline = candidates
      .filter((candidate) => Math.abs(candidate.snapshot.timestamp - decision.bookReceivedAt) <= maxSkewMs && midMatches(candidate))
      .sort((a, b) => Math.abs(a.snapshot.timestamp - decision.bookReceivedAt) - Math.abs(b.snapshot.timestamp - decision.bookReceivedAt))[0];
    if (baseline) {
      exactBlockBaselines++;
    } else {
      // The recorder and paper reader poll independently. Use only a verified
      // observation at or before the audited book time, with the same midpoint.
      let lo = 0, hi = snapshots.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (snapshots[mid]!.snapshot.timestamp <= decision.bookReceivedAt) lo = mid + 1;
        else hi = mid;
      }
      const prior = snapshots[lo - 1];
      if (prior && decision.bookReceivedAt - prior.snapshot.timestamp <= maxSkewMs && midMatches(prior)) baseline = prior;
      if (baseline) timestampMatchedBaselines++;
    }
    if (!baseline) {
      unmatchedBaselines++;
      for (const horizon of horizons) {
        missingByHorizon.set(horizon, missingByHorizon.get(horizon)! + 1);
        const actionMissing = missingByAction.get(horizon)!;
        actionMissing[decision.action as "buy" | "sell"]++;
      }
      continue;
    }
    matchedBaselines++;
    const path = bySegment.get(baseline.segment)!;
    const baseIndex = path.findIndex((snapshot) => snapshot.block === baseline.snapshot.block && snapshot.timestamp === baseline.snapshot.timestamp);
    for (const horizon of horizons) {
      const target = baseline.snapshot.timestamp + horizon;
      let future: DepthSnapshot | undefined;
      for (let i = baseIndex + 1; i < path.length; i++) {
        if (path[i]!.timestamp >= target) { future = path[i]; break; }
      }
      if (!future || future.timestamp - target > maxSkewMs) {
        missingByHorizon.set(horizon, missingByHorizon.get(horizon)! + 1);
        const actionMissing = missingByAction.get(horizon)!;
        actionMissing[decision.action as "buy" | "sell"]++;
        continue;
      }
      const rawReturnBps = (midpoint(future) / decision.mid - 1) * 10_000;
      const directionalReturn = decision.action === "buy" ? rawReturnBps : -rawReturnBps;
      valuesByHorizon.get(horizon)!.push(directionalReturn);
      const segmentStart = segmentStarts.get(baseline.segment)!;
      const timeBlock = Math.floor((decision.bookReceivedAt - segmentStart) / dependenceBlockMs);
      observationsByHorizon.get(horizon)!.push({ cluster: `${baseline.segment}:${timeBlock}`, directionalReturn, confidence: decision.confidence, action: decision.action as "buy" | "sell" });
      valuesByAction.get(horizon)![decision.action as "buy" | "sell"].push(directionalReturn);
      const confidenceGroup = confidenceByHorizon.get(horizon)!.get(confidenceBucket(decision.confidence))!;
      confidenceGroup.values.push(directionalReturn);
      if (decision.confidence !== null) {
        confidenceGroup.probabilities.push(decision.confidence);
        confidenceGroup.outcomes.push(directionalReturn > 0 ? 1 : 0);
      }
    }
  }

  const horizonResults = horizons.map((horizonMs) => {
    const values = valuesByHorizon.get(horizonMs)!;
    const uncertainty = (observations: MarkoutObservation[], key: string) => temporalUncertainty(
      observations, dependenceBlockMs, bootstrapReplicates, 0x4a6576 ^ horizonMs ^ key.split("").reduce((sum, char) => Math.imul(sum ^ char.charCodeAt(0), 16777619), 2166136261),
    );
    const summarize = (action: "buy" | "sell", actionValues: number[], missing: number) => ({
      decisions: directional.filter((decision) => decision.action === action).length,
      matched: actionValues.length,
      missing,
      meanDirectionalMarkoutBps: actionValues.length ? actionValues.reduce((sum, value) => sum + value, 0) / actionValues.length : null,
      medianDirectionalMarkoutBps: median(actionValues),
      positiveFraction: actionValues.length ? actionValues.filter((value) => value > 0).length / actionValues.length : null,
      temporalUncertainty: uncertainty(observationsByHorizon.get(horizonMs)!.filter((item) => item.action === action), action),
      evidenceStatus: actionValues.length < minimumDecisionCount ? "INSUFFICIENT_SAMPLE" : "DESCRIPTIVE_ONLY",
    });
    const actionValues = valuesByAction.get(horizonMs)!;
    const actionMissing = missingByAction.get(horizonMs)!;
    const confidenceGroups = Object.fromEntries(CONFIDENCE_BUCKETS.map((bucket) => {
      const group = confidenceByHorizon.get(horizonMs)!.get(bucket)!;
      return [bucket, {
        decisions: group.decisions,
        matched: group.values.length,
        missing: group.decisions - group.values.length,
        meanDirectionalMarkoutBps: group.values.length ? group.values.reduce((sum, value) => sum + value, 0) / group.values.length : null,
        medianDirectionalMarkoutBps: median(group.values),
        positiveFraction: group.values.length ? group.values.filter((value) => value > 0).length / group.values.length : null,
        calibration: summarizeCalibration(group.probabilities, group.outcomes),
        temporalUncertainty: uncertainty(observationsByHorizon.get(horizonMs)!.filter((item) => confidenceBucket(item.confidence) === bucket), bucket),
        evidenceStatus: group.values.length < minimumDecisionCount ? "INSUFFICIENT_SAMPLE" : "DESCRIPTIVE_ONLY",
      }];
    }));
    const calibratedGroups = [...confidenceByHorizon.get(horizonMs)!.values()];
    const chosenProbabilities = calibratedGroups.flatMap((group) => group.probabilities);
    const chosenOutcomes = calibratedGroups.flatMap((group) => group.outcomes);
    return {
      horizonMs,
      matched: values.length,
      missing: missingByHorizon.get(horizonMs)!,
      meanDirectionalMarkoutBps: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      medianDirectionalMarkoutBps: median(values),
      positiveFraction: values.length ? values.filter((value) => value > 0).length / values.length : null,
      fixedBenchmarks: fixedBenchmarks(observationsByHorizon.get(horizonMs)!),
      chosenActionCalibration: summarizeCalibration(chosenProbabilities, chosenOutcomes),
      temporalUncertainty: uncertainty(observationsByHorizon.get(horizonMs)!, "all"),
      evidenceStatus: values.length < minimumDecisionCount ? "INSUFFICIENT_SAMPLE" : "DESCRIPTIVE_ONLY",
      byChosenActionProbability: confidenceGroups,
      byAction: {
        buy: summarize("buy", actionValues.buy, actionMissing.buy),
        sell: summarize("sell", actionValues.sell, actionMissing.sell),
      },
    };
  });
  const first = snapshots[0]?.snapshot;
  const last = snapshots.at(-1)?.snapshot;
  return {
    evidenceStatus: matchedBaselines < minimumDecisionCount ? "INSUFFICIENT_SAMPLE" : "DESCRIPTIVE_MARKOUT_ONLY",
    interpretation: "Observed post-decision price direction only; calibration metrics compare chosen-side confidence with a positive directional markout at each horizon and are descriptive, sample-limited estimates. Time-block bootstrap intervals account for clustering within each configured block, but remain exploratory estimates from one capture and are not formal significance tests. This is not a fill model, return estimate, or profitability claim.",
    audit: { market: audit.market, chainId: 143, decisions: audit.decisions.length, directionalDecisions: directional.length, matchedBaselines, exactBlockBaselines, timestampMatchedBaselines, unmatchedBaselines },
    capture: { verifiedSnapshots: snapshots.length, firstTimestamp: first?.timestamp ?? null, lastTimestamp: last?.timestamp ?? null, segments: new Set(snapshots.map((x) => x.segment)).size },
    assumptions: { horizonsMs: horizons, maxSnapshotSkewMs: maxSkewMs, minimumDecisionCount, dependenceBlockMs, bootstrapReplicates, minimumTimeBlocksForIntervals: 10, baseline: "same market and verified chain 143; prefer exact audited block, otherwise use a matching midpoint from the latest snapshot at or before the book receipt time; forward observation must remain within the same uninterrupted capture segment" },
    horizonResults,
  };
}
