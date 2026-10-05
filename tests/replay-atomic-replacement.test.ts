import { expect, test } from "bun:test";
import { defaultBacktestOptions, replayDepth } from "../src/research";
import type { DepthSnapshot, TradeEvent } from "../src/types";

const options = { ...defaultBacktestOptions, startingCash: 10_000, startingMon: 0,
  orderSizeMon: 10, positionCapMon: 30, feeBps: 0, gasUsdPerUpdate: 0,
  tickSize: 0.01, baseHalfSpreadBps: 0, volatilityMultiplier: 0,
  quoteRefreshMs: 1_000, quoteActivationDelayMs: 500 };
const book = (timestamp: number, bid = 99, ask = 101, queue = 1): DepthSnapshot => ({
  timestamp, block: timestamp / 10, bids: [[bid, queue]], asks: [[ask, queue]],
});
const trade = (timestamp: number, price: number, size: number, takerSide: "buy" | "sell" = "sell"): TradeEvent => ({ timestamp, price, size, takerSide });

test("old quotes fill until atomic replacement; exact-boundary old and new trades affect neither queue", () => {
  const result = replayDepth([book(1_000), book(2_000, 98, 100), book(3_000, 98, 100)], options, [
    trade(2_250, 99, 5), trade(2_500, 99, 100), trade(2_500, 98, 100), trade(2_750, 98, 4),
  ]);
  expect(result.fillDetails.map((fill) => [fill.timestamp, fill.quoteTimestamp, fill.price, fill.size])).toEqual([
    [2_250, 1_000, 99, 4], [2_750, 2_000, 98, 3],
  ]);
  expect(result.fillsWhileReplacementPending).toBe(1);
  expect(result.replacementBoundaryBlockedEvents).toBe(2);
  expect(result.exactPriceSideMatches).toBe(4);
  expect(result.endingMon).toBe(7);
  expect(result.fillDetails[1]?.queueAheadBefore).toBe(1);
});

test("same-price size replacement consumes each public event once and resets queue only at application", () => {
  const result = replayDepth([book(1_000), book(2_000), book(3_000)], options, [
    trade(1_750, 99, 3), trade(2_250, 99, 5), trade(2_750, 99, 4),
  ]);
  expect(result.fillDetails.map((fill) => fill.size)).toEqual([2, 5, 3]);
  expect(result.exactPriceSideMatches).toBe(3);
  expect(result.endingMon).toBe(10);
  expect(result.fillDetails.map((fill) => fill.queueAheadBefore)).toEqual([1, 0, 1]);
  expect(result.fillsWhileReplacementPending).toBe(1);
});

test("unchanged side keeps priority and can fill at the other side's atomic boundary", () => {
  const result = replayDepth([book(1_000), book(2_000, 99, 102), book(3_000, 99, 102)],
    { ...options, startingMon: 10 }, [trade(2_500, 99, 5), trade(2_500, 101, 5, "buy"), trade(2_500, 102, 5, "buy")]);
  expect(result.fillDetails.map((fill) => [fill.quoteTimestamp, fill.side, fill.size])).toEqual([[1_000, "buy", 4]]);
  expect(result.replacementBoundaryBlockedEvents).toBe(2);
  expect(result.fillsWhileReplacementPending).toBe(0);
});

test("old sell exhausting inventory makes the frozen replacement revert; attempts retain gas cost", () => {
  const result = replayDepth([book(1_000), book(2_000, 100, 102), book(3_000, 100, 102)],
    { ...options, startingCash: 100, startingMon: 10, gasUsdPerUpdate: 0.1 }, [
      trade(2_250, 101, 11, "buy"), trade(2_750, 102, 11, "buy"),
    ]);
  expect(result.fills).toBe(1);
  expect(result.endingMon).toBe(0);
  expect(result.quoteUpdatesReverted).toBe(1);
  expect(result.quoteUpdatesApplied).toBe(1);
  expect(result.quoteUpdates).toBe(3);
  expect(result.pendingQuoteUpdateAtEnd).toBe(true);
  expect(result.gasCostsUsd).toBeCloseTo(0.3);
  expect(result.endingCashUsd).toBeCloseTo(1_109.7);
});

test("old buy filling the cap cannot be followed by an unfunded or over-cap frozen replacement", () => {
  const result = replayDepth([book(1_000), book(2_000, 98, 100), book(3_000, 98, 100)],
    { ...options, startingCash: 1_000, positionCapMon: 10, gasUsdPerUpdate: 1 }, [
      trade(2_250, 99, 11), trade(2_750, 98, 11),
    ]);
  expect(result.fillDetails.map((fill) => fill.price)).toEqual([99]);
  expect(result.endingMon).toBe(10);
  expect(result.maxAbsInventoryMon).toBe(10);
  expect(result.endingCashUsd).toBeCloseTo(7);
  expect(result.quoteUpdatesReverted).toBe(1);
  expect(result.gasCostsUsd).toBe(3);
});

test("a crossing frozen leg reverts the whole batch and preserves both old surviving quotes", () => {
  const result = replayDepth([book(1_000), book(2_000, 98, 100), book(2_400, 101, 103), book(3_000, 101, 103)],
    { ...options, startingMon: 10, gasUsdPerUpdate: 0.1 }, [trade(2_750, 99, 2), trade(2_750, 101, 2, "buy")]);
  expect(result.quoteUpdatesReverted).toBe(1);
  expect(result.fillDetails.map((fill) => [fill.quoteTimestamp, fill.price, fill.size])).toEqual([[1_000, 99, 1], [1_000, 101, 1]]);
  expect(result.endingMon).toBe(10);
  expect(result.gasCostsUsd).toBeCloseTo(0.3);
});

test("activation queue uses latest prior depth rather than submission depth or a future observation", () => {
  const result = replayDepth([book(1_000, 99, 101, 20), book(1_200, 99, 101, 2), book(2_000, 99, 101, 100)],
    options, [trade(1_600, 99, 5)]);
  expect(result.fillDetails.map((fill) => [fill.queueAheadBefore, fill.size])).toEqual([[2, 3]]);
  expect(result.assumptions.activationQueueRule).toContain("at/before scheduled application");
});

test("receipt fills between activation and the next captured block are excluded without consuming queue", () => {
  const verified = (timestamp: number, receiptBlock: number) => ({ ...trade(timestamp, 99, 5), receiptVerified: true as const, receiptBlock });
  const result = replayDepth([book(1_000, 99, 101, 20), book(1_200, 99, 101, 2), book(2_000, 99, 101, 100), book(3_000)],
    options, [verified(1_600, 160), verified(2_100, 201)]);
  expect(result.receiptTimingBlockedEvents).toBe(1);
  expect(result.fillDetails.map((fill) => [fill.timestamp, fill.queueAheadBefore, fill.size])).toEqual([[2_100, 2, 3]]);
  expect(result.assumptions.fillRule).toContain("not a proven inclusion block");
});

test("one frozen update survives refreshes and remains pending at end with its submitted cost", () => {
  const result = replayDepth([book(1_000), book(2_000), book(3_000)],
    { ...options, quoteActivationDelayMs: 2_500, gasUsdPerUpdate: 1 }, []);
  expect(result.quoteUpdates).toBe(1);
  expect(result.quoteUpdatesApplied).toBe(0);
  expect(result.pendingQuoteUpdateAtEnd).toBe(true);
  expect(result.refreshesSkippedWhileUpdatePending).toBe(2);
  expect(result.gasCostsUsd).toBe(1);
  expect(result.endingCashUsd).toBe(9_999);
});

test("delayed cancellation gas cannot consume the old bid's reserved cash", () => {
  const result = replayDepth([book(1_000), book(2_000, 100, 102), book(3_000, 100, 102)],
    { ...options, startingCash: 995, gasUsdPerUpdate: 5 }, [trade(2_250, 99, 11)]);
  expect(result.gasBlockedUpdates).toBeGreaterThan(0);
  expect(result.gasCostsUsd).toBe(5);
  expect(result.fillDetails.map((fill) => fill.size)).toEqual([10]);
  expect(result.endingCashUsd).toBe(0);
});

test("midpoint observation spanning application cannot establish a fill on the replaced quote", () => {
  const result = replayDepth([book(1_000), book(2_000, 97, 99), book(3_000, 97, 99)], options);
  expect(result.fills).toBe(0);
  expect(result.midpointReplacementAmbiguities).toBe(1);
});

test("zero latency applies immediately and retains original queue-proxy outcomes", () => {
  const result = replayDepth([book(1_000), book(2_000), book(3_000)],
    { ...options, quoteActivationDelayMs: 0 }, [trade(1_500, 99, 3), trade(2_500, 99, 4)]);
  expect(result.fillDetails.map((fill) => [fill.timestamp, fill.quoteTimestamp, fill.size])).toEqual([[1_500, 1_000, 2], [2_500, 2_000, 3]]);
  expect(result.quoteUpdatesApplied).toBe(result.quoteUpdates);
  expect(result.quoteUpdatesReverted).toBe(0);
  expect(result.pendingQuoteUpdateAtEnd).toBe(false);
  expect(result.replacementBoundaryBlockedEvents).toBe(0);
  expect(result.assumptions.executionScope).toContain("root execution submits one placement");
});

test("inventory diagnostics retain an intrainterval peak when a later opposing fill reduces exposure", () => {
  const result = replayDepth([book(1_000), book(2_000)], { ...options, startingMon: 10 },
    [trade(1_750, 99, 11), trade(1_800, 101, 11, "buy")]);
  expect(result.endingMon).toBe(10);
  expect(result.maxAbsInventoryMon).toBe(20);
});

test("invalid capital and backwards captured blocks cannot establish resource or receipt bounds", () => {
  expect(() => replayDepth([book(1_000), book(2_000)], { ...options, startingCash: Infinity }, [])).toThrow("Invalid backtest assumptions");
  expect(() => replayDepth([book(1_000), { ...book(2_000), block: 99 }], options, [])).toThrow("blocks must not move backwards");
});
