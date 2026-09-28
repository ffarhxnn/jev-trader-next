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

  test("an RPC outage changes the dashboard to degraded until a fresh book arrives", async () => {
    const engine = new PaperEngine({ mode: "paper", model: new FixedModel(["hold"]), orderSizeMon: 10, positionCapMon: 20, startingCash: 10 });
    engine.setUnavailable("RPC unavailable");
    expect(engine.snapshot().status).toBe("degraded");
    const recovered = await engine.onBook(mkBook(1, 0.019, 0.021));
    expect(recovered.status).toBe("live");
  });
});
