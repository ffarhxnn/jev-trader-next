import { describe, expect, test } from "bun:test";
import { ethers } from "ethers";
import {
  KURU_MAINNET_CHAIN_ID,
  KURU_MAINNET_MARKET_IMPLEMENTATION,
  KURU_MAINNET_MARGIN_ACCOUNT,
  KURU_MAINNET_MARGIN_IMPLEMENTATION,
  KURU_MAINNET_MON_USDC_MARKET,
  KURU_MAINNET_USDC,
  readKuruMainnetBookSnapshot,
  readKuruMainnetAccountOrdersSnapshot,
  readKuruMainnetMarginSnapshot,
  readKuruMainnetMarketSnapshot,
} from "../src/kuru-mainnet-readiness";

function mockProvider(chainId = KURU_MAINNET_CHAIN_ID, blockNumber = 102) {
  const provider = new ethers.providers.JsonRpcProvider();
  const calls: unknown[][] = [];
  provider.send = async (method: string, params: unknown[] = []) => {
    if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
    if (method === "eth_blockNumber") return `0x${blockNumber.toString(16)}`;
    if (method === "eth_getStorageAt") {
      const address = String(params[0]).toLowerCase();
      const implementation = address === KURU_MAINNET_MON_USDC_MARKET.toLowerCase()
        ? KURU_MAINNET_MARKET_IMPLEMENTATION : KURU_MAINNET_MARGIN_IMPLEMENTATION;
      return `0x${implementation.slice(2).padStart(64, "0")}`;
    }
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_call") {
      calls.push(params);
      const tx = params[0] as { data: string };
      const marketIface = new ethers.utils.Interface([
        "function getMarketParams() view returns (uint32,uint96,address,uint256,address,uint256,uint32,uint96,uint96,uint256,uint256)",
        "function getL2Book() view returns (bytes)",
        "function s_buyPricePoints(uint256) view returns (uint40,uint40)",
        "function s_sellPricePoints(uint256) view returns (uint40,uint40)",
        "function s_orders(uint40) view returns (address,uint96,uint40,uint40,uint40,uint32,uint32,bool)",
      ]);
      if (tx.data.slice(0, 10) === marketIface.getSighash("getMarketParams")) {
        return marketIface.encodeFunctionResult("getMarketParams", [
          "100000000", "10000000000", ethers.constants.AddressZero, "18", KURU_MAINNET_USDC, "6",
          "100", "2000000000000", "2000000000000000000", "0", "0",
        ]);
      }
      if (tx.data.slice(0, 10) === marketIface.getSighash("getL2Book")) {
        const word = (value: number | bigint) => BigInt(value).toString(16).padStart(64, "0");
        const raw = `0x${[
          word(100), word(2_714_900), word(20_000_000_000_000), word(2_714_800), word(10_000_000_000_000), word(0),
          word(2_720_400), word(20_000_000_000_000), word(2_720_500), word(10_000_000_000_000),
        ].join("")}`;
        return marketIface.encodeFunctionResult("getL2Book", [raw]);
      }
      for (const method of ["s_buyPricePoints", "s_sellPricePoints"] as const) {
        if (tx.data.slice(0, 10) === marketIface.getSighash(method)) {
          const [price] = marketIface.decodeFunctionData(method, tx.data);
          const sideBase = method === "s_buyPricePoints" ? 1000 : 1002;
          const offset = ["2714900", "2714800", "2720400", "2720500"].indexOf(price.toString());
          const orderId = sideBase + (offset % 2);
          return marketIface.encodeFunctionResult(method, [orderId.toString(), orderId.toString()]);
        }
      }
      if (tx.data.slice(0, 10) === marketIface.getSighash("s_orders")) {
        const [orderId] = marketIface.decodeFunctionData("s_orders", tx.data);
        const id = Number(orderId.toString());
        const fixtures: Record<number, [string, string, string, string, string, string, string, boolean]> = {
          1000: ["0x1111111111111111111111111111111111111111", "20000000000000", "0", "0", "0", "2714900", "0", true],
          1001: ["0x2222222222222222222222222222222222222222", "10000000000000", "0", "0", "0", "2714800", "0", true],
          1002: ["0x1111111111111111111111111111111111111111", "20000000000000", "0", "0", "0", "2720400", "0", false],
          1003: ["0x2222222222222222222222222222222222222222", "10000000000000", "0", "0", "0", "2720500", "0", false],
        };
        return marketIface.encodeFunctionResult("s_orders", fixtures[id]!);
      }
      const marginIface = new ethers.utils.Interface(["function getBalance(address user,address token) view returns (uint256)"]);
      if (tx.data.slice(0, 10) === marginIface.getSighash("getBalance")) {
        const [user, token] = marginIface.decodeFunctionData("getBalance", tx.data);
        return marginIface.encodeFunctionResult("getBalance", [token === ethers.constants.AddressZero ? "1234567890123456789" : user === ethers.constants.AddressZero ? "0" : "987654"]);
      }
      const vaultIface = new ethers.utils.Interface(["function getVaultParams() view returns (address,uint256,uint96,uint256,uint96,uint96,uint96,uint96)"]);
      if (tx.data.slice(0, 10) === vaultIface.getSighash("getVaultParams")) {
        return vaultIface.encodeFunctionResult("getVaultParams", [
          "0x3333333333333333333333333333333333333333", "27150500000000000", "0", "27202000000000000", "0",
          "100000000000", "100000000000", "10",
        ]);
      }
      throw new Error("Unexpected eth_call selector");
    }
    throw new Error(`Unexpected RPC method ${method}`);
  };
  return { provider, calls };
}

describe("read-only Kuru mainnet readiness snapshot", () => {
  test("reads official mainnet code and market parameters at one verified block", async () => {
    const { provider } = mockProvider();
    const market = await readKuruMainnetMarketSnapshot(provider);
    expect(market).toMatchObject({
      chainId: 143, market: KURU_MAINNET_MON_USDC_MARKET, observedBlock: 102,
      baseAssetAddress: ethers.constants.AddressZero, baseAssetDecimals: 18,
      quoteAssetAddress: KURU_MAINNET_USDC, quoteAssetDecimals: 6,
      pricePrecision: "100000000", sizePrecision: "10000000000", tickSizeRaw: "100",
      minSizeRaw: "2000000000000", maxSizeRaw: "2000000000000000000", makerFeeBps: "0", takerFeeBps: "0",
    });
    expect(KURU_MAINNET_MARGIN_ACCOUNT).toBe("0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5");
  });

  test("combines mainnet manual and AMM depth at the L2 source block", async () => {
    const { provider, calls } = mockProvider();
    const market = await readKuruMainnetMarketSnapshot(provider);
    const book = await readKuruMainnetBookSnapshot(provider, market, 50_000);
    expect(book).toMatchObject({ source: "Monad Kuru", chainId: 143, block: 100, receivedAt: 50_000, bid: 0.0271505, ask: 0.027202 });
    expect(book.bids).toContainEqual([0.027149, 2000]);
    expect(book.asks).toContainEqual([0.027204, 2000]);
    expect(book.bids).toContainEqual([0.0271505, 10]);
    expect(book.asks).toContainEqual([0.027202, 10]);
    expect(calls.map((call) => call[1])).toContain("0x64");
  });

  test("reads raw Kuru margin balances for a public account at one verified block", async () => {
    const { provider, calls } = mockProvider();
    const account = "0x1111111111111111111111111111111111111111";
    const snapshot = await readKuruMainnetMarginSnapshot(provider, account);
    expect(snapshot).toEqual({
      chainId: 143,
      implementation: KURU_MAINNET_MARGIN_IMPLEMENTATION,
      account,
      observedBlock: 102,
      marginBaseBalanceRaw: "1234567890123456789",
      marginQuoteBalanceRaw: "987654",
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[1]).toBe("0x66");
      const tx = call[0] as { to: string; data: string };
      expect(tx.to.toLowerCase()).toBe(KURU_MAINNET_MARGIN_ACCOUNT.toLowerCase());
      const iface = new ethers.utils.Interface(["function getBalance(address user,address token) view returns (uint256)"]);
      const [user] = iface.decodeFunctionData("getBalance", tx.data);
      expect(user).toBe(account);
    }
  });

  test("enumerates and reconciles every active manual order at the same block as balances", async () => {
    const { provider } = mockProvider();
    const account = "0x1111111111111111111111111111111111111111";
    const snapshot = await readKuruMainnetAccountOrdersSnapshot(provider, account);
    expect(snapshot).toMatchObject({
      chainId: 143, account, market: KURU_MAINNET_MON_USDC_MARKET, observedBlock: 102,
      bookSourceBlock: 100, marginBaseBalanceRaw: "1234567890123456789", marginQuoteBalanceRaw: "987654",
      manualOrderCount: 4, accountOpenBuyQuoteNotionalRawCeil: "54298000", accountOpenSellBaseTokenRaw: "2000000000000000000000",
    });
    expect(snapshot.accountOrders).toEqual([
      { orderId: "1000", side: "buy", priceRaw: "2714900", sizePrecisionRaw: "20000000000000", baseTokenRaw: "2000000000000000000000", quoteNotionalRawCeil: "54298000" },
      { orderId: "1002", side: "sell", priceRaw: "2720400", sizePrecisionRaw: "20000000000000", baseTokenRaw: "2000000000000000000000", quoteNotionalRawCeil: "54408000" },
    ]);
  });

  test("fails closed if full manual-order enumeration exceeds its bound", async () => {
    const { provider } = mockProvider();
    await expect(readKuruMainnetAccountOrdersSnapshot(provider, "0x1111111111111111111111111111111111111111", 2)).rejects.toThrow(/bounded 2-order/);
  });

  test("rejects a wrong chain or invalid account before reading margin balances", async () => {
    const wrong = mockProvider(10143);
    await expect(readKuruMainnetMarginSnapshot(wrong.provider, "0x1111111111111111111111111111111111111111")).rejects.toThrow(/chain 143/);
    expect(wrong.calls).toHaveLength(0);
    const { provider, calls } = mockProvider();
    await expect(readKuruMainnetMarginSnapshot(provider, "not-an-address")).rejects.toThrow(/Invalid margin account/);
    expect(calls).toHaveLength(0);
  });

  test("fails closed when an allowlisted mainnet proxy changes implementation", async () => {
    const { provider } = mockProvider();
    const originalSend = provider.send.bind(provider);
    provider.send = async (method: string, params: unknown[] = []) => {
      if (method === "eth_getStorageAt" && String(params[0]).toLowerCase() === KURU_MAINNET_MON_USDC_MARKET.toLowerCase()) {
        return `0x${"4444444444444444444444444444444444444444".padStart(64, "0")}`;
      }
      return originalSend(method, params);
    };
    await expect(readKuruMainnetMarketSnapshot(provider)).rejects.toThrow(/implementation changed/);
  });

  test("fails closed when the Margin Account proxy implementation changes", async () => {
    const { provider } = mockProvider();
    const originalSend = provider.send.bind(provider);
    provider.send = async (method: string, params: unknown[] = []) => {
      if (method === "eth_getStorageAt" && String(params[0]).toLowerCase() === KURU_MAINNET_MARGIN_ACCOUNT.toLowerCase()) {
        return `0x${"4444444444444444444444444444444444444444".padStart(64, "0")}`;
      }
      return originalSend(method, params);
    };
    await expect(readKuruMainnetMarginSnapshot(provider, "0x1111111111111111111111111111111111111111")).rejects.toThrow(/implementation changed/);
  });

  test("rejects the wrong chain and hand-built market parameters", async () => {
    const wrong = mockProvider(10143);
    await expect(readKuruMainnetMarketSnapshot(wrong.provider)).rejects.toThrow(/chain 143/);
    const { provider } = mockProvider();
    const verified = await readKuruMainnetMarketSnapshot(provider);
    await expect(readKuruMainnetBookSnapshot(provider, { ...verified }, 50_000)).rejects.toThrow(/verified Kuru mainnet/);
  });
});
