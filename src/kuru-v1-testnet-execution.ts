import { BigNumber, ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import type { Book, Side } from "./types";
import { qualifyKuruBook } from "./market-qualification";

/** Allowlisted legacy Kuru v1 testnet market listed by Kuru. No private-key signer is accepted. */
export const KURU_V1_TESTNET_CHAIN_ID = 10143;
export const KURU_V1_TESTNET_MARKET = "0xa241896A7Dbe8a550D2E5fF7A914bB1989ceD2D9";
export const KURU_V1_TESTNET_MARGIN_ACCOUNT = "0xd029C2D98ff85D8F64799017fE00a59B1159CE02";
/** EIP-1967 implementations observed on Kuru's listed testnet deployments. */
export const KURU_V1_TESTNET_MARKET_IMPLEMENTATION = "0x72caE0a99C19B574e8a6De558F43fc1D019c9374";
export const KURU_V1_TESTNET_MARGIN_IMPLEMENTATION = "0xF10af40F060b7AE54a2d5DA682BecC981DFB52C3";
/** Quote token listed by Kuru for its MON-USDC testnet market. */
export const KURU_V1_TESTNET_QUOTE = "0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BPS = 10_000n;
const approvedOrderPlans = new WeakSet<object>();
const verifiedMarginSnapshots = new WeakSet<object>();
const verifiedMarketSnapshots = new WeakSet<object>();
const verifiedBooks = new WeakSet<object>();
const marginBalanceInterface = new ethers.utils.Interface(["function getBalance(address user,address token) view returns (uint256)"]);
const marketParamsInterface = new ethers.utils.Interface(["function getMarketParams() view returns (uint32,uint96,address,uint256,address,uint256,uint32,uint96,uint96,uint256,uint256)"]);
const marketBookInterface = new ethers.utils.Interface(["function getL2Book() view returns (bytes)"]);

export interface KuruV1MarketPrecision {
  market: string;
  baseAssetAddress: string;
  quoteAssetAddress: string;
  baseAssetDecimals: number;
  quoteAssetDecimals: number;
  pricePrecision: string;
  sizePrecision: string;
  tickSizeRaw: string;
  minSizeRaw: string;
  maxSizeRaw: string;
  takerFeeBps: string;
  makerFeeBps: string;
}

export interface VerifiedKuruV1MarketSnapshot extends KuruV1MarketPrecision {
  observedBlock: number;
}

/** Read deployed market precision, assets, size bounds, and maker fee at one testnet block. */
export async function readKuruV1TestnetMarketSnapshot(
  provider: ethers.providers.JsonRpcProvider,
): Promise<VerifiedKuruV1MarketSnapshot> {
  const observedBlock = await verifiedTestnetProvider(provider);
  if (!Number.isSafeInteger(observedBlock) || observedBlock < 1) throw new Error("Kuru testnet RPC returned an invalid market snapshot block.");
  await verifyTestnetImplementation(provider, KURU_V1_TESTNET_MARKET, KURU_V1_TESTNET_MARKET_IMPLEMENTATION, observedBlock, "market");
  const code = await provider.getCode(KURU_V1_TESTNET_MARKET, observedBlock);
  if (code === "0x") throw new Error("Allowlisted Kuru testnet market has no contract code at the verified block.");
  const marketContract = new ethers.Contract(KURU_V1_TESTNET_MARKET, marketParamsInterface, provider);
  const params = await marketContract.getMarketParams({ from: ZERO_ADDRESS, blockTag: observedBlock });
  const snapshot: VerifiedKuruV1MarketSnapshot = Object.freeze({
    market: KURU_V1_TESTNET_MARKET,
    pricePrecision: params[0].toString(), sizePrecision: params[1].toString(),
    baseAssetAddress: params[2], baseAssetDecimals: Number(params[3].toString()),
    quoteAssetAddress: params[4], quoteAssetDecimals: Number(params[5].toString()),
    tickSizeRaw: params[6].toString(), minSizeRaw: params[7].toString(), maxSizeRaw: params[8].toString(),
    takerFeeBps: params[9].toString(), makerFeeBps: params[10].toString(), observedBlock,
  });
  validateMarket(snapshot);
  verifiedMarketSnapshots.add(snapshot);
  return snapshot;
}

/** Read manual L2 plus Kuru AMM vault depth at the source book block. */
export async function readKuruV1TestnetBookSnapshot(
  provider: ethers.providers.JsonRpcProvider,
  market: VerifiedKuruV1MarketSnapshot,
  receivedAt = Date.now(),
): Promise<Book> {
  if (!verifiedMarketSnapshots.has(market)) throw new Error("A block-verified Kuru market-parameter snapshot is required to decode book depth.");
  if (!Number.isFinite(receivedAt)) throw new Error("Kuru book receipt time must be finite.");
  const observedBlock = await verifiedTestnetProvider(provider);
  if (market.observedBlock > observedBlock) throw new Error("Kuru market snapshot is ahead of this testnet RPC.");
  await verifyTestnetImplementation(provider, KURU_V1_TESTNET_MARKET, KURU_V1_TESTNET_MARKET_IMPLEMENTATION, observedBlock, "market");
  const bookContract = new ethers.Contract(KURU_V1_TESTNET_MARKET, marketBookInterface, provider);
  const encoded = await bookContract.getL2Book({ from: ZERO_ADDRESS, blockTag: observedBlock });
  if (typeof encoded !== "string" || !/^0x(?:[\da-f]{64})+$/i.test(encoded)) throw new Error("Kuru returned malformed L2 book bytes.");
  let cursor = 2;
  const word = () => {
    if (cursor + 64 > encoded.length) throw new Error("Kuru L2 book ended before its required side terminator.");
    const value = BigInt(`0x${encoded.slice(cursor, cursor + 64)}`);
    cursor += 64;
    return value;
  };
  const blockRaw = word();
  if (blockRaw < 1n || blockRaw > BigInt(Number.MAX_SAFE_INTEGER) || blockRaw > BigInt(observedBlock)) throw new Error("Kuru L2 book returned an invalid source block.");
  const priceDecimals = decimalsOfPrecision(market.pricePrecision, "pricePrecision");
  const sizeDecimals = decimalsOfPrecision(market.sizePrecision, "sizePrecision");
  const decodeSide = (): [number, number][] => {
    const levels: [number, number][] = [];
    while (cursor < encoded.length) {
      const price = word();
      if (price === 0n) return levels;
      const size = word();
      if (size === 0n) throw new Error("Kuru L2 book contains a zero-size level.");
      const numericPrice = Number(ethers.utils.formatUnits(price.toString(), priceDecimals));
      const numericSize = Number(ethers.utils.formatUnits(size.toString(), sizeDecimals));
      if (!(numericPrice > 0) || !(numericSize > 0) || !Number.isFinite(numericPrice + numericSize)) throw new Error("Kuru L2 book level is outside the supported numeric range.");
      levels.push([numericPrice, numericSize]);
    }
    throw new Error("Kuru L2 book ended before its side terminator.");
  };
  const manualBids = decodeSide();
  const manualAsks = decodeSide();
  if (cursor !== encoded.length) throw new Error("Kuru L2 book contains unexpected trailing data.");
  const sdkMarketParams = {
    pricePrecision: BigNumber.from(market.pricePrecision), sizePrecision: BigNumber.from(market.sizePrecision),
    baseAssetAddress: market.baseAssetAddress, baseAssetDecimals: BigNumber.from(market.baseAssetDecimals),
    quoteAssetAddress: market.quoteAssetAddress, quoteAssetDecimals: BigNumber.from(market.quoteAssetDecimals),
    tickSize: BigNumber.from(market.tickSizeRaw), minSize: BigNumber.from(market.minSizeRaw), maxSize: BigNumber.from(market.maxSizeRaw),
    takerFeeBps: BigNumber.from(market.takerFeeBps), makerFeeBps: BigNumber.from(market.makerFeeBps),
  };
  const combinedBook = await Kuru.OrderBook.getL2OrderBook(provider, KURU_V1_TESTNET_MARKET, sdkMarketParams, encoded);
  if (combinedBook.blockNumber !== Number(blockRaw)) throw new Error("Kuru SDK returned depth for a different source block.");
  if (combinedBook.manualOrders.bids.length !== manualBids.length || combinedBook.manualOrders.asks.length !== manualAsks.length) {
    throw new Error("Kuru SDK manual depth does not match the decoded on-chain L2 payload.");
  }
  const bids = combinedBook.bids as [number, number][];
  const asks = combinedBook.asks as [number, number][];
  const qualification = qualifyKuruBook(bids, asks);
  const bid = qualification.bestBid ?? 0;
  const ask = qualification.bestAsk ?? 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
  const snapshot: Book = Object.freeze({
    source: "Monad Kuru", chainId: KURU_V1_TESTNET_CHAIN_ID, block: Number(blockRaw), receivedAt,
    bid, ask, mid, spreadBps: mid > 0 && ask >= bid ? ((ask - bid) / mid) * 10_000 : 0,
    tickSize: Number(market.tickSizeRaw) / Number(market.pricePrecision),
    makerFeeBps: Number(market.makerFeeBps),
    bids: Object.freeze(bids.map((level) => Object.freeze(level))) as unknown as [number, number][],
    asks: Object.freeze(asks.map((level) => Object.freeze(level))) as unknown as [number, number][],
  });
  verifiedBooks.add(snapshot);
  return snapshot;
}

export interface TestnetMarginSnapshot {
  account: string;
  observedBlock: number;
  marginQuoteBalanceRaw: string;
  marginBaseBalanceRaw: string;
  maxPositionBaseRaw: string;
}

/** Read the account's Kuru-held MON and USDC balances at one verified testnet block. */
export async function readKuruV1TestnetMarginSnapshot(
  provider: ethers.providers.JsonRpcProvider,
  account: string,
  maxPositionBaseRaw: string,
): Promise<TestnetMarginSnapshot> {
  if (!validAddress(account)) throw new Error("Invalid margin account address.");
  const maxPosition = uint(maxPositionBaseRaw, "maxPositionBaseRaw");
  const observedBlock = await verifiedTestnetProvider(provider);
  if (!Number.isSafeInteger(observedBlock) || observedBlock < 1) throw new Error("Kuru testnet RPC returned an invalid margin snapshot block.");
  await verifyTestnetImplementation(provider, KURU_V1_TESTNET_MARGIN_ACCOUNT, KURU_V1_TESTNET_MARGIN_IMPLEMENTATION, observedBlock, "Margin Account");
  const code = await provider.getCode(KURU_V1_TESTNET_MARGIN_ACCOUNT, observedBlock);
  if (code === "0x") throw new Error("Official Kuru testnet Margin Account has no contract code at the verified block.");
  const margin = new ethers.Contract(KURU_V1_TESTNET_MARGIN_ACCOUNT, marginBalanceInterface, provider);
  const overrides = { from: ZERO_ADDRESS, blockTag: observedBlock };
  const [baseBalance, quoteBalance] = await Promise.all([
    margin.getBalance(account, ZERO_ADDRESS, overrides) as Promise<BigNumber>,
    margin.getBalance(account, KURU_V1_TESTNET_QUOTE, overrides) as Promise<BigNumber>,
  ]);
  const snapshot: TestnetMarginSnapshot = Object.freeze({
    account: ethers.utils.getAddress(account), observedBlock,
    marginQuoteBalanceRaw: quoteBalance.toString(), marginBaseBalanceRaw: baseBalance.toString(),
    maxPositionBaseRaw: maxPosition.toString(),
  });
  verifiedMarginSnapshots.add(snapshot);
  return snapshot;
}

export interface TestnetOrderRisk {
  desiredSize: string;
  maxNotionalQuoteRaw: string;
  maxSpreadBps: number;
  maxBookAgeMs: number;
  maxBalanceBlockLag: number;
  maxExecutionBlockLag: number;
}

export interface KuruV1TestnetOrderPlan {
  chainId: 10143;
  market: string;
  account: string;
  side: Side;
  block: number;
  bookReceivedAt: number;
  plannedAtMs: number;
  maxBookAgeMs: number;
  maxExecutionBlockLag: number;
  maxSpreadBps: number;
  priceRaw: string;
  sizeRaw: string;
  notionalQuoteRaw: string;
  makerFeeQuoteRaw: string;
  maxPositionBaseRaw: string;
}

export interface TestnetTransactionBudget {
  gasLimit: string;
  gasPriceWei: string;
  maxGasCostWei: string;
}

export interface UnsignedKuruTestnetTransaction {
  chainId: 10143;
  market: string;
  account: string;
  operation: "place_post_only_limit" | "cancel_orders";
  data: string;
  gasLimit: string;
  gasPriceWei: string;
  valueWei: "0";
  expectedOrder?: { side: Side; priceRaw: string; sizeRaw: string };
  expectedCancelOrderIds?: string[];
}

export interface UnsignedKuruTestnetBatchUpdate extends Omit<UnsignedKuruTestnetTransaction, "operation"> {
  operation: "batch_update_post_only_limit";
  preparationOnly: true;
  conformanceScope: "root_batch_update_calldata_policy_only";
  establishesExecutionLifecycle: false;
  interpretation: string;
}

function validAddress(value: string) { return /^0x[\da-fA-F]{40}$/.test(value); }
function uint(value: string, name: string, max = (1n << 256n) - 1n) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${name} must be a nonnegative integer string.`);
  const result = BigInt(value);
  if (result > max) throw new Error(`${name} is outside its supported integer range.`);
  return result;
}
function decimalsOfPrecision(value: string, name: string) {
  if (!/^10*$/.test(value)) throw new Error(`${name} must be a power of ten.`);
  return value.length - 1;
}
function parseDecimal(value: string, decimals: number, name: string): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${name} must be a plain nonnegative decimal string.`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`${name} has more decimal places than the market supports.`);
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}
function ceilDiv(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) throw new Error("Integer denominator must be positive.");
  return (numerator + denominator - 1n) / denominator;
}
function power10(decimals: number) { return 10n ** BigInt(decimals); }

function validateMarket(market: KuruV1MarketPrecision) {
  if (market.market.toLowerCase() !== KURU_V1_TESTNET_MARKET.toLowerCase()) throw new Error("Only the allowlisted legacy Kuru v1 testnet candidate is allowed.");
  if (!validAddress(market.market) || market.baseAssetAddress.toLowerCase() !== ZERO_ADDRESS || market.quoteAssetAddress.toLowerCase() !== KURU_V1_TESTNET_QUOTE.toLowerCase()) {
    throw new Error("Kuru v1 testnet market assets do not match the pinned candidate deployment.");
  }
  if (![market.baseAssetDecimals, market.quoteAssetDecimals].every((x) => Number.isSafeInteger(x) && x >= 0 && x <= 36)) throw new Error("Invalid Kuru token decimals.");
  const priceDecimals = decimalsOfPrecision(market.pricePrecision, "pricePrecision");
  const sizeDecimals = decimalsOfPrecision(market.sizePrecision, "sizePrecision");
  const tick = uint(market.tickSizeRaw, "tickSizeRaw");
  const minSize = uint(market.minSizeRaw, "minSizeRaw");
  const maxSize = uint(market.maxSizeRaw, "maxSizeRaw");
  const fee = uint(market.makerFeeBps, "makerFeeBps", BPS);
  const takerFee = uint(market.takerFeeBps, "takerFeeBps", BPS);
  if (tick <= 0n || minSize <= 0n || maxSize < minSize || fee > BPS || takerFee > BPS) throw new Error("Invalid Kuru v1 tick, size, or fee parameters.");
  return { priceDecimals, sizeDecimals, tick, minSize, maxSize, fee };
}

/**
 * Creates an offline risk-approved intent for one legacy Kuru v1 testnet order.
 * This does not sign or submit. It requires current two-sided public depth and
 * account margin observed at or after that book block.
 */
export function planKuruV1TestnetOrder(input: {
  chainId: number;
  book: Book;
  market: VerifiedKuruV1MarketSnapshot;
  margin: TestnetMarginSnapshot;
  risk: TestnetOrderRisk;
  side: Side;
  nowMs: number;
}): KuruV1TestnetOrderPlan {
  if (input.chainId !== KURU_V1_TESTNET_CHAIN_ID || input.book.chainId !== KURU_V1_TESTNET_CHAIN_ID) throw new Error("Kuru v1 order planning is restricted to Monad testnet chain 10143.");
  if (!verifiedMarginSnapshots.has(input.margin)) throw new Error("A block-verified Kuru Margin Account snapshot is required for order planning.");
  if (!verifiedMarketSnapshots.has(input.market)) throw new Error("A block-verified Kuru market-parameter snapshot is required for order planning.");
  if (!verifiedBooks.has(input.book)) throw new Error("A block-verified Kuru L2 book snapshot is required for order planning.");
  const precision = validateMarket(input.market);
  if (input.book.source !== "Monad Kuru" || input.book.block <= 0 || !Number.isSafeInteger(input.book.block)) throw new Error("A verified Kuru testnet book is required.");
  if (!Number.isFinite(input.nowMs) || input.book.receivedAt === undefined || !Number.isFinite(input.book.receivedAt) || input.nowMs < input.book.receivedAt
    || !Number.isSafeInteger(input.risk.maxBookAgeMs) || input.risk.maxBookAgeMs < 1 || input.nowMs - input.book.receivedAt > input.risk.maxBookAgeMs) {
    throw new Error("Kuru book is stale or has no trustworthy local receipt time.");
  }
  if (!Number.isSafeInteger(input.risk.maxExecutionBlockLag) || input.risk.maxExecutionBlockLag < 0) throw new Error("Invalid maximum execution block lag.");
  if (!Number.isSafeInteger(input.risk.maxBalanceBlockLag) || input.risk.maxBalanceBlockLag < 0
    || !Number.isSafeInteger(input.market.observedBlock) || input.market.observedBlock < input.book.block
    || input.market.observedBlock - input.book.block > input.risk.maxBalanceBlockLag
    || !Number.isSafeInteger(input.margin.observedBlock) || input.margin.observedBlock < input.book.block
    || input.margin.observedBlock - input.book.block > input.risk.maxBalanceBlockLag) {
    throw new Error("Kuru market or margin snapshot is stale relative to the book.");
  }
  if (!validAddress(input.margin.account)) throw new Error("Invalid margin account address.");
  if (!input.book.bids?.length || !input.book.asks?.length || !qualifyKuruBook(input.book.bids, input.book.asks).twoSidedPositiveDepth) {
    throw new Error("A two-sided positive-depth Kuru book is required for post-only order planning.");
  }
  const bestBidDepth = Math.max(...input.book.bids.filter((level) => level[0] > 0 && level[1] > 0).map(([price]) => price));
  const bestAskDepth = Math.min(...input.book.asks.filter((level) => level[0] > 0 && level[1] > 0).map(([price]) => price));
  if (input.book.bid !== bestBidDepth || input.book.ask !== bestAskDepth) throw new Error("Kuru top-of-book fields do not match the captured depth levels.");
  if (!(input.side === "buy" || input.side === "sell")) throw new Error("Unsupported Kuru order side.");
  if (!Number.isFinite(input.risk.maxSpreadBps) || input.risk.maxSpreadBps <= 0 || input.risk.maxSpreadBps > 10_000) {
    throw new Error("Kuru maximum spread risk limit must be greater than 0 and no more than 10000 bps.");
  }
  const observedSpreadBps = (input.book.ask - input.book.bid) / ((input.book.ask + input.book.bid) / 2) * 10_000;
  if (!Number.isFinite(observedSpreadBps) || observedSpreadBps > input.risk.maxSpreadBps) {
    throw new Error("Kuru book spread exceeds the configured risk limit.");
  }

  const bidRaw = parseDecimal(String(input.book.bid), precision.priceDecimals, "best bid");
  const askRaw = parseDecimal(String(input.book.ask), precision.priceDecimals, "best ask");
  if (bidRaw <= 0n || askRaw <= bidRaw || bidRaw % precision.tick !== 0n || askRaw % precision.tick !== 0n || askRaw >= 1n << 32n) throw new Error("Kuru top of book is invalid, outside the SDK ABI range, or not tick aligned.");
  const spreadTicks = (askRaw - bidRaw) / precision.tick;
  const priceRaw = input.side === "buy"
    ? bidRaw + (spreadTicks >= 3n ? precision.tick : 0n)
    : askRaw - (spreadTicks >= 3n ? precision.tick : 0n);
  if (priceRaw <= 0n || priceRaw % precision.tick !== 0n || (input.side === "buy" ? priceRaw >= askRaw : priceRaw <= bidRaw)) throw new Error("Post-only order would cross or violate the market tick.");

  const sizeRaw = parseDecimal(input.risk.desiredSize, precision.sizeDecimals, "desiredSize");
  const minOrderSize = uint(input.market.minSizeRaw, "minSizeRaw");
  const maxOrderSize = uint(input.market.maxSizeRaw, "maxSizeRaw");
  if (sizeRaw < minOrderSize || sizeRaw > maxOrderSize || sizeRaw >= 1n << 96n) throw new Error("Order size violates Kuru's minimum, maximum, or ABI limit.");
  const maxNotional = uint(input.risk.maxNotionalQuoteRaw, "maxNotionalQuoteRaw");
  const quoteScale = power10(input.market.quoteAssetDecimals);
  const notionalQuoteRaw = ceilDiv(priceRaw * sizeRaw * quoteScale, power10(precision.priceDecimals) * power10(precision.sizeDecimals));
  if (notionalQuoteRaw > maxNotional) throw new Error("Order exceeds the configured quote-notional cap.");
  const makerFeeQuoteRaw = ceilDiv(notionalQuoteRaw * precision.fee, BPS);
  const accountQuote = uint(input.margin.marginQuoteBalanceRaw, "marginQuoteBalanceRaw");
  const accountBase = uint(input.margin.marginBaseBalanceRaw, "marginBaseBalanceRaw");
  // Treat all base balance as exposure; this is conservative until open-order collateral is reconciled.
  const currentPosition = accountBase;
  const maxPosition = uint(input.margin.maxPositionBaseRaw, "maxPositionBaseRaw");
  const baseScale = power10(input.market.baseAssetDecimals);
  const orderBaseRaw = ceilDiv(sizeRaw * baseScale, power10(precision.sizeDecimals));
  if (input.side === "buy") {
    if (accountQuote < notionalQuoteRaw + makerFeeQuoteRaw) throw new Error("Reported Kuru quote margin balance does not cover order plus maker-fee reserve.");
    if (currentPosition + orderBaseRaw > maxPosition) throw new Error("Buy would exceed the configured base-position cap.");
  } else if (accountBase < orderBaseRaw || currentPosition < orderBaseRaw) {
    throw new Error("Sell exceeds reported Kuru base margin balance or conservative exposure; shorting is disabled.");
  }
  const plan: KuruV1TestnetOrderPlan = Object.freeze({
    chainId: KURU_V1_TESTNET_CHAIN_ID, market: input.market.market, account: input.margin.account,
    side: input.side, block: input.book.block, bookReceivedAt: input.book.receivedAt!, plannedAtMs: input.nowMs,
    maxBookAgeMs: input.risk.maxBookAgeMs, maxExecutionBlockLag: input.risk.maxExecutionBlockLag, maxSpreadBps: input.risk.maxSpreadBps,
    priceRaw: priceRaw.toString(), sizeRaw: sizeRaw.toString(),
    notionalQuoteRaw: notionalQuoteRaw.toString(), makerFeeQuoteRaw: makerFeeQuoteRaw.toString(), maxPositionBaseRaw: maxPosition.toString(),
  });
  approvedOrderPlans.add(plan);
  return plan;
}

function validateBudget(budget: TestnetTransactionBudget) {
  const sdkGasLimit = uint(budget.gasLimit, "gasLimit");
  const gasPriceWei = uint(budget.gasPriceWei, "gasPriceWei");
  const maxGasCostWei = uint(budget.maxGasCostWei, "maxGasCostWei");
  if (sdkGasLimit === 0n || gasPriceWei === 0n) throw new Error("Transaction exceeds the explicit testnet gas budget.");
  // Kuru SDK buildTransactionRequest adds a fixed 20% gas-limit buffer.
  const transactionGasLimit = sdkGasLimit * 120n / 100n;
  const gasCost = transactionGasLimit * gasPriceWei;
  if (gasCost > maxGasCostWei) throw new Error("Transaction exceeds the explicit testnet gas budget after the SDK gas buffer.");
  return {
    gasLimit: BigNumber.from(sdkGasLimit.toString()), transactionGasLimit: BigNumber.from(transactionGasLimit.toString()),
    gasPrice: BigNumber.from(gasPriceWei.toString()), gasCost: gasCost.toString(),
  };
}

function verifyUnsignedRequest(
  request: ethers.providers.TransactionRequest,
  input: { account: string; market: string; data: string; gasLimit: BigNumber; gasPrice: BigNumber },
) {
  if (request.from?.toLowerCase() !== input.account.toLowerCase()
    || request.to?.toLowerCase() !== input.market.toLowerCase()
    || !request.data
    || BigNumber.from(request.value ?? 0).gt(0)
    || !BigNumber.from(request.gasLimit ?? 0).eq(input.gasLimit)
    || !BigNumber.from(request.gasPrice ?? 0).eq(input.gasPrice)
    || ethers.utils.hexlify(request.data).toLowerCase() !== input.data.toLowerCase()) {
    throw new Error("Kuru SDK returned unsigned transaction fields outside the approved account, market, data, value, or gas budget.");
  }
}

async function verifiedTestnetProvider(provider: ethers.providers.JsonRpcProvider): Promise<number> {
  const raw = await provider.send("eth_chainId", []);
  const chainId = typeof raw === "string" && /^0x[0-9a-f]+$/i.test(raw) ? Number.parseInt(raw.slice(2), 16) : Number(raw);
  if (chainId !== KURU_V1_TESTNET_CHAIN_ID) throw new Error("Kuru testnet transaction planning requires an RPC that reports chain 10143.");
  const rawBlock = await provider.send("eth_blockNumber", []);
  const currentBlock = typeof rawBlock === "string" && /^0x[0-9a-f]+$/i.test(rawBlock) ? Number.parseInt(rawBlock.slice(2), 16) : Number(rawBlock);
  if (!Number.isSafeInteger(currentBlock) || currentBlock < 1) throw new Error("Kuru testnet RPC returned an invalid current block.");
  return currentBlock;
}

async function verifyTestnetImplementation(
  provider: ethers.providers.JsonRpcProvider,
  proxy: string,
  expectedImplementation: string,
  observedBlock: number,
  label: string,
): Promise<void> {
  const rawSlot = await provider.getStorageAt(proxy, EIP1967_IMPLEMENTATION_SLOT, observedBlock);
  if (!/^0x[\da-f]{64}$/i.test(rawSlot)) throw new Error(`Kuru testnet returned a malformed ${label} implementation slot.`);
  const implementation = ethers.utils.getAddress(`0x${rawSlot.slice(-40)}`);
  if (implementation.toLowerCase() !== expectedImplementation.toLowerCase()) {
    throw new Error(`Kuru testnet ${label} implementation changed; review the deployment before use.`);
  }
  const code = await provider.getCode(implementation, observedBlock);
  if (code === "0x") throw new Error(`Pinned Kuru testnet ${label} implementation has no code at the verified block.`);
}

async function requireReadOnlySimulation(
  provider: ethers.providers.JsonRpcProvider,
  request: ethers.providers.TransactionRequest,
  blockTag: number,
) {
  try {
    await provider.call({
      from: request.from, to: request.to, data: request.data, value: request.value ?? 0,
      gasLimit: request.gasLimit, gasPrice: request.gasPrice,
    }, blockTag);
  } catch {
    throw new Error(`Kuru transaction failed read-only simulation at verified testnet block ${blockTag}.`);
  }
}

async function prepareUnsignedKuruV1TestnetOrder(
  plan: KuruV1TestnetOrderPlan,
  budget: TestnetTransactionBudget,
  provider: ethers.providers.JsonRpcProvider,
  nowMs = Date.now(),
) {
  if (!approvedOrderPlans.has(plan) || plan.chainId !== KURU_V1_TESTNET_CHAIN_ID || plan.market.toLowerCase() !== KURU_V1_TESTNET_MARKET.toLowerCase()
    || !validAddress(plan.account) || !(plan.side === "buy" || plan.side === "sell") || !Number.isSafeInteger(plan.block) || plan.block < 1) {
    throw new Error("Invalid Kuru v1 testnet order plan.");
  }
  if (!Number.isFinite(nowMs) || nowMs < plan.plannedAtMs || nowMs < plan.bookReceivedAt
    || nowMs - plan.bookReceivedAt > plan.maxBookAgeMs) throw new Error("Kuru order plan expired before unsigned transaction construction.");
  const priceRaw = uint(plan.priceRaw, "priceRaw", (1n << 32n) - 1n);
  const sizeRaw = uint(plan.sizeRaw, "sizeRaw", (1n << 96n) - 1n);
  if (priceRaw <= 0n || sizeRaw <= 0n) throw new Error("Unsigned Kuru order price and size must be positive.");
  const gas = validateBudget(budget);
  const currentBlock = await verifiedTestnetProvider(provider);
  if (currentBlock < plan.block || currentBlock - plan.block > plan.maxExecutionBlockLag) throw new Error("Kuru order plan exceeded its allowed testnet block lag before unsigned transaction construction.");
  await verifyTestnetImplementation(provider, KURU_V1_TESTNET_MARKET, KURU_V1_TESTNET_MARKET_IMPLEMENTATION, currentBlock, "market");
  await verifyTestnetImplementation(provider, KURU_V1_TESTNET_MARGIN_ACCOUNT, KURU_V1_TESTNET_MARGIN_IMPLEMENTATION, currentBlock, "Margin Account");
  return { priceRaw, sizeRaw, gas, currentBlock };
}

/** Build only unsigned SDK calldata via a non-signing VoidSigner; no sendTransaction call exists here. */
export async function buildUnsignedKuruV1TestnetOrder(
  plan: KuruV1TestnetOrderPlan,
  budget: TestnetTransactionBudget,
  provider: ethers.providers.JsonRpcProvider,
  nowMs = Date.now(),
): Promise<UnsignedKuruTestnetTransaction> {
  const { priceRaw, sizeRaw, gas, currentBlock } = await prepareUnsignedKuruV1TestnetOrder(plan, budget, provider, nowMs);
  const signer = new ethers.VoidSigner(plan.account, provider);
  const txOptions = { gasLimit: gas.gasLimit, gasPrice: gas.gasPrice };
  const rawPrice = BigNumber.from(priceRaw.toString()), rawSize = BigNumber.from(sizeRaw.toString());
  const request = plan.side === "buy"
    ? await Kuru.GTC.constructBuyOrderTransaction(signer, plan.market, rawPrice, rawSize, true, provider, txOptions)
    : await Kuru.GTC.constructSellOrderTransaction(signer, plan.market, rawPrice, rawSize, true, provider, txOptions);
  const data = ethers.utils.hexlify(request.data ?? "0x");
  const orderInterface = new ethers.utils.Interface([
    "function addBuyOrder(uint32 price,uint96 size,bool postOnly)",
    "function addSellOrder(uint32 price,uint96 size,bool postOnly)",
  ]);
  let decoded: ethers.utils.TransactionDescription;
  try { decoded = orderInterface.parseTransaction({ data, value: request.value ?? 0 }); }
  catch { throw new Error("Kuru SDK returned calldata that is not a supported post-only order."); }
  const expectedMethod = plan.side === "buy" ? "addBuyOrder" : "addSellOrder";
  if (decoded.name !== expectedMethod || decoded.args.price.toString() !== priceRaw.toString()
    || decoded.args.size.toString() !== sizeRaw.toString() || decoded.args.postOnly !== true) {
    throw new Error("Kuru SDK order calldata does not match the exact post-only approved order.");
  }
  verifyUnsignedRequest(request, { account: plan.account, market: plan.market, data, gasLimit: gas.transactionGasLimit, gasPrice: gas.gasPrice });
  await requireReadOnlySimulation(provider, request, currentBlock);
  return {
    chainId: KURU_V1_TESTNET_CHAIN_ID, market: plan.market, account: plan.account,
    operation: "place_post_only_limit", data, gasLimit: gas.transactionGasLimit.toString(),
    gasPriceWei: gas.gasPrice.toString(), valueWei: "0", expectedOrder: { side: plan.side, priceRaw: plan.priceRaw, sizeRaw: plan.sizeRaw },
  };
}

/** Root Market.encode calldata policy only; eth_call does not prove later fills, cancellation or replacement. */
export async function buildUnsignedKuruV1TestnetBatchUpdate(
  plan: KuruV1TestnetOrderPlan,
  cancelOrderIds: readonly string[],
  budget: TestnetTransactionBudget,
  provider: ethers.providers.JsonRpcProvider,
  nowMs = Date.now(),
): Promise<UnsignedKuruTestnetBatchUpdate> {
  if (cancelOrderIds.length > 8) throw new Error("Batch update supports at most 8 explicit cancellation IDs.");
  const ids = cancelOrderIds.map((id) => uint(id, "orderId", (1n << 40n) - 1n));
  if (ids.some((id) => id === 0n) || new Set(ids.map(String)).size !== ids.length) {
    throw new Error("Batch update cancellation IDs must be positive and unique.");
  }
  const { priceRaw, sizeRaw, gas, currentBlock } = await prepareUnsignedKuruV1TestnetOrder(plan, budget, provider, nowMs);
  const iface = new ethers.utils.Interface([
    "function batchUpdate(uint32[] buyPrices,uint96[] buySizes,uint32[] sellPrices,uint96[] sellSizes,uint40[] orderIdsToCancel,bool postOnly)",
  ]);
  const price = BigNumber.from(priceRaw.toString()), size = BigNumber.from(sizeRaw.toString());
  const [bp, bs, sp, ss] = plan.side === "buy" ? [[price], [size], [], []] : [[], [], [price], [size]];
  const data = iface.encodeFunctionData("batchUpdate", [bp, bs, sp, ss, ids.map((id) => BigNumber.from(id.toString())), true]);
  const request = {
    from: plan.account, to: plan.market, data, value: BigNumber.from(0),
    gasLimit: gas.transactionGasLimit, gasPrice: gas.gasPrice,
  };
  await requireReadOnlySimulation(provider, request, currentBlock);
  return {
    chainId: KURU_V1_TESTNET_CHAIN_ID, market: plan.market, account: plan.account,
    operation: "batch_update_post_only_limit", data, gasLimit: gas.transactionGasLimit.toString(),
    gasPriceWei: gas.gasPrice.toString(), valueWei: "0",
    expectedOrder: { side: plan.side, priceRaw: plan.priceRaw, sizeRaw: plan.sizeRaw }, expectedCancelOrderIds: ids.map(String),
    preparationOnly: true, conformanceScope: "root_batch_update_calldata_policy_only", establishesExecutionLifecycle: false,
    interpretation: "Unsigned calldata preparation only. Successful eth_call does not resolve later fill/cancel/replacement races or cancellation receipt ambiguity, and does not establish root nonce, fee, journal or lifecycle conformance.",
  };
}

/** Build only unsigned cancel calldata. Cancels need exact IDs and the same capped testnet gas policy. */
export async function buildUnsignedKuruV1TestnetCancel(
  input: { chainId: number; market: string; account: string; orderIds: string[] },
  budget: TestnetTransactionBudget,
  provider: ethers.providers.JsonRpcProvider,
): Promise<UnsignedKuruTestnetTransaction> {
  if (input.chainId !== KURU_V1_TESTNET_CHAIN_ID || input.market.toLowerCase() !== KURU_V1_TESTNET_MARKET.toLowerCase() || !validAddress(input.account)) throw new Error("Kuru testnet cancellation requires the allowlisted market and a valid account.");
  if (!input.orderIds.length || input.orderIds.length > 32) throw new Error("Cancel request must contain 1 to 32 explicit order IDs.");
  const ids = input.orderIds.map((id) => uint(id, "orderId", (1n << 40n) - 1n));
  if (new Set(ids.map(String)).size !== ids.length) throw new Error("Cancel request contains duplicate order IDs.");
  const gas = validateBudget(budget);
  const currentBlock = await verifiedTestnetProvider(provider);
  await verifyTestnetImplementation(provider, KURU_V1_TESTNET_MARKET, KURU_V1_TESTNET_MARKET_IMPLEMENTATION, currentBlock, "market");
  const signer = new ethers.VoidSigner(input.account, provider);
  const request = await Kuru.OrderCanceler.constructCancelOrdersTransaction(signer, input.market, ids.map((id) => BigNumber.from(id.toString())), { gasLimit: gas.gasLimit, gasPrice: gas.gasPrice });
  const data = ethers.utils.hexlify(request.data ?? "0x");
  const cancelInterface = new ethers.utils.Interface(["function batchCancelOrders(uint40[] orderIds)"]);
  let decoded: ethers.utils.TransactionDescription;
  try { decoded = cancelInterface.parseTransaction({ data, value: request.value ?? 0 }); }
  catch { throw new Error("Kuru SDK returned calldata that is not a supported cancellation."); }
  if (decoded.name !== "batchCancelOrders" || decoded.args.orderIds.length !== ids.length
    || decoded.args.orderIds.some((id: BigNumber, index: number) => id.toString() !== ids[index]!.toString())) {
    throw new Error("Kuru SDK cancellation calldata does not match the exact requested order IDs.");
  }
  verifyUnsignedRequest(request, { account: input.account, market: input.market, data, gasLimit: gas.transactionGasLimit, gasPrice: gas.gasPrice });
  await requireReadOnlySimulation(provider, request, currentBlock);
  return { chainId: KURU_V1_TESTNET_CHAIN_ID, market: input.market, account: input.account, operation: "cancel_orders", data,
    gasLimit: gas.transactionGasLimit.toString(), gasPriceWei: gas.gasPrice.toString(), valueWei: "0", expectedCancelOrderIds: ids.map(String) };
}
