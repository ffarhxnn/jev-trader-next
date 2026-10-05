import { expect, test } from "bun:test";
import { PaperEngine } from "../src/paper";
import { PaperBookObservationCapture } from "../src/paper-book-timeline";
import type { DecisionModel } from "../src/model";
import type { Book, Decision, PaperLifecycleEvent } from "../src/types";

const decision = (): Decision => ({ action: "buy", buy: 0.8, sell: 0.2, latencyMs: 1,
  model: "offline stand-in", source: "local demo heuristic" });
const model: DecisionModel = { name: "offline stand-in", status: () => ({ state: "ready", retryAt: null, reason: null }),
  decide: async () => decision() };
const book = (block = 100): Book => ({ block, source: "Monad Kuru", bid: 0.0499, ask: 0.05,
  mid: (0.0499 + 0.05) / 2, spreadBps: 20, tickSize: 0.0001, makerFeeBps: 0,
  chainId: 143, market: `0x${"1".repeat(40)}`, sizePrecision: 1e10, minSizeMon: 200, captureIntervalMs: 1000,
  bids: [[0.0499, 5]], asks: [[0.05, 5]] });
const makeEngine = (now: () => number, chosenModel = model, mode: "paper" | "demo" = "paper") =>
  new PaperEngine({ mode, model: chosenModel, now, staleAfterMs: 5000, feeBps: 0,
    orderSizeMon: 10, positionCapMon: 20, startingCash: 10, lossStopUsd: 10 });

test("watchdog cancels at exact deadline without any new book and recovery requires a newer block", async () => {
  let now = 1000;
  const engine = makeEngine(() => now);
  const events: PaperLifecycleEvent[] = [];
  const publishedBlocks: number[] = [];
  const capture = new PaperBookObservationCapture();
  const captured: NonNullable<ReturnType<PaperBookObservationCapture["observe"]>>[] = [];
  engine.subscribeLifecycle(event => events.push(event));
  engine.subscribe(snapshot => {
    if (snapshot.book) publishedBlocks.push(snapshot.book.block);
    const observed = capture.observe(snapshot.book, snapshot.ts);
    if (observed) captured.push(observed);
  });
  engine.setTradeFeedHealthy(true);
  await engine.onBook(book());
  expect(engine.snapshot().quote?.queueAhead).toBe(5);
  now = 5999;
  expect(engine.checkBookFreshness()).toBe(true);
  expect(engine.snapshot().status).toBe("live");
  now = 6000;
  expect(engine.checkBookFreshness()).toBe(false);
  const stale = engine.snapshot();
  expect(stale.status).toBe("degraded");
  expect(stale.quote).toBeNull();
  expect(stale.decision).toBeNull();
  expect(stale.book?.receivedAt).toBe(1000);
  expect(stale.totals.blocks).toBe(1);
  expect(captured).toHaveLength(1);
  expect(captured[0]!.inputSnapshot?.timestamp).toBe(1000);
  expect(publishedBlocks.every(block => block === 100)).toBe(true);
  const publications = publishedBlocks.length;
  expect(engine.checkBookFreshness()).toBe(false);
  expect(publishedBlocks).toHaveLength(publications);
  engine.setTradeFeedHealthy(true);
  expect((await engine.onBook(book())).status).toBe("degraded");
  expect((await engine.onBook(book(99))).status).toBe("degraded");
  expect(events.filter(event => event.kind === "quote_cancelled")).toHaveLength(1);
  now = 5999; // A backward clock cannot unlatch the expired old book.
  expect(engine.checkBookFreshness()).toBe(false);
  now = 6001;
  const recovered = await engine.onBook(book(101));
  expect(recovered.status).toBe("live");
  expect(recovered.quote).not.toBeNull();
  expect(recovered.book?.receivedAt).toBe(6001);
  expect(captured.map(row => row.inputSnapshot?.timestamp)).toEqual([1000, 6001]);
  expect(events.map(event => event.kind)).toEqual(["quote_resting", "quote_cancelled", "quote_resting"]);
});

test("arriving trade independently guards stale queue and fills when a hung read delays the watchdog", async () => {
  let now = 1000;
  const engine = makeEngine(() => now);
  const events: PaperLifecycleEvent[] = [];
  engine.subscribeLifecycle(event => events.push(event));
  engine.setTradeFeedHealthy(true);
  await engine.onBook(book());
  const originalQuote = engine.snapshot().quote!;
  now = 6000; // No onBook call or watchdog callback occurs after the initial observation.
  const stale = engine.onTrade({ timestamp: 5900, price: 0.0499, size: 100, takerSide: "sell" });
  expect(stale.totals.tradeEvents).toBe(1);
  expect(stale.totals.fills).toBe(0);
  expect(stale.position.mon).toBe(0);
  expect(stale.position.cash).toBe(10);
  expect(stale.status).toBe("degraded");
  expect(stale.quote).toBeNull();
  expect(originalQuote.queueAhead).toBe(5);
  expect(originalQuote.size).toBe(10);
  engine.onTrade({ timestamp: 6100, price: 0.0499, size: 100, takerSide: "sell" });
  engine.checkBookFreshness();
  expect(events.filter(event => event.kind === "quote_cancelled")).toHaveLength(1);
  expect(events.filter(event => event.kind === "fill")).toHaveLength(0);
});

test("stale model completion cannot create a quote even without a watchdog callback", async () => {
  let now = 1000;
  let complete!: (value: Decision) => void;
  const delayed: DecisionModel = { ...model, decide: () => new Promise(resolve => { complete = resolve; }) };
  const engine = makeEngine(() => now, delayed);
  engine.setTradeFeedHealthy(true);
  const pending = engine.onBook(book());
  now = 6000;
  complete(decision());
  const stale = await pending;
  expect(stale.status).toBe("degraded");
  expect(stale.quote).toBeNull();
  expect(stale.decision).toBeNull();
  expect(stale.totals.decisions).toBe(1);
  expect(stale.totals.quotes).toBe(0);
  expect(stale.book?.receivedAt).toBe(1000);
});

test("watchdog expires a resting quote during a pending model without duplicate cancellation on completion", async () => {
  let now = 1000, calls = 0;
  let complete!: (value: Decision) => void;
  const delayed: DecisionModel = { ...model, decide: () => ++calls === 1 ? Promise.resolve(decision())
    : new Promise(resolve => { complete = resolve; }) };
  const engine = makeEngine(() => now, delayed);
  const events: PaperLifecycleEvent[] = [];
  engine.subscribeLifecycle(event => events.push(event));
  engine.setTradeFeedHealthy(true);
  await engine.onBook(book());
  now = 2000;
  const pending = engine.onBook(book(101));
  now = 7000;
  engine.checkBookFreshness();
  expect(engine.snapshot().quote).toBeNull();
  complete(decision());
  const stale = await pending;
  expect(stale.totals.quotes).toBe(1);
  expect(stale.decision).toBeNull();
  expect(events.filter(event => event.kind === "quote_cancelled")).toHaveLength(1);
});

test("synthetic paper books and demo mode retain their existing timing behavior", async () => {
  for (const mode of ["paper", "demo"] as const) {
    let now = 1000;
    const engine = makeEngine(() => now, model, mode);
    engine.setTradeFeedHealthy(true);
    await engine.onBook({ ...book(), source: mode === "paper" ? "synthetic demo" : "Monad Kuru" });
    now = 50_000;
    expect(engine.checkBookFreshness()).toBe(true);
    expect(engine.snapshot().quote).not.toBeNull();
    expect(engine.snapshot().decision?.action).toBe("buy");
    if (mode === "paper") {
      const fill = engine.onTrade({ timestamp: now, price: 0.0499, size: 15, takerSide: "sell" });
      expect(fill.totals.fills).toBe(1);
      expect(fill.position.mon).toBe(10);
    }
  }
});
