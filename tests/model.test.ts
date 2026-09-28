import { describe, expect, test } from "bun:test";
import { JevModel, RateLimitWait } from "../src/model";
import type { Book } from "../src/types";

const book: Book = { block: 1, bid: 0.02, ask: 0.02001, mid: 0.020005, spreadBps: 5, source: "Monad Kuru" };

describe("free Jev provider boundary", () => {
  test("uses only the fixed free Jev endpoint and validates typed probabilities", async () => {
    let requested = "";
    const fakeFetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return Response.json({ model: "jev-1.13-free", answers: { direction: { type: "choice", choice: "buy", probabilities: { buy: 0.72, sell: 0.28 } } }, usage: { input_tokens: 15, output_tokens: 3 } });
    }) as unknown as typeof fetch;
    const model = new JevModel("test-only", Date.now, fakeFetch);
    const decision = await model.decide(book, [0.019, 0.020]);
    expect(requested).toBe("https://opencode.ai/zen/v1/systemone");
    expect(decision.action).toBe("buy");
    expect(decision.buy + decision.sell).toBeCloseTo(1, 8);
    expect(decision.source).toBe("OpenCode Zen free Jev");
  });

  test("honors Retry-After and sends no additional request before its deadline", async () => {
    let now = 1_000_000;
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "120" } });
    }) as unknown as typeof fetch;
    const model = new JevModel("test-only", () => now, fakeFetch);
    let retryAt = 0;
    await expect(model.decide(book, [])).rejects.toMatchObject({ name: "RateLimitWait" });
    retryAt = model.status().retryAt!;
    expect(retryAt).toBe(now + 120_000);
    expect(model.status().state).toBe("waiting");
    await expect(model.decide(book, [])).rejects.toBeInstanceOf(RateLimitWait);
    expect(calls).toBe(1);
    now = retryAt;
    await expect(model.decide(book, [])).rejects.toBeInstanceOf(RateLimitWait);
    expect(calls).toBe(2);
  });

  test("invalid typed outputs fail closed rather than becoming a demo decision", async () => {
    const fakeFetch = (async () => Response.json({ model: "jev-1.13-free", answers: { direction: { type: "choice", choice: "buy", probabilities: { buy: 0.9, sell: 0.4 } } } })) as unknown as typeof fetch;
    const model = new JevModel("test-only", Date.now, fakeFetch);
    await expect(model.decide(book, [])).rejects.toThrow("Jev request failed");
    expect(model.status().state).toBe("failed");
  });
});
