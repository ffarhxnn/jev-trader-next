import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import { expandReceiptVerifiedKuruTrades, type CanonicalMarketTradeLog, type SuccessfulTradeReceipt } from "../src/chain-trade-reconstruction";
import { KURU_TRADE_TOPIC } from "../src/receipt-verification";

const market = "0x1111111111111111111111111111111111111111";
const txHash = `0x${"a".repeat(64)}`;
const blockHash = `0x${"b".repeat(64)}`;
const eventData = ethers.utils.defaultAbiCoder.encode(
  ["uint40", "address", "bool", "uint256", "uint96", "address", "address", "uint96"],
  [7, `0x${"2".repeat(40)}`, true, "27800000000000000", "990000000000", `0x${"3".repeat(40)}`, `0x${"4".repeat(40)}`, "100000000000"],
);
const log: CanonicalMarketTradeLog = {
  address: market, topics: [KURU_TRADE_TOPIC], data: eventData, blockNumber: 100, blockHash,
  transactionHash: txHash, transactionIndex: 2, logIndex: 9,
};
const receipt: SuccessfulTradeReceipt = {
  transactionHash: txHash, blockNumber: 100, blockHash, status: 1, logs: [log],
};
function reconstruct(overrides: {
  logs?: CanonicalMarketTradeLog[];
  receipts?: Map<string, SuccessfulTradeReceipt>;
  blockTimestampsSeconds?: Map<number, number>;
} = {}) {
  return expandReceiptVerifiedKuruTrades({
    logs: overrides.logs ?? [log],
    receipts: overrides.receipts ?? new Map([[txHash, receipt]]),
    blockTimestampsSeconds: overrides.blockTimestampsSeconds ?? new Map([[100, 1_790_000_000]]),
    market, sizePrecision: 10_000_000_000, clockOffsetMs: 900,
  });
}

describe("receipt-verified Kuru chain trade reconstruction", () => {
  test("uses exact receipt logs, executed fill size, side, block time and provenance", () => {
    expect(reconstruct()).toEqual([{
      timestamp: 1_790_000_000_900, price: 0.0278, size: 10, takerSide: "buy",
      rawPrice: "27800000000000000", rawSize: "100000000000", transactionHash: txHash,
      sourceTimestamp: "1790000000", receiptVerified: true, receiptBlock: 100, receiptLogIndex: 9,
      receiptChainId: 143, receiptMarket: market,
    }]);
  });

  test("fails closed on missing, reverted, or canonical-mismatched receipts", () => {
    expect(() => reconstruct({ receipts: new Map() })).toThrow(/successful canonical transaction receipt/);
    expect(() => reconstruct({ receipts: new Map([[txHash, { ...receipt, status: 0 }]]) })).toThrow(/successful canonical transaction receipt/);
    expect(() => reconstruct({ receipts: new Map([[txHash, { ...receipt, blockHash: `0x${"c".repeat(64)}` }]]) })).toThrow(/disagree on the canonical block/);
  });

  test("rejects a query log that differs from the receipt event", () => {
    const altered = { ...log, data: `0x${"00".repeat(256)}` };
    expect(() => reconstruct({ logs: [altered] })).toThrow(/does not exactly match its receipt/);
  });

  test("rejects an incomplete RPC log result when the receipt contains another market Trade log", () => {
    const extra = { ...log, logIndex: 10, transactionIndex: 2 };
    const receiptWithTwo: SuccessfulTradeReceipt = { ...receipt, logs: [log, extra] };
    expect(() => reconstruct({ receipts: new Map([[txHash, receiptWithTwo]]) })).toThrow(/log set is incomplete/);
  });

  test("requires valid block times and rejects duplicate or wrong-market query logs", () => {
    expect(() => reconstruct({ blockTimestampsSeconds: new Map() })).toThrow(/missing its verified block timestamp/);
    expect(() => reconstruct({ logs: [log, log] })).toThrow(/Duplicate market Trade log/);
    expect(() => reconstruct({ logs: [{ ...log, address: `0x${"5".repeat(40)}` }] })).toThrow(/invalid canonical provenance/);
  });
});
