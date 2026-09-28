import { config } from "./config";
import type { Book, Decision, Fill, PaperQuote, Snapshot, Side } from "./types";
import { RateLimitWait, type DecisionModel, type ModelStatus } from "./model";

export interface QuoteEngineOptions {
  mode: "paper" | "demo";
  model: DecisionModel;
  now?: () => number;
  feeBps?: number;
  orderSizeMon?: number;
  positionCapMon?: number;
  startingCash?: number;
  lossStopUsd?: number;
}

export function quotePrice(book: Pick<Book, "bid" | "ask">, side: Side, tick = 0.000001): number | null {
  if (!(book.bid > 0 && book.ask > book.bid && tick > 0)) return null;
  const spreadTicks = Math.floor((book.ask - book.bid) / tick + 1e-7);
  const raw = side === "buy"
    ? spreadTicks >= 3 ? book.bid + tick : book.bid
    : spreadTicks >= 3 ? book.ask - tick : book.ask;
  const price = Number((Math.round(raw / tick) * tick).toFixed(8));
  if (side === "buy" ? price >= book.ask : price <= book.bid) return null;
  return price;
}

export class PaperEngine {
  private readonly now: () => number;
  private readonly feeBps: number;
  private readonly size: number;
  private readonly cap: number;
  private readonly startCash: number;
  private readonly maxLoss: number;
  private cash: number;
  private inventory = 0;
  private basis = 0;
  private realized = 0;
  private fees = 0;
  private quotes = 0;
  private fills = 0;
  private late = 0;
  private blocks = 0;
  private decisions = 0;
  private resting: PaperQuote | null = null;
  private history: { ts: number; price: number }[] = [];
  private tape: Fill[] = [];
  private lastBook: Book | null = null;
  private lastDecision: Decision | null = null;
  private notice = "Starting local feed.";
  private stopped = false;
  private processing = false;
  private modelStatus: ModelStatus = { state: "ready", retryAt: null, reason: null };
  private listeners = new Set<(snapshot: Snapshot) => void>();

  constructor(private readonly options: QuoteEngineOptions) {
    this.now = options.now ?? Date.now;
    this.feeBps = options.feeBps ?? config.feeBps;
    this.size = options.orderSizeMon ?? config.orderSizeMon;
    this.cap = options.positionCapMon ?? config.maxPositionMon;
    this.startCash = options.startingCash ?? config.initialCashUsd;
    this.maxLoss = options.lossStopUsd ?? config.maxLossUsd;
    this.cash = this.startCash;
  }

  subscribe(listener: (snapshot: Snapshot) => void) { this.listeners.add(listener); listener(this.snapshot()); return () => this.listeners.delete(listener); }
  snapshot(): Snapshot {
    const mid = this.lastBook?.mid ?? 0;
    const equity = this.cash + this.inventory * mid;
    const unrealized = this.inventory === 0 ? 0 : this.inventory * (mid - this.basis);
    return {
      status: this.stopped ? "stopped" : this.modelStatus.state === "failed" ? "degraded" : this.lastBook ? "live" : "connecting",
      mode: this.options.mode,
      model: this.options.model.name,
      modelStatus: this.modelStatus.state,
      nextRetryAt: this.modelStatus.retryAt,
      block: this.lastBook?.block ?? 0,
      ts: this.now(),
      book: this.lastBook,
      decision: this.lastDecision,
      quote: this.resting,
      position: { mon: this.inventory, cash: this.cash, equity, unrealized },
      totals: { blocks: this.blocks, decisions: this.decisions, quotes: this.quotes, fills: this.fills, feesUsd: this.fees, realizedUsd: this.realized, pnlUsd: equity - this.startCash, late: this.late },
      chart: this.history.slice(-240), tape: this.tape.slice(-40).reverse(),
      notice: this.notice,
    };
  }

  async onBook(book: Book): Promise<Snapshot> {
    if (this.processing) return this.snapshot();
    this.processing = true;
    try {
      this.blocks++;
      this.lastBook = book;
      this.history.push({ ts: this.now(), price: book.mid });
      if (this.history.length > 1500) this.history.shift();
      this.resolveResting(book);
      this.checkLossStop(book);
      this.modelStatus = this.options.model.status();

      if (this.stopped) { this.notice = "Paper loss stop latched. Book and existing paper order monitoring continue until process restart."; return this.publish(); }
      if (this.modelStatus.state === "failed") { this.notice = this.modelStatus.reason ?? "Model paused."; this.lastDecision = null; return this.publish(); }
      if (this.modelStatus.state === "waiting") {
        this.notice = this.modelStatus.reason ?? "Waiting for Jev cadence.";
        this.lastDecision = null; // no request was made, so do not present a model decision
        return this.publish();
      }

      const decision = await this.options.model.decide(book, this.history.map((x) => x.price));
      this.decisions++;
      this.lastDecision = decision;
      this.createQuote(book, decision);
      this.modelStatus = this.options.model.status();
      return this.publish();
    } catch (error) {
      const e = error as { retryAt?: number; message?: string; name?: string };
      if (error instanceof RateLimitWait) {
        this.notice = e.message ?? "Jev rate limited; retrying after cooldown.";
        this.modelStatus = this.options.model.status();
      } else {
        this.modelStatus = this.options.model.status();
        this.notice = this.modelStatus.reason ?? "Book or model temporarily unavailable. No fallback decision is substituted.";
      }
      return this.publish();
    } finally { this.processing = false; }
  }

  setUnavailable(message: string) { this.notice = message; this.modelStatus = this.options.model.status(); this.publish(); }

  private createQuote(book: Book, decision: Decision) {
    if (decision.action === "hold") { this.cancelResting("replaced by hold"); return; }
    const side = decision.action;
    if (Math.abs(this.inventory + (side === "buy" ? this.size : -this.size)) > this.cap) {
      this.cancelResting("position cap prevents quote");
      this.notice = "Position cap reached. No paper quote submitted.";
      return;
    }
    const price = quotePrice(book, side);
    if (price === null) { this.cancelResting("no safe post-only price"); this.notice = "Spread too narrow for a non-crossing paper quote."; return; }
    if (side === "buy" && this.cash < price * this.size * (1 + this.feeBps / 10_000)) { this.cancelResting("insufficient paper cash"); this.notice = "Paper cash limit prevents this buy quote."; return; }
    this.cancelResting("replaced by newer decision");
    this.resting = { side, price, size: this.size, block: book.block, status: "resting", note: "Simulated quote; not submitted to Kuru." };
    this.quotes++;
    this.notice = decision.source === "OpenCode Zen free Jev"
      ? "Jev decision applied to a non-crossing paper quote; no order was submitted."
      : "Stand-in demo decision applied to a non-crossing simulated quote.";
  }

  private resolveResting(book: Book) {
    const order = this.resting;
    if (!order || book.block <= order.block) return;
    const crossedByObservedMid = order.side === "buy" ? book.mid <= order.price : book.mid >= order.price;
    if (!crossedByObservedMid) return;
    const notional = order.price * order.size;
    const fee = notional * this.feeBps / 10_000;
    const signedFill = order.side === "buy" ? order.size : -order.size;
    const prior = this.inventory;
    const closes = prior !== 0 && Math.sign(prior) !== Math.sign(signedFill) ? Math.min(Math.abs(prior), Math.abs(signedFill)) : 0;
    if (closes > 0) this.realized += closes * (order.side === "sell" ? order.price - this.basis : this.basis - order.price);
    const remaining = Math.abs(signedFill) - closes;
    if (remaining > 0) this.basis = order.price;
    this.inventory += signedFill;
    this.cash -= signedFill * order.price + fee;
    this.fees += fee;
    this.fills++;
    const fill: Fill = { side: order.side, price: order.price, size: order.size, block: book.block, source: "next-book midpoint crossed quote; queue position not modeled" };
    this.tape.push(fill);
    order.status = "filled";
    this.resting = null;
    const equity = this.cash + this.inventory * book.mid;
    this.checkLossStop(book);
  }

  private cancelResting(note: string) {
    if (!this.resting) return;
    this.resting.status = "cancelled";
    this.resting.note = `Simulated order canceled: ${note}.`;
    this.resting = null;
  }
  private checkLossStop(book: Book) {
    if (this.stopped) return;
    const equity = this.cash + this.inventory * book.mid;
    if (equity - this.startCash <= -this.maxLoss) {
      this.stopped = true;
      this.cancelResting("paper loss stop latched");
      this.notice = "Paper loss stop latched. No new quotes; book monitoring continues.";
    }
  }
  private publish() { const s = this.snapshot(); for (const fn of this.listeners) fn(s); return s; }
}
