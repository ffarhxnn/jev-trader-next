import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import { config } from "./config";
import type { Book, DepthSnapshot } from "./types";
import { readRpcConnectionInfo, readWithRpcFailover } from "./rpc-failover";

const MONAD_CHAIN_ID = 143;

export function parseRpcChainId(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  if (/^0x[0-9a-f]+$/i.test(value)) {
    const parsed = Number.parseInt(value.slice(2), 16);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  if (/^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function assertMonadRpcChainId(value: unknown): void {
  const actual = parseRpcChainId(value);
  if (actual !== MONAD_CHAIN_ID) {
    throw new Error(`Configured RPC chain mismatch: expected Monad ${MONAD_CHAIN_ID}; received ${actual ?? "invalid"}.`);
  }
}

export interface BookReader {
  read(): Promise<Book>;
  close?(): void;
}

/** Read-only adapter over the published Kuru SDK and Monad JSON-RPC provider. */
export class KuruBookReader implements BookReader {
  private readonly providers = config.rpcUrls.map((url) => new ethers.providers.StaticJsonRpcProvider(readRpcConnectionInfo(url), 143));
  private readonly params = new Map<number, Kuru.MarketParams>();
  private readonly verifiedProviderIndices = new Set<number>();
  private preferredProviderIndex = 0;

  private async verifyNetwork(provider: ethers.providers.StaticJsonRpcProvider, endpointIndex: number) {
    if (this.verifiedProviderIndices.has(endpointIndex)) return;
    assertMonadRpcChainId(await provider.send("eth_chainId", []));
    this.verifiedProviderIndices.add(endpointIndex);
  }

  private async getMarketParams(provider: ethers.providers.StaticJsonRpcProvider, endpointIndex: number) {
    let params = this.params.get(endpointIndex);
    if (!params) {
      params = await Kuru.ParamFetcher.getMarketParams(provider, config.market);
      this.params.set(endpointIndex, params);
    }
    return params;
  }

  async getSizePrecision(): Promise<number> {
    const result = await readWithRpcFailover(this.providers, this.preferredProviderIndex, async (provider, endpointIndex) => {
      await this.verifyNetwork(provider, endpointIndex);
      const params = await this.getMarketParams(provider, endpointIndex);
      const sizePrecision = Number(params.sizePrecision.toString());
      if (!Number.isFinite(sizePrecision) || sizePrecision <= 0) throw new Error("Kuru returned an invalid size precision.");
      return sizePrecision;
    });
    this.preferredProviderIndex = result.endpointIndex;
    return result.value;
  }

  async read(): Promise<Book> {
    const snapshot = await this.readDepth();
    const bid = snapshot.bids[0]![0], ask = snapshot.asks[0]![0];
    return { block: snapshot.block, chainId: MONAD_CHAIN_ID, bid, ask, mid: (bid + ask) / 2, spreadBps: (ask - bid) / ((ask + bid) / 2) * 10_000, source: "Monad Kuru", tickSize: snapshot.tickSize, makerFeeBps: snapshot.makerFeeBps, market: snapshot.market, sizePrecision: snapshot.sizePrecision, minSizeMon: snapshot.minSizeMon, takerFeeBps: snapshot.takerFeeBps, captureIntervalMs: config.pollMs, bids: snapshot.bids, asks: snapshot.asks };
  }

  async readDepth(): Promise<DepthSnapshot> {
    const result = await readWithRpcFailover(this.providers, this.preferredProviderIndex,
      (provider, endpointIndex) => this.readDepthFrom(provider, endpointIndex));
    this.preferredProviderIndex = result.endpointIndex;
    return { ...result.value, rpcEndpointIndex: result.endpointIndex };
  }

  private async readDepthFrom(provider: ethers.providers.StaticJsonRpcProvider, endpointIndex: number): Promise<DepthSnapshot> {
    await this.verifyNetwork(provider, endpointIndex);
    const params = await this.getMarketParams(provider, endpointIndex);
    const raw = await Kuru.OrderBook.getFormattedL2OrderBook(provider, config.market, params);
    const parseLevels = (levels: unknown, side: "bid" | "ask"): [number, number][] => {
      if (!Array.isArray(levels) || !levels.length) throw new Error(`Kuru returned no public ${side} levels.`);
      return levels.map((level: unknown) => {
        if (!Array.isArray(level) || level.length < 2) throw new Error(`Kuru returned a malformed ${side} level.`);
        const price = Number(level[0]), size = Number(level[1]);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) throw new Error(`Kuru returned an invalid ${side} price or size.`);
        return [price, size] as [number, number];
      }).filter(([, size]) => size > 0).sort((a, b) => side === "bid" ? b[0] - a[0] : a[0] - b[0]);
    };
    const bids = parseLevels(raw.bids, "bid");
    const asks = parseLevels(raw.asks, "ask");
    if (!bids.length || !asks.length || bids[0]![0] >= asks[0]![0]) throw new Error("Kuru returned an empty or crossed public book.");
    const param = (value: unknown) => Number((value as { toString?: () => string } | undefined)?.toString?.());
    const pricePrecision = param(params.pricePrecision);
    const tickSize = pricePrecision > 0 ? param(params.tickSize) / pricePrecision : Number.NaN;
    const sizePrecision = param(params.sizePrecision);
    const minSizeMon = param(params.minSize) / sizePrecision;
    const makerFeeBps = param(params.makerFeeBps);
    const takerFeeBps = param(params.takerFeeBps);
    const block = Number(raw.blockNumber ?? await provider.getBlockNumber());
    if (!Number.isSafeInteger(block) || block <= 0 || !Number.isFinite(tickSize) || tickSize <= 0 || !Number.isFinite(sizePrecision) || sizePrecision <= 0 || !Number.isFinite(minSizeMon) || minSizeMon <= 0 || !Number.isFinite(makerFeeBps) || makerFeeBps < 0 || !Number.isFinite(takerFeeBps) || takerFeeBps < 0) {
      throw new Error("Kuru returned invalid block, tick, size, precision, or fee parameters.");
    }
    return {
      timestamp: Date.now(), block, chainId: MONAD_CHAIN_ID, market: config.market, tickSize, sizePrecision, minSizeMon, makerFeeBps, takerFeeBps,
      bids, asks,
    };
  }
}

export class DemoBookReader implements BookReader {
  private n = 0;
  private mid = 0.02;
  async read(): Promise<Book> {
    this.n++;
    const wave = Math.sin(this.n / 19) * 0.000012 + Math.sin(this.n / 61) * 0.000018;
    this.mid = Math.max(0.000001, this.mid + wave + Math.sin(this.n * 1.7) * 0.0000009);
    const half = this.mid * 0.00032;
    return { block: this.n, bid: this.mid - half, ask: this.mid + half, mid: this.mid, spreadBps: half * 2 / this.mid * 10_000, source: "synthetic demo" };
  }
}
