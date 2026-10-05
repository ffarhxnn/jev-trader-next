import { config } from "./config";
import type { Book, Decision, Fill, PaperLifecycleEvent, PaperQuote, Snapshot, Side, TradeEvent } from "./types";
import { RateLimitWait, type DecisionModel, type ModelStatus } from "./model";
import type { PaperRiskStop } from "./paper-risk-latch";
import { postOnlyQuotePrice } from "./post-only-quote";

export interface QuoteEngineOptions {
  mode: "paper" | "demo";
  model: DecisionModel;
  now?: () => number;
  feeBps?: number;
  orderSizeMon?: number;
  positionCapMon?: number;
  startingCash?: number;
  lossStopUsd?: number;
  staleAfterMs?: number;
  riskStop?: PaperRiskStop | null;
  persistRiskStop?: (state: Omit<PaperRiskStop, "version" | "mode" | "reason">) => void;
}

export function quotePrice(book: Pick<Book, "bid" | "ask">, side: Side, tick = 0.000001): number | null {
  if (!Number.isFinite(tick) || tick <= 0) return null;
  const units = Math.round(tick * 1e8);
  if (units < 1 || Math.abs(units / 1e8 - tick) > Number.EPSILON * tick * 4) return null;
  return postOnlyQuotePrice(book, side, { priceDecimals: 8, tickUnits: units, insideTicks: 1 });
}

export class PaperEngine {
  private readonly now: () => number;
  private readonly feeBpsOverride: number | null;
  private feeBps: number;
  private readonly size: number;
  private readonly cap: number;
  private readonly startCash: number;
  private readonly maxLoss: number;
  private readonly staleAfterMs: number;
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
  private tradeEvents = 0;
  private ignoredTradeEvents = 0;
  private lastTradeAt: number | null = null;
  private resting: PaperQuote | null = null;
  private history: { ts: number; price: number }[] = [];
  private tape: Fill[] = [];
  private lastBook: Book | null = null;
  private lastAdvancingBookAt: number | null = null;
  private bookStale = false;
  private lastDecision: Decision | null = null;
  private notice = "Starting local feed.";
  private stopped = false;
  private riskStopPersistenceFailed = false;
  private feedFailed = false;
  private tradeFeedHealthy = false;
  private processing = false;
  private modelStatus: ModelStatus = { state: "ready", retryAt: null, reason: null };
  private listeners = new Set<(snapshot: Snapshot) => void>();
  private lifecycleListeners = new Set<(event: PaperLifecycleEvent) => void>();
  private quoteSequence = 0;

  constructor(private readonly options: QuoteEngineOptions) {
    this.now = options.now ?? Date.now;
    this.feeBpsOverride = options.feeBps ?? config.feeBps;
    this.feeBps = this.feeBpsOverride ?? (options.mode === "paper" ? Number.NaN : 0);
    this.size = options.orderSizeMon ?? config.orderSizeMon;
    this.cap = options.positionCapMon ?? config.maxPositionMon;
    this.startCash = options.startingCash ?? config.initialCashUsd;
    this.maxLoss = options.lossStopUsd ?? config.maxLossUsd;
    this.staleAfterMs = options.staleAfterMs ?? config.staleAfterMs;
    this.cash = this.startCash;
    this.stopped = options.riskStop !== undefined && options.riskStop !== null;
    if (this.stopped) this.notice = "Persistent paper loss stop is latched. Review the saved stop and explicitly reset it before restarting paper mode.";
  }

  subscribe(listener: (snapshot: Snapshot) => void) { this.listeners.add(listener); listener(this.snapshot()); return () => this.listeners.delete(listener); }
  subscribeLifecycle(listener: (event: PaperLifecycleEvent) => void) { this.lifecycleListeners.add(listener); return () => this.lifecycleListeners.delete(listener); }
  snapshot(): Snapshot {
    const mid = this.lastBook?.mid ?? 0;
    const equity = this.cash + this.inventory * mid;
    const unrealized = this.inventory === 0 ? 0 : this.inventory * (mid - this.basis);
    return {
      status: this.stopped ? "stopped" : this.modelStatus.state === "failed" || this.feedFailed || this.options.mode === "paper" && !this.tradeFeedHealthy ? "degraded" : this.lastBook ? "live" : "connecting",
      mode: this.options.mode,
      paperFeeBps: Number.isFinite(this.feeBps) ? this.feeBps : null,
      model: this.options.model.name,
      modelStatus: this.modelStatus.state,
      nextRetryAt: this.modelStatus.retryAt,
      block: this.lastBook?.block ?? 0,
      ts: this.now(),
      book: this.lastBook,
      decision: this.lastDecision,
      quote: this.resting,
      position: { mon: this.inventory, cash: this.cash, equity, unrealized },
      totals: { blocks: this.blocks, decisions: this.decisions, quotes: this.quotes, fills: this.fills, feesUsd: this.fees, realizedUsd: this.realized, pnlUsd: equity - this.startCash, late: this.late, tradeEvents: this.tradeEvents, ignoredTradeEvents: this.ignoredTradeEvents, lastTradeAt: this.lastTradeAt },
      chart: this.history.slice(-240), tape: this.tape.slice(-40).reverse(),
      notice: this.notice,
    };
  }

  async onBook(book: Book): Promise<Snapshot> {
    this.checkBookFreshness();
    if (this.processing) return this.snapshot();
    this.processing = true;
    try {
      const receivedAt = this.now();
      if (book.source === "Monad Kuru" && this.lastBook) {
        if (book.block < this.lastBook.block) {
          this.setUnavailable("Kuru RPC returned an older block than the last accepted book. Quotes canceled until the feed recovers.");
          return this.snapshot();
        }
        if (book.block === this.lastBook.block) {
          return this.snapshot();
        }
      }
      if (this.options.mode === "paper") {
        const currentFeeBps = this.feeBpsOverride ?? (book.source === "Monad Kuru" ? book.makerFeeBps : undefined);
        if (!Number.isFinite(currentFeeBps) || currentFeeBps! < 0) {
          this.setUnavailable("Kuru maker-fee parameters are missing or invalid. Paper quoting is paused.");
          return this.snapshot();
        }
        if (Number.isFinite(this.feeBps) && this.feeBps !== currentFeeBps) this.cancelResting("Kuru maker fee changed");
        this.feeBps = currentFeeBps!;
      }
      if (book.source === "Monad Kuru") this.lastAdvancingBookAt = receivedAt;
      this.blocks++;
      this.lastBook = { ...book, receivedAt };
      this.bookStale = false;
      this.feedFailed = false;
      this.history.push({ ts: this.now(), price: book.mid });
      if (this.history.length > 1500) this.history.shift();
      this.resolveResting(book);
      this.checkLossStop(book);

      if (this.options.mode === "paper" && (!Number.isFinite(book.spreadBps) || book.spreadBps < 0 || book.spreadBps > config.maxMarketSpreadBps)) {
        this.cancelResting("market spread exceeds the configured limit");
        this.lastDecision = null;
        const shownSpread = Number.isFinite(book.spreadBps) ? `${book.spreadBps.toFixed(1)} bps` : "invalid";
        this.notice = `Market spread is ${shownSpread}; the ${config.maxMarketSpreadBps} bps limit blocks model decisions and paper quotes.`;
        return this.publish();
      }

      this.modelStatus = this.options.model.status();

      if (this.stopped) {
        if (!this.riskStopPersistenceFailed) this.notice = "Paper loss stop remains latched. Book monitoring continues; no new decisions or quotes are allowed.";
        return this.publish();
      }
      if (this.options.mode === "paper" && !this.tradeFeedHealthy) { this.notice = "Kuru trade feed is unavailable. No paper quote is active."; this.lastDecision = null; return this.publish(); }
      if (this.modelStatus.state === "failed") { this.notice = this.modelStatus.reason ?? "Model paused."; this.lastDecision = null; return this.publish(); }
      if (this.modelStatus.state === "waiting") {
        this.notice = this.modelStatus.reason ?? "Waiting for Jev cadence.";
        // Keep the previous signal visible during cadence waits. Safety states above still clear it.
        return this.publish();
      }

      const decision = await this.options.model.decide(book, this.history.map((x) => x.price));
      this.decisions++;
      this.modelStatus = this.options.model.status();
      if (!this.checkBookFreshness()) return this.publish();
      if (this.stopped || this.feedFailed || this.options.mode === "paper" && !this.tradeFeedHealthy) {
        this.lastDecision = null;
        this.notice = this.stopped ? "Paper loss stop latched. No quote was created." : "Market data became unavailable during the model request. No quote was created.";
        return this.publish();
      }
      this.lastDecision = decision;
      this.createQuote(book, decision);
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

  /** Wall-clock guard independent of RPC completion, model completion and trade arrival. */
  checkBookFreshness(): boolean {
    if (this.options.mode !== "paper" || this.lastBook?.source !== "Monad Kuru" || this.lastAdvancingBookAt === null) return true;
    if (this.bookStale) return false;
    if (this.now() - this.lastAdvancingBookAt < this.staleAfterMs) return true;
    this.bookStale = true;
    this.lastDecision = null;
    this.setUnavailable("Kuru book block did not advance before the stale-data limit. Quotes canceled until a newer block arrives.");
    return false;
  }

  setUnavailable(message: string) {
    this.feedFailed = true;
    this.cancelResting("public book feed unavailable");
    this.notice = message;
    this.modelStatus = this.options.model.status();
    this.publish();
  }

  setTradeFeedHealthy(healthy: boolean) {
    this.tradeFeedHealthy = healthy;
    if (!healthy) {
      this.cancelResting("Kuru trade feed unavailable");
      this.notice = "Kuru trade feed disconnected. Paper quotes were canceled.";
    } else if (!this.feedFailed) {
      this.notice = "Kuru trade feed connected. Waiting for the next fresh book.";
    }
    this.publish();
  }

  onTrade(trade: TradeEvent): Snapshot {
    if (this.options.mode !== "paper") return this.snapshot();
    this.tradeEvents++;
    this.lastTradeAt = trade.timestamp;
    if (!this.checkBookFreshness()) return this.snapshot();
    if (!this.tradeFeedHealthy || this.feedFailed || this.stopped) return this.snapshot();
    const order = this.resting;
    const tickSize = this.lastBook?.tickSize ?? 0.000001;
    if (!order || trade.timestamp <= (order.placedAt ?? 0) || Math.abs(trade.price - order.price) > tickSize * 0.5 || (order.side === "buy" ? trade.takerSide !== "sell" : trade.takerSide !== "buy")) return this.snapshot();
    const queueAhead = order.queueAhead ?? 0;
    const consumedAhead = Math.min(queueAhead, trade.size);
    order.queueAhead = queueAhead - consumedAhead;
    const availableInventory = order.side === "sell" ? Math.max(0, this.inventory) : Number.POSITIVE_INFINITY;
    const amount = Math.min(order.size, Math.max(0, trade.size - consumedAhead), availableInventory);
    if (amount <= 0) return this.publish();
    const filled = this.applyFill(order, amount, "public Kuru trade at quote price after modeled visible queue", trade.timestamp, trade);
    order.size -= filled;
    if (order.size <= 1e-12 || order.side === "sell" && this.inventory <= 1e-12) this.resting = null;
    else if (!this.stopped) this.notice = `Paper partial fill recorded; ${order.size} MON remains at the quote.`;
    if (this.lastBook) this.checkLossStop(this.lastBook);
    return this.publish();
  }

  onIgnoredTrade() { this.ignoredTradeEvents++; }

  private createQuote(book: Book, decision: Decision) {
    if (decision.action === "hold") { this.cancelResting("replaced by hold"); return; }
    const side = decision.action;
    const size = side === "buy" ? this.size : Math.min(this.size, Math.max(0, this.inventory));
    if (size <= 1e-12) {
      this.cancelResting("sell requires available MON inventory");
      this.notice = "Sell signal ignored because the paper account has no MON inventory; shorting is disabled.";
      return;
    }
    if (Math.abs(this.inventory + (side === "buy" ? size : -size)) > this.cap) {
      this.cancelResting("position cap prevents quote");
      this.notice = "Position cap reached. No paper quote submitted.";
      return;
    }
    const tickSize = book.tickSize ?? 0.000001;
    const price = quotePrice(book, side, tickSize);
    if (price === null) { this.cancelResting("no safe post-only price"); this.notice = "Spread too narrow for a non-crossing paper quote."; return; }
    if (side === "buy" && this.cash < price * size * (1 + this.feeBps / 10_000)) { this.cancelResting("insufficient paper cash"); this.notice = "Paper cash limit prevents this buy quote."; return; }
    const levels = side === "buy" ? book.bids : book.asks;
    const queueAhead = levels?.find(([levelPrice]) => Math.abs(levelPrice - price) <= tickSize * 0.5)?.[1] ?? 0;
    if (this.resting?.side === side && this.resting.price === price && this.resting.size <= size) {
      this.resting.queueAhead = Math.max(this.resting.queueAhead ?? 0, queueAhead);
      this.notice = "Existing paper quote kept at the same price; modeled queue priority is preserved.";
      return;
    }
    this.cancelResting("replaced by newer decision");
    this.resting = { quoteId: `q${++this.quoteSequence}`, side, price, size, queueAhead, placedAt: this.now(), block: book.block, status: "resting", note: "Simulated quote; not submitted to Kuru." };
    this.quotes++;
    const decisionLabel = decision.source === "local demo heuristic" ? "Local demo heuristic" : decision.source.includes("Jev") ? "Jev" : "Model";
    this.emitLifecycle({ kind: "quote_resting", timestamp: this.now(), block: book.block, quote: { ...this.resting }, positionMon: this.inventory, cashUsd: this.cash });
    this.notice = this.options.mode === "paper"
      ? `${decisionLabel} decision applied to a paper quote; fill simulation waits for Kuru trades at price and modeled queue ahead.`
      : `${decisionLabel} decision applied to a non-crossing simulated quote; no order was submitted.`;
  }

  private resolveResting(book: Book) {
    if (this.options.mode === "paper") return;
    const order = this.resting;
    if (!order || book.block <= order.block) return;
    const crossedByObservedMid = order.side === "buy" ? book.mid <= order.price : book.mid >= order.price;
    if (!crossedByObservedMid) return;
    this.applyFill(order, order.size, "next-book midpoint crossed quote; queue position not modeled");
    this.resting = null;
  }

  private applyFill(order: PaperQuote, amount: number, source: string, timestamp = this.now(), trade?: TradeEvent): number {
    amount = order.side === "sell" ? Math.min(amount, Math.max(0, this.inventory)) : amount;
    if (!(amount > 0)) return 0;
    const notional = order.price * amount;
    const fee = notional * this.feeBps / 10_000;
    const signedFill = order.side === "buy" ? amount : -amount;
    const prior = this.inventory;
    const closes = prior !== 0 && Math.sign(prior) !== Math.sign(signedFill) ? Math.min(Math.abs(prior), Math.abs(signedFill)) : 0;
    if (closes > 0) this.realized += closes * (order.side === "sell" ? order.price - this.basis : this.basis - order.price);
    const remaining = Math.abs(signedFill) - closes;
    if (remaining > 0) {
      this.basis = closes === 0 && prior !== 0
        ? (Math.abs(prior) * this.basis + remaining * order.price) / (Math.abs(prior) + remaining)
        : order.price;
    }
    this.inventory += signedFill;
    this.cash -= signedFill * order.price + fee;
    this.fees += fee;
    this.fills++;
    const fill: Fill = { quoteId: order.quoteId, side: order.side, price: order.price, size: amount, block: this.lastBook?.block ?? order.block, ts: timestamp, source,
      ...(trade?.transactionHash ? { tradeTransactionHash: trade.transactionHash } : {}),
      ...(trade?.sourceTimestamp ? { tradeSourceTimestamp: trade.sourceTimestamp } : {}) };
    this.tape.push(fill);
    this.emitLifecycle({ kind: "fill", timestamp, fill: { ...fill }, remainingSize: Math.max(0, order.size - amount), positionMon: this.inventory, cashUsd: this.cash, equityUsd: this.cash + this.inventory * (this.lastBook?.mid ?? order.price), feesUsd: this.fees });
    return amount;
  }

  private cancelResting(note: string) {
    if (!this.resting) return;
    const quote = this.resting;
    this.resting.status = "cancelled";
    this.resting.note = `Simulated order canceled: ${note}.`;
    this.resting = null;
    this.emitLifecycle({ kind: "quote_cancelled", timestamp: this.now(), block: this.lastBook?.block ?? quote.block, quoteId: quote.quoteId, side: quote.side, price: quote.price, remainingSize: quote.size, reason: note });
  }
  private checkLossStop(book: Book) {
    if (this.stopped) return;
    const equity = this.cash + this.inventory * book.mid;
    if (equity - this.startCash <= -this.maxLoss) {
      this.stopped = true;
      this.notice = "Paper loss stop latched. No new quotes; book monitoring continues. An explicit local reset and process restart are required.";
      try {
        this.options.persistRiskStop?.({
          market: config.market.toLowerCase(), latchedAt: this.now(), startingEquityUsd: this.startCash,
          equityAtStopUsd: equity, lossLimitUsd: this.maxLoss,
        });
      } catch {
        this.riskStopPersistenceFailed = true;
        this.notice = "Paper loss stop is active in memory, but saving its persistent latch failed. Do not restart until storage is restored.";
      }
      this.cancelResting("paper loss stop latched");
    }
  }
  private publish() { const s = this.snapshot(); for (const fn of this.listeners) fn(s); return s; }
  private emitLifecycle(event: PaperLifecycleEvent) { for (const listener of this.lifecycleListeners) listener(event); }
}
