import { expect, test } from "bun:test";
import { captureDecisionReplayInput } from "../src/decision-replay-input";
import type { Book } from "../src/types";

const book: Book = { source: "Monad Kuru", chainId: 143, market: `0x${"1".repeat(40)}`, block: 100,
  receivedAt: 1000, bid: 0.03, ask: 0.030002, mid: 0.030001, spreadBps: 0.666644,
  tickSize: 0.000001, sizePrecision: 1e10, minSizeMon: 200, makerFeeBps: 0, takerFeeBps: 0,
  captureIntervalMs: 1000, bids: [[0.03, 42]], asks: [[0.030002, 71]] };

test("decision input preserves actual book identity and independent public depth without extra fields", () => {
  const input = { ...book, providerResponse: "excluded fixture field", bids: [[0.03, 42]] as [number, number][] };
  const saved = captureDecisionReplayInput(input)!;
  expect(saved.timestamp).toBe(1000);
  expect(saved.block).toBe(100);
  expect(saved.chainId).toBe(143);
  expect(saved.minSizeMon).toBe(200);
  expect(saved.sizePrecision).toBe(1e10);
  expect(saved.bids).toEqual([[0.03, 42]]);
  expect(Object.hasOwn(saved, "providerResponse")).toBe(false);
  input.bids[0]![1] = 999;
  expect(saved.bids[0]![1]).toBe(42);
});

test("missing provenance, synthetic data, or mismatched displayed touches cannot become replay inputs", () => {
  for (const patch of [{ source: "synthetic demo" }, { receivedAt: undefined }, { chainId: 1 }, { market: undefined },
    { sizePrecision: undefined }, { minSizeMon: undefined }, { tickSize: undefined }, { makerFeeBps: undefined },
    { bids: undefined }, { bid: 0.029 }, { mid: 0.031 }, { block: 1.5 }]) {
    expect(captureDecisionReplayInput({ ...book, ...patch } as Book)).toBeNull();
  }
});
