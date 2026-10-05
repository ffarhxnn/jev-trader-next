import { BigNumber, ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import type { Book } from "./types";
import { qualifyKuruBook } from "./market-qualification";

/** Official Kuru MON-USDC mainnet market and Margin Account deployment. */
export const KURU_MAINNET_CHAIN_ID = 143;
export const KURU_MAINNET_MON_USDC_MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";
export const KURU_MAINNET_MARGIN_ACCOUNT = "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5";
export const KURU_MAINNET_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
export const KURU_MAINNET_MARKET_IMPLEMENTATION = "0x5e3446c600524Be453bbCEFD46a9E4C9bE8899a0";
export const KURU_MAINNET_MARGIN_IMPLEMENTATION = "0x351525073afa933720329756716Fcf7d741e7Ff0";
const ZERO_ADDRESS = ethers.constants.AddressZero;
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const verifiedMainnetMarkets = new WeakSet<object>();
const marginBalanceInterface = new ethers.utils.Interface([
  "function getBalance(address user,address token) view returns (uint256)",
]);
const marketInterface = new ethers.utils.Interface([
  "function getMarketParams() view returns (uint32,uint96,address,uint256,address,uint256,uint32,uint96,uint96,uint256,uint256)",
  "function getL2Book() view returns (bytes)",
  "function s_buyPricePoints(uint256) view returns (uint40,uint40)",
  "function s_sellPricePoints(uint256) view returns (uint40,uint40)",
  "function s_orders(uint40) view returns (address,uint96,uint40,uint40,uint40,uint32,uint32,bool)",
]);

const MAX_ENUMERATED_MANUAL_ORDERS = 20_000;

export interface KuruMainnetMarketSnapshot {
  chainId: 143;
  market: typeof KURU_MAINNET_MON_USDC_MARKET;
  implementation: typeof KURU_MAINNET_MARKET_IMPLEMENTATION;
  observedBlock: number;
  baseAssetAddress: string;
  baseAssetDecimals: number;
  quoteAssetAddress: string;
  quoteAssetDecimals: number;
  pricePrecision: string;
  sizePrecision: string;
  tickSizeRaw: string;
  minSizeRaw: string;
  maxSizeRaw: string;
  takerFeeBps: string;
  makerFeeBps: string;
}

/** Raw Kuru Margin Account balances at a verified block; these are not free collateral. */
export interface KuruMainnetMarginSnapshot {
  chainId: 143;
  implementation: typeof KURU_MAINNET_MARGIN_IMPLEMENTATION;
  account: string;
  observedBlock: number;
  marginBaseBalanceRaw: string;
  marginQuoteBalanceRaw: string;
}

export interface KuruMainnetOpenOrder {
  orderId: string;
  side: "buy" | "sell";
  priceRaw: string;
  sizePrecisionRaw: string;
  baseTokenRaw: string;
  quoteNotionalRawCeil: string;
}

/** Block-pinned balances and complete active manual-order state for one market account. */
export interface KuruMainnetAccountOrdersSnapshot {
  chainId: 143;
  account: string;
  market: typeof KURU_MAINNET_MON_USDC_MARKET;
  marketImplementation: typeof KURU_MAINNET_MARKET_IMPLEMENTATION;
  marginImplementation: typeof KURU_MAINNET_MARGIN_IMPLEMENTATION;
  observedBlock: number;
  bookSourceBlock: number;
  marginBaseBalanceRaw: string;
  marginQuoteBalanceRaw: string;
  manualOrderCount: number;
  accountOrders: readonly KuruMainnetOpenOrder[];
  accountOpenBuyQuoteNotionalRawCeil: string;
  accountOpenSellBaseTokenRaw: string;
}

async function verifiedMainnetBlock(provider: ethers.providers.JsonRpcProvider): Promise<number> {
  const chainId = Number(await provider.send("eth_chainId", []));
  if (chainId !== KURU_MAINNET_CHAIN_ID) throw new Error("Kuru mainnet preflight requires RPC chain 143.");
  const block = Number(await provider.send("eth_blockNumber", []));
  if (!Number.isSafeInteger(block) || block < 1) throw new Error("Kuru mainnet RPC returned an invalid block number.");
  return block;
}

async function verifyMainnetImplementation(
  provider: ethers.providers.JsonRpcProvider,
  proxy: string,
  expectedImplementation: string,
  observedBlock: number,
): Promise<string> {
  const rawSlot = await provider.getStorageAt(proxy, EIP1967_IMPLEMENTATION_SLOT, observedBlock);
  if (!/^0x[\da-f]{64}$/i.test(rawSlot)) throw new Error("Kuru mainnet returned a malformed proxy implementation slot.");
  const implementation = ethers.utils.getAddress(`0x${rawSlot.slice(-40)}`);
  if (implementation.toLowerCase() !== expectedImplementation.toLowerCase()) {
    throw new Error(`Kuru mainnet ${proxy.toLowerCase() === KURU_MAINNET_MON_USDC_MARKET.toLowerCase() ? "market" : "Margin Account"} implementation changed; review the deployment before use.`);
  }
  const code = await provider.getCode(implementation, observedBlock);
  if (code === "0x") throw new Error("Pinned Kuru mainnet implementation has no code at the verified block.");
  return implementation;
}

function validateMainnetMarket(snapshot: KuruMainnetMarketSnapshot) {
  if (snapshot.market.toLowerCase() !== KURU_MAINNET_MON_USDC_MARKET.toLowerCase()
    || snapshot.baseAssetAddress.toLowerCase() !== ZERO_ADDRESS.toLowerCase()
    || snapshot.quoteAssetAddress.toLowerCase() !== KURU_MAINNET_USDC.toLowerCase()
    || snapshot.baseAssetDecimals !== 18 || snapshot.quoteAssetDecimals !== 6) {
    throw new Error("Kuru mainnet MON-USDC market assets or decimals differ from the official deployment.");
  }
  if (!/^10*$/.test(snapshot.pricePrecision) || !/^10*$/.test(snapshot.sizePrecision)) throw new Error("Kuru mainnet market precision is unsupported.");
  const tick = BigInt(snapshot.tickSizeRaw), minSize = BigInt(snapshot.minSizeRaw), maxSize = BigInt(snapshot.maxSizeRaw);
  const makerFee = BigInt(snapshot.makerFeeBps), takerFee = BigInt(snapshot.takerFeeBps);
  if (tick <= 0n || minSize <= 0n || maxSize < minSize || makerFee > 10_000n || takerFee > 10_000n) {
    throw new Error("Kuru mainnet market bounds or fee parameters are invalid.");
  }
}

/** Read and validate Kuru's official mainnet MON-USDC market parameters at one block. */
export async function readKuruMainnetMarketSnapshot(
  provider: ethers.providers.JsonRpcProvider,
): Promise<KuruMainnetMarketSnapshot> {
  const observedBlock = await verifiedMainnetBlock(provider);
  const implementation = await verifyMainnetImplementation(
    provider, KURU_MAINNET_MON_USDC_MARKET, KURU_MAINNET_MARKET_IMPLEMENTATION, observedBlock,
  );
  const code = await provider.getCode(KURU_MAINNET_MON_USDC_MARKET, observedBlock);
  if (code === "0x") throw new Error("Official Kuru mainnet market has no code at the verified block.");
  const contract = new ethers.Contract(KURU_MAINNET_MON_USDC_MARKET, marketInterface, provider);
  const params = await contract.getMarketParams({ from: ZERO_ADDRESS, blockTag: observedBlock });
  const snapshot: KuruMainnetMarketSnapshot = Object.freeze({
    chainId: KURU_MAINNET_CHAIN_ID, market: KURU_MAINNET_MON_USDC_MARKET,
    implementation: implementation as typeof KURU_MAINNET_MARKET_IMPLEMENTATION, observedBlock,
    pricePrecision: BigNumber.from(params[0]).toString(), sizePrecision: BigNumber.from(params[1]).toString(),
    baseAssetAddress: params[2], baseAssetDecimals: Number(params[3].toString()),
    quoteAssetAddress: params[4], quoteAssetDecimals: Number(params[5].toString()),
    tickSizeRaw: BigNumber.from(params[6]).toString(), minSizeRaw: BigNumber.from(params[7]).toString(),
    maxSizeRaw: BigNumber.from(params[8]).toString(), takerFeeBps: BigNumber.from(params[9]).toString(),
    makerFeeBps: BigNumber.from(params[10]).toString(),
  });
  validateMainnetMarket(snapshot);
  verifiedMainnetMarkets.add(snapshot);
  return snapshot;
}

/** Read MON and USDC held by one account in Kuru's mainnet Margin Account. */
export async function readKuruMainnetMarginSnapshot(
  provider: ethers.providers.JsonRpcProvider,
  account: string,
): Promise<KuruMainnetMarginSnapshot> {
  if (!ethers.utils.isAddress(account)) throw new Error("Invalid margin account address.");
  const normalizedAccount = ethers.utils.getAddress(account);
  const observedBlock = await verifiedMainnetBlock(provider);
  const implementation = await verifyMainnetImplementation(
    provider, KURU_MAINNET_MARGIN_ACCOUNT, KURU_MAINNET_MARGIN_IMPLEMENTATION, observedBlock,
  );
  const code = await provider.getCode(KURU_MAINNET_MARGIN_ACCOUNT, observedBlock);
  if (code === "0x") throw new Error("Official Kuru mainnet Margin Account has no contract code at the verified block.");
  const margin = new ethers.Contract(KURU_MAINNET_MARGIN_ACCOUNT, marginBalanceInterface, provider);
  const overrides = { from: ZERO_ADDRESS, blockTag: observedBlock };
  const [baseBalance, quoteBalance] = await Promise.all([
    margin.getBalance(normalizedAccount, ZERO_ADDRESS, overrides) as Promise<BigNumber>,
    margin.getBalance(normalizedAccount, KURU_MAINNET_USDC, overrides) as Promise<BigNumber>,
  ]);
  return Object.freeze({
    chainId: KURU_MAINNET_CHAIN_ID,
    implementation: KURU_MAINNET_MARGIN_IMPLEMENTATION,
    account: normalizedAccount,
    observedBlock,
    marginBaseBalanceRaw: BigNumber.from(baseBalance).toString(),
    marginQuoteBalanceRaw: BigNumber.from(quoteBalance).toString(),
  });
}

/**
 * Reconstruct current manual orders from each live price-level linked list, then verify
 * every level's summed order size against the raw L2 payload. It does not infer free
 * collateral or include AMM liquidity in account orders.
 */
export async function readKuruMainnetAccountOrdersSnapshot(
  provider: ethers.providers.JsonRpcProvider,
  account: string,
  maxManualOrders = MAX_ENUMERATED_MANUAL_ORDERS,
): Promise<KuruMainnetAccountOrdersSnapshot> {
  if (!ethers.utils.isAddress(account)) throw new Error("Invalid margin account address.");
  if (!Number.isSafeInteger(maxManualOrders) || maxManualOrders < 1 || maxManualOrders > MAX_ENUMERATED_MANUAL_ORDERS) {
    throw new Error(`maxManualOrders must be an integer from 1 to ${MAX_ENUMERATED_MANUAL_ORDERS}.`);
  }
  const normalizedAccount = ethers.utils.getAddress(account);
  const market = await readKuruMainnetMarketSnapshot(provider);
  const observedBlock = market.observedBlock;
  const marginImplementation = await verifyMainnetImplementation(
    provider, KURU_MAINNET_MARGIN_ACCOUNT, KURU_MAINNET_MARGIN_IMPLEMENTATION, observedBlock,
  );
  const contract = new ethers.Contract(KURU_MAINNET_MON_USDC_MARKET, marketInterface, provider);
  const marginCode = await provider.getCode(KURU_MAINNET_MARGIN_ACCOUNT, observedBlock);
  if (marginCode === "0x") throw new Error("Official Kuru mainnet Margin Account has no contract code at the verified block.");

  const [encoded, baseBalance, quoteBalance] = await Promise.all([
    contract.getL2Book({ from: ZERO_ADDRESS, blockTag: observedBlock }) as Promise<string>,
    new ethers.Contract(KURU_MAINNET_MARGIN_ACCOUNT, marginBalanceInterface, provider)
      .getBalance(normalizedAccount, ZERO_ADDRESS, { from: ZERO_ADDRESS, blockTag: observedBlock }) as Promise<BigNumber>,
    new ethers.Contract(KURU_MAINNET_MARGIN_ACCOUNT, marginBalanceInterface, provider)
      .getBalance(normalizedAccount, KURU_MAINNET_USDC, { from: ZERO_ADDRESS, blockTag: observedBlock }) as Promise<BigNumber>,
  ]);
  if (!/^0x(?:[\da-f]{64})+$/i.test(encoded)) throw new Error("Kuru mainnet returned malformed L2 book bytes.");
  const bookSourceBig = BigInt(`0x${encoded.slice(2, 66)}`);
  if (bookSourceBig < 1n || bookSourceBig > BigInt(observedBlock) || bookSourceBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Kuru mainnet L2 book returned an invalid source block.");
  }
  const bookSourceBlock = Number(bookSourceBig);
  snapshotPrecisionDecimals(market.pricePrecision);
  snapshotPrecisionDecimals(market.sizePrecision);
  const pricePrecision = BigInt(market.pricePrecision);
  const sizePrecision = BigInt(market.sizePrecision);
  const quoteScale = 10n ** BigInt(market.quoteAssetDecimals);
  let cursor = 66;
  let enumerated = 0;
  const seenOrderIds = new Set<string>();
  const accountOrders: KuruMainnetOpenOrder[] = [];
  let accountOpenBuyQuoteNotionalRawCeil = 0n;
  let accountOpenSellBaseTokenRaw = 0n;
  const orderPointInterface = new ethers.utils.Interface([
    "function s_buyPricePoints(uint256) view returns (uint40,uint40)",
    "function s_sellPricePoints(uint256) view returns (uint40,uint40)",
    "function s_orders(uint40) view returns (address,uint96,uint40,uint40,uint40,uint32,uint32,bool)",
  ]);
  const readSide = async (side: "buy" | "sell", allowEndOfPayload: boolean) => {
    while (cursor < encoded.length) {
      if (cursor + 64 > encoded.length) throw new Error("Kuru mainnet L2 book has a truncated price word.");
      const price = BigInt(`0x${encoded.slice(cursor, cursor + 64)}`); cursor += 64;
      if (price === 0n) return;
      if (cursor + 64 > encoded.length) throw new Error("Kuru mainnet L2 book has a truncated size word.");
      const aggregateSize = BigInt(`0x${encoded.slice(cursor, cursor + 64)}`); cursor += 64;
      if (aggregateSize <= 0n || price > BigInt("0xffffffff")) throw new Error("Kuru mainnet L2 book contains an invalid manual level.");
      const pointMethod = side === "buy" ? "s_buyPricePoints" : "s_sellPricePoints";
      const pointData = orderPointInterface.encodeFunctionData(pointMethod, [price.toString()]);
      const pointResult = await provider.call({ to: KURU_MAINNET_MON_USDC_MARKET, from: ZERO_ADDRESS, data: pointData }, observedBlock);
      const [headRaw, tailRaw] = orderPointInterface.decodeFunctionResult(pointMethod, pointResult);
      let orderId = BigInt(headRaw.toString());
      const tail = BigInt(tailRaw.toString());
      if (orderId === 0n || tail === 0n) throw new Error("Kuru manual price level is missing its linked-order endpoints.");
      let previous = 0n;
      let levelSize = 0n;
      while (orderId !== 0n) {
        enumerated++;
        if (enumerated > maxManualOrders) throw new Error(`Kuru manual book exceeds the bounded ${maxManualOrders}-order account snapshot limit.`);
        const id = orderId.toString();
        if (seenOrderIds.has(id)) throw new Error("Kuru manual order linked lists contain a cycle or duplicate ID.");
        seenOrderIds.add(id);
        const orderData = orderPointInterface.encodeFunctionData("s_orders", [id]);
        const orderResult = await provider.call({ to: KURU_MAINNET_MON_USDC_MARKET, from: ZERO_ADDRESS, data: orderData }, observedBlock);
        const order = orderPointInterface.decodeFunctionResult("s_orders", orderResult);
        const owner = ethers.utils.getAddress(String(order[0]));
        const size = BigInt(order[1].toString());
        const prev = BigInt(order[2].toString());
        const next = BigInt(order[3].toString());
        const storedPrice = BigInt(order[5].toString());
        const isBuy = Boolean(order[7]);
        if (size <= 0n || prev !== previous || storedPrice !== price || isBuy !== (side === "buy")) {
          throw new Error("Kuru linked order failed its owner-independent structural checks.");
        }
        levelSize += size;
        if (owner === normalizedAccount) {
          const baseTokenRaw = size * (10n ** BigInt(market.baseAssetDecimals)) / sizePrecision;
          const quoteNumerator = price * size * quoteScale;
          const quoteDenominator = pricePrecision * sizePrecision;
          const quoteNotionalRawCeil = (quoteNumerator + quoteDenominator - 1n) / quoteDenominator;
          accountOrders.push(Object.freeze({
            orderId: id, side, priceRaw: price.toString(), sizePrecisionRaw: size.toString(),
            baseTokenRaw: baseTokenRaw.toString(), quoteNotionalRawCeil: quoteNotionalRawCeil.toString(),
          }));
          if (side === "buy") accountOpenBuyQuoteNotionalRawCeil += quoteNotionalRawCeil;
          else accountOpenSellBaseTokenRaw += baseTokenRaw;
        }
        previous = orderId;
        orderId = next;
      }
      if (previous !== tail || levelSize !== aggregateSize) throw new Error("Kuru linked orders do not reconcile to the raw L2 price-level size.");
    }
    if (!allowEndOfPayload) throw new Error("Kuru mainnet L2 book is missing the bid/ask separator.");
  };
  await readSide("buy", false);
  await readSide("sell", true);
  if (cursor !== encoded.length) throw new Error("Kuru mainnet L2 book has unexpected trailing bytes.");
  const sortedAccountOrders = accountOrders.sort((a, b) => BigInt(a.orderId) < BigInt(b.orderId) ? -1 : BigInt(a.orderId) > BigInt(b.orderId) ? 1 : 0);
  return Object.freeze({
    chainId: KURU_MAINNET_CHAIN_ID, account: normalizedAccount, market: KURU_MAINNET_MON_USDC_MARKET,
    marketImplementation: market.implementation, marginImplementation: marginImplementation as typeof KURU_MAINNET_MARGIN_IMPLEMENTATION,
    observedBlock, bookSourceBlock,
    marginBaseBalanceRaw: BigNumber.from(baseBalance).toString(), marginQuoteBalanceRaw: BigNumber.from(quoteBalance).toString(),
    manualOrderCount: enumerated, accountOrders: Object.freeze(sortedAccountOrders),
    accountOpenBuyQuoteNotionalRawCeil: accountOpenBuyQuoteNotionalRawCeil.toString(),
    accountOpenSellBaseTokenRaw: accountOpenSellBaseTokenRaw.toString(),
  });
}

/** Read full manual-plus-AMM depth without a signer or transaction path. */
export async function readKuruMainnetBookSnapshot(
  provider: ethers.providers.JsonRpcProvider,
  market: KuruMainnetMarketSnapshot,
  receivedAt = Date.now(),
): Promise<Book> {
  if (!verifiedMainnetMarkets.has(market) || market.chainId !== KURU_MAINNET_CHAIN_ID || market.market.toLowerCase() !== KURU_MAINNET_MON_USDC_MARKET.toLowerCase()) {
    throw new Error("A verified Kuru mainnet MON-USDC market snapshot is required.");
  }
  if (!Number.isFinite(receivedAt)) throw new Error("Kuru mainnet book receipt time must be finite.");
  const observedBlock = await verifiedMainnetBlock(provider);
  if (market.observedBlock > observedBlock) throw new Error("Kuru mainnet market snapshot is ahead of the RPC.");
  const contract = new ethers.Contract(KURU_MAINNET_MON_USDC_MARKET, marketInterface, provider);
  const encoded: string = await contract.getL2Book({ from: ZERO_ADDRESS, blockTag: observedBlock });
  if (!/^0x(?:[\da-f]{64})+$/i.test(encoded)) throw new Error("Kuru mainnet returned malformed L2 book bytes.");
  const rawBookBlock = BigInt(`0x${encoded.slice(2, 66)}`);
  if (rawBookBlock < 1n || rawBookBlock > BigInt(observedBlock) || rawBookBlock > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Kuru mainnet L2 book returned an invalid source block.");
  }
  const priceDecimals = snapshotPrecisionDecimals(market.pricePrecision);
  const sizeDecimals = snapshotPrecisionDecimals(market.sizePrecision);
  let cursor = 66;
  const decodeSide = (allowEndOfPayload = false): [number, number][] => {
    const levels: [number, number][] = [];
    while (cursor < encoded.length) {
      if (cursor + 64 > encoded.length) throw new Error("Kuru mainnet L2 book has a truncated word.");
      const price = BigInt(`0x${encoded.slice(cursor, cursor + 64)}`); cursor += 64;
      if (price === 0n) return levels;
      if (cursor + 64 > encoded.length) throw new Error("Kuru mainnet L2 book has a truncated level.");
      const size = BigInt(`0x${encoded.slice(cursor, cursor + 64)}`); cursor += 64;
      if (size === 0n) throw new Error("Kuru mainnet L2 book contains a zero-size level.");
      const px = Number(ethers.utils.formatUnits(price.toString(), priceDecimals));
      const qty = Number(ethers.utils.formatUnits(size.toString(), sizeDecimals));
      if (!(px > 0) || !(qty > 0) || !Number.isFinite(px + qty)) throw new Error("Kuru mainnet L2 level is outside the supported range.");
      levels.push([px, qty]);
    }
    if (allowEndOfPayload) return levels;
    throw new Error("Kuru mainnet L2 book is missing the bid/ask separator.");
  };
  const manualBids = decodeSide(), manualAsks = decodeSide(true);
  if (cursor !== encoded.length) throw new Error("Kuru mainnet L2 book has unexpected trailing bytes.");
  const sdkParams = {
    pricePrecision: BigNumber.from(market.pricePrecision), sizePrecision: BigNumber.from(market.sizePrecision),
    baseAssetAddress: market.baseAssetAddress, baseAssetDecimals: BigNumber.from(market.baseAssetDecimals),
    quoteAssetAddress: market.quoteAssetAddress, quoteAssetDecimals: BigNumber.from(market.quoteAssetDecimals),
    tickSize: BigNumber.from(market.tickSizeRaw), minSize: BigNumber.from(market.minSizeRaw), maxSize: BigNumber.from(market.maxSizeRaw),
    takerFeeBps: BigNumber.from(market.takerFeeBps), makerFeeBps: BigNumber.from(market.makerFeeBps),
  };
  const fullBook = await Kuru.OrderBook.getL2OrderBook(provider, market.market, sdkParams, encoded);
  if (fullBook.blockNumber !== Number(rawBookBlock) || fullBook.manualOrders.bids.length !== manualBids.length
    || fullBook.manualOrders.asks.length !== manualAsks.length) throw new Error("Kuru SDK depth does not match the verified mainnet L2 payload.");
  const bids = fullBook.bids as [number, number][], asks = fullBook.asks as [number, number][];
  const qualified = qualifyKuruBook(bids, asks);
  const bid = qualified.bestBid ?? 0, ask = qualified.bestAsk ?? 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
  return Object.freeze({
    source: "Monad Kuru", chainId: KURU_MAINNET_CHAIN_ID, block: Number(rawBookBlock), receivedAt,
    bid, ask, mid, spreadBps: mid > 0 && ask >= bid ? (ask - bid) / mid * 10_000 : 0,
    tickSize: Number(market.tickSizeRaw) / Number(market.pricePrecision), makerFeeBps: Number(market.makerFeeBps),
    bids: Object.freeze(bids.map((level) => Object.freeze(level))) as unknown as [number, number][],
    asks: Object.freeze(asks.map((level) => Object.freeze(level))) as unknown as [number, number][],
  });
}

function snapshotPrecisionDecimals(value: string): number {
  if (!/^10*$/.test(value)) throw new Error("Kuru market precision must be a power of ten.");
  return value.length - 1;
}
