import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoModel, JevModel, RateLimitWait } from "../src/model";
import type { Book } from "../src/types";

const book: Book = { block: 1, bid: 0.02, ask: 0.02001, mid: 0.020005, spreadBps: 5, source: "Monad Kuru" };

describe("free Jev provider boundary", () => {
  test("uses only the fixed free Jev endpoint and validates typed probabilities", async () => {
    let requested = "";
    const fakeFetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return Response.json({ model: "jev-1.13-free", answers: { direction: { type: "choice", choice: "buy", probabilities: { buy: 0.72, sell: 0.28 } } }, usage: { input_tokens: 15, output_tokens: 3 } });
    }) as unknown as typeof fetch;
    const model = new JevModel("test-only", Date.now, fakeFetch, null, undefined, true);
    const decision = await model.decide(book, [0.019, 0.020]);
    expect(requested).toBe("https://opencode.ai/zen/v1/systemone");
    expect(decision.action).toBe("buy");
    expect(decision.buy + decision.sell).toBeCloseTo(1, 8);
    expect(decision.source).toBe("OpenCode Zen free Jev");
  });

  test("supports the paid Jev ID explicitly without automatic fallback", async () => {
    let requested = "";
    let sentModel = "";
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requested = String(input);
      sentModel = JSON.parse(String(init?.body)).model;
      return Response.json({ model: "jev-1.13", answers: { direction: { type: "choice", choice: "sell", probabilities: { buy: 0.2, sell: 0.8 } } } });
    }) as unknown as typeof fetch;
    const model = new JevModel("test-only", Date.now, fakeFetch, null, "jev-1.13", true);
    const decision = await model.decide(book, []);
    expect(requested).toBe("https://opencode.ai/zen/v1/systemone");
    expect(sentModel).toBe("jev-1.13");
    expect(model.name).toContain("jev-1.13 · OpenCode Zen paid");
    expect(decision.source).toBe("OpenCode Zen paid Jev");
    expect(decision.model).toBe(model.name);
  });

  test("honors Retry-After and sends no additional request before its deadline", async () => {
    let now = 1_000_000;
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "120" } });
    }) as unknown as typeof fetch;
    const model = new JevModel("test-only", () => now, fakeFetch, null, undefined, true);
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

  test("honors an HTTP-date Retry-After and ignores malformed date-like values", async () => {
    let now = Date.parse("Wed, 30 Sep 2026 01:00:00 GMT");
    let calls = 0;
    let retryAfter = new Date(now + 3_600_000).toUTCString();
    const fakeFetch = (async () => {
      calls++;
      return Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": retryAfter } });
    }) as unknown as typeof fetch;
    const model = new JevModel("test-only", () => now, fakeFetch, null, undefined, true);
    await expect(model.decide(book, [])).rejects.toBeInstanceOf(RateLimitWait);
    expect(model.status().retryAt).toBe(now + 3_600_000);
    expect(calls).toBe(1);

    now += 3_600_000;
    retryAfter = "-1";
    await expect(model.decide(book, [])).rejects.toBeInstanceOf(RateLimitWait);
    expect(model.status().retryAt).toBe(now + 120_000);
    expect(calls).toBe(2);
  });

  test("restores a private retry cooldown across a model-process restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-provider-state-"));
    const statePath = join(directory, "provider.json");
    let now = 1_000_000;
    let calls = 0;
    const limitedFetch = (async () => {
      calls++;
      return Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "120" } });
    }) as unknown as typeof fetch;
    const firstProcess = new JevModel("test-only", () => now, limitedFetch, statePath, undefined, true);
    try {
      await expect(firstProcess.decide(book, [])).rejects.toBeInstanceOf(RateLimitWait);
      expect(calls).toBe(1);
      expect(statSync(statePath).mode & 0o777).toBe(0o600);
      const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      expect(persisted.cooldownUntil).toBe(now + 120_000);
      expect(JSON.stringify(persisted)).not.toContain("test-only");

      const successfulFetch = (async () => {
        calls++;
        return Response.json({ model: "jev-1.13-free", answers: { direction: { type: "choice", choice: "buy", probabilities: { buy: 0.6, sell: 0.4 } } } });
      }) as unknown as typeof fetch;
      const restartedProcess = new JevModel("test-only", () => now, successfulFetch, statePath, undefined, true);
      expect(restartedProcess.status().state).toBe("waiting");
      expect(restartedProcess.status().retryAt).toBe(now + 120_000);
      await expect(restartedProcess.decide(book, [])).rejects.toBeInstanceOf(RateLimitWait);
      expect(calls).toBe(1);

      now += 120_000;
      expect((await restartedProcess.decide(book, [])).action).toBe("buy");
      expect(calls).toBe(2);
      const nextRestart = new JevModel("test-only", () => now + 1, successfulFetch, statePath, undefined, true);
      expect(nextRestart.status().state).toBe("waiting");
      expect(nextRestart.status().retryAt).toBe(now + 10_000);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("invalid typed outputs fail closed rather than becoming a demo decision", async () => {
    const fakeFetch = (async () => Response.json({ model: "jev-1.13-free", answers: { direction: { type: "choice", choice: "buy", probabilities: { buy: 0.9, sell: 0.4 } } } })) as unknown as typeof fetch;
    const model = new JevModel("test-only", Date.now, fakeFetch, null, undefined, true);
    await expect(model.decide(book, [])).rejects.toThrow("Jev request failed");
    expect(model.status().state).toBe("failed");
  });

  test("disabled Jev mode makes no provider request", async () => {
    let calls = 0;
    const fakeFetch = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
    const model = new JevModel(undefined, Date.now, fakeFetch, null, undefined, false);
    expect(model.status()).toMatchObject({ state: "waiting", retryAt: null });
    expect(model.status().reason).toContain("disabled");
    await expect(model.decide(book, [])).rejects.toThrow("no provider request was sent");
    expect(calls).toBe(0);
  });
});

describe("local demo decision model", () => {
  test("uses the configured cadence instead of making a momentum decision on every book poll", async () => {
    let now = 1_000;
    const model = new DemoModel(() => now, 10_000);
    expect(model.status().state).toBe("ready");
    const decision = await model.decide(book, [0.019, 0.020]);
    expect(decision.source).toBe("local demo heuristic");
    expect(model.status()).toMatchObject({ state: "waiting", retryAt: 11_000 });
    await expect(model.decide(book, [])).rejects.toBeInstanceOf(RateLimitWait);
    now = 11_000;
    expect(model.status().state).toBe("ready");
  });
});
