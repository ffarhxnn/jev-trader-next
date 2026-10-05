import { describe, expect, test } from "bun:test";
import { PaperEngine, quotePrice } from "../src/paper";
import type { Book, Decision } from "../src/types";
import type { DecisionModel, ModelStatus } from "../src/model";

class FixedModel implements DecisionModel {
  readonly name = "test stand-in";
  calls = 0;
  constructor(private readonly actions: Decision["action"][]) {}
  status(): ModelStatus { return { state: "ready", retryAt: null, reason: null }; }
  async decide(book: Book): Promise<Decision> {
    const action = this.actions[this.calls++] ?? "hold";
    return { action, buy: 0.7, sell: 0.3, latencyMs: 1, model: this.name, source: "local demo heuristic" };
  }
}

const mkBook = (block: number, bid: number, ask: number): Book => ({ block, bid, ask, mid: (bid + ask) / 2, spreadBps: (ask - bid) / ((ask + bid) / 2) * 10_000, source: "synthetic demo" });

describe("paper execution boundaries", () => {
  test("quotes remain post-only and reject malformed or too-narrow books", () => {
    const book = { bid: 1, ask: 1.00001 };
    const buy = quotePrice(book, "buy", 0.000001)!;
    const sell = quotePrice(book, "sell", 0.000001)!;
    expect(buy).toBeLessThan(book.ask);
    expect(sell).toBeGreaterThan(book.bid);
    expect(quotePrice({ bid: 1, ask: 1.000001 }, "buy", 0.000001)).toBe(1);
    expect(quotePrice({ bid: 1, ask: 1 }, "buy")).toBeNull();
  });

  test("a wide market spread cancels paper quotes and prevents another model decision", async () => {
    const model = new FixedModel(["buy", "buy"]);
    const engine = new PaperEngine({ mode: "paper", model, orderSizeMon: 10, positionCapMon: 20, startingCash: 10, feeBps: 0, lossStopUsd: 10 });
    engine.setTradeFeedHealthy(true);
    const normal = await engine.onBook(mkBook(1, 0.0499, 0.0501));
    expect(normal.quote?.status).toBe("resting");
    expect(normal.notice).toContain("Local demo heuristic decision");
    expect(model.calls).toBe(1);

    const bid = 0.027718, ask = 0.036;
    const wide = await engine.onBook({ ...mkBook(2, bid, ask), spreadBps: (ask - bid) / ((ask + bid) / 2) * 10_000 });

    expect(wide.quote).toBeNull();
    expect(wide.totals.quotes).toBe(1);
    expect(wide.totals.decisions).toBe(1);
    expect(model.calls).toBe(1);
    expect(wide.notice).toContain("50 bps limit blocks model decisions and paper quotes");
  });

  test("quote rests first, fills only on a later observed midpoint cross, and equity includes fees once", async () => {
    const model = new FixedModel(["buy", "hold"]);
    const engine = new PaperEngine({ mode: "demo", model, orderSizeMon: 10, positionCapMon: 20, startingCash: 10, lossStopUsd: 10, feeBps: 20 });
    const first = await engine.onBook(mkBook(1, 0.049, 0.051));
    expect(first.quote?.status).toBe("resting");
    expect(first.totals.fills).toBe(0);
    const fill = await engine.onBook(mkBook(2, 0.047, 0.049));
    expect(fill.totals.fills).toBe(1);
    expect(fill.position.mon).toBe(10);
    expect(fill.quote).toBeNull();
    expect(fill.totals.pnlUsd).toBeCloseTo(fill.position.cash + fill.position.mon * 0.048 - 10, 8);
    expect(fill.totals.feesUsd).toBeGreaterThan(0);
    expect(fill.totals.pnlUsd).toBeLessThan(0.01);
  });

  test("keeps the last buy or sell signal visible during cadence wait without making another decision", async () => {
    let waiting = false;
    const model: DecisionModel = {
      name: "stand-in momentum heuristic",
      status: () => waiting
        ? { state: "waiting", retryAt: 20_000, reason: "Waiting for the local demo decision cadence." }
        : { state: "ready", retryAt: null, reason: null },
      decide: async () => {
        waiting = true;
        return { action: "buy", buy: 0.72, sell: 0.28, latencyMs: 1, model: model.name, source: "local demo heuristic" };
      },
    };
    const engine = new PaperEngine({ mode: "paper", model, orderSizeMon: 10, positionCapMon: 20, startingCash: 10, lossStopUsd: 10, feeBps: 0, now: () => 10_000 });
    engine.setTradeFeedHealthy(true);
    const signal = await engine.onBook(mkBook(1, 0.0499, 0.0501));
    const cadence = await engine.onBook(mkBook(2, 0.0499, 0.0501));

    expect(signal.decision?.action).toBe("buy");
    expect(cadence.decision).toMatchObject({ action: "buy", buy: 0.72, sell: 0.28 });
    expect(cadence.modelStatus).toBe("waiting");
    expect(cadence.totals.decisions).toBe(1);
    expect(cadence.totals.quotes).toBe(1);
    expect(cadence.quote?.side).toBe("buy");
  });

  test("mark-to-market loss stop latches and prevents subsequent decisions and quotes", async () => {
    const model = new FixedModel(["buy", "buy", "buy"]);
    const engine = new PaperEngine({ mode: "demo", model, orderSizeMon: 10, positionCapMon: 20, startingCash: 10, lossStopUsd: 0.1 });
    await engine.onBook(mkBook(1, 0.049, 0.051));
    const stopped = await engine.onBook(mkBook(2, 0.001, 0.003));
    expect(stopped.status).toBe("stopped");
    expect(stopped.totals.fills).toBe(1);
    expect(stopped.totals.decisions).toBe(1);
    expect(stopped.quote).toBeNull();
    await engine.onBook(mkBook(3, 0.001, 0.003));
    expect(model.calls).toBe(1);
  });

  test("persists market, equity, and limit when the paper loss stop trips", async () => {
    const model = new FixedModel(["buy", "buy"]);
    const saved: Record<string, unknown>[] = [];
    const engine = new PaperEngine({ mode: "demo", model, orderSizeMon: 10, positionCapMon: 20, startingCash: 10, lossStopUsd: 0.1, persistRiskStop: (state) => { saved.push(state); } });
    await engine.onBook(mkBook(1, 0.049, 0.051));
    const stopped = await engine.onBook(mkBook(2, 0.001, 0.003));
    expect(stopped.status).toBe("stopped");
    expect(stopped.quote).toBeNull();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({
      market: "0x065c9d28e428a0db40191a54d33d5b7c71a9c394", latchedAt: expect.any(Number),
      startingEquityUsd: 10, equityAtStopUsd: expect.any(Number), lossLimitUsd: 0.1,
    });
  });

  test("keeps trading stopped in memory when the durable latch write fails", async () => {
    const model = new FixedModel(["buy", "buy"]);
    const engine = new PaperEngine({ mode: "demo", model, orderSizeMon: 10, positionCapMon: 20, startingCash: 10, lossStopUsd: 0.1, persistRiskStop: () => { throw new Error("disk unavailable"); } });
    await engine.onBook(mkBook(1, 0.049, 0.051));
    const stopped = await engine.onBook(mkBook(2, 0.001, 0.003));
    expect(stopped.status).toBe("stopped");
    expect(stopped.quote).toBeNull();
    expect(stopped.notice).toContain("saving its persistent latch failed");
    expect(model.calls).toBe(1);
  });

  test("restores a persistent loss stop before paper decisions can resume", async () => {
    const model = new FixedModel(["buy"]);
    const riskStop = {
      version: 1 as const, mode: "paper" as const, reason: "MAX_MARK_TO_MARKET_LOSS" as const,
      market: "0x065c9d28e428a0db40191a54d33d5b7c71a9c394", latchedAt: 1_700_000_000_000,
      startingEquityUsd: 100, equityAtStopUsd: 80, lossLimitUsd: 20,
    };
    const restored = new PaperEngine({ mode: "paper", model, orderSizeMon: 10, positionCapMon: 20, startingCash: 10, riskStop });
    restored.setTradeFeedHealthy(true);
    const snapshot = await restored.onBook({ ...mkBook(1, 0.0499, 0.0501), source: "Monad Kuru", makerFeeBps: 0 });
    expect(snapshot.status).toBe("stopped");
    expect(snapshot.decision).toBeNull();
    expect(snapshot.quote).toBeNull();
    expect(snapshot.totals.decisions).toBe(0);
    expect(model.calls).toBe(0);
    expect(snapshot.notice).toContain("loss stop remains latched");
  });

  test("an RPC outage changes the dashboard to degraded until a fresh book arrives", async () => {
    const engine = new PaperEngine({ mode: "paper", model: new FixedModel(["buy", "hold"]), orderSizeMon: 10, positionCapMon: 20, startingCash: 10, lossStopUsd: 10, feeBps: 0 });
    engine.setTradeFeedHealthy(true);
    const quoted = await engine.onBook(mkBook(1, 0.01995, 0.02005));
    expect(quoted.quote?.status).toBe("resting");
    engine.setUnavailable("RPC unavailable");
    expect(engine.snapshot().status).toBe("degraded");
    expect(engine.snapshot().quote).toBeNull();
    const recovered = await engine.onBook(mkBook(2, 0.01995, 0.02005));
    expect(recovered.status).toBe("live");
    expect(recovered.totals.fills).toBe(0);
  });

  test("Kuru paper fills require exact-price opposite-side trades after visible queue ahead", async () => {
    const engine = new PaperEngine({ mode: "paper", model: new FixedModel(["buy", "buy"]), orderSizeMon: 10, positionCapMon: 20, startingCash: 10, lossStopUsd: 10, now: () => 0 });
    engine.setTradeFeedHealthy(true);
    const book: Book = { ...mkBook(1, 0.0499, 0.05), source: "Monad Kuru", tickSize: 0.0001, makerFeeBps: 0, bids: [[0.0499, 5]], asks: [[0.05, 4]] };
    const quoted = await engine.onBook(book);
    expect(quoted.quote?.price).toBe(0.0499);
    expect(quoted.quote?.queueAhead).toBe(5);

    const crossedBook = await engine.onBook({ ...mkBook(2, 0.0498, 0.0499), source: book.source, tickSize: book.tickSize, makerFeeBps: book.makerFeeBps, bids: [[0.0498, 5]], asks: [[0.0499, 4]] });
    expect(crossedBook.totals.fills).toBe(0);
    expect(crossedBook.quote?.queueAhead).toBe(5);
    engine.onTrade({ timestamp: 2.5, price: 0.0498, size: 20, takerSide: "buy" });
    engine.onTrade({ timestamp: 2.6, price: 0.0497, size: 20, takerSide: "sell" });
    expect(engine.snapshot().quote?.queueAhead).toBe(5);
    expect(engine.snapshot().totals.fills).toBe(0);

    engine.onTrade({ timestamp: 3, price: 0.0498, size: 3, takerSide: "sell" });
    expect(engine.snapshot().quote?.queueAhead).toBe(2);
    expect(engine.snapshot().totals.fills).toBe(0);
    engine.onTrade({ timestamp: 4, price: 0.0498, size: 4, takerSide: "sell" });
    expect(engine.snapshot().totals.fills).toBe(1);
    expect(engine.snapshot().quote?.size).toBe(8);
    engine.onTrade({ timestamp: 5, price: 0.0498, size: 8, takerSide: "sell", transactionHash: `0x${"c".repeat(64)}`, sourceTimestamp: "1790000000123" });
    expect(engine.snapshot().totals.fills).toBe(2);
    expect(engine.snapshot().tape[0]?.ts).toBe(5);
    expect(engine.snapshot().tape[0]?.tradeTransactionHash).toBe(`0x${"c".repeat(64)}`);
    expect(engine.snapshot().tape[0]?.tradeSourceTimestamp).toBe("1790000000123");
    expect(engine.snapshot().quote).toBeNull();
    expect(engine.snapshot().position.mon).toBe(10);
    expect(engine.snapshot().totals.tradeEvents).toBe(5);
    expect(engine.snapshot().totals.lastTradeAt).toBe(5);
    engine.onIgnoredTrade();
    expect(engine.snapshot().totals.ignoredTradeEvents).toBe(1);
  });

  test("paper sells require inventory and cannot create a short position", async () => {
    const empty = new PaperEngine({ mode: "paper", model: new FixedModel(["sell"]), orderSizeMon: 10, positionCapMon: 20, startingCash: 10, lossStopUsd: 10, now: () => 0 });
    empty.setTradeFeedHealthy(true);
    const book: Book = { ...mkBook(1, 0.0499, 0.05), source: "Monad Kuru", tickSize: 0.0001, makerFeeBps: 0, bids: [[0.0499, 0]], asks: [[0.05, 0]] };
    const blocked = await empty.onBook(book);
    expect(blocked.decision?.action).toBe("sell");
    expect(blocked.quote).toBeNull();
    expect(blocked.position.mon).toBe(0);
    expect(blocked.notice).toContain("shorting is disabled");

    const funded = new PaperEngine({ mode: "paper", model: new FixedModel(["buy", "sell"]), orderSizeMon: 10, positionCapMon: 20, startingCash: 10, lossStopUsd: 10, now: () => 0 });
    funded.setTradeFeedHealthy(true);
    await funded.onBook(book);
    funded.onTrade({ timestamp: 1, price: 0.0499, size: 10, takerSide: "sell" });
    const sellQuote = await funded.onBook({ ...book, block: 2 });
    expect(sellQuote.quote?.side).toBe("sell");
    expect(sellQuote.quote?.size).toBe(10);
    funded.onTrade({ timestamp: 3, price: sellQuote.quote!.price, size: 10, takerSide: "buy" });
    expect(funded.snapshot().position.mon).toBe(0);
    expect(funded.snapshot().tape.every((fill) => fill.size <= 10)).toBe(true);
  });

  test("a trade-feed disconnect during a model request cannot create a new paper quote", async () => {
    let resolveDecision!: (decision: Decision) => void;
    const delayedModel: DecisionModel = {
      name: "delayed test model",
      status: () => ({ state: "ready", retryAt: null, reason: null }),
      decide: () => new Promise((resolve) => { resolveDecision = resolve; }),
    };
    const engine = new PaperEngine({ mode: "paper", model: delayedModel, orderSizeMon: 10, positionCapMon: 20, startingCash: 10, feeBps: 0 });
    engine.setTradeFeedHealthy(true);
    const pending = engine.onBook(mkBook(1, 0.01995, 0.02005));
    engine.setTradeFeedHealthy(false);
    resolveDecision({ action: "buy", buy: 0.8, sell: 0.2, latencyMs: 10, model: delayedModel.name, source: "OpenCode Zen free Jev" });
    const result = await pending;
    expect(result.status).toBe("degraded");
    expect(result.quote).toBeNull();
    expect(result.totals.decisions).toBe(1);
  });

  test("same-price decisions preserve a resting quote's age and queue estimate", async () => {
    const engine = new PaperEngine({ mode: "paper", model: new FixedModel(["buy", "buy"]), orderSizeMon: 10, positionCapMon: 20, startingCash: 10, now: () => 99, feeBps: 0 });
    engine.setTradeFeedHealthy(true);
    const book: Book = { ...mkBook(1, 0.0499, 0.05), tickSize: 0.0001, bids: [[0.0499, 5]], asks: [[0.05, 4]] };
    await engine.onBook(book);
    engine.onTrade({ timestamp: 100, price: 0.0499, size: 3, takerSide: "sell" });
    const refreshed = await engine.onBook({ ...book, block: 2, bids: [[0.0499, 1]] });
    expect(refreshed.quote?.queueAhead).toBe(2);
    expect(refreshed.quote?.placedAt).toBe(99);
    expect(refreshed.totals.quotes).toBe(1);
  });

  test("lifecycle events preserve cancel-and-replace transitions with distinct quote IDs", async () => {
    const engine = new PaperEngine({ mode: "demo", model: new FixedModel(["buy", "buy"]), orderSizeMon: 1, positionCapMon: 2, startingCash: 10, lossStopUsd: 10 });
    const events: Array<{ kind: string; quoteId?: string }> = [];
    engine.subscribeLifecycle((event) => events.push({ kind: event.kind, quoteId: event.kind === "quote_resting" ? event.quote.quoteId : event.kind === "fill" ? event.fill.quoteId : event.quoteId }));
    await engine.onBook(mkBook(1, 0.049, 0.051));
    await engine.onBook(mkBook(2, 0.0495, 0.052));
    expect(events).toEqual([
      { kind: "quote_resting", quoteId: "q1" },
      { kind: "quote_cancelled", quoteId: "q1" },
      { kind: "quote_resting", quoteId: "q2" },
    ]);
  });

  test("repeated or backward Kuru blocks cancel paper quotes until a newer block arrives", async () => {
    let now = 1_000;
    const engine = new PaperEngine({ mode: "paper", model: new FixedModel(["buy", "buy"]), orderSizeMon: 10, positionCapMon: 20, startingCash: 10, now: () => now, staleAfterMs: 5_000 });
    engine.setTradeFeedHealthy(true);
    const book: Book = { ...mkBook(100, 0.01995, 0.02005), source: "Monad Kuru", makerFeeBps: 0, bids: [[0.01995, 10]], asks: [[0.02005, 10]] };
    expect((await engine.onBook(book)).quote).not.toBeNull();
    now = 5_000;
    expect((await engine.onBook(book)).status).toBe("live");
    now = 6_001;
    const stale = await engine.onBook(book);
    expect(stale.status).toBe("degraded");
    expect(stale.quote).toBeNull();
    const rollback = await engine.onBook({ ...book, block: 99 });
    expect(rollback.status).toBe("degraded");
    const recovered = await engine.onBook({ ...book, block: 101 });
    expect(recovered.status).toBe("live");
  });

  test("Kuru paper mode uses known on-chain maker fees and refuses unknown fees", async () => {
    const missingFeeEngine = new PaperEngine({ mode: "paper", model: new FixedModel(["buy"]), orderSizeMon: 1, positionCapMon: 2, startingCash: 10 });
    missingFeeEngine.setTradeFeedHealthy(true);
    const unknown = await missingFeeEngine.onBook({ ...mkBook(1, 1, 1.004), source: "Monad Kuru" });
    expect(unknown.status).toBe("degraded");
    expect(unknown.quote).toBeNull();
    expect(unknown.totals.decisions).toBe(0);

    const feeEngine = new PaperEngine({ mode: "paper", model: new FixedModel(["buy", "buy"]), orderSizeMon: 1, positionCapMon: 2, startingCash: 10 });
    feeEngine.setTradeFeedHealthy(true);
    const book: Book = { ...mkBook(1, 1, 1.004), source: "Monad Kuru", makerFeeBps: 10 };
    expect((await feeEngine.onBook(book)).paperFeeBps).toBe(10);
    const updated = await feeEngine.onBook({ ...book, block: 2, makerFeeBps: 20 });
    expect(updated.paperFeeBps).toBe(20);
    expect(updated.totals.quotes).toBe(2);
  });
});
