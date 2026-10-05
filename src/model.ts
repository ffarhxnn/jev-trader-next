import { experimental_evaluate } from "ai";
import { generateObject } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config";
import type { Action, Book, Decision } from "./types";

export const ZEN_FREE_MODEL = "jev-1.13-free";
type EvaluationModel = ReturnType<ReturnType<typeof createTypeSafeAi>["evaluationModel"]>;
const QUESTION = {
  direction: {
    type: "choice",
    instructions: { question: "Will MON-USDC mid be higher or lower after the stated horizon?", goal: "Choose a side only from the supplied public book and recent mids. This is paper-only; no wallet or order API exists.", inputs: "Use recent momentum, spread, and book depth as context. The quote simulator rejects a quote that would cross the opposite touch." },
    criteria: { buy: "Buy MON if a higher mid is more likely.", sell: "Sell MON if a lower mid is more likely." },
  },
} as const;

export interface ModelStatus { state: "ready" | "waiting" | "failed"; retryAt: number | null; reason: string | null }
export interface DecisionModel { name: string; status(): ModelStatus; decide(book: Book, mids: number[]): Promise<Decision> }
export class RateLimitWait extends Error { constructor(readonly retryAt: number, message: string) { super(message); this.name = "RateLimitWait"; } }

/** Hosted providers implement the same typed paper-decision contract; provider failure never falls back silently. */
export class GeminiModel implements DecisionModel {
  readonly name: string;
  private readonly model: ReturnType<ReturnType<typeof createGoogleGenerativeAI>> | null = null;
  private lastCall = -Infinity;
  private cooldownUntil = 0;
  private fatal: string | null = null;

  constructor(apiKey: string | undefined, private readonly enabled = process.env.GEMINI_REQUESTS_ENABLED === "1", private readonly now = Date.now) {
    const modelId = config.geminiModel;
    this.name = `${modelId} · Google Gemini`;
    if (enabled) {
      if (!apiKey) throw new Error("GEMINI_API_KEY is required when Gemini requests are enabled.");
      this.model = createGoogleGenerativeAI({ apiKey })(modelId);
    } else {
      // The client is only created when explicitly enabled, so monitoring cannot make provider calls.
    }
  }

  status(): ModelStatus {
    if (this.fatal) return { state: "failed", retryAt: null, reason: this.fatal };
    if (!this.enabled) return { state: "waiting", retryAt: null, reason: "Gemini requests are disabled; live market monitoring continues without model decisions." };
    const retryAt = Math.max(this.cooldownUntil, this.lastCall + config.decisionIntervalMs);
    if (this.now() < retryAt) return { state: "waiting", retryAt, reason: this.cooldownUntil > this.now() ? "Gemini rate limit; waiting before a retry." : "Waiting for the configured model request cadence." };
    return { state: "ready", retryAt: null, reason: null };
  }

  async decide(book: Book, mids: number[]): Promise<Decision> {
    if (!this.enabled) throw new RateLimitWait(Number.MAX_SAFE_INTEGER, "Gemini requests are disabled; no provider request was sent.");
    if (this.fatal) throw new Error(this.fatal);
    const status = this.status();
    if (status.state === "waiting") throw new RateLimitWait(status.retryAt!, status.reason!);
    this.lastCall = this.now();
    const started = performance.now();
    try {
      const result = await generateObject({
        model: this.model!,
        schema: z.object({ action: z.enum(["buy", "sell", "hold"]), buyProbability: z.number().min(0).max(1), sellProbability: z.number().min(0).max(1) }),
        prompt: `Paper research only. Using only these public MON-USDC book observations, estimate whether the mid will be higher or lower after 60 seconds. Do not invent external facts. Choose hold if the evidence is weak. Return probabilities that sum to 1.\nCurrent: ${JSON.stringify({ block: book.block, mid: book.mid, bid: book.bid, ask: book.ask, spreadBps: book.spreadBps, recentMids: mids.slice(-20) })}`,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(config.timeoutMs),
      });
      const { action, buyProbability: buy, sellProbability: sell } = result.object;
      if (![buy, sell].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) || Math.abs(buy + sell - 1) > 0.02) throw new Error("invalid probability schema");
      this.cooldownUntil = 0;
      return { action, buy, sell, latencyMs: performance.now() - started, model: this.name, source: "Google Gemini API" };
    } catch (error) {
      const e = error as { statusCode?: unknown; responseHeaders?: Record<string, string> };
      if (e.statusCode === 429) {
        const raw = Object.entries(e.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
        const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : 60;
        this.cooldownUntil = this.now() + Math.max(60, seconds) * 1000;
        throw new RateLimitWait(this.cooldownUntil, "Gemini rate limit; waiting before retry. No other model is substituted.");
      }
      this.fatal = typeof e.statusCode === "number" ? `Gemini request failed (HTTP ${e.statusCode}); model paused.` : "Gemini request failed, timed out, or returned invalid output; model paused.";
      throw new Error(this.fatal);
    }
  }
}

export class PausedModel implements DecisionModel {
  constructor(readonly name = "model paused · public data capture only") {}
  status(): ModelStatus { return { state: "waiting", retryAt: null, reason: "Model decisions are paused; live market monitoring and paper audit capture continue." }; }
  async decide(): Promise<Decision> { throw new RateLimitWait(Number.MAX_SAFE_INTEGER, "Model decisions are paused; no provider request was sent."); }
}

/** OpenCode Go exposes several model families through different API protocols; this adapter supports its chat and Responses routes. */
export class OpenCodeGoModel implements DecisionModel {
  readonly name: string;
  private readonly model: any = null;
  private lastCall = -Infinity;
  private cooldownUntil = 0;
  private fatal: string | null = null;

  constructor(apiKey: string | undefined, private readonly enabled = process.env.OPENCODE_GO_REQUESTS_ENABLED === "1", private readonly now = Date.now) {
    const modelId = config.opencodeGoModel;
    this.name = `${modelId} · OpenCode Go`;
    if (enabled) {
      if (!apiKey) throw new Error("OPENCODE_GO_API_KEY is required when OpenCode Go requests are enabled.");
      const baseURL = "https://opencode.ai/zen/go/v1";
      const headers = { "x-opencode-session": `jev-trader-${randomUUID()}`, "user-agent": "jev-trader/0.1" };
      if (config.opencodeGoProtocol === "responses") this.model = createOpenAI({ baseURL, apiKey, headers }).responses(modelId);
      else this.model = createOpenAICompatible({ name: "opencode-go", baseURL, apiKey, headers }).chatModel(modelId);
    }
  }

  status(): ModelStatus {
    if (this.fatal) return { state: "failed", retryAt: null, reason: this.fatal };
    if (!this.enabled) return { state: "waiting", retryAt: null, reason: "OpenCode Go requests are disabled; live market monitoring continues without model decisions." };
    const retryAt = Math.max(this.cooldownUntil, this.lastCall + config.decisionIntervalMs);
    if (this.now() < retryAt) return { state: "waiting", retryAt, reason: this.cooldownUntil > this.now() ? "OpenCode Go rate limit; waiting before a retry." : "Waiting for the configured model request cadence." };
    return { state: "ready", retryAt: null, reason: null };
  }

  async decide(book: Book, mids: number[]): Promise<Decision> {
    if (!this.enabled) throw new RateLimitWait(Number.MAX_SAFE_INTEGER, "OpenCode Go requests are disabled; no provider request was sent.");
    if (this.fatal) throw new Error(this.fatal);
    const status = this.status();
    if (status.state === "waiting") throw new RateLimitWait(status.retryAt!, status.reason!);
    this.lastCall = this.now();
    const started = performance.now();
    try {
      const result = await generateObject({
        model: this.model,
        schema: z.object({ action: z.enum(["buy", "sell", "hold"]), buyProbability: z.number().min(0).max(1), sellProbability: z.number().min(0).max(1) }),
        prompt: `Paper research only. Using only these public MON-USDC book observations, estimate whether the mid will be higher or lower after 60 seconds. Do not invent external facts. Choose hold if evidence is weak. Return probabilities that sum to 1.\nCurrent: ${JSON.stringify({ block: book.block, mid: book.mid, bid: book.bid, ask: book.ask, spreadBps: book.spreadBps, recentMids: mids.slice(-20) })}`,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(config.timeoutMs),
      });
      const { action, buyProbability: buy, sellProbability: sell } = result.object;
      if (![buy, sell].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) || Math.abs(buy + sell - 1) > 0.02) throw new Error("invalid probability schema");
      this.cooldownUntil = 0;
      return { action, buy, sell, latencyMs: performance.now() - started, model: this.name, source: "OpenCode Go API" };
    } catch (error) {
      const e = error as { statusCode?: unknown; responseHeaders?: Record<string, string> };
      if (e.statusCode === 429) {
        const raw = Object.entries(e.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
        const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : 60;
        this.cooldownUntil = this.now() + Math.max(60, seconds) * 1000;
        throw new RateLimitWait(this.cooldownUntil, "OpenCode Go rate limit; waiting before retry. No other model is substituted.");
      }
      this.fatal = typeof e.statusCode === "number" ? `OpenCode Go request failed (HTTP ${e.statusCode}); model paused.` : "OpenCode Go request failed, timed out, or returned invalid output; model paused.";
      throw new Error(this.fatal);
    }
  }
}

export class JevModel implements DecisionModel {
  readonly name: string;
  private client: EvaluationModel | null = null;
  private lastCall = -Infinity;
  private cooldownUntil = 0;
  private cooldownReason = "Zen returned HTTP 429; market monitoring continues. Retry after the provider cooldown; quota may still be unavailable.";
  private strikes = 0;
  private fatal: string | null = null;
  private inFlight: Promise<Decision> | null = null;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly now = Date.now,
    private readonly fetcher: typeof fetch = fetch,
    private readonly statePath: string | null = resolve("data/jev-provider-state.json"),
    private readonly modelId = config.zenModel,
    private readonly enabled = config.jevRequestsEnabled,
  ) {
    if (modelId !== "jev-1.13-free" && modelId !== "jev-1.13") throw new Error("Unsupported Jev model ID.");
    this.name = `${modelId} · OpenCode Zen ${modelId === ZEN_FREE_MODEL ? "free" : "paid"}`;
    if (this.enabled) {
      if (!apiKey) throw new Error("Jev API key is required when provider requests are enabled.");
      this.client = createTypeSafeAi({ apiKey, baseURL: config.zenBaseUrl, fetch: fetcher }).evaluationModel(modelId);
    }
    this.restoreProviderState();
  }

  status(): ModelStatus {
    if (this.fatal) return { state: "failed", retryAt: null, reason: this.fatal };
    if (!this.enabled) return { state: "waiting", retryAt: null, reason: "Jev requests are disabled; live market monitoring continues without model decisions." };
    const retryAt = Math.max(this.cooldownUntil, this.lastCall + config.decisionIntervalMs);
    if (this.now() < retryAt) return { state: "waiting", retryAt, reason: this.cooldownUntil > this.now() ? this.cooldownReason : "Waiting for the configured Jev request cadence." };
    return { state: "ready", retryAt: null, reason: null };
  }

  decide(book: Book, mids: number[]): Promise<Decision> {
    if (this.inFlight) return this.inFlight;
    if (!this.enabled) return Promise.reject(new RateLimitWait(Number.MAX_SAFE_INTEGER, "Jev requests are disabled; no provider request was sent."));
    if (this.fatal) return Promise.reject(new Error(this.fatal));
    const status = this.status();
    if (status.state === "waiting") return Promise.reject(new RateLimitWait(status.retryAt!, status.reason!));
    this.lastCall = this.now();
    this.persistProviderState();
    this.inFlight = this.request(book, mids).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async request(book: Book, mids: number[]): Promise<Decision> {
    if (!this.client) throw new Error("Jev provider client is disabled.");
    const started = performance.now();
    try {
      const output = await experimental_evaluate({
        model: this.client,
        state: { market: "MON-USDC", block: book.block, mid: book.mid, bid: book.bid, ask: book.ask, spreadBps: book.spreadBps, recentMids: mids.slice(-20) },
        questions: QUESTION,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(config.timeoutMs),
      });
      const answer = output.answers.direction;
      if (answer?.type !== "choice" || !["buy", "sell"].includes(answer.choice) || !answer.probabilities) throw new Error("invalid Jev choice schema");
      const { buy, sell } = answer.probabilities;
      if (![buy, sell].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) || Math.abs(buy + sell - 1) > 0.02) throw new Error("invalid Jev probability schema");
      this.cooldownUntil = 0;
      this.cooldownReason = "Zen returned HTTP 429; market monitoring continues. Retry after the provider cooldown; quota may still be unavailable.";
      this.strikes = 0;
      this.persistProviderState();
      return { action: answer.choice as Action, buy, sell, latencyMs: performance.now() - started, model: this.name, source: this.modelId === ZEN_FREE_MODEL ? "OpenCode Zen free Jev" : "OpenCode Zen paid Jev" };
    } catch (error) {
      const e = error as { statusCode?: unknown; responseHeaders?: Record<string, string> };
      if (e.statusCode === 429) {
        const retryAfter = Object.entries(e.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
        const retryAt = this.rateLimit(retryAfter);
        throw new RateLimitWait(retryAt, "Zen returned HTTP 429; retry after the provider cooldown. Quota may still be unavailable.");
      }
      this.fatal = typeof e.statusCode === "number" ? `Jev request failed (HTTP ${e.statusCode}); model paused.` : "Jev request failed, timed out, or returned an invalid response; model paused.";
      throw new Error(this.fatal);
    }
  }

  private rateLimit(raw?: string) {
    const now = this.now();
    const trimmed = raw?.trim();
    let until: number | null = null;
    if (trimmed) {
      if (/^\d+$/.test(trimmed)) {
        const seconds = Number(trimmed);
        if (Number.isFinite(seconds)) until = now + seconds * 1000;
      } else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) {
        const date = Date.parse(trimmed);
        if (Number.isFinite(date)) until = date;
      }
    }
    const fallback = [60, 120, 300][Math.min(this.strikes, 2)]! * 1000;
    this.strikes++;
    this.cooldownUntil = until === null ? now + fallback : Math.max(now, until);
    this.persistProviderState();
    return Math.max(this.cooldownUntil, now + config.decisionIntervalMs);
  }

  private restoreProviderState() {
    if (!this.statePath) return;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Record<string, unknown>;
      if (parsed.version !== 1 || !Number.isFinite(parsed.cooldownUntil) || !Number.isSafeInteger(parsed.strikes)
        || Number(parsed.strikes) < 0 || !Number.isFinite(parsed.lastCallAt)) throw new Error("Invalid provider state.");
      this.cooldownUntil = Number(parsed.cooldownUntil);
      this.strikes = Number(parsed.strikes);
      this.lastCall = Number(parsed.lastCallAt);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      this.cooldownUntil = this.now() + 300_000;
      this.strikes = 1;
      this.cooldownReason = "Stored Jev cooldown state is unreadable; requests are held for five minutes before retry.";
    }
  }

  private persistProviderState() {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.statePath}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, cooldownUntil: this.cooldownUntil, strikes: this.strikes, lastCallAt: this.lastCall }), { encoding: "utf8", mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.statePath);
    } catch {
      // The active process still enforces its in-memory cooldown if storage is unavailable.
    }
  }

}

export class DemoModel implements DecisionModel {
  name = "stand-in momentum heuristic";
  private lastCall = -Infinity;
  constructor(private readonly now = Date.now, private readonly intervalMs = config.decisionIntervalMs) {}
  status(): ModelStatus {
    const retryAt = this.lastCall + this.intervalMs;
    return this.now() < retryAt
      ? { state: "waiting", retryAt, reason: "Waiting for the local demo decision cadence." }
      : { state: "ready", retryAt: null, reason: null };
  }
  async decide(book: Book, mids: number[]): Promise<Decision> {
    const status = this.status();
    if (status.state === "waiting") throw new RateLimitWait(status.retryAt!, status.reason!);
    const started = performance.now();
    this.lastCall = this.now();
    const prev = mids.length > 5 ? mids[mids.length - 6]! : book.mid;
    const move = prev ? (book.mid - prev) / prev : 0;
    const buy = Math.max(0.05, Math.min(0.95, 0.5 + move * 160));
    return { action: buy >= 0.5 ? "buy" : "sell", buy, sell: 1 - buy, latencyMs: performance.now() - started, model: this.name, source: "local demo heuristic" };
  }
}
