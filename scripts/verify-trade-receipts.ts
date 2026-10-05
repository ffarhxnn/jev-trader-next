import { readFile, writeFile } from "node:fs/promises";
import { providers } from "ethers";
import { parseDepthJsonl, parseTradeJsonl } from "../src/research";
import { verifyTradeReceipt } from "../src/receipt-verification";

const args = process.argv.slice(2);
const expandedIndex = args.indexOf("--expanded-tape");
const expandedTapePath = expandedIndex >= 0 ? args[expandedIndex + 1] : undefined;
const [tradePath, depthPath] = args;
if (!tradePath || !depthPath) {
  console.error("Usage: bun run verify:receipts -- <trade-tape.jsonl> <depth-capture.jsonl> [--expanded-tape output.jsonl]");
  process.exit(2);
}
if (expandedIndex >= 0 && !expandedTapePath) { console.error("--expanded-tape requires a JSONL output path."); process.exit(2); }

try {
  const [tradeText, depthText] = await Promise.all([readFile(tradePath, "utf8"), readFile(depthPath, "utf8")]);
  const tape = parseTradeJsonl(tradeText);
  const trades = [...tape.events, ...tape.ignored].filter((trade) => trade.transactionHash);
  const depth = parseDepthJsonl(depthText);
  const market = depth.find((snapshot) => snapshot.market)?.market;
  const sizePrecision = depth.find((snapshot) => snapshot.sizePrecision)?.sizePrecision;
  if (!trades.length) throw new Error("No trades with transaction hashes were found in the capture.");
  if (!market || !sizePrecision) throw new Error("The depth capture must include market and sizePrecision metadata.");

  const provider = new providers.JsonRpcProvider(process.env.READ_RPC_URL ?? "https://rpc.monad.xyz");
  let network;
  try { network = await provider.getNetwork(); }
  catch { throw new Error("Could not verify the read-only RPC chain id; check the endpoint and network connection."); }
  if (network.chainId !== 143) throw new Error(`RPC chain mismatch: expected Monad 143, received ${network.chainId}.`);
  const groups = new Map<string, typeof trades>();
  for (const trade of trades) {
    const hash = trade.transactionHash!.toLowerCase();
    groups.set(hash, [...(groups.get(hash) ?? []), trade]);
  }
  const results: Array<{ transactionHash: string; verdict: string; [key: string]: unknown }> = [];
  for (const [hash, group] of groups) {
    if (group.some((trade) => trade.rawPrice === undefined || trade.rawSize === undefined)) {
      results.push({ transactionHash: hash, verdict: "RAW_FIELDS_UNAVAILABLE" });
      continue;
    }
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      results.push({ transactionHash: hash, ...verifyTradeReceipt(group, receipt, market, sizePrecision) });
    } catch {
      results.push({ transactionHash: hash, verdict: "LOOKUP_ERROR", error: "Read-only RPC receipt lookup failed." });
    }
  }
  let expandedCount = 0;
  if (expandedTapePath) {
    const rows = tradeText.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
    const byHash = new Map(groups);
    const records: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      if (row.kind === "status" || row.kind === "gap" || row.kind === "ignored" && typeof row.transactionHash !== "string") records.push(row);
      else if (row.kind === "trade" && typeof row.transactionHash !== "string") records.push({ kind: "ignored", timestamp: row.timestamp, reason: "trade has no transaction hash for receipt-enriched replay" });
    }
    for (const result of results) {
      const group = byHash.get(result.transactionHash) ?? [];
      const timestamp = Math.min(...group.map((trade) => trade.timestamp));
      const sourceTimestamp = group.find((trade) => trade.sourceTimestamp)?.sourceTimestamp;
      const tradeFills = Array.isArray(result.tradeFills) ? result.tradeFills as { rawPrice: string; rawSize: string; takerSide: "buy" | "sell"; logIndex: number }[] : [];
      if (result.verdict === "ALL_FEED_TRADES_MATCHED" && typeof result.receiptBlock === "number") {
        for (const fill of tradeFills) {
          records.push({ kind: "trade", timestamp, price: Number(BigInt(fill.rawPrice)) / 1e18, size: Number(BigInt(fill.rawSize)) / sizePrecision,
            takerSide: fill.takerSide, rawPrice: fill.rawPrice, rawSize: fill.rawSize,
            transactionHash: result.transactionHash, ...(typeof sourceTimestamp === "string" ? { sourceTimestamp } : {}),
            receiptVerified: true, receiptBlock: result.receiptBlock, receiptLogIndex: fill.logIndex,
            receiptChainId: network.chainId, receiptMarket: market.toLowerCase() });
          expandedCount++;
        }
      } else if (group.length) records.push({ kind: "ignored", timestamp, reason: `trade receipt not reconciled: ${result.verdict}` });
    }
    records.sort((a, b) => Number(a.timestamp) - Number(b.timestamp) || Number(a.receiptLogIndex ?? -1) - Number(b.receiptLogIndex ?? -1));
    await writeFile(expandedTapePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
  }
  const transactions = results.map(({ tradeFills: _tradeFills, ...result }) => result);
  console.log(JSON.stringify({
    evidenceStatus: "PUBLIC_RECEIPT_RECONCILIATION_ONLY",
    chainId: network.chainId, market, uniqueTransactions: results.length,
    ...(expandedTapePath ? { expandedTapePath, expandedTradeEvents: expandedCount } : {}),
    verdictCounts: Object.fromEntries([...new Set(results.map((result) => result.verdict))].map((verdict) => [verdict, results.filter((result) => result.verdict === verdict).length])),
    interpretation: "A matching Kuru Trade event proves only that the public feed trade is present in a successful Monad transaction receipt. It does not validate a local paper fill, queue priority, or a live order.",
    transactions,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
