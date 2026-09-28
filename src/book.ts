import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import { config } from "./config";
import type { Book } from "./types";

export interface BookReader {
  read(): Promise<Book>;
  close?(): void;
}

/** Read-only adapter over the published Kuru SDK and Monad JSON-RPC provider. */
export class KuruBookReader implements BookReader {
  private readonly provider = new ethers.providers.StaticJsonRpcProvider(config.rpcUrl, 143);
  private params: Kuru.MarketParams | null = null;

  async read(): Promise<Book> {
    this.params ??= await Kuru.ParamFetcher.getMarketParams(this.provider, config.market);
    const raw = await Kuru.OrderBook.getFormattedL2OrderBook(this.provider, config.market, this.params);
    const bids = raw.bids.map((level: any) => [Number(level[0]), Number(level[1])] as const).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => b[0] - a[0]);
    const asks = raw.asks.map((level: any) => [Number(level[0]), Number(level[1])] as const).filter(([p, s]) => p > 0 && s > 0).sort((a, b) => a[0] - b[0]);
    if (!bids.length || !asks.length || bids[0]![0] >= asks[0]![0]) throw new Error("Kuru returned an empty or crossed public book.");
    const bid = bids[0]![0], ask = asks[0]![0];
    return { block: Number(raw.blockNumber ?? await this.provider.getBlockNumber()), bid, ask, mid: (bid + ask) / 2, spreadBps: (ask - bid) / ((ask + bid) / 2) * 10_000, source: "Monad Kuru" };
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
