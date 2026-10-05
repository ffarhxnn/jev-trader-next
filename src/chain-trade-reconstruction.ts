import { utils } from "ethers";
import { KURU_TRADE_TOPIC } from "./receipt-verification";
import type { TradeEvent } from "./types";

export interface CanonicalMarketTradeLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  removed?: boolean;
}

export interface SuccessfulTradeReceipt {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  status: number | null;
  transactionIndex?: number;
  logs: CanonicalMarketTradeLog[];
}

/** Reject a new reconstruction unless every successful receipt has finalized canonical inclusion. */
export function assertFinalizedReconstructionReceipts(
  receipts: ReadonlyMap<string, SuccessfulTradeReceipt>,
  blocks: ReadonlyMap<number, { number: number; hash: string; transactions: string[] }>,
  finalized: { number: unknown; hash: unknown },
): void {
  const hash = /^0x[\da-fA-F]{64}$/;
  const height = typeof finalized?.number === "number" ? finalized.number
    : typeof finalized?.number === "string" && /^0x[\da-fA-F]+$/.test(finalized.number) ? Number.parseInt(finalized.number.slice(2), 16) : NaN;
  if (!receipts.size || !Number.isSafeInteger(height) || height < 1 || typeof finalized?.hash !== "string" || !hash.test(finalized.hash)) {
    throw new Error("Reconstruction has no valid finalized commitment or receipt evidence.");
  }
  for (const [identity, receipt] of receipts) {
    const block = blocks.get(receipt.blockNumber), index = receipt.transactionIndex;
    if (!hash.test(identity) || receipt.transactionHash.toLowerCase() !== identity.toLowerCase() || receipt.status !== 1
      || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 1 || receipt.blockNumber > height
      || !hash.test(receipt.blockHash) || !block || block.number !== receipt.blockNumber || !hash.test(block.hash)
      || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase() || !Number.isSafeInteger(index) || Number(index) < 0
      || !Array.isArray(block.transactions) || !block.transactions.every(tx => typeof tx === "string" && hash.test(tx))
      || block.transactions.filter(tx => tx.toLowerCase() === identity.toLowerCase()).length !== 1
      || block.transactions[index!]?.toLowerCase() !== identity.toLowerCase()
      || receipt.blockNumber === height && finalized.hash.toLowerCase() !== block.hash.toLowerCase()
      || receipt.logs.some(log => log.removed === true || log.blockNumber !== receipt.blockNumber
        || log.blockHash.toLowerCase() !== block.hash.toLowerCase() || log.transactionHash.toLowerCase() !== identity.toLowerCase()
        || log.transactionIndex !== index)) {
      throw new Error("A reconstructed receipt lacks exact finalized canonical transaction-index inclusion.");
    }
  }
}

/** Expand the complete Trade-log set only after every log is matched to a successful canonical receipt. */
export function expandReceiptVerifiedKuruTrades(input: {
  logs: CanonicalMarketTradeLog[];
  receipts: ReadonlyMap<string, SuccessfulTradeReceipt>;
  blockTimestampsSeconds: ReadonlyMap<number, number>;
  market: string;
  sizePrecision: number;
  clockOffsetMs: number;
}): TradeEvent[] {
  const { logs, receipts, blockTimestampsSeconds, market, sizePrecision, clockOffsetMs } = input;
  if (!/^0x[\da-fA-F]{40}$/.test(market) || !(sizePrecision > 0) || !Number.isFinite(sizePrecision)
    || !Number.isFinite(clockOffsetMs)) throw new Error("Invalid chain trade reconstruction metadata.");
  const marketLower = market.toLowerCase();
  const byTransaction = new Map<string, CanonicalMarketTradeLog[]>();
  const uniqueLogs = new Set<string>();
  for (const log of logs) {
    if (log.removed === true || log.address.toLowerCase() !== marketLower
      || log.topics[0]?.toLowerCase() !== KURU_TRADE_TOPIC.toLowerCase()
      || !/^0x[\da-fA-F]{64}$/.test(log.transactionHash) || !/^0x[\da-fA-F]{64}$/.test(log.blockHash)
      || !Number.isSafeInteger(log.blockNumber) || log.blockNumber < 1
      || !Number.isSafeInteger(log.transactionIndex) || log.transactionIndex < 0
      || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) {
      throw new Error("Market Trade log has invalid canonical provenance.");
    }
    const hash = log.transactionHash.toLowerCase();
    const key = `${hash}:${log.logIndex}`;
    if (uniqueLogs.has(key)) throw new Error("Duplicate market Trade log returned by the chain query.");
    uniqueLogs.add(key);
    byTransaction.set(hash, [...(byTransaction.get(hash) ?? []), log]);
  }
  if (!logs.length) throw new Error("No Kuru Trade logs were returned for reconstruction.");

  const trades: TradeEvent[] = [];
  for (const [hash, expectedLogs] of byTransaction) {
    const receipt = receipts.get(hash);
    if (!receipt || receipt.transactionHash.toLowerCase() !== hash || receipt.status !== 1
      || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 1
      || !/^0x[\da-fA-F]{64}$/.test(receipt.blockHash)) {
      throw new Error("A Kuru Trade log has no matching successful canonical transaction receipt.");
    }
    if (expectedLogs.some((log) => log.blockNumber !== receipt.blockNumber || log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase())) {
      throw new Error("A Kuru Trade log and its receipt disagree on the canonical block.");
    }
    const receiptLogs = receipt.logs.filter((log) => log.address.toLowerCase() === marketLower
      && log.topics[0]?.toLowerCase() === KURU_TRADE_TOPIC.toLowerCase());
    const receiptByIndex = new Map(receiptLogs.map((log) => [log.logIndex, log]));
    if (receiptByIndex.size !== expectedLogs.length) throw new Error("The queried Kuru Trade log set is incomplete for a transaction receipt.");
    for (const log of expectedLogs) {
      const canonical = receiptByIndex.get(log.logIndex);
      if (!canonical || canonical.transactionHash.toLowerCase() !== hash || canonical.blockNumber !== log.blockNumber
        || canonical.transactionIndex !== log.transactionIndex || canonical.blockHash.toLowerCase() !== log.blockHash.toLowerCase()
        || canonical.address.toLowerCase() !== log.address.toLowerCase()
        || canonical.data.toLowerCase() !== log.data.toLowerCase()
        || canonical.topics.length !== log.topics.length
        || canonical.topics.some((topic, index) => topic.toLowerCase() !== log.topics[index]?.toLowerCase())) {
        throw new Error("A queried Kuru Trade log does not exactly match its receipt log.");
      }
      const blockTimestamp = blockTimestampsSeconds.get(log.blockNumber);
      if (!Number.isSafeInteger(blockTimestamp) || Number(blockTimestamp) < 1) throw new Error("A Kuru Trade log is missing its verified block timestamp.");
      let decoded: utils.Result;
      try {
        decoded = utils.defaultAbiCoder.decode(
          ["uint40", "address", "bool", "uint256", "uint96", "address", "address", "uint96"], log.data,
        );
      } catch {
        throw new Error("A Kuru Trade log has malformed event data.");
      }
      const rawPrice = BigInt(decoded[3].toString());
      const rawSize = BigInt(decoded[7].toString());
      const price = Number(rawPrice) / 1e18;
      const size = Number(rawSize) / sizePrecision;
      const timestamp = Number(blockTimestamp) * 1_000 + clockOffsetMs;
      if (rawPrice <= 0n || rawSize <= 0n || !Number.isFinite(price) || !Number.isFinite(size) || !Number.isSafeInteger(timestamp)) {
        throw new Error("A Kuru Trade log contains an invalid price, size, or aligned timestamp.");
      }
      trades.push({ timestamp, price, size, takerSide: decoded[2] ? "buy" : "sell", rawPrice: rawPrice.toString(), rawSize: rawSize.toString(),
        transactionHash: hash, sourceTimestamp: String(blockTimestamp), receiptVerified: true,
        receiptBlock: receipt.blockNumber, receiptLogIndex: log.logIndex, receiptChainId: 143, receiptMarket: marketLower });
    }
  }
  trades.sort((a, b) => a.receiptBlock! - b.receiptBlock! || a.receiptLogIndex! - b.receiptLogIndex!);
  return trades;
}
