import { utils } from "ethers";
import type { Side } from "./types";

export const KURU_TRADE_TOPIC = utils.id("Trade(uint40,address,bool,uint256,uint96,address,address,uint96)");

export interface ReceiptLog { address: string; topics: string[]; data: string; logIndex?: number }
export interface TradeReceipt { transactionHash: string; blockNumber: number; status: number | null; logs: ReceiptLog[] }
export type ReceiptVerdict = "RAW_FIELDS_UNAVAILABLE" | "NOT_FOUND" | "REVERTED" | "NO_MATCHING_MARKET_TRADE" | "PARTIAL_MATCH" | "ALL_FEED_TRADES_MATCHED";
export interface FeedTradeObservation {
  transactionHash?: string;
  rawPrice?: string;
  rawSize?: string;
  takerSide?: Side;
}

export function verifyTradeReceipt(trades: FeedTradeObservation[], receipt: TradeReceipt | null, market: string, sizePrecision: number) {
  if (!trades.length || trades.some((trade) => !trade.transactionHash || !/^0x[\da-fA-F]{64}$/.test(trade.transactionHash))) throw new Error("Receipt verification requires trades with valid transaction hashes.");
  if (!/^0x[\da-fA-F]{40}$/.test(market) || !(sizePrecision > 0) || !Number.isFinite(sizePrecision)) throw new Error("Invalid market address or size precision.");
  if (trades.some((trade) => trade.rawPrice === undefined || trade.rawSize === undefined)) return { verdict: "RAW_FIELDS_UNAVAILABLE" as const, receiptBlock: null, expectedTrades: trades.length, matchingEvents: 0, tradeFills: [] };
  if (!receipt) return { verdict: "NOT_FOUND" as const, receiptBlock: null, expectedTrades: trades.length, matchingEvents: 0, tradeFills: [] };
  const hash = trades[0]!.transactionHash!.toLowerCase();
  if (trades.some((trade) => trade.transactionHash!.toLowerCase() !== hash) || receipt.transactionHash.toLowerCase() !== hash) throw new Error("Trade and receipt transaction hashes do not agree.");
  if (receipt.status !== 1) return { verdict: "REVERTED" as const, receiptBlock: receipt.blockNumber, expectedTrades: trades.length, matchingEvents: 0, tradeFills: [] };

  const onChainBySide = new Map<boolean, { size: bigint; notional: bigint }>();
  const onChainTotal = { size: 0n, notional: 0n };
  const tradeFills: { rawPrice: string; rawSize: string; takerSide: "buy" | "sell"; logIndex: number }[] = [];
  receipt.logs.forEach((log, receiptIndex) => {
    if (log.address.toLowerCase() !== market.toLowerCase() || log.topics[0]?.toLowerCase() !== KURU_TRADE_TOPIC.toLowerCase()) return;
    try {
      const [orderId, taker, isBuy, price, size, maker, owner, filledSize] = utils.defaultAbiCoder.decode(
        ["uint40", "address", "bool", "uint256", "uint96", "address", "address", "uint96"], log.data,
      );
      void orderId; void taker; void size; void maker; void owner;
      const side = Boolean(isBuy);
      const amount = BigInt((filledSize as { toString(): string }).toString());
      const rawPrice = (price as { toString(): string }).toString();
      tradeFills.push({ rawPrice, rawSize: amount.toString(), takerSide: side ? "buy" : "sell", logIndex: log.logIndex ?? receiptIndex });
      const total = onChainBySide.get(side) ?? { size: 0n, notional: 0n };
      total.size += amount;
      total.notional += BigInt(rawPrice) * amount;
      onChainBySide.set(side, total);
      onChainTotal.size += amount;
      onChainTotal.notional += BigInt(rawPrice) * amount;
    } catch { /* malformed unrelated log; it contributes no evidence */ }
  });
  const feedBySide = new Map<boolean, { size: bigint; notional: bigint; eventCount: number }>();
  const feedTotal = { size: 0n, notional: 0n };
  for (const trade of trades) {
    const amount = BigInt(trade.rawSize!);
    const price = BigInt(trade.rawPrice!);
    feedTotal.size += amount;
    feedTotal.notional += price * amount;
    if (trade.takerSide) {
      const side = trade.takerSide === "buy";
      const expected = feedBySide.get(side) ?? { size: 0n, notional: 0n, eventCount: 0 };
      expected.size += amount;
      expected.notional += price * amount;
      expected.eventCount++;
      feedBySide.set(side, expected);
    }
  }
  const notionalTolerance = (actual: { size: bigint; notional: bigint } | undefined, expected: { size: bigint; notional: bigint }) => {
    if (expected.size <= 0n) return 0n;
    const feedMeanRawPrice = Number(expected.notional / expected.size);
    const receiptMeanRawPrice = actual && actual.size > 0n ? Number(actual.notional / actual.size) : feedMeanRawPrice;
    const referenceRawPrice = Math.max(Math.abs(feedMeanRawPrice), Math.abs(receiptMeanRawPrice));
    // Kuru's feed may serialize a Number-derived WAD price. Allow one binary64 spacing at that magnitude, with a two-unit floor for exact integer producers.
    const floatUnits = Number.isFinite(referenceRawPrice) ? BigInt(Math.ceil(Number.EPSILON * referenceRawPrice)) : 2n;
    const units = floatUnits > 2n ? floatUnits : 2n;
    return units * expected.size;
  };
  const totalsMatch = (actual: { size: bigint; notional: bigint } | undefined, expected: { size: bigint; notional: bigint }) => {
    const difference = actual && (actual.notional > expected.notional ? actual.notional - expected.notional : expected.notional - actual.notional);
    return Boolean(actual && actual.size === expected.size && difference! <= notionalTolerance(actual, expected));
  };
  let matchingEvents = 0;
  if (totalsMatch(onChainTotal, feedTotal) && [...feedBySide].every(([side, expected]) => totalsMatch(onChainBySide.get(side), expected))) {
    // Chain logs provide the taker side when the websocket omitted it. Exact aggregate size/notional
    // plus every known-side subtotal must match before accepting any observations in the transaction.
    matchingEvents = trades.length;
  }
  const verdict: ReceiptVerdict = matchingEvents === trades.length ? "ALL_FEED_TRADES_MATCHED" : matchingEvents > 0 ? "PARTIAL_MATCH" : "NO_MATCHING_MARKET_TRADE";
  if (verdict !== "ALL_FEED_TRADES_MATCHED") {
    const notionalDifference = onChainTotal.notional > feedTotal.notional ? onChainTotal.notional - feedTotal.notional : feedTotal.notional - onChainTotal.notional;
    const knownSideTotalsMatch = [...feedBySide].every(([side, expected]) => totalsMatch(onChainBySide.get(side), expected));
    return {
      verdict, receiptBlock: receipt.blockNumber, expectedTrades: trades.length, matchingEvents,
      tradeFills: [],
      mismatch: {
        matchingMarketTradeLogs: tradeFills.length,
        feedSizeRaw: feedTotal.size.toString(), receiptSizeRaw: onChainTotal.size.toString(),
        feedNotionalRaw: feedTotal.notional.toString(), receiptNotionalRaw: onChainTotal.notional.toString(),
        notionalDifferenceRaw: notionalDifference.toString(), notionalToleranceRaw: notionalTolerance(onChainTotal, feedTotal).toString(),
        sizeTotalsMatch: onChainTotal.size === feedTotal.size, knownSideTotalsMatch,
      },
    };
  }
  return { verdict, receiptBlock: receipt.blockNumber, expectedTrades: trades.length, matchingEvents, tradeFills };
}
