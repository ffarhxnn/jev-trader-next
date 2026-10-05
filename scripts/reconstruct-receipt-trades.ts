import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { parseDepthJsonl } from "../src/research";
import { assertFinalizedReconstructionReceipts, expandReceiptVerifiedKuruTrades, type CanonicalMarketTradeLog, type SuccessfulTradeReceipt } from "../src/chain-trade-reconstruction";
import { KURU_TRADE_TOPIC } from "../src/receipt-verification";
import { KURU_MAINNET_MARKET_IMPLEMENTATION, KURU_MAINNET_MON_USDC_MARKET } from "../src/kuru-mainnet-readiness";

const args = process.argv.slice(2);
if (args.includes("--help") || args.length !== 2) {
  console.log("Usage: bun scripts/reconstruct-receipt-trades.ts <continuous-depth-window.jsonl> <output-trades.jsonl>");
  process.exit(args.includes("--help") ? 0 : 2);
}
const [depthPathArg, outputPathArg] = args as [string, string];
const depthPath = resolve(depthPathArg);
const outputPath = resolve(outputPathArg);
const snapshots = parseDepthJsonl(readFileSync(depthPath, "utf8"));
if (snapshots.length < 2) throw new Error("At least two continuous L2 snapshots are required.");
const first = snapshots[0]!;
const last = snapshots.at(-1)!;
if (first.chainId !== 143 || first.market?.toLowerCase() !== KURU_MAINNET_MON_USDC_MARKET.toLowerCase()
  || snapshots.some((row, index) => row.chainId !== 143 || row.market?.toLowerCase() !== first.market!.toLowerCase()
    || index > 0 && (row.gapBefore || row.tickSize !== first.tickSize || row.sizePrecision !== first.sizePrecision || row.minSizeMon !== first.minSizeMon || row.makerFeeBps !== first.makerFeeBps))) {
  throw new Error("Depth input must be one uninterrupted chain-143 capture segment with stable market parameters for the pinned Kuru MON-USDC market.");
}
const sizePrecision = Number(first.sizePrecision);
if (!(sizePrecision > 0) || !Number.isSafeInteger(first.block) || !Number.isSafeInteger(last.block) || last.block < first.block) {
  throw new Error("Depth capture is missing a valid precision or ordered source blocks.");
}

const rpcUrl = process.env.READ_RPC_URL ?? "https://rpc.monad.xyz";
const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, 143);
const actualChainId: unknown = await provider.send("eth_chainId", []);
if (typeof actualChainId !== "string" || !/^0x[\da-f]+$/i.test(actualChainId) || Number.parseInt(actualChainId.slice(2), 16) !== 143) {
  throw new Error("Public reconstruction RPC did not explicitly confirm Monad chain 143.");
}
const network = await provider.getNetwork();
if (network.chainId !== 143) throw new Error("Trade-log reconstruction requires verified Monad mainnet chain 143.");
const market = KURU_MAINNET_MON_USDC_MARKET;
const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const upgradedTopic = ethers.utils.id("Upgraded(address)");
const calibrationIndices = [...new Set([0, Math.floor((snapshots.length - 1) / 4), Math.floor((snapshots.length - 1) / 2), Math.floor(3 * (snapshots.length - 1) / 4), snapshots.length - 1])];
const calibrationBlocks = [...new Set(calibrationIndices.map((index) => snapshots[index]!.block))];
for (const block of [...new Set([first.block, last.block, ...calibrationBlocks])]) {
  const slot = await provider.getStorageAt(market, implementationSlot, block);
  const implementation = ethers.utils.getAddress(`0x${slot.slice(-40)}`);
  if (implementation.toLowerCase() !== KURU_MAINNET_MARKET_IMPLEMENTATION.toLowerCase()) {
    throw new Error(`Kuru market implementation differs from the audited pin at block ${block}.`);
  }
}
if (await provider.getCode(market, first.block) === "0x" || await provider.getCode(KURU_MAINNET_MARKET_IMPLEMENTATION, first.block) === "0x") {
  throw new Error("Pinned Kuru market deployment has no code at the capture's start block.");
}

const queriedLogs: CanonicalMarketTradeLog[] = [];
let upgradeEvents = 0;
for (let from = first.block; from <= last.block; from += 100) {
  const to = Math.min(last.block, from + 99);
  const logs = await provider.getLogs({ address: market, topics: [[KURU_TRADE_TOPIC, upgradedTopic]], fromBlock: from, toBlock: to });
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() === upgradedTopic.toLowerCase()) { upgradeEvents++; continue; }
    if (log.topics[0]?.toLowerCase() !== KURU_TRADE_TOPIC.toLowerCase()) throw new Error("Unexpected event topic in filtered Kuru market log query.");
    queriedLogs.push(log as CanonicalMarketTradeLog);
  }
}
if (upgradeEvents) throw new Error(`Kuru market emitted ${upgradeEvents} implementation upgrade event(s) in the capture window; review before replay.`);
if (!queriedLogs.length) throw new Error("No Kuru Trade logs were found between the captured L2 source blocks.");

const uniqueTransactionHashes = [...new Set(queriedLogs.map((log) => log.transactionHash.toLowerCase()))];
const receipts = new Map<string, SuccessfulTradeReceipt>();
let receiptCursor = 0;
const receiptWorkers = Array.from({ length: Math.min(8, uniqueTransactionHashes.length) }, async () => {
  while (receiptCursor < uniqueTransactionHashes.length) {
    const hash = uniqueTransactionHashes[receiptCursor++]!;
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) throw new Error("A queried Kuru Trade transaction has no receipt.");
    receipts.set(hash, receipt as SuccessfulTradeReceipt);
  }
});
await Promise.all(receiptWorkers);

const blockNumbers = [...new Set([...calibrationBlocks, ...queriedLogs.map((log) => log.blockNumber)])];
// Select commitment before canonical inclusion reads; provisional old-branch evidence cannot precede it.
const finalized = await provider.send("eth_getBlockByNumber", ["finalized", false]);
const finalizedHeight = typeof finalized?.number === "string" && /^0x[\da-f]+$/i.test(finalized.number)
  ? Number.parseInt(finalized.number.slice(2), 16) : NaN;
if (!Number.isSafeInteger(finalizedHeight) || finalizedHeight < last.block || typeof finalized?.hash !== "string" || !/^0x[\da-f]{64}$/i.test(finalized.hash)) {
  throw new Error("The complete reconstruction capture must be covered by a valid finalized commitment before canonical block reads.");
}
const blocks = new Map<number, ethers.providers.Block>();
let blockCursor = 0;
const blockWorkers = Array.from({ length: Math.min(8, blockNumbers.length) }, async () => {
  while (blockCursor < blockNumbers.length) {
    const number = blockNumbers[blockCursor++]!;
    const block = await provider.getBlock(number);
    if (!block || block.number !== number) throw new Error(`Could not verify canonical block ${number} for trade timestamps.`);
    blocks.set(number, block);
  }
});
await Promise.all(blockWorkers);
assertFinalizedReconstructionReceipts(receipts, blocks, finalized);
for (const log of queriedLogs) {
  if (blocks.get(log.blockNumber)?.hash.toLowerCase() !== log.blockHash.toLowerCase()) throw new Error("A Kuru Trade log changed canonical block during reconstruction.");
}
const clockOffsets = calibrationIndices.map((index) => {
  const row = snapshots[index]!;
  const block = blocks.get(row.block);
  if (!block) throw new Error("Missing L2 calibration block header.");
  return row.timestamp - block.timestamp * 1_000;
}).sort((a, b) => a - b);
const clockOffsetMs = clockOffsets[Math.floor(clockOffsets.length / 2)]!;
const maxClockOffsetResidualMs = Math.max(...clockOffsets.map((offset) => Math.abs(offset - clockOffsetMs)));
if (maxClockOffsetResidualMs > 5_000) throw new Error("Capture and chain timestamps disagree by more than five seconds; refuse timestamp alignment.");
const blockTimestampsSeconds = new Map([...blocks].map(([number, block]) => [number, block.timestamp]));
const trades = expandReceiptVerifiedKuruTrades({ logs: queriedLogs, receipts, blockTimestampsSeconds, market, sizePrecision, clockOffsetMs })
  .map(trade => ({ ...trade, receiptFinalizedVerified: true }));

const rows: Record<string, unknown>[] = [
  { kind: "status", status: "connected", timestamp: first.timestamp },
  ...trades.map((trade) => ({ kind: "trade", ...trade })),
  { kind: "gap", timestamp: last.timestamp + 1, reason: "end of reconstructed receipt-verified block window" },
].sort((a, b) => Number(a.timestamp) - Number(b.timestamp) || Number(a.receiptBlock ?? -1) - Number(b.receiptBlock ?? -1) || Number(a.receiptLogIndex ?? -1) - Number(b.receiptLogIndex ?? -1));
writeFileSync(outputPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
chmodSync(outputPath, 0o600);
console.log(JSON.stringify({
  evidenceStatus: "RECEIPT_VERIFIED_MARKET_LOG_RECONSTRUCTION",
  chainId: network.chainId, market, implementation: KURU_MAINNET_MARKET_IMPLEMENTATION,
  capture: { startTimestamp: first.timestamp, endTimestamp: last.timestamp, snapshots: snapshots.length, fromBlock: first.block, toBlock: last.block },
  tradeLogs: queriedLogs.length, uniqueTransactions: uniqueTransactionHashes.length,
  verifiedEvents: trades.length, receiptFailures: 0, upgradeEvents,
  finalizedVerification: { block: finalizedHeight, hash: finalized.hash, exactTransactionIndex: true, canonicalBlocksReadAfterCommitment: true },
  clockAlignment: { sampleCount: clockOffsets.length, medianOffsetMs: clockOffsetMs, maxResidualMs: maxClockOffsetResidualMs },
  outputPath,
  interpretation: "Every emitted event came from a market Trade log matched exactly to a successful canonical transaction receipt. Event timestamps use chain block time plus a measured capture-clock offset. This verifies public trades, not local fills, hidden queue state, or profitability.",
}, null, 2));
