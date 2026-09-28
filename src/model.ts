import { experimental_evaluate } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";
import type { Action, Book, Decision } from "./types";

export const ZEN_FREE_MODEL = "jev-1.13-free";
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

export class JevModel implements DecisionModel {
  readonly name = `${ZEN_FREE_MODEL} · OpenCode Zen free`;
  private client;
  private lastCall = -Infinity;
  private cooldownUntil = 0;
  private strikes = 0;
  private fatal: string | null = null;
  private inFlight: Promise<Decision> | null = null;

  constructor(private readonly apiKey: string, private readonly now = Date.now, private readonly fetcher: typeof fetch = fetch) {
    this.client = createTypeSafeAi({ apiKey, baseURL: config.zenBaseUrl, fetch: fetcher }).evaluationModel(ZEN_FREE_MODEL);
  }

  status(): ModelStatus {
    if (this.fatal) return { state: "failed", retryAt: null, reason: this.fatal };
    const retryAt = Math.max(this.cooldownUntil, this.lastCall + config.decisionIntervalMs);
    if (this.now() < retryAt) return { state: "waiting", retryAt, reason: this.cooldownUntil > this.now() ? "Zen returned HTTP 429; market monitoring continues. Retry after the provider cooldown; quota may still be unavailable." : "Waiting for the configured Jev request cadence." };
    return { state: "ready", retryAt: null, reason: null };
  }

  decide(book: Book, mids: number[]): Promise<Decision> {
    if (this.inFlight) return this.inFlight;
    if (this.fatal) return Promise.reject(new Error(this.fatal));
    const status = this.status();
    if (status.state === "waiting") return Promise.reject(new RateLimitWait(status.retryAt!, status.reason!));
    this.lastCall = this.now();
    this.inFlight = this.request(book, mids).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async request(book: Book, mids: number[]): Promise<Decision> {
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
      this.strikes = 0;
      return { action: answer.choice as Action, buy, sell, latencyMs: performance.now() - started, model: this.name, source: "OpenCode Zen free Jev" };
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
      const seconds = Number(trimmed);
      if (Number.isFinite(seconds) && seconds >= 0) until = now + seconds * 1000;
      else { const date = Date.parse(trimmed); if (Number.isFinite(date)) until = date; }
    }
    const fallback = [60, 120, 300][Math.min(this.strikes, 2)]! * 1000;
    this.strikes++;
    this.cooldownUntil = until === null ? now + fallback : Math.max(now, until);
    return Math.max(this.cooldownUntil, now + config.decisionIntervalMs);
  }
}

export class DemoModel implements DecisionModel {
  name = "stand-in momentum heuristic";
  status(): ModelStatus { return { state: "ready", retryAt: null, reason: null }; }
  async decide(book: Book, mids: number[]): Promise<Decision> {
    const prev = mids.length > 5 ? mids[mids.length - 6]! : book.mid;
    const move = prev ? (book.mid - prev) / prev : 0;
    const buy = Math.max(0.05, Math.min(0.95, 0.5 + move * 160));
    return { action: buy >= 0.5 ? "buy" : "sell", buy, sell: 1 - buy, latencyMs: 0, model: this.name, source: "local demo heuristic" };
  }
}
