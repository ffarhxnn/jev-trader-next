import { expect, test } from "bun:test";
import { replaySinglePlacement, type ReplayDecision, type SinglePlacementReplayOptions } from "../src/single-placement-replay";
import type { DepthSnapshot, TradeEvent } from "../src/types";
const market = "0x0000000000000000000000000000000000000001";
const options: SinglePlacementReplayOptions = { startingCash: 10, startingMon: 20, orderSizeMon: 10, positionCapMon: 100,
  minimumOrderSizeMon: 1, feeBps: 0, tickSize: 0.000001, insideTicks: 1, maxSpreadBps: 50, maxLossUsd: 100,
  gasUsdPerUpdate: 0.001, orderLatencyMs: 100, receiptConfirmationDelayMs: 100 };
function books(count = 11): DepthSnapshot[] { return Array.from({ length: count }, (_, i) => ({ timestamp: i * 1000,
  block: 100 + i, chainId: 143, market, tickSize: options.tickSize, sizePrecision: 1e10, minSizeMon: 1,
  makerFeeBps: 0, takerFeeBps: 0, captureIntervalMs: 1000, bids: [[0.03, 5]], asks: [[0.030002, 5]] })); }
function decision(bookTimestamp: number, action: ReplayDecision["action"], decidedAt = bookTimestamp): ReplayDecision {
  return { bookTimestamp, bookBlock: 100 + bookTimestamp / 1000, decidedAt, action, model: "captured public model label", source: "captured decision audit" };
}
function trade(timestamp: number, price = 0.030001, size = 5, takerSide: "buy" | "sell" = "sell", block = 100 + Math.ceil(timestamp / 1000) + 1): TradeEvent {
  return { timestamp, price, size, takerSide, rawPrice: (BigInt(Math.round(price * 1e8)) * 10n ** 10n).toString(),
    rawSize: BigInt(Math.round(size * 1e10)).toString(), receiptVerified: true, receiptBlock: block, receiptLogIndex: Math.round(timestamp),
    receiptChainId: 143, receiptMarket: market, transactionHash: "0x" + Math.round(timestamp).toString(16).padStart(64, "0") };
}
const unused = () => [trade(9000, 0.04)];
const replay = (decisions: ReplayDecision[], trades = unused(), patch: Partial<SinglePlacementReplayOptions> = {}, snapshots = books()) => replaySinglePlacement(snapshots, trades, decisions, { ...options, ...patch });

test("single-placement buy sell and explicit hold replay supplied decisions without a strategy", () => {
  const result = replay([decision(0, "buy"), decision(2000, "sell"), decision(4000, "hold")],
    [trade(500), trade(2500, 0.030001, 5, "buy"), trade(4500, 0.030001, 5, "buy")]);
  expect(result.evidenceStatus).toBe("RESEARCH_PROXY_ONLY");
  expect(result.attempts.map(a => a.operation)).toEqual(["placement", "placement", "cancel"]);
  expect(result.counts.buyFills).toBe(1); expect(result.counts.sellFills).toBe(1);
  expect(result.endingMon).toBe(20); expect(result.endingRestingQuote).toBeNull();
  expect(result.gasCostsUsd).toBeCloseTo(0.003); expect(result.rootLifecycleAgreement).toContain("not root equivalence");
});

test("root side fallback counts old same-side reserve and never opens a short", () => {
  const result = replay([decision(0, "buy"), decision(1000, "buy")], unused(), { positionCapMon: 35 });
  expect(result.attempts.map(a => a.side)).toEqual(["buy", "sell"]);
  expect(result.counts.riskFallbacks).toBe(1);
  const noMon = replay([decision(0, "sell")], unused(), { startingMon: 0 });
  expect(noMon.attempts[0]?.side).toBe("buy"); expect(noMon.endingMon).toBe(0);
});

test("disallowed sides leave an existing order while actionable same-price repeats reset queue", () => {
  const retained = replay([decision(0, "buy"), decision(1000, "buy")], unused(), { startingMon: 0, positionCapMon: 10 });
  expect(retained.counts.attempts).toBe(1); expect(retained.counts.disallowedDecisions).toBe(1);
  expect(retained.endingRestingQuote?.quoteId).toBe(1);
  const reset = replay([decision(0, "buy"), decision(1000, "buy")], [trade(500, 0.03, 4), trade(1500, 0.03, 4)], { insideTicks: 0 });
  expect(reset.attempts.map(a => a.queueAheadAtActivation)).toEqual([5, 5]);
  expect(reset.counts.applied).toBe(2); expect(reset.counts.queueOnlyTradeEvents).toBe(2);
  expect(reset.counts.fills).toBe(0); expect(reset.endingRestingQuote?.queueAhead).toBe(1);
});

test("old orders fill before frozen replacement application and receipt delay skips later decisions", () => {
  const result = replay([decision(0, "buy"), decision(1000, "sell"), decision(2000, "hold")],
    [trade(1400, 0.030001, 3), trade(2500, 0.030001, 3, "buy")], { orderLatencyMs: 500, receiptConfirmationDelayMs: 1200 });
  expect(result.counts.decisionsSkippedWhilePending).toBe(1);
  // The 1000 sell decision is still waiting for the original placement's receipt.
  expect(result.counts.attempts).toBe(2); expect(result.attempts[1]?.operation).toBe("cancel");
  const pendingFill = replay([decision(0, "buy"), decision(2000, "sell")], [trade(2200, 0.030001, 3)], { orderLatencyMs: 500 });
  expect(pendingFill.counts.fillsWhileReplacementPending).toBe(1);
  expect(pendingFill.fillDetails[0]?.quoteId).toBe(1); expect(pendingFill.attempts[1]?.side).toBe("sell");
});

test("crossing and resource failure atomically revert while preserving the old survivor and gas", () => {
  const snapshots = books(); snapshots[3]!.bids = [[0.030003, 5]]; snapshots[3]!.asks = [[0.030005, 5]];
  const result = replay([decision(0, "buy"), decision(2000, "sell")], unused(), { orderLatencyMs: 1500 }, snapshots);
  expect(result.attempts[1]?.outcome).toBe("reverted"); expect(result.endingRestingQuote?.side).toBe("buy");
  expect(result.counts.reverted).toBe(1); expect(result.gasCostsUsd).toBeCloseTo(0.002);
  const failedResource = replay([decision(0, "buy")], unused(), { startingCash: 0.30003, gasUsdPerUpdate: 0.01 });
  expect(failedResource.attempts[0]?.outcome).toBe("reverted"); expect(failedResource.endingRestingQuote).toBeNull();
  expect(failedResource.gasCostsUsd).toBe(0.01);
});

test("a fully exhausted frozen cancellation target latches unresolved and retains gas", () => {
  const result = replay([decision(0, "buy"), decision(2000, "sell"), decision(4000, "buy")],
    [trade(2200, 0.030001, 10)], { orderLatencyMs: 500 });
  expect(result.attempts[1]?.outcome).toBe("unresolved"); expect(result.executionStopped).toBe(true);
  expect(result.counts.unresolved).toBe(1); expect(result.counts.pendingAtEnd).toBe(1);
  expect(result.counts.attempts).toBe(2); expect(result.gasCostsUsd).toBeCloseTo(0.002);
});

test("application-time affected trades are censored and same or earlier receipt blocks cannot fill", () => {
  const result = replay([decision(0, "buy"), decision(2000, "sell")],
    [trade(100, 0.030001, 5, "sell", 101), trade(300, 0.030001, 5, "sell", 101),
      trade(500, 0.030001, 5, "sell", 102), trade(2100, 0.030001, 5, "buy", 103)]);
  expect(result.counts.applicationBoundaryBlockedEvents).toBe(2);
  expect(result.counts.receiptTimingBlockedEvents).toBe(1);
  expect(result.counts.fills).toBe(1); expect(result.fillDetails[0]?.timestamp).toBe(500);
});

test("queue activation never reads future depth, and frozen prices never use future books", () => {
  const snapshots = books(); snapshots[1]!.bids = [[0.03, 500]];
  const result = replay([decision(0, "buy")], [trade(500, 0.03, 8)], { insideTicks: 0 }, snapshots);
  expect(result.attempts[0]?.activationSnapshotTimestamp).toBe(0); expect(result.attempts[0]?.queueAheadAtActivation).toBe(5);
  expect(result.attempts[0]?.activationReceiptBlockCeiling).toBe(101);
  expect(result.counts.fills).toBe(1); expect(result.fillDetails[0]?.size).toBe(3);
});

test("known newer capture block during completion skips stale decision and protectively cancels old quote", () => {
  const result = replay([decision(0, "buy"), decision(1000, "sell", 2500)], unused());
  expect(result.counts.staleDecisions).toBe(1); expect(result.attempts[1]?.operation).toBe("cancel");
  expect(result.endingRestingQuote).toBeNull();
  const initialStale = replay([decision(0, "buy", 1500)], unused());
  expect(initialStale.counts.attempts).toBe(0); expect(initialStale.counts.staleDecisions).toBe(1);
});

test("pending-at-end gas stays charged and a marked loss stop latches and cancels", () => {
  const pending = replay([decision(9000, "buy")], unused(), { orderLatencyMs: 2000 });
  expect(pending.attempts[0]?.outcome).toBe("pending"); expect(pending.counts.pendingAtEnd).toBe(1);
  expect(pending.gasCostsUsd).toBe(0.001);
  const snapshots = books(); snapshots[2]!.bids = [[0.029, 5]]; snapshots[2]!.asks = [[0.029002, 5]];
  const stopped = replay([decision(0, "buy"), decision(4000, "buy")], unused(), { maxLossUsd: 0.01 }, snapshots);
  expect(stopped.lossStop?.timestamp).toBe(2000); expect(stopped.attempts[1]?.operation).toBe("cancel");
  expect(stopped.endingRestingQuote).toBeNull(); expect(stopped.counts.attempts).toBe(2);
  expect(stopped.decisionDetails[1]?.outcome).toBe("loss_stop_latched");
});

test("wrong decision book provenance, gaps, malformed metadata and unverified receipt tapes fail closed", () => {
  for (const patch of [{ bookTimestamp: 1 }, { bookBlock: 999 }, { decidedAt: -1 }, { source: "" }]) {
    expect(() => replay([{ ...decision(0, "buy"), ...patch }])).toThrow();
  }
  for (const patch of [{ chainId: 1 }, { market: undefined }, { tickSize: 2e-6 }, { makerFeeBps: 1 },
    { minSizeMon: 2 }, { gapBefore: true }, { sizePrecision: undefined }, { block: 99 }, { timestamp: 9000 }]) {
    const snapshots = books(); snapshots[1] = { ...snapshots[1]!, ...patch };
    expect(() => replay([], unused(), {}, snapshots)).toThrow();
  }
  for (const patch of [{ receiptVerified: false }, { receiptMarket: "0x0000000000000000000000000000000000000002" },
    { receiptBlock: -1 }, { rawPrice: "garbage" }, { size: 0 }, { takerSide: "unknown" }, { rawSize: "1" }]) {
    expect(() => replay([], [{ ...trade(9000), ...patch } as TradeEvent])).toThrow();
  }
  expect(() => replay([], [trade(9000), trade(9000)])).toThrow();
  expect(() => replay([], [])).toThrow(/no usable trade/);
  expect(() => replay([], unused(), { maxLossUsd: 0 })).toThrow();
});

test("pending placement price matches are diagnostic only, and delayed receipts freeze replacement after activation", () => {
  const result = replay([decision(0, "buy"), decision(1000, "sell"), decision(2000, "sell")],
    [trade(200), trade(1600)], { orderLatencyMs: 500, receiptConfirmationDelayMs: 1800 });
  expect(result.counts.activationLatencyBlockedEvents).toBe(1);
  expect(result.counts.decisionsSkippedWhilePending).toBe(2);
  expect(result.counts.attempts).toBe(1); expect(result.counts.fills).toBe(1);
  expect(result.fillDetails[0]?.timestamp).toBe(1600);
  const atEnd = replay([decision(9000, "buy")], unused(), { orderLatencyMs: 100, receiptConfirmationDelayMs: 2000 });
  expect(atEnd.attempts[0]?.outcome).toBe("applied"); expect(atEnd.attempts[0]?.pendingAtEnd).toBe(true);
  expect(atEnd.counts.pendingAtEnd).toBe(1); expect(atEnd.gasCostsUsd).toBe(0.001);
});

test("zero-latency updates censor both old and new affected prices at their application timestamp", () => {
  const result = replay([decision(0, "buy"), decision(2000, "sell")],
    [trade(0, 0.030001, 5, "sell", 100), trade(2000, 0.030001, 5, "sell", 103),
      { ...trade(2000, 0.030001, 5, "buy", 103), receiptLogIndex: 2001, transactionHash: "0x" + "7".repeat(64) }],
    { orderLatencyMs: 0, receiptConfirmationDelayMs: 0 });
  expect(result.counts.applicationBoundaryBlockedEvents).toBe(3);
  expect(result.counts.fills).toBe(0); expect(result.counts.applied).toBe(2);
});

test("spread holds cancel only, fees stay in marked P&L, and outside metadata gaps decline replay", () => {
  const snapshots = books(); snapshots[1]!.asks = [[0.031, 5]];
  const spread = replay([decision(0, "buy"), decision(1000, "buy")], unused(), {}, snapshots);
  expect(spread.attempts[1]?.operation).toBe("cancel"); expect(spread.decisionDetails[1]?.outcome).toBe("market_spread_hold");
  const chargedBooks = books(); for (const book of chargedBooks) book.makerFeeBps = 10;
  const fees = replay([decision(0, "buy")], [trade(500)], { feeBps: 10 }, chargedBooks);
  expect(fees.feesUsd).toBeCloseTo(5 * 0.030001 * 0.001);
  expect(fees.netPnlUsd).toBeCloseTo(fees.grossPnlUsd - fees.feesUsd - fees.gasCostsUsd);
  const gap = books(); gap.splice(1, 4);
  expect(() => replay([], unused(), {}, gap)).toThrow(/discontinuous/);
  const missing = { ...options } as any; delete missing.orderLatencyMs;
  expect(() => replaySinglePlacement(books(), unused(), [], missing)).toThrow(/options/);
});

test("a first snapshot gap marker is a segment boundary, while later gaps are invalid", () => {
  const snapshots = books(); snapshots[0]!.gapBefore = true;
  expect(replay([decision(0, "buy")], unused(), {}, snapshots).counts.applied).toBe(1);
  snapshots[1]!.gapBefore = true;
  expect(() => replay([], unused(), {}, snapshots)).toThrow(/discontinuous/);
});

test("USD gas never consumes the backing of an old buy quote executable during replacement delay", () => {
  const result = replay([decision(0, "buy"), decision(2000, "sell")], [trade(2300, 0.030001, 10)],
    { startingCash: 0.31001, gasUsdPerUpdate: 0.01, orderLatencyMs: 500 });
  expect(result.counts.attempts).toBe(1); expect(result.counts.gasBlockedUpdates).toBe(1);
  expect(result.fillDetails[0]?.size).toBe(10); expect(result.counts.fillsWhileReplacementPending).toBe(0);
  expect(result.gasCostsUsd).toBe(0.01);
  expect(result.remainingMismatches.some(reason => reason.includes("combined-USD-capital"))).toBe(true);
});

test("a resource-reverted replacement preserves a partially filled old quote and its queue", () => {
  const result = replay([decision(0, "buy"), decision(2000, "buy")], [trade(2200, 0.030001, 5)],
    { startingCash: 0.450015, orderLatencyMs: 500 });
  expect(result.attempts[1]?.side).toBe("buy"); expect(result.attempts[1]?.outcome).toBe("reverted");
  expect(result.endingRestingQuote).toMatchObject({ quoteId: 1, side: "buy", remainingSize: 5 });
  expect(result.counts.fillsWhileReplacementPending).toBe(1); expect(result.gasCostsUsd).toBeCloseTo(0.002);
});

test("future capture prices cannot choose the frozen quote's price or queue", () => {
  const snapshots = books(); snapshots[1]!.bids = [[0.031, 999]]; snapshots[1]!.asks = [[0.031002, 999]];
  const result = replay([decision(0, "buy")], [trade(500, 0.030001, 5)], {}, snapshots);
  expect(result.attempts[0]?.price).toBe(0.030001); expect(result.attempts[0]?.queueAheadAtActivation).toBe(0);
  expect(result.fillDetails[0]?.price).toBe(0.030001); expect(result.fillDetails[0]?.activationSnapshotTimestamp).toBe(0);
});

test("merged observations may declare different positive cadences without changing market identity", () => {
  const snapshots = books(); snapshots[1]!.captureIntervalMs = 2000; snapshots[2]!.captureIntervalMs = 500;
  expect(replay([decision(0, "buy")], unused(), {}, snapshots).counts.applied).toBe(1);
  snapshots[1]!.gapBefore = true;
  expect(() => replay([], unused(), {}, snapshots)).toThrow(/discontinuous/);
  snapshots[1]!.gapBefore = false;
  for (const cadence of [0, -1, NaN, Infinity, undefined]) {
    snapshots[1]!.captureIntervalMs = cadence;
    expect(() => replay([], unused(), {}, snapshots)).toThrow(/discontinuous/);
  }
});

test("terminal fill loss is visible without inventing a post-window risk loop or cancellation", () => {
  const snapshots = books(); for (const snapshot of snapshots) snapshot.makerFeeBps = 10_000;
  const result = replay([decision(0, "buy")], [trade(10_000)],
    { feeBps: 10_000, maxLossUsd: 0.1, gasUsdPerUpdate: 0 }, snapshots);
  expect(result.netPnlUsd).toBeLessThan(-0.1);
  expect(result.terminalMarkedLossBreached).toBe(true);
  expect(result.lossStop).toBeNull();
  expect(result.counts.attempts).toBe(1);
  expect(result.endingRestingQuote?.remainingSize).toBe(5);
  expect(replay([], unused()).terminalMarkedLossBreached).toBe(false);
});
