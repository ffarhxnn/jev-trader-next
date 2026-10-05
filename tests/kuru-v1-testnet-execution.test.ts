import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import {
  buildUnsignedKuruV1TestnetCancel,
  buildUnsignedKuruV1TestnetOrder,
  buildUnsignedKuruV1TestnetBatchUpdate,
  KURU_V1_TESTNET_CHAIN_ID,
  KURU_V1_TESTNET_MARGIN_ACCOUNT,
  KURU_V1_TESTNET_MARGIN_IMPLEMENTATION,
  KURU_V1_TESTNET_MARKET,
  KURU_V1_TESTNET_MARKET_IMPLEMENTATION,
  KURU_V1_TESTNET_QUOTE,
  planKuruV1TestnetOrder,
  readKuruV1TestnetMarginSnapshot,
  readKuruV1TestnetMarketSnapshot,
  readKuruV1TestnetBookSnapshot,
} from "../src/kuru-v1-testnet-execution";

const account = "0x1111111111111111111111111111111111111111";
const risk = { desiredSize: "100", maxNotionalQuoteRaw: "10000000", maxBookAgeMs: 2_000, maxBalanceBlockLag: 2, maxExecutionBlockLag: 2, maxSpreadBps: 50 };
const budget = { gasLimit: "500000", gasPriceWei: "1000000000", maxGasCostWei: "1000000000000000" };

function mockProvider(chainId = KURU_V1_TESTNET_CHAIN_ID, blockNumber = 102, balances = { base: "100000000000000000000", quote: "250000000" }, simulationFails: boolean | string = false, top: { bid: number; ask: number } = { bid: 27012, ask: 27045 }) {
  const provider = new ethers.providers.JsonRpcProvider();
  const methods: string[] = [];
  const callBlockTags: unknown[] = [];
  const simulationCalls: { from?: string; to?: string; data: string; blockTag: unknown }[] = [];
  provider.send = async (method: string, params: unknown[] = []) => {
    methods.push(method);
    if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
    if (method === "eth_blockNumber") return `0x${blockNumber.toString(16)}`;
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getStorageAt") {
      const address = String(params[0]).toLowerCase();
      const implementation = address === KURU_V1_TESTNET_MARKET.toLowerCase()
        ? KURU_V1_TESTNET_MARKET_IMPLEMENTATION : KURU_V1_TESTNET_MARGIN_IMPLEMENTATION;
      return `0x${implementation.slice(2).toLowerCase().padStart(64, "0")}`;
    }
    if (method === "eth_call") {
      callBlockTags.push(params[1]);
      const call = params[0] as { data: string; from?: string; to?: string };
      const marketInterface = new ethers.utils.Interface(["function getMarketParams() view returns (uint32,uint96,address,uint256,address,uint256,uint32,uint96,uint96,uint256,uint256)"]);
      if (call.data.slice(0, 10) === marketInterface.getSighash("getMarketParams")) {
        return marketInterface.encodeFunctionResult("getMarketParams", [
          "1000000", "1000000", ethers.constants.AddressZero, "18", KURU_V1_TESTNET_QUOTE, "6", "1", "1000000", "1000000000000000", "0", "0",
        ]);
      }
      const bookInterface = new ethers.utils.Interface(["function getL2Book() view returns (bytes)"]);
      if (call.data.slice(0, 10) === bookInterface.getSighash("getL2Book")) {
        const word = (value: number) => BigInt(value).toString(16).padStart(64, "0");
        const rawBook = `0x${[
          word(100), word(top.bid), word(1_000_000_000), word(top.bid - 9), word(20_000_000), word(0),
          word(top.ask), word(1_000_000_000), word(top.ask + 9), word(20_000_000), word(0),
        ].join("")}`;
        return bookInterface.encodeFunctionResult("getL2Book", [rawBook]);
      }
      const vaultInterface = new ethers.utils.Interface(["function getVaultParams() view returns (address,uint256,uint96,uint256,uint96,uint96,uint96,uint96)"]);
      if (call.data.slice(0, 10) === vaultInterface.getSighash("getVaultParams")) {
        return vaultInterface.encodeFunctionResult("getVaultParams", [
          "0x3333333333333333333333333333333333333333", "27020000000000000", "0", "27035000000000000", "0",
          "5000000", "5000000", "10",
        ]);
      }
      const simulatedOrderbook = new ethers.utils.Interface([
        "function addBuyOrder(uint32 price,uint96 size,bool postOnly)",
        "function addSellOrder(uint32 price,uint96 size,bool postOnly)",
        "function batchCancelOrders(uint40[] orderIds)",
        "function batchUpdate(uint32[] buyPrices,uint96[] buySizes,uint32[] sellPrices,uint96[] sellSizes,uint40[] orderIdsToCancel,bool postOnly)",
      ]);
      try {
        simulatedOrderbook.parseTransaction({ data: call.data });
        simulationCalls.push({ from: call.from, to: call.to, data: call.data, blockTag: params[1] });
        if (simulationFails) throw new Error(typeof simulationFails === "string" ? simulationFails : "simulated revert");
        return "0x";
      } catch (error) {
        if ((error as Error).message === (typeof simulationFails === "string" ? simulationFails : "simulated revert")) throw error;
      }
      const iface = new ethers.utils.Interface(["function getBalance(address user,address token) view returns (uint256)"]);
      const decoded = iface.decodeFunctionData("getBalance", call.data);
      const balance = decoded.token.toLowerCase() === ethers.constants.AddressZero ? balances.base : balances.quote;
      return ethers.utils.defaultAbiCoder.encode(["uint256"], [balance]);
    }
    throw new Error(`Unexpected RPC method ${method}`);
  };
  return { provider, methods, callBlockTags, simulationCalls };
}

const { provider: marginProvider } = mockProvider();
const margin = await readKuruV1TestnetMarginSnapshot(marginProvider, account, "500000000000000000000");
const { provider: marketProvider } = mockProvider();
const market = await readKuruV1TestnetMarketSnapshot(marketProvider);
const { provider: bookProvider } = mockProvider();
const book = await readKuruV1TestnetBookSnapshot(bookProvider, market, 9_900);

describe("legacy Kuru v1 testnet unsigned execution boundary", () => {
  for (const side of ["buy", "sell"] as const) {
    for (const cancelIds of [[], ["7", "8"]]) {
      test(`builds exact root ${side} batchUpdate calldata for ${cancelIds.length ? "replacement" : "initial placement"} only`, async () => {
        const plan = planKuruV1TestnetOrder({ chainId: 10143, book, market, margin, risk, side, nowMs: 10_000 });
        const { provider, simulationCalls, methods } = mockProvider();
        const unsigned = await buildUnsignedKuruV1TestnetBatchUpdate(plan, cancelIds, budget, provider, 10_000);
        const iface = new ethers.utils.Interface(["function batchUpdate(uint32[] buyPrices,uint96[] buySizes,uint32[] sellPrices,uint96[] sellSizes,uint40[] orderIdsToCancel,bool postOnly)"]);
        const decoded = iface.decodeFunctionData("batchUpdate", unsigned.data);
        const arrays = [decoded.buyPrices, decoded.buySizes, decoded.sellPrices, decoded.sellSizes]
          .map((items: ethers.BigNumber[]) => items.map(String));
        expect(arrays).toEqual(side === "buy" ? [[plan.priceRaw], [plan.sizeRaw], [], []] : [[], [], [plan.priceRaw], [plan.sizeRaw]]);
        expect(decoded.orderIdsToCancel.map(String)).toEqual(cancelIds);
        expect(decoded.postOnly).toBe(true);
        expect(unsigned).toMatchObject({
          chainId: 10143, account, market: KURU_V1_TESTNET_MARKET, operation: "batch_update_post_only_limit",
          gasLimit: "600000", gasPriceWei: budget.gasPriceWei, valueWei: "0", expectedCancelOrderIds: cancelIds,
          preparationOnly: true, conformanceScope: "root_batch_update_calldata_policy_only", establishesExecutionLifecycle: false,
        });
        expect(simulationCalls).toEqual([{ from: account, to: KURU_V1_TESTNET_MARKET.toLowerCase(), data: unsigned.data, blockTag: "0x66" }]);
        expect(methods).toEqual(["eth_chainId", "eth_blockNumber", "eth_chainId", "eth_getStorageAt", "eth_getCode", "eth_getStorageAt", "eth_getCode", "eth_call"]);
        expect("signTransaction" in unsigned).toBe(false);
        expect("nonce" in unsigned).toBe(false);
      });
    }
  }

  test("rejects forged plans, wrong chain, expired inputs, block lag and over-budget batch preparation", async () => {
    const plan = planKuruV1TestnetOrder({ chainId: 10143, book, market, margin, risk, side: "buy", nowMs: 10_000 });
    await expect(buildUnsignedKuruV1TestnetBatchUpdate({ ...plan }, [], budget, mockProvider().provider, 10_000)).rejects.toThrow(/Invalid Kuru v1 testnet order plan/);
    await expect(buildUnsignedKuruV1TestnetBatchUpdate(plan, [], budget, mockProvider(143).provider, 10_000)).rejects.toThrow(/chain 10143/);
    await expect(buildUnsignedKuruV1TestnetBatchUpdate(plan, [], budget, mockProvider().provider, 12_000)).rejects.toThrow(/expired/);
    await expect(buildUnsignedKuruV1TestnetBatchUpdate(plan, [], budget, mockProvider(10143, 103).provider, 10_000)).rejects.toThrow(/block lag/);
    await expect(buildUnsignedKuruV1TestnetBatchUpdate(plan, [], { ...budget, maxGasCostWei: "599999999999999" }, mockProvider().provider, 10_000)).rejects.toThrow(/gas budget/);
  });

  test("refuses invalid replacement IDs before any provider request", async () => {
    const plan = planKuruV1TestnetOrder({ chainId: 10143, book, market, margin, risk, side: "buy", nowMs: 10_000 });
    for (const ids of [["7", "7"], ["0"], [(1n << 40n).toString()], ["-1"], ["07"], Array.from({ length: 9 }, (_, index) => String(index + 1))]) {
      const { provider, methods } = mockProvider();
      await expect(buildUnsignedKuruV1TestnetBatchUpdate(plan, ids, budget, provider, 10_000)).rejects.toThrow();
      expect(methods).toEqual([]);
    }
    const { provider } = mockProvider();
    const valid = await buildUnsignedKuruV1TestnetBatchUpdate(plan, [(2n ** 40n - 1n).toString()], budget, provider, 10_000);
    expect(valid.expectedCancelOrderIds).toEqual(["1099511627775"]);
  });

  test("retains exact replacement IDs and refuses explicitly mocked filled/cancelled-target simulation failures", async () => {
    const plan = planKuruV1TestnetOrder({ chainId: 10143, book, market, margin, risk, side: "buy", nowMs: 10_000 });
    const iface = new ethers.utils.Interface(["function batchUpdate(uint32[] buyPrices,uint96[] buySizes,uint32[] sellPrices,uint96[] sellSizes,uint40[] orderIdsToCancel,bool postOnly)"]);
    // These are refused simulations, not a claim that every deployed filled-target batchUpdate reverts.
    for (const [orderId, targetState] of [["7", "filled"], ["8", "cancelled"]]) {
      const { provider, simulationCalls } = mockProvider(10143, 102, undefined, `mocked ${targetState}-target replacement rejection`);
      await expect(buildUnsignedKuruV1TestnetBatchUpdate(plan, [orderId], budget, provider, 10_000)).rejects.toThrow(/read-only simulation/);
      expect(simulationCalls).toHaveLength(1);
      expect(iface.decodeFunctionData("batchUpdate", simulationCalls[0].data).orderIdsToCancel.map(String)).toEqual([orderId]);
    }
  });
  test("plans only a fresh, depth-consistent, post-only order within account and notional limits", () => {
    const plan = planKuruV1TestnetOrder({ chainId: 10143, book, market, margin, risk, side: "buy", nowMs: 10_000 });
    expect(plan).toMatchObject({ chainId: 10143, side: "buy", priceRaw: "27021", sizeRaw: "100000000", notionalQuoteRaw: "2702100" });
  });

  test("rejects wrong deployment, stale inputs, mismatched depth, insufficient margin, forged margin, and a crossing book", async () => {
    const input = { chainId: 10143, book, market, margin, risk, side: "buy" as const, nowMs: 10_000 };
    expect(() => planKuruV1TestnetOrder({ ...input, chainId: 143 })).toThrow(/chain 10143/);
    expect(() => planKuruV1TestnetOrder({ ...input, nowMs: Number.NaN })).toThrow(/stale|receipt time/);
    expect(() => planKuruV1TestnetOrder({ ...input, nowMs: 20_000 })).toThrow(/stale/);
    expect(() => planKuruV1TestnetOrder({ ...input, book: { ...book, bid: 0.027003 } })).toThrow(/block-verified Kuru L2 book/);
    expect(() => planKuruV1TestnetOrder({ ...input, market: { ...market, market: "0x2222222222222222222222222222222222222222" } })).toThrow(/block-verified Kuru market/);
    expect(() => planKuruV1TestnetOrder({ ...input, market: { ...market } })).toThrow(/block-verified Kuru market/);
    const { provider: poorMarginProvider } = mockProvider(10143, 102, { base: "100000000000000000000", quote: "1" });
    const poorMargin = await readKuruV1TestnetMarginSnapshot(poorMarginProvider, account, "500000000000000000000");
    expect(() => planKuruV1TestnetOrder({ ...input, margin: poorMargin })).toThrow(/quote margin/);
    expect(() => planKuruV1TestnetOrder({ ...input, margin: { ...margin } })).toThrow(/block-verified/);
    const { provider: lowCapProvider } = mockProvider();
    const lowCapMargin = await readKuruV1TestnetMarginSnapshot(lowCapProvider, account, "150000000000000000000");
    expect(() => planKuruV1TestnetOrder({ ...input, margin: lowCapMargin })).toThrow(/position cap/);
    expect(() => planKuruV1TestnetOrder({ ...input, book: { ...book, ask: book.bid, asks: [[book.bid, 10]] } })).toThrow(/block-verified Kuru L2 book/);
  });

  test("rejects a two-sided book wider than the explicit spread risk limit", async () => {
    const { provider } = mockProvider(KURU_V1_TESTNET_CHAIN_ID, 102, undefined, false, { bid: 27012, ask: 28000 });
    const wideBook = await readKuruV1TestnetBookSnapshot(provider, market, 9_900);
    expect(wideBook.spreadBps).toBeGreaterThan(1);
    expect(() => planKuruV1TestnetOrder({ chainId: 10143, book: wideBook, market, margin, risk: { ...risk, maxSpreadBps: 1 }, side: "buy", nowMs: 10_000 }))
      .toThrow("Kuru book spread exceeds the configured risk limit");
  });

  test("returns unsigned buy calldata and checks chain plus fresh block through read-only RPC", async () => {
    const plan = planKuruV1TestnetOrder({ chainId: 10143, book, market, margin, risk, side: "buy", nowMs: 10_000 });
    const { provider, methods, simulationCalls } = mockProvider();
    const unsigned = await buildUnsignedKuruV1TestnetOrder(plan, budget, provider, 10_000);
    const iface = new ethers.utils.Interface(["function addBuyOrder(uint32 price,uint96 size,bool postOnly)"]);
    const decoded = iface.decodeFunctionData("addBuyOrder", unsigned.data);
    expect([decoded.price.toString(), decoded.size.toString(), decoded.postOnly]).toEqual(["27021", "100000000", true]);
    expect(unsigned).toMatchObject({ operation: "place_post_only_limit", account, market: KURU_V1_TESTNET_MARKET, valueWei: "0", gasLimit: "600000" });
    expect(methods).toEqual(["eth_chainId", "eth_blockNumber", "eth_chainId", "eth_getStorageAt", "eth_getCode", "eth_getStorageAt", "eth_getCode", "eth_call"]);
    expect(simulationCalls).toMatchObject([{ from: account, to: KURU_V1_TESTNET_MARKET.toLowerCase(), blockTag: "0x66" }]);
    expect("signTransaction" in unsigned).toBe(false);
  });

  test("does not let caller-constructed plans bypass the risk planner", async () => {
    const plan = planKuruV1TestnetOrder({ chainId: 10143, book, market, margin, risk, side: "buy", nowMs: 10_000 });
    expect(Object.isFrozen(plan)).toBe(true);
    const { provider } = mockProvider();
    await expect(buildUnsignedKuruV1TestnetOrder({ ...plan, sizeRaw: "999999999999999999999999999" }, budget, provider))
      .rejects.toThrow(/Invalid Kuru v1 testnet order plan/);
  });

  test("does not return order calldata when the read-only on-chain simulation reverts", async () => {
    const plan = planKuruV1TestnetOrder({ chainId: 10143, book, market, margin, risk, side: "buy", nowMs: 10_000 });
    const { provider, simulationCalls } = mockProvider(10143, 102, undefined, true);
    await expect(buildUnsignedKuruV1TestnetOrder(plan, budget, provider, 10_000)).rejects.toThrow(/read-only simulation/);
    expect(simulationCalls).toHaveLength(1);
    expect(simulationCalls[0]).toMatchObject({ from: account, to: KURU_V1_TESTNET_MARKET.toLowerCase(), blockTag: "0x66" });
  });

  test("rejects expired plans by time or testnet block advancement", async () => {
    const plan = planKuruV1TestnetOrder({ chainId: 10143, book, market, margin, risk, side: "buy", nowMs: 10_000 });
    const fresh = mockProvider(10143, 102);
    await expect(buildUnsignedKuruV1TestnetOrder(plan, budget, fresh.provider, 12_000)).rejects.toThrow(/expired/);
    const advanced = mockProvider(10143, 103);
    await expect(buildUnsignedKuruV1TestnetOrder(plan, budget, advanced.provider, 10_000)).rejects.toThrow(/block lag/);
  });

  test("reads Kuru-held token balances at one verified testnet block without a signer", async () => {
    const { provider, methods } = mockProvider();
    const snapshot = await readKuruV1TestnetMarginSnapshot(provider, account, "500000000000000000000");
    expect(snapshot).toEqual({
      account, observedBlock: 102, marginQuoteBalanceRaw: "250000000", marginBaseBalanceRaw: "100000000000000000000",
      maxPositionBaseRaw: "500000000000000000000",
    });
    expect(methods).toEqual(["eth_chainId", "eth_blockNumber", "eth_chainId", "eth_getStorageAt", "eth_getCode", "eth_getCode", "eth_call", "eth_call"]);
    expect(KURU_V1_TESTNET_MARGIN_ACCOUNT).toBe("0xd029C2D98ff85D8F64799017fE00a59B1159CE02");
  });

  test("reads precision, assets, limits, and maker fee from the allowlisted market at a verified block", async () => {
    const { provider, methods } = mockProvider();
    const snapshot = await readKuruV1TestnetMarketSnapshot(provider);
    expect(snapshot).toMatchObject({
      market: KURU_V1_TESTNET_MARKET, baseAssetAddress: ethers.constants.AddressZero,
      quoteAssetAddress: KURU_V1_TESTNET_QUOTE, baseAssetDecimals: 18, quoteAssetDecimals: 6,
      pricePrecision: "1000000", sizePrecision: "1000000", tickSizeRaw: "1", takerFeeBps: "0",
      minSizeRaw: "1000000", maxSizeRaw: "1000000000000000", makerFeeBps: "0", observedBlock: 102,
    });
    expect(methods).toEqual(["eth_chainId", "eth_blockNumber", "eth_chainId", "eth_getStorageAt", "eth_getCode", "eth_getCode", "eth_call"]);
  });

  test("fails closed if either pinned testnet proxy implementation changes", async () => {
    for (const [proxyAddress, label] of [[KURU_V1_TESTNET_MARKET, "market"], [KURU_V1_TESTNET_MARGIN_ACCOUNT, "Margin Account"]] as const) {
      const { provider } = mockProvider();
      const originalSend = provider.send.bind(provider);
      provider.send = async (method: string, params: unknown[] = []) => {
        if (method === "eth_getStorageAt" && String(params[0]).toLowerCase() === proxyAddress.toLowerCase()) {
          return `0x${"22".repeat(12)}${"22".repeat(20)}`;
        }
        return originalSend(method, params);
      };
      const read = label === "market"
        ? readKuruV1TestnetMarketSnapshot(provider)
        : readKuruV1TestnetMarginSnapshot(provider, account, "500000000000000000000");
      await expect(read).rejects.toThrow(new RegExp(`${label} implementation changed`));
    }
  });

  test("combines raw L2 and AMM vault depth at a verified testnet block", async () => {
    const { provider, methods, callBlockTags } = mockProvider();
    const snapshot = await readKuruV1TestnetBookSnapshot(provider, market, 9_900);
    expect(snapshot).toMatchObject({
      source: "Monad Kuru", chainId: 10143, block: 100, receivedAt: 9_900,
      bid: 0.02702, ask: 0.027035,
    });
    expect(snapshot.bids).toContainEqual([0.02702, 5]);
    expect(snapshot.asks).toContainEqual([0.027035, 5]);
    expect(snapshot.bids).toContainEqual([0.027012, 1000]);
    expect(snapshot.asks).toContainEqual([0.027045, 1000]);
    expect(methods).toEqual(["eth_chainId", "eth_blockNumber", "eth_chainId", "eth_getStorageAt", "eth_getCode", "eth_call", "eth_call"]);
    expect(callBlockTags).toEqual(["0x66", "0x64"]);
    expect(() => planKuruV1TestnetOrder({ chainId: 10143, book: { ...snapshot }, market, margin, risk, side: "buy", nowMs: 10_000 }))
      .toThrow(/block-verified Kuru L2 book/);
  });

  test("returns unsigned cancel calldata for explicit bounded order IDs", async () => {
    const { provider, methods, simulationCalls } = mockProvider();
    const unsigned = await buildUnsignedKuruV1TestnetCancel({ chainId: 10143, market: KURU_V1_TESTNET_MARKET, account, orderIds: ["7", "8"] }, budget, provider);
    const iface = new ethers.utils.Interface(["function batchCancelOrders(uint40[] orderIds)"]);
    const decoded = iface.decodeFunctionData("batchCancelOrders", unsigned.data);
    expect(decoded.orderIds.map((id: ethers.BigNumber) => id.toString())).toEqual(["7", "8"]);
    expect(unsigned).toMatchObject({ operation: "cancel_orders", gasLimit: "600000" });
    expect(methods).toEqual(["eth_chainId", "eth_blockNumber", "eth_chainId", "eth_getStorageAt", "eth_getCode", "eth_call"]);
    expect(simulationCalls).toMatchObject([{ from: account, to: KURU_V1_TESTNET_MARKET.toLowerCase(), blockTag: "0x66" }]);
  });

  test("rejects an unexpected RPC chain and gas budget overrun", async () => {
    const plan = planKuruV1TestnetOrder({ chainId: 10143, book, market, margin, risk, side: "buy", nowMs: 10_000 });
    const wrongChain = mockProvider(143);
    await expect(buildUnsignedKuruV1TestnetOrder(plan, budget, wrongChain.provider, 10_000)).rejects.toThrow(/chain 10143/);
    expect(() => planKuruV1TestnetOrder({ chainId: 10143, book, market, margin, risk: { ...risk, maxNotionalQuoteRaw: "1" }, side: "buy", nowMs: 10_000 })).toThrow(/notional/);
    const rightChain = mockProvider();
    await expect(buildUnsignedKuruV1TestnetCancel({ chainId: 10143, market: KURU_V1_TESTNET_MARKET, account, orderIds: ["1"] }, { ...budget, maxGasCostWei: "599999999999999" }, rightChain.provider)).rejects.toThrow(/gas budget/);
  });
});
