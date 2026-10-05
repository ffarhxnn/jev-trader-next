import type { Action, DepthSnapshot, Side, TradeEvent } from "./types";
import { assertReceiptVerifiedReplay, validateDepthSnapshot } from "./research";
import { hasL2CaptureGap } from "./capture";
import { postOnlyQuotePrice } from "./post-only-quote";

/** Completed decisions tied to the exact recorded input book; no strategy or model is synthesized. */
export interface ReplayDecision {
  bookTimestamp: number;
  bookBlock: number;
  decidedAt: number;
  action: Action;
  model: string;
  source: string;
}
export interface SinglePlacementReplayOptions {
  startingCash: number;
  startingMon: number;
  orderSizeMon: number;
  positionCapMon: number;
  minimumOrderSizeMon: number;
  feeBps: number;
  tickSize: number;
  insideTicks: number;
  maxSpreadBps: number;
  maxLossUsd: number;
  gasUsdPerUpdate: number;
  orderLatencyMs: number;
  receiptConfirmationDelayMs: number;
}
export interface SinglePlacementAttempt {
  sequence: number;
  decisionIndex: number | null;
  operation: "placement" | "cancel";
  side: Side | null;
  price: number | null;
  size: number;
  cancelTargetQuoteId: number | null;
  submittedAt: number;
  appliesAt: number;
  confirmsAt: number;
  outcome: "pending" | "applied" | "reverted" | "unresolved";
  reason: string;
  model: string | null;
  source: string | null;
  activationSnapshotTimestamp?: number;
  activationReceiptBlockCeiling?: number;
  queueAheadAtActivation?: number;
  pendingAtEnd: boolean;
}
export interface SinglePlacementFill {
  quoteId: number;
  decisionIndex: number;
  timestamp: number;
  activatedAt: number;
  activationSnapshotTimestamp: number;
  activationReceiptBlockCeiling: number;
  side: Side;
  price: number;
  size: number;
  queueAheadBefore: number;
  queueConsumed: number;
  cashAfter: number;
  inventoryAfter: number;
  trade: TradeEvent;
}
export interface SinglePlacementReplayResult {
  evidenceStatus: "RESEARCH_PROXY_ONLY";
  assumptions: SinglePlacementReplayOptions;
  decisions: number;
  decisionDetails: { decisionIndex: number; action: Action; selectedSide: Side | null; outcome: string }[];
  attempts: SinglePlacementAttempt[];
  fillDetails: SinglePlacementFill[];
  counts: {
    attempts: number; applied: number; reverted: number; unresolved: number; pendingAtEnd: number;
    buyFills: number; sellFills: number; fills: number; decisionsSkippedWhilePending: number;
    staleDecisions: number; riskFallbacks: number; disallowedDecisions: number; gasBlockedUpdates: number;
    exactPriceSideMatches: number; queueOnlyTradeEvents: number; receiptTimingBlockedEvents: number;
    activationLatencyBlockedEvents: number; applicationBoundaryBlockedEvents: number;
    riskBlockedTradeEvents: number; fillsWhileReplacementPending: number;
  };
  endingCashUsd: number;
  endingMon: number;
  endingMidUsd: number;
  endingRestingQuote: { quoteId: number; side: Side; price: number; remainingSize: number; queueAhead: number } | null;
  feesUsd: number;
  gasCostsUsd: number;
  grossPnlUsd: number;
  netPnlUsd: number;
  terminalMarkedLossBreached: boolean;
  maxInventoryMon: number;
  lossStop: null | { timestamp: number; equityUsd: number; pnlUsd: number; maxLossUsd: number };
  executionStopped: boolean;
  rootLifecycleAgreement: string;
  remainingMismatches: string[];
}
interface Quote {
  id: number; decisionIndex: number; side: Side; price: number; priceWad: string; remaining: number;
  queueAhead: number; activeAt: number; activationSnapshotTimestamp: number; receiptBlockCeiling: number;
}
interface Pending {
  attempt: SinglePlacementAttempt;
  target: Quote | null;
  next: { side: Side; price: number; decisionIndex: number } | null;
  applied: boolean;
}
const finite = (x: number) => Number.isFinite(x);
const address = /^0x[\da-f]{40}$/i;
const integer = /^(?:0|[1-9]\d*)$/;
const priceWad = (price: number) => (BigInt(Math.round(price * 1e8)) * 10n ** 10n).toString();
const samePrice = (quote: { priceWad: string; side: Side } | null, trade: TradeEvent) => !!quote && quote.side !== trade.takerSide && quote.priceWad === trade.rawPrice;

/** A receipt-evidenced, single-placement lifecycle proxy; it does not reproduce the root runtime. */
export function replaySinglePlacement(snapshots: DepthSnapshot[], trades: TradeEvent[], decisions: ReplayDecision[], options: SinglePlacementReplayOptions): SinglePlacementReplayResult {
  const required: (keyof SinglePlacementReplayOptions)[] = ["startingCash", "startingMon", "orderSizeMon", "positionCapMon", "minimumOrderSizeMon",
    "feeBps", "tickSize", "insideTicks", "maxSpreadBps", "maxLossUsd", "gasUsdPerUpdate", "orderLatencyMs", "receiptConfirmationDelayMs"];
  if (snapshots.length < 2 || !required.every(key => finite(options[key]))
    || options.startingCash < 0 || options.startingMon < 0 || options.orderSizeMon <= 0
    || options.positionCapMon <= 0 || options.minimumOrderSizeMon <= 0 || options.orderSizeMon < options.minimumOrderSizeMon
    || options.feeBps < 0 || options.feeBps > 10_000 || options.tickSize <= 0
    || !Number.isSafeInteger(options.insideTicks) || options.insideTicks < 0 || options.maxSpreadBps <= 0
    || options.maxLossUsd <= 0 || options.gasUsdPerUpdate < 0 || options.orderLatencyMs < 0 || options.receiptConfirmationDelayMs < 0) throw new Error("Invalid single-placement replay options or insufficient snapshots.");
  const first = snapshots[0]!, last = snapshots.at(-1)!;
  if (first.chainId !== 143 || !first.market || !address.test(first.market)
    || first.tickSize !== options.tickSize || first.minSizeMon !== options.minimumOrderSizeMon
    || first.makerFeeBps !== options.feeBps || !finite(first.sizePrecision!) || first.sizePrecision! <= 0
    || !/^10*$/.test(String(first.sizePrecision)) || !finite(first.captureIntervalMs!) || first.captureIntervalMs! <= 0) throw new Error("Single-placement replay needs stable Monad market, tick, minimum, fee and capture metadata.");
  const tickUnits = Math.round(options.tickSize * 1e8);
  if (!Number.isSafeInteger(tickUnits) || tickUnits < 1 || Math.abs(tickUnits / 1e8 - options.tickSize) > Number.EPSILON * options.tickSize * 4) throw new Error("Unsupported Kuru price tick.");
  const metadata = (s: DepthSnapshot) => JSON.stringify([s.chainId, s.market?.toLowerCase(), s.tickSize, s.sizePrecision, s.minSizeMon, s.makerFeeBps, s.takerFeeBps]);
  const baseline = metadata(first);
  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i]!, prior = snapshots[i - 1];
    if (!validateDepthSnapshot(snapshot) || !Number.isSafeInteger(snapshot.block) || snapshot.block < 1
      || snapshot.timestamp < 0 || (i > 0 && snapshot.gapBefore) || metadata(snapshot) !== baseline
      || !finite(snapshot.captureIntervalMs!) || snapshot.captureIntervalMs! <= 0
      || snapshot.makerFeeBps! < 0 || snapshot.makerFeeBps! > 10_000
      || (snapshot.takerFeeBps !== undefined && (!finite(snapshot.takerFeeBps) || snapshot.takerFeeBps < 0 || snapshot.takerFeeBps > 10_000))
      || (prior && (snapshot.block < prior.block || hasL2CaptureGap(prior.timestamp, snapshot.timestamp,
        Math.max(prior.captureIntervalMs!, snapshot.captureIntervalMs!))))) throw new Error("Invalid, discontinuous or changed single-placement L2 metadata.");
    for (const [side, levels] of [["buy", snapshot.bids], ["sell", snapshot.asks]] as const) {
      let previous: number | null = null;
      for (const [price] of levels) {
        const raw = price * 1e8, rounded = Math.round(raw);
        if (!Number.isSafeInteger(rounded) || rounded > 0xffffffff || rounded <= 0 || rounded % tickUnits !== 0
          || Math.abs(raw - rounded) > Math.min(0.125, Number.EPSILON * Math.max(1, Math.abs(raw)) * 2)
          || (previous !== null && (side === "buy" ? price >= previous : price <= previous))) throw new Error("Invalid or unordered Kuru L2 price levels.");
        previous = price;
      }
    }
  }
  assertReceiptVerifiedReplay(trades, 0, first.chainId, first.market);
  const seen = new Set<string>();
  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i]!, previous = trades[i - 1];
    const key = `${trade.transactionHash!.toLowerCase()}:${trade.receiptLogIndex}`;
    if (!finite(trade.timestamp) || trade.timestamp < first.timestamp || trade.timestamp > last.timestamp
      || !finite(trade.price) || trade.price <= 0 || !finite(trade.size) || trade.size <= 0
      || !["buy", "sell"].includes(trade.takerSide) || !trade.rawPrice || !integer.test(trade.rawPrice)
      || !trade.rawSize || !integer.test(trade.rawSize) || BigInt(trade.rawPrice) <= 0n || BigInt(trade.rawPrice) >= 1n << 256n
      || BigInt(trade.rawSize) <= 0n || BigInt(trade.rawSize) >= 1n << 96n || trade.receiptBlock! < 1
      || trade.price !== Number(BigInt(trade.rawPrice)) / 1e18 || trade.size !== Number(BigInt(trade.rawSize)) / first.sizePrecision!
      || seen.has(key) || (previous && (trade.timestamp < previous.timestamp || trade.receiptBlock! < previous.receiptBlock!
        || (trade.receiptBlock === previous.receiptBlock && trade.receiptLogIndex! <= previous.receiptLogIndex!)))) throw new Error("Invalid, duplicate or unordered receipt trade evidence.");
    seen.add(key);
  }
  const books = new Map(snapshots.map(snapshot => [`${snapshot.timestamp}:${snapshot.block}`, snapshot]));
  decisions.forEach((decision, i) => {
    if (!finite(decision.decidedAt) || !finite(decision.bookTimestamp) || !Number.isSafeInteger(decision.bookBlock)
      || !books.has(`${decision.bookTimestamp}:${decision.bookBlock}`) || decision.decidedAt < decision.bookTimestamp
      || decision.decidedAt > last.timestamp || (i > 0 && decision.decidedAt <= decisions[i - 1]!.decidedAt)
      || !["buy", "sell", "hold"].includes(decision.action) || typeof decision.model !== "string" || !decision.model.trim()
      || typeof decision.source !== "string" || !decision.source.trim() || decision.model.length > 200 || decision.source.length > 200) throw new Error("Decision lacks exact chronological book provenance or public model/source labels.");
  });

  let cash = options.startingCash, inventory = options.startingMon, fees = 0, gas = 0, maxInventory = inventory;
  let observed = first, quote: Quote | null = null, pending: Pending | null = null, executionStopped = false;
  let lossStop: SinglePlacementReplayResult["lossStop"] = null;
  const initialEquity = cash + inventory * (first.bids[0]![0] + first.asks[0]![0]) / 2;
  const attempts: SinglePlacementAttempt[] = [], fills: SinglePlacementFill[] = [], decisionDetails: SinglePlacementReplayResult["decisionDetails"] = [];
  const counts: SinglePlacementReplayResult["counts"] = { attempts: 0, applied: 0, reverted: 0, unresolved: 0, pendingAtEnd: 0,
    buyFills: 0, sellFills: 0, fills: 0, decisionsSkippedWhilePending: 0, staleDecisions: 0, riskFallbacks: 0,
    disallowedDecisions: 0, gasBlockedUpdates: 0, exactPriceSideMatches: 0, queueOnlyTradeEvents: 0,
    receiptTimingBlockedEvents: 0, activationLatencyBlockedEvents: 0, applicationBoundaryBlockedEvents: 0,
    riskBlockedTradeEvents: 0, fillsWhileReplacementPending: 0 };
  let boundary: { timestamp: number; old: Quote | null; next: { side: Side; priceWad: string } | null } | null = null;
  const mid = () => (observed.bids[0]![0] + observed.asks[0]![0]) / 2;
  const submit = (at: number, next: Pending["next"], decisionIndex: number | null, reason: string) => {
    const oldBuyReserve = quote?.side === "buy" ? quote.remaining * quote.price * (1 + options.feeBps / 10_000) : 0;
    if (pending || executionStopped || cash - options.gasUsdPerUpdate < oldBuyReserve) { if (!pending && !executionStopped) counts.gasBlockedUpdates++; return false; }
    cash -= options.gasUsdPerUpdate; gas += options.gasUsdPerUpdate;
    const attempt: SinglePlacementAttempt = { sequence: attempts.length + 1, decisionIndex, operation: next ? "placement" : "cancel",
      side: next?.side ?? null, price: next?.price ?? null, size: next ? options.orderSizeMon : 0,
      cancelTargetQuoteId: quote?.id ?? null, submittedAt: at, appliesAt: at + options.orderLatencyMs,
      confirmsAt: at + options.orderLatencyMs + options.receiptConfirmationDelayMs, outcome: "pending", reason,
      model: decisionIndex === null ? null : decisions[decisionIndex]!.model,
      source: decisionIndex === null ? null : decisions[decisionIndex]!.source, pendingAtEnd: true };
    if (!finite(attempt.appliesAt) || !finite(attempt.confirmsAt)) throw new Error("Replay transaction timing overflowed.");
    attempts.push(attempt); pending = { attempt, target: quote, next, applied: false }; return true;
  };
  const checkLoss = (at: number) => {
    const equity = cash + inventory * mid(), pnl = equity - initialEquity;
    if (!lossStop && pnl <= -options.maxLossUsd) lossStop = { timestamp: at, equityUsd: equity, pnlUsd: pnl, maxLossUsd: options.maxLossUsd };
    if (lossStop && quote && !pending && !executionStopped) submit(at, null, null, "latched_marked_equity_loss_stop");
  };
  const apply = (at: number) => {
    const update = pending!; boundary = { timestamp: at, old: update.target, next: update.next ? { side: update.next.side, priceWad: priceWad(update.next.price) } : null };
    update.applied = true;
    if (update.target && update.target.remaining <= 0) {
      update.attempt.outcome = "unresolved"; update.attempt.reason = "frozen_cancel_target_fully_filled_before_application"; executionStopped = true; return;
    }
    const next = update.next;
    if (next && ((next.side === "buy" && (next.price >= observed.asks[0]![0]
      || cash < options.orderSizeMon * next.price * (1 + options.feeBps / 10_000) || inventory + options.orderSizeMon > options.positionCapMon))
      || (next.side === "sell" && (next.price <= observed.bids[0]![0] || inventory < options.orderSizeMon)))) {
      update.attempt.outcome = "reverted"; update.attempt.reason = "atomic_post_only_or_resource_revert"; return;
    }
    quote = null;
    if (next) {
      const levels = next.side === "buy" ? observed.bids : observed.asks;
      const queue = levels.find(([price]) => priceWad(price) === priceWad(next.price))?.[1] ?? 0;
      const ceiling = snapshots.find(snapshot => snapshot.timestamp >= at)!.block;
      quote = { id: update.attempt.sequence, decisionIndex: next.decisionIndex, side: next.side, price: next.price,
        priceWad: priceWad(next.price), remaining: options.orderSizeMon, queueAhead: queue, activeAt: at,
        activationSnapshotTimestamp: observed.timestamp, receiptBlockCeiling: ceiling };
      update.attempt.activationSnapshotTimestamp = observed.timestamp; update.attempt.activationReceiptBlockCeiling = ceiling;
      update.attempt.queueAheadAtActivation = queue;
    }
    update.attempt.outcome = "applied";
  };
  const settle = (at: number) => {
    if (pending && !pending.applied && pending.attempt.appliesAt === at) apply(at);
    if (pending && pending.applied && !executionStopped && pending.attempt.confirmsAt <= at) {
      pending.attempt.pendingAtEnd = false; pending = null;
    }
  };
  const allowed = (side: Side, book: DepthSnapshot) => {
    const reserve = quote?.side === side ? quote.remaining : 0;
    const current = inventory + (side === "buy" ? reserve : -reserve);
    const exposure = current + (side === "buy" ? options.orderSizeMon : -options.orderSizeMon);
    if ((Math.abs(exposure) > options.positionCapMon && Math.abs(exposure) >= Math.abs(current)) || (side === "sell" && exposure < 0)) return false;
    return side === "buy" ? cash >= options.orderSizeMon * book.asks[0]![0] : inventory >= options.orderSizeMon;
  };
  const processDecision = (decision: ReplayDecision, index: number, at: number) => {
    let selectedSide: Side | null = null, outcome: string;
    if (executionStopped) outcome = "execution_stop_latched";
    else if (pending) { counts.decisionsSkippedWhilePending++; outcome = "pending_transaction_or_receipt"; }
    else if (lossStop) outcome = "loss_stop_latched";
    else {
      const book = books.get(`${decision.bookTimestamp}:${decision.bookBlock}`)!;
      const stale = snapshots.some(snapshot => snapshot.timestamp > decision.bookTimestamp && snapshot.timestamp <= at && snapshot.block > decision.bookBlock);
      const spread = (book.asks[0]![0] - book.bids[0]![0]) / ((book.asks[0]![0] + book.bids[0]![0]) / 2) * 10_000;
      if (stale || spread > options.maxSpreadBps || decision.action === "hold") {
        if (stale) counts.staleDecisions++;
        outcome = stale ? "stale_observed_capture_block" : spread > options.maxSpreadBps ? "market_spread_hold" : "explicit_hold";
        if (quote) submit(at, null, index, outcome);
      } else {
        const wanted = decision.action as Side, other = wanted === "buy" ? "sell" : "buy";
        selectedSide = allowed(wanted, book) ? wanted : allowed(other, book) ? other : null;
        if (!selectedSide) { counts.disallowedDecisions++; outcome = "both_sides_disallowed_old_quote_retained"; }
        else {
          if (selectedSide !== wanted) counts.riskFallbacks++;
          const price = postOnlyQuotePrice({ bid: book.bids[0]![0], ask: book.asks[0]![0] }, selectedSide,
            { priceDecimals: 8, tickUnits, insideTicks: options.insideTicks });
          if (price === null) throw new Error("Cannot construct a valid root-policy post-only quote.");
          outcome = submit(at, { side: selectedSide, price, decisionIndex: index }, index, selectedSide === wanted ? "preferred_side" : "risk_fallback_side") ? "submitted" : "gas_resource_hold";
        }
      }
    }
    decisionDetails.push({ decisionIndex: index, action: decision.action, selectedSide, outcome });
  };
  const processTrade = (trade: TradeEvent) => {
    if (boundary?.timestamp === trade.timestamp && (samePrice(boundary.old, trade) || samePrice(boundary.next, trade))) {
      counts.exactPriceSideMatches++; counts.applicationBoundaryBlockedEvents++; return;
    }
    if (!quote || !samePrice(quote, trade)) {
      if (pending && !pending.applied && pending.next && samePrice({ side: pending.next.side, priceWad: priceWad(pending.next.price) }, trade)) {
        counts.exactPriceSideMatches++; counts.activationLatencyBlockedEvents++;
      }
      return;
    }
    counts.exactPriceSideMatches++;
    if (trade.receiptBlock! <= quote.receiptBlockCeiling) { counts.receiptTimingBlockedEvents++; return; }
    const queueBefore = quote.queueAhead, consumed = Math.min(queueBefore, trade.size);
    quote.queueAhead -= consumed;
    const available = trade.size - consumed;
    if (available <= 0) { counts.queueOnlyTradeEvents++; return; }
    const bound = quote.side === "buy" ? Math.min(options.positionCapMon - inventory, cash / (quote.price * (1 + options.feeBps / 10_000))) : inventory;
    const size = Math.min(available, quote.remaining, Math.max(0, bound));
    if (size <= 0) { counts.riskBlockedTradeEvents++; return; }
    const notional = size * quote.price, fee = notional * options.feeBps / 10_000;
    cash += quote.side === "buy" ? -notional - fee : notional - fee;
    inventory += quote.side === "buy" ? size : -size; fees += fee; quote.remaining -= size;
    if (Math.abs(cash) < Number.EPSILON * Math.max(1, notional) * 4) cash = 0;
    if (!finite(cash) || !finite(inventory) || cash < 0 || inventory < 0) throw new Error("Replay violated cash or inventory bounds.");
    maxInventory = Math.max(maxInventory, inventory);
    fills.push({ quoteId: quote.id, decisionIndex: quote.decisionIndex, timestamp: trade.timestamp, activatedAt: quote.activeAt,
      activationSnapshotTimestamp: quote.activationSnapshotTimestamp, activationReceiptBlockCeiling: quote.receiptBlockCeiling,
      side: quote.side, price: quote.price, size, queueAheadBefore: queueBefore, queueConsumed: consumed, cashAfter: cash, inventoryAfter: inventory, trade });
    if (pending && !pending.applied && pending.target?.id === quote.id) counts.fillsWhileReplacementPending++;
    if (quote.side === "buy") counts.buyFills++; else counts.sellFills++;
    if (quote.remaining <= 0) quote = null;
  };
  let si = 0, ti = 0, di = 0;
  while (true) {
    const currentPending = pending as Pending | null;
    const transactionTime = currentPending && !executionStopped ? currentPending.applied ? currentPending.attempt.confirmsAt : currentPending.attempt.appliesAt : Infinity;
    const at = Math.min(snapshots[si]?.timestamp ?? Infinity, trades[ti]?.timestamp ?? Infinity, decisions[di]?.decidedAt ?? Infinity, transactionTime);
    if (!finite(at) || at > last.timestamp) break;
    if (snapshots[si]?.timestamp === at) observed = snapshots[si++]!;
    settle(at); checkLoss(at); settle(at);
    while (decisions[di]?.decidedAt === at) { processDecision(decisions[di]!, di++, at); settle(at); checkLoss(at); settle(at); }
    // One timestamp's trade batch is consumed before a later observable loop can react to it.
    // Avoid inventing an application boundary halfway through indistinguishable-time trades.
    while (trades[ti]?.timestamp === at) processTrade(trades[ti++]!);
  }
  const endingMid = mid(), net = cash + inventory * endingMid - initialEquity;
  counts.attempts = attempts.length; counts.applied = attempts.filter(a => a.outcome === "applied").length;
  counts.reverted = attempts.filter(a => a.outcome === "reverted").length; counts.unresolved = attempts.filter(a => a.outcome === "unresolved").length;
  counts.pendingAtEnd = attempts.filter(a => a.pendingAtEnd).length; counts.fills = fills.length;
  const endingQuote = quote as Quote | null;
  return { evidenceStatus: "RESEARCH_PROXY_ONLY", assumptions: { ...options }, decisions: decisions.length, decisionDetails,
    attempts, fillDetails: fills, counts, endingCashUsd: cash, endingMon: inventory, endingMidUsd: endingMid,
    endingRestingQuote: endingQuote ? { quoteId: endingQuote.id, side: endingQuote.side, price: endingQuote.price, remainingSize: endingQuote.remaining, queueAhead: endingQuote.queueAhead } : null,
    feesUsd: fees, gasCostsUsd: gas, grossPnlUsd: net + fees + gas, netPnlUsd: net,
    terminalMarkedLossBreached: net <= -options.maxLossUsd, maxInventoryMon: maxInventory, lossStop, executionStopped,
    rootLifecycleAgreement: "One placement, preferred-side risk fallback with existing same-side reserve, unconditional actionable repost, explicit hold cancellation, one pending transaction, atomic modeled application, receipt-delay holds and latched loss/execution stops follow the specified root lifecycle. This is a research proxy, not root equivalence.",
    remainingMismatches: [
      "Decisions are supplied evidence; complete root model input, permissions, provider readiness/costs, loss history and concurrent fault state are not independently reconstructed.",
      "Capture timestamps reveal only observed blocks; missing true block-feed callbacks and chain inclusion timing cannot be inferred. Modeled millisecond latency and receipt delay are assumptions.",
      "Receipt-verified input flags are required but this offline engine cannot independently establish RPC canonicality, true finality, source permissions or receipt-verifier correctness.",
      "Displayed aggregate depth is a FIFO queue proxy. Hidden liquidity, queue ownership, cancellations and actual maker priority cannot be established.",
      "Cash and inventory are bounded floating-point research balances; actual margin refresh, exact token units, USD gas conversion and deployment/signer checks are not reproduced.",
      "Gas is a conservative combined-USD-capital scenario, while root gas is separately paid in MON; USD gas must preserve the active buy reserve and does not establish root free-collateral parity.",
      "Same timestamps are processed as capture, scheduled application/confirmation, completed decision with zero-delay application, then trades. This declares a proxy tie convention, not proven intra-time ordering; affected exact-application-price events are censored. Trade-induced loss checks wait for a subsequent observable loop.",
      "An exhausted frozen cancellation target is unresolved conservatively; the source contract's terminal cancellation behavior remains unverified.",
    ] };
}
