import { describe, expect, test } from "bun:test";
import { assertReceiptVerifiedReplay, defaultBacktestOptions, normalizeIgnoredKuruTrade, normalizeKuruTrade, parseDepthJsonl, parseKuruRawMessage, parseTradeJsonl, replayDepth, selectDepthReplayRange, selectTradeFeedRowsForRange, selectTradeReplayRange, selectTradeReplayWindow, tradeReplayEvidenceStatus } from "../src/research";
import type { DepthSnapshot } from "../src/types";

const depth = (timestamp: number, bid: number, ask: number): DepthSnapshot => ({
  timestamp, block: timestamp, bids: [[bid, 100]], asks: [[ask, 100]],
});

describe("read-only L2 research replay", () => {
  test("selects a continuous depth interval without relying on auxiliary WebSocket coverage", () => {
    const rows = [
      depth(1_000, 99, 101), depth(2_000, 99, 101), depth(3_000, 99, 101),
      depth(4_000, 99, 101), depth(5_000, 99, 101),
    ].map((row) => ({ ...row, chainId: 143, market: `0x${"1".repeat(40)}`, captureIntervalMs: 1_000 }));
    const result = selectDepthReplayRange(rows, 1_000, 5_000, 4_000);
    expect(result?.snapshots.map((row) => row.timestamp)).toEqual([1_000, 2_000, 3_000, 4_000, 5_000]);
    expect(result?.window).toEqual({ startTimestamp: 1_000, endTimestamp: 5_001 });
    expect(selectDepthReplayRange(rows, 1_000, 5_000, 4_002)).toBeNull();
  });

  test("refuses explicit depth ranges crossing recorder, timestamp, or market-metadata gaps", () => {
    const base = [1_000, 2_000, 3_000, 4_000, 5_000].map((timestamp) => ({
      ...depth(timestamp, 99, 101), chainId: 143, market: `0x${"1".repeat(40)}`, captureIntervalMs: 1_000,
    }));
    const recorderGap = base.map((row, index) => index === 3 ? { ...row, gapBefore: true } : row);
    const timeGap = base.map((row, index) => index === 3 ? { ...row, timestamp: 9_000, block: 9_000 } : row);
    const marketChange = base.map((row, index) => index === 3 ? { ...row, market: `0x${"2".repeat(40)}` } : row);
    for (const rows of [recorderGap, timeGap, marketChange]) {
      expect(selectDepthReplayRange(rows, 1_000, 9_000)).toBeNull();
    }
    expect(() => selectDepthReplayRange(base, 2_000, 1_000)).toThrow("end after start");
  });

  test("distinguishes no replayable trade evidence from a midpoint-only proxy", () => {
    expect(tradeReplayEvidenceStatus(false, 0, 0)).toBe("MIDPOINT_CROSS_THROUGH_PROXY");
    expect(tradeReplayEvidenceStatus(true, 3, 0)).toBe("PUBLIC_TRADE_QUEUE_PROXY");
    expect(tradeReplayEvidenceStatus(true, 0, 5)).toBe("NO_REPLAYABLE_TRADES_IN_SELECTED_WINDOW");
    expect(tradeReplayEvidenceStatus(true, 0, 0)).toBe("NO_TRADE_EVENTS_IN_SELECTED_WINDOW");
  });

  test("receipt-required replay rejects unverified or unreconciled trade evidence", () => {
    const market = `0x${"1".repeat(40)}`;
    const verified = [{ timestamp: 2, price: 99.9, size: 7, takerSide: "sell" as const,
      transactionHash: `0x${"f".repeat(64)}`, receiptVerified: true as const, receiptBlock: 12, receiptLogIndex: 4,
      receiptChainId: 143, receiptMarket: market }];
    expect(() => assertReceiptVerifiedReplay(verified, 0, 143, market)).not.toThrow();
    expect(() => assertReceiptVerifiedReplay([], 0, 143, market)).toThrow("no usable trade events");
    expect(() => assertReceiptVerifiedReplay([{ ...verified[0]!, receiptVerified: undefined }], 0, 143, market)).toThrow("without complete verified receipt provenance");
    expect(() => assertReceiptVerifiedReplay(verified, 1, 143, market)).toThrow("ignored feed event");
    expect(() => assertReceiptVerifiedReplay(verified, 0, 10143, market)).toThrow("without complete verified receipt provenance");
    expect(() => assertReceiptVerifiedReplay([{ ...verified[0]!, receiptMarket: `0x${"2".repeat(40)}` }], 0, 143, market)).toThrow("without complete verified receipt provenance");
  });

  test("can select the newest uninterrupted tape window as well as the longest", () => {
    const segments = [
      [depth(1_000, 99, 101), depth(2_000, 99, 101), depth(3_000, 99, 101)],
      [depth(9_000, 99, 101), depth(10_000, 99, 101)],
    ];
    const coverage = [{ startTimestamp: 0, endTimestamp: 4_000 }, { startTimestamp: 8_000, endTimestamp: 11_000 }];
    expect(selectTradeReplayWindow(coverage, segments, "longest")).toMatchObject({
      window: { startTimestamp: 1_000, endTimestamp: 3_001 },
      snapshots: expect.arrayContaining([expect.objectContaining({ timestamp: 1_000 })]),
    });
    expect(selectTradeReplayWindow(coverage, segments, "latest")).toMatchObject({
      window: { startTimestamp: 9_000, endTimestamp: 10_001 },
      snapshots: expect.arrayContaining([expect.objectContaining({ timestamp: 10_000 })]),
    });
    expect(selectTradeReplayWindow([{ startTimestamp: 0, endTimestamp: Number.POSITIVE_INFINITY }], segments, "latest")?.window)
      .toEqual({ startTimestamp: 9_000, endTimestamp: 10_001 });
    expect(selectTradeReplayWindow(coverage, segments, "latest", 1_500)?.window)
      .toEqual({ startTimestamp: 1_000, endTimestamp: 3_001 });
    expect(selectTradeReplayWindow(coverage, segments, "latest", 5_000)).toBeNull();
    expect(() => selectTradeReplayWindow(coverage, segments, "latest", -1)).toThrow("finite and nonnegative");
    expect(selectTradeReplayWindow([], segments, "latest")).toBeNull();
  });

  test("selects exact inclusive UTC replay bounds and rejects gaps or invalid ranges", () => {
    const snapshots = [1_000, 2_000, 3_000, 4_000, 5_000].map((timestamp) => depth(timestamp, 99, 101));
    const coverage = [{ startTimestamp: 0, endTimestamp: 8_000 }];
    expect(selectTradeReplayRange(coverage, [snapshots], 2_000, 4_000)).toMatchObject({
      window: { startTimestamp: 2_000, endTimestamp: 4_001 },
      snapshots: [expect.objectContaining({ timestamp: 2_000 }), expect.objectContaining({ timestamp: 3_000 }), expect.objectContaining({ timestamp: 4_000 })],
    });
    expect(selectTradeReplayRange(coverage, [snapshots], 2_000, 4_000, 2_002)).toBeNull();
    expect(selectTradeReplayRange(coverage, [snapshots.slice(0, 2), snapshots.slice(3)], 1_000, 5_000)).toBeNull();
    expect(() => selectTradeReplayRange(coverage, [snapshots], 2_000, 2_000)).toThrow("end after start");
    expect(() => selectTradeReplayRange(coverage, [snapshots], Number.NaN, 4_000)).toThrow("finite bounds");
    expect(() => selectTradeReplayRange(coverage, [snapshots], 2_000, 4_000, -1)).toThrow("finite and nonnegative");
  });

  test("exact feed slices retain their connection marker and exclude earlier or later trades", () => {
    const rows = [
      { kind: "status", status: "connected", timestamp: 0 },
      { kind: "trade", timestamp: 500, price: 100, size: 1, takerSide: "buy" },
      { kind: "ignored", timestamp: 1_000, reason: "side unavailable" },
      { kind: "trade", timestamp: 1_500, price: 100, size: 1, takerSide: "sell" },
      { kind: "gap", timestamp: 4_000, reason: "feed gap" },
      { kind: "trade", timestamp: 4_500, price: 100, size: 1, takerSide: "buy" },
    ];
    const contents = rows.map((row) => JSON.stringify(row)).join("\n");
    expect(selectTradeFeedRowsForRange(contents, { startTimestamp: 0, endTimestamp: 5_000 }, { startTimestamp: 1_000, endTimestamp: 4_001 }))
      .toEqual([JSON.stringify(rows[0]), JSON.stringify(rows[2]), JSON.stringify(rows[3]), JSON.stringify(rows[4])]);
    expect(() => selectTradeFeedRowsForRange(contents, { startTimestamp: 5_000, endTimestamp: 0 }, { startTimestamp: 1_000, endTimestamp: 4_001 }))
      .toThrow("valid increasing bounds");
  });

  test("parses captured JSONL and rejects crossed or malformed snapshots", () => {
    const parsed = parseDepthJsonl(`${JSON.stringify(depth(1, 99, 101))}\n${JSON.stringify(depth(2, 99.5, 100.5))}\n`);
    expect(parsed).toHaveLength(2);
    expect(parseDepthJsonl(`${JSON.stringify({ ...depth(3, 99, 101), chainId: 143 })}\n`)[0]?.chainId).toBe(143);
    expect(() => parseDepthJsonl("{bad json}\n")).toThrow("Invalid JSON");
    expect(() => parseDepthJsonl(`${JSON.stringify(depth(1, 101, 99))}\n`)).toThrow("Invalid L2 snapshot");
    expect(() => parseDepthJsonl(`${JSON.stringify({ ...depth(1, 99, 101), chainId: -1 })}\n`)).toThrow("Invalid L2 snapshot");
  });

  test("replays cross-through fills, caps inventory, and deducts both-side fees", () => {
    const result = replayDepth([
      depth(1_000, 99.9, 100.1),
      depth(2_000, 99.7, 99.9), // Crosses prior bid by more than one tick.
      depth(3_000, 99.9, 100.1), // Crosses the newly quoted ask.
      depth(4_000, 99.9, 100.1),
    ], {
      startingCash: 10_000, startingMon: 0, orderSizeMon: 10, positionCapMon: 10,
      feeBps: 10, gasUsdPerUpdate: 0, tickSize: 0.01, baseHalfSpreadBps: 10, volatilityMultiplier: 1, quoteRefreshMs: 1_000,
    });
    expect(result.fills).toBe(2);
    expect(result.buyFills).toBe(1);
    expect(result.sellFills).toBe(1);
    expect(result.endingMon).toBe(0);
    expect(result.feesUsd).toBeGreaterThan(0);
    expect(result.netPnlUsd).toBeLessThan(result.grossPnlUsd);
    expect(result.evidenceStatus).toBe("RESEARCH_PROXY_ONLY");
    expect(result.fillDetails.map(({ matchRule }) => matchRule)).toEqual(["midpoint_cross_through_proxy", "midpoint_cross_through_proxy"]);
  });

  test("requires time-ordered observations and sound capital assumptions", () => {
    expect(() => replayDepth([depth(2, 99, 101), depth(2, 99, 101)])).toThrow("timestamps must increase");
    expect(() => replayDepth([depth(1, 99, 101), depth(2, 99, 101)], { startingCash: 1, startingMon: 0, orderSizeMon: 5, positionCapMon: 1, feeBps: 0, gasUsdPerUpdate: 0, tickSize: 0.01, baseHalfSpreadBps: 1, volatilityMultiplier: 1, quoteRefreshMs: 1_000 })).toThrow("Invalid backtest assumptions");
  });

  test("rejects research order sizes below the explicit venue minimum", () => {
    const snapshots = [depth(1_000, 99.9, 100.1), depth(2_000, 99.9, 100.1)];
    expect(() => replayDepth(snapshots, { ...defaultBacktestOptions, minimumOrderSizeMon: 200 })).toThrow("Invalid backtest assumptions");
    expect(replayDepth(snapshots, {
      ...defaultBacktestOptions, startingCash: 20, startingMon: 600, orderSizeMon: 200,
      minimumOrderSizeMon: 200, positionCapMon: 1_000,
    }).assumptions).toMatchObject({ startingCash: 20, startingMon: 600, orderSizeMon: 200, minimumOrderSizeMon: 200, positionCapMon: 1_000 });
  });

  test("charges configured gas once per simulated quote update", () => {
    const snapshots = [depth(1_000, 99.9, 100.1), depth(2_000, 99.9, 100.1)];
    const zeroGas = replayDepth(snapshots, { ...defaultBacktestOptions, startingCash: 5_000, quoteRefreshMs: 1_000 });
    const withGas = replayDepth(snapshots, { ...defaultBacktestOptions, startingCash: 5_000, quoteRefreshMs: 1_000, gasUsdPerUpdate: 2 });
    expect(withGas.quoteUpdates).toBe(1);
    expect(withGas.gasCostsUsd).toBe(2);
    expect(withGas.netPnlUsd).toBeCloseTo(zeroGas.netPnlUsd - 2);
    expect(withGas.grossPnlUsd).toBeCloseTo(zeroGas.grossPnlUsd);
  });

  test("trade replay waits for displayed queue ahead and supports partial fills", () => {
    const result = replayDepth([
      { ...depth(1, 99.9, 100.1), bids: [[99.9, 5]], asks: [[100.1, 2]] },
      { ...depth(3, 99.9, 100.1), bids: [[99.9, 5]], asks: [[100.1, 2]] },
    ], {
      startingCash: 10_000, startingMon: 0, orderSizeMon: 10, positionCapMon: 20,
      feeBps: 0, gasUsdPerUpdate: 0, tickSize: 0.01, baseHalfSpreadBps: 10, volatilityMultiplier: 1, quoteRefreshMs: 1_000,
    }, [
      { timestamp: 2, price: 99.9, size: 3, takerSide: "sell" },
      { timestamp: 2.5, price: 99.9, size: 7, takerSide: "sell", transactionHash: `0x${"f".repeat(64)}`, receiptVerified: true, receiptBlock: 12, receiptLogIndex: 4 },
    ]);
    expect(result.fills).toBe(1);
    expect(result.buyFills).toBe(1);
    expect(result.endingMon).toBe(5);
    expect(result.assumptions.fillRule).toContain("displayed queue-ahead");
    expect(result.fillDetails).toEqual([{ timestamp: 2.5, quoteTimestamp: 1, side: "buy", price: 99.9, size: 5,
      matchRule: "exact_price_trade_queue_proxy", queueAheadBefore: 2, queueConsumed: 2,
      trade: { timestamp: 2.5, price: 99.9, size: 7, takerSide: "sell", transactionHash: `0x${"f".repeat(64)}`, receiptVerified: true, receiptBlock: 12, receiptLogIndex: 4 } }]);
  });

  test("reports exact-side trades that stop at the displayed queue", () => {
    const result = replayDepth([
      { ...depth(1, 99.9, 100.1), bids: [[99.9, 5]], asks: [[100.1, 2]] },
      { ...depth(4, 99.9, 100.1), bids: [[99.9, 5]], asks: [[100.1, 2]] },
    ], {
      startingCash: 10_000, startingMon: 0, orderSizeMon: 10, positionCapMon: 20,
      feeBps: 0, gasUsdPerUpdate: 0, tickSize: 0.01, baseHalfSpreadBps: 10,
      volatilityMultiplier: 0, quoteRefreshMs: 1_000,
    }, [
      { timestamp: 2, price: 99.9, size: 3, takerSide: "sell" },
      { timestamp: 3, price: 99.9, size: 7, takerSide: "sell" },
    ]);
    expect(result.exactPriceSideMatches).toBe(2);
    expect(result.bidQuoteExactPriceMatches).toBe(2);
    expect(result.askQuoteExactPriceMatches).toBe(0);
    expect(result.queueOnlyTradeEvents).toBe(1);
    expect(result.riskBlockedTradeEvents).toBe(0);
    expect(result.fills).toBe(1);
    expect(result.fillDetails[0]?.size).toBe(5);
  });

  test("trade replay blocks matching prints before modeled quote activation", () => {
    const result = replayDepth([
      { ...depth(1_000, 99.9, 100.1), bids: [[99.9, 2]], asks: [[100.1, 2]] },
      { ...depth(3_000, 99.9, 100.1), bids: [[99.9, 2]], asks: [[100.1, 2]] },
    ], {
      startingCash: 10_000, startingMon: 0, orderSizeMon: 10, positionCapMon: 20,
      feeBps: 0, gasUsdPerUpdate: 0, tickSize: 0.01, baseHalfSpreadBps: 10,
      volatilityMultiplier: 1, quoteRefreshMs: 1_000, quoteActivationDelayMs: 1_000,
    }, [
      { timestamp: 1_500, price: 99.9, size: 20, takerSide: "sell" },
      { timestamp: 2_500, price: 99.9, size: 7, takerSide: "sell" },
    ]);
    expect(result.activationLatencyBlockedEvents).toBe(1);
    expect(result.exactPriceSideMatches).toBe(2);
    expect(result.fills).toBe(1);
    expect(result.fillDetails[0]?.timestamp).toBe(2_500);
    expect(result.assumptions.quoteActivationDelayMs).toBe(1_000);
  });

  test("receipt-verified trade replay excludes same-or-earlier-block fills", () => {
    const market = `0x${"1".repeat(40)}`;
    const hash = `0x${"f".repeat(64)}`;
    const result = replayDepth([
      { ...depth(1, 99.9, 100.1), block: 100, bids: [[99.9, 5]], asks: [[100.1, 2]] },
      { ...depth(3, 99.9, 100.1), block: 102, bids: [[99.9, 5]], asks: [[100.1, 2]] },
    ], {
      startingCash: 10_000, startingMon: 0, orderSizeMon: 10, positionCapMon: 20,
      feeBps: 0, gasUsdPerUpdate: 0, tickSize: 0.01, baseHalfSpreadBps: 10, volatilityMultiplier: 1, quoteRefreshMs: 1_000,
    }, [
      { timestamp: 2, price: 99.9, size: 20, takerSide: "sell", transactionHash: hash, receiptVerified: true, receiptBlock: 100, receiptLogIndex: 1, receiptChainId: 143, receiptMarket: market },
      { timestamp: 2.5, price: 99.9, size: 7, takerSide: "sell", transactionHash: hash, receiptVerified: true, receiptBlock: 101, receiptLogIndex: 2, receiptChainId: 143, receiptMarket: market },
    ]);
    expect(result.receiptTimingBlockedEvents).toBe(1);
    expect(result.exactPriceSideMatches).toBe(2);
    expect(result.fills).toBe(1);
    expect(result.fillDetails.map((fill) => fill.size)).toEqual([2]);
    expect(result.fillDetails[0]?.trade?.receiptBlock).toBe(101);
    expect(result.assumptions.fillRule).toContain("within-block order is unknown");
  });

  test("trade tape parser records uninterrupted feed windows and gaps", () => {
    const tape = parseTradeJsonl([
      JSON.stringify({ kind: "status", status: "connected", timestamp: 10 }),
      JSON.stringify({ kind: "trade", timestamp: 11, price: 1, size: 2, takerSide: "sell", transactionHash: `0x${"a".repeat(64)}`, sourceTimestamp: "1790000000123", rawPrice: "1000000000000000000", rawSize: "20000000000", receiptVerified: true, receiptBlock: 22, receiptLogIndex: 3, receiptChainId: 143, receiptMarket: `0x${"1".repeat(40)}` }),
      JSON.stringify({ kind: "ignored", timestamp: 11.5, reason: "missing side", transactionHash: `0x${"c".repeat(64)}`, rawPrice: "1000000000000000000", rawSize: "20000000000", sourceTimestamp: "1790000000123" }),
      JSON.stringify({ kind: "gap", timestamp: 12, reason: "disconnect" }),
      JSON.stringify({ kind: "status", status: "connected", timestamp: 20 }),
      JSON.stringify({ kind: "trade", timestamp: 21, price: 1, size: 1, takerSide: "buy" }),
    ].join("\n"));
    expect(tape.coverage).toEqual([{ startTimestamp: 10, endTimestamp: 12 }, { startTimestamp: 20, endTimestamp: Infinity }]);
    expect(tape.events).toHaveLength(2);
    expect(tape.events[0]?.transactionHash).toBe(`0x${"a".repeat(64)}`);
    expect(tape.events[0]?.sourceTimestamp).toBe("1790000000123");
    expect(tape.events[0]?.receiptVerified).toBe(true);
    expect(tape.events[0]?.receiptLogIndex).toBe(3);
    expect(tape.events[1]?.transactionHash).toBeUndefined();
    expect(tape.ignored).toHaveLength(1);
    expect(tape.ignored[0]).toEqual({ timestamp: 11.5, reason: "missing side", transactionHash: `0x${"c".repeat(64)}`, rawPrice: "1000000000000000000", rawSize: "20000000000", sourceTimestamp: "1790000000123" });
  });

  test("trade tape parser rejects verified markers without block, log, and transaction provenance", () => {
    expect(() => parseTradeJsonl(JSON.stringify({ kind: "trade", timestamp: 1, price: 1, size: 2,
      takerSide: "sell", receiptVerified: true })) ).toThrow("Incomplete verified receipt provenance");
  });

  test("normalizes Kuru raw trade scales and taker direction", () => {
    expect(normalizeKuruTrade({ e: "Trade", p: "27800000000000000", s: "100000000000", ib: false }, 10_000_000_000, 12)).toEqual({ timestamp: 12, price: 0.0278, size: 10, takerSide: "sell", rawPrice: "27800000000000000", rawSize: "100000000000" });
    expect(normalizeKuruTrade({ e: "OrderCanceled" }, 10_000_000_000, 12)).toBeNull();
    expect(normalizeKuruTrade({ e: "Trade", p: "27800000000000000", s: "100000000000" }, 10_000_000_000, 12)).toBeNull();
    expect(() => normalizeKuruTrade({ e: "Trade", p: 1e22, s: "1", ib: true }, 1, 12)).toThrow("safe JSON number precision");
  });

  test("preserves Kuru transaction provenance without interpreting source timestamp", () => {
    const hash = `0x${"b".repeat(64)}`;
    const parsed = parseKuruRawMessage(`{"e":"Trade","p":27800000000000000,"s":100000000000,"ib":false,"ts":1790000000123456789,"th":"${hash}"}`) as Record<string, unknown>;
    expect(parsed.ts).toBe("1790000000123456789");
    expect(normalizeKuruTrade(parsed, 10_000_000_000, 12)).toEqual({ timestamp: 12, price: 0.0278, size: 10, takerSide: "sell", rawPrice: "27800000000000000", rawSize: "100000000000", transactionHash: hash, sourceTimestamp: "1790000000123456789" });
  });

  test("normalizes the installed Kuru SDK named trade-event fields without using remaining order size", () => {
    const hash = `0x${"a".repeat(64)}`;
    const event = { orderId: 9, makerAddress: `0x${"1".repeat(40)}`, takerAddress: `0x${"2".repeat(40)}`, isBuy: true, price: "27800000000000000", updatedSize: "990000000000", filledSize: "100000000000", transactionHash: hash, triggerTime: 1790000000123 };
    expect(normalizeKuruTrade(event, 10_000_000_000, 12)).toEqual({
      timestamp: 12, price: 0.0278, size: 10, takerSide: "buy", rawPrice: "27800000000000000",
      rawSize: "100000000000", transactionHash: hash, sourceTimestamp: "1790000000123",
    });
    expect(normalizeIgnoredKuruTrade({ ...event, isBuy: undefined }, 12)).toMatchObject({
      transactionHash: hash, rawPrice: "27800000000000000", rawSize: "100000000000", sourceTimestamp: "1790000000123",
    });
    expect(normalizeKuruTrade({ e: "OrderCreated", ...event }, 10_000_000_000, 12)).toBeNull();
  });

  test("keeps only minimal public receipt fields for an ignored Kuru trade", () => {
    const hash = `0x${"d".repeat(64)}`;
    const evidence = normalizeIgnoredKuruTrade({ e: "Trade", p: "27800000000000000", s: "100000000000", ts: "1790000000123", th: hash, maker: "0x1234" }, 12);
    expect(evidence).toEqual({ timestamp: 12, reason: "trade lacks a reliable taker side or price/size", rawPrice: "27800000000000000", rawSize: "100000000000", sourceTimestamp: "1790000000123", transactionHash: hash });
    expect(normalizeIgnoredKuruTrade({ e: "OrderCanceled" }, 12)).toBeNull();
    expect(normalizeIgnoredKuruTrade({ e: "Trade", p: 1e22, s: "not-a-number", th: "0x1234" }, 12)).toEqual({ timestamp: 12, reason: "trade lacks a reliable taker side or price/size" });
  });

  test("preserves large raw Kuru price and size tokens through JSON parsing", () => {
    const parsed = parseKuruRawMessage('{"events":[{"e":"Trade","p":27571000000000000000,"s":152570599999999990000,"ib":true}]}') as { events: Array<{ p: string; s: string }> };
    expect(parsed.events[0]!.p).toBe("27571000000000000000");
    expect(parsed.events[0]!.s).toBe("152570599999999990000");
    const trade = normalizeKuruTrade({ e: "Trade", p: parsed.events[0]!.p, s: parsed.events[0]!.s, ib: true }, 10_000_000_000, 12)!;
    expect(trade.price).toBe(27.571);
    expect(trade.size).toBeCloseTo(15_257_060_000, 2);
    expect(trade.takerSide).toBe("buy");
  });

  test("preserves large named WssTradeEvent integers through JSON parsing", () => {
    const parsed = parseKuruRawMessage('{"events":[{"e":"Trade","price":27800000000000000,"filledSize":100000000000,"isBuy":true}]}') as { events: Array<{ price: string; filledSize: string }> };
    expect(parsed.events[0]!.price).toBe("27800000000000000");
    expect(parsed.events[0]!.filledSize).toBe("100000000000");
  });
});
