import { describe, expect, test } from "bun:test";
import { utils } from "ethers";
import { KURU_TRADE_TOPIC, verifyTradeReceipt, type TradeReceipt } from "../src/receipt-verification";
import type { TradeEvent } from "../src/types";

const market = "0x1111111111111111111111111111111111111111";
const hash = `0x${"a".repeat(64)}`;
const trade: TradeEvent = { timestamp: 12, price: 0.0278, size: 10, takerSide: "buy", transactionHash: hash, rawPrice: "27800000000000000", rawSize: "100000000000" };
const eventLog = (filled: string, price = trade.rawPrice!, side = true) => ({
  address: market, topics: [KURU_TRADE_TOPIC],
  data: utils.defaultAbiCoder.encode(["uint40", "address", "bool", "uint256", "uint96", "address", "address", "uint96"], [1, market, side, price, 999, market, market, filled]),
});
const receipt: TradeReceipt = {
  transactionHash: hash, blockNumber: 123, status: 1,
  logs: [eventLog(trade.rawSize!)],
};

describe("public Kuru trade receipt reconciliation", () => {
  test("matches exact raw price, size, direction, and market Trade log", () => {
    expect(verifyTradeReceipt([trade], receipt, market, 10_000_000_000)).toEqual({ verdict: "ALL_FEED_TRADES_MATCHED", receiptBlock: 123, expectedTrades: 1, matchingEvents: 1,
      tradeFills: [{ rawPrice: trade.rawPrice!, rawSize: trade.rawSize!, takerSide: "buy", logIndex: 0 }] });
  });

  test("does not accept a trade log from another contract or with mismatched event fields", () => {
    expect(verifyTradeReceipt([trade], receipt, "0x2222222222222222222222222222222222222222", 10_000_000_000).verdict).toBe("NO_MATCHING_MARKET_TRADE");
    expect(verifyTradeReceipt([{ ...trade, rawSize: "100000000001" }], receipt, market, 10_000_000_000).verdict).toBe("NO_MATCHING_MARKET_TRADE");
  });

  test("explains why an unmatched feed event failed receipt reconciliation", () => {
    const result = verifyTradeReceipt([{ ...trade, rawSize: "100000000001" }], receipt, market, 10_000_000_000);
    expect(result).toMatchObject({ verdict: "NO_MATCHING_MARKET_TRADE", mismatch: {
      matchingMarketTradeLogs: 1,
      feedSizeRaw: "100000000001", receiptSizeRaw: "100000000000",
      sizeTotalsMatch: false, knownSideTotalsMatch: false,
    } });
  });

  test("matches a feed weighted price across multiple on-chain fill prices", () => {
    const splitReceipt = { ...receipt, logs: [eventLog("50000000000", "27700000000000000"), eventLog("50000000000", "27900000000000000")] };
    expect(verifyTradeReceipt([trade], splitReceipt, market, 10_000_000_000).verdict).toBe("ALL_FEED_TRADES_MATCHED");
  });

  test("uses receipt side only after exact raw totals match for a feed event missing taker side", () => {
    const { takerSide: _side, ...unknownSideTrade } = trade;
    expect(verifyTradeReceipt([unknownSideTrade], receipt, market, 10_000_000_000)).toEqual({ verdict: "ALL_FEED_TRADES_MATCHED", receiptBlock: 123, expectedTrades: 1, matchingEvents: 1,
      tradeFills: [{ rawPrice: trade.rawPrice!, rawSize: trade.rawSize!, takerSide: "buy", logIndex: 0 }] });
    expect(verifyTradeReceipt([unknownSideTrade], { ...receipt, logs: [eventLog("100000000001")] }, market, 10_000_000_000).verdict).toBe("NO_MATCHING_MARKET_TRADE");
  });

  test("rejects unrelated opposite-side market activity in the same receipt", () => {
    expect(verifyTradeReceipt([trade], { ...receipt, logs: [eventLog(trade.rawSize!), eventLog("1", trade.rawPrice!, false)] }, market, 10_000_000_000).verdict).toBe("NO_MATCHING_MARKET_TRADE");
  });

  test("allows one binary64 spacing of WAD feed-price rounding but rejects larger discrepancies", () => {
    const withinFloatPrecision = { ...receipt, logs: [eventLog(trade.rawSize!, (BigInt(trade.rawPrice!) + 5n).toString())] };
    const outsideFloatPrecision = { ...receipt, logs: [eventLog(trade.rawSize!, (BigInt(trade.rawPrice!) + 8n).toString())] };
    expect(verifyTradeReceipt([trade], withinFloatPrecision, market, 10_000_000_000).verdict).toBe("ALL_FEED_TRADES_MATCHED");
    expect(verifyTradeReceipt([trade], outsideFloatPrecision, market, 10_000_000_000).verdict).toBe("NO_MATCHING_MARKET_TRADE");
  });

  test("reports missing and reverted receipts separately", () => {
    expect(verifyTradeReceipt([trade], null, market, 10_000_000_000).verdict).toBe("NOT_FOUND");
    expect(verifyTradeReceipt([trade], { ...receipt, status: 0 }, market, 10_000_000_000).verdict).toBe("REVERTED");
  });

  test("does not mislabel legacy normalized-only records as chain mismatches", () => {
    const { rawPrice: _rawPrice, rawSize: _rawSize, ...legacyTrade } = trade;
    expect(verifyTradeReceipt([legacyTrade], receipt, market, 10_000_000_000).verdict).toBe("RAW_FIELDS_UNAVAILABLE");
  });
});
