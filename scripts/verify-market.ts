import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import { qualifyKuruBook } from "../src/market-qualification";

const args = Bun.argv.slice(2);
const readArg = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const usage = "Usage: bun scripts/verify-market.ts --rpc <read-only-rpc-url> --chain-id <143|10143> --market <orderbook-address> [--require-two-sided]";
const rpcUrl = readArg("--rpc"), market = readArg("--market"), chainId = Number(readArg("--chain-id"));
if (args.includes("--help") || !rpcUrl || !market || ![143, 10143].includes(chainId)) {
  console.log(usage);
  process.exit(args.includes("--help") ? 0 : 2);
}
if (!ethers.utils.isAddress(market)) throw new Error("Market address is invalid.");
const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, chainId);
const actualChain = Number.parseInt(await provider.send("eth_chainId", []), 16);
if (actualChain !== chainId) throw new Error(`RPC chain mismatch: expected ${chainId}, received ${actualChain}.`);
const code = await provider.getCode(market);
if (code === "0x") throw new Error("No contract code exists at this market address on the selected chain.");
const params = await Kuru.ParamFetcher.getMarketParams(provider, market);
const book = await Kuru.OrderBook.getFormattedL2OrderBook(provider, market, params);
const toString = (value: { toString(): string }) => value.toString();
// The SDK currently returns both sides in descending order; normalize asks so
// the reported top of book is actually the lowest ask.
const topBids = [...book.bids].sort((a, b) => b[0] - a[0]).slice(0, 5);
const topAsks = [...book.asks].sort((a, b) => a[0] - b[0]).slice(0, 5);
const bookQualification = qualifyKuruBook(topBids, topAsks);
const requireTwoSided = args.includes("--require-two-sided");
console.log(JSON.stringify({
  evidenceStatus: "READ_ONLY_MARKET_CHECK",
  chainId: actualChain,
  market,
  codeBytes: (code.length - 2) / 2,
  marketParameters: {
    baseAsset: params.baseAssetAddress, baseAssetDecimals: toString(params.baseAssetDecimals),
    quoteAsset: params.quoteAssetAddress, quoteAssetDecimals: toString(params.quoteAssetDecimals),
    tickSizeRaw: toString(params.tickSize), sizePrecision: toString(params.sizePrecision),
    minSizeRaw: toString(params.minSize), maxSizeRaw: toString(params.maxSize),
    makerFeeBps: toString(params.makerFeeBps), takerFeeBps: toString(params.takerFeeBps),
  },
  observedAtBlock: book.blockNumber,
  topBids,
  topAsks,
  bookQualification,
  bookTestability: actualChain === 10143 && bookQualification.twoSidedPositiveDepth ? "TWO_SIDED_BOOK_ONLY" : "NOT_TWO_SIDED_BOOK",
  executionEnabled: false,
}, null, 2));
if (requireTwoSided && !bookQualification.twoSidedPositiveDepth) {
  console.error(`Market book is ${bookQualification.state}; two-sided positive depth is required for this check.`);
  process.exitCode = 3;
}
