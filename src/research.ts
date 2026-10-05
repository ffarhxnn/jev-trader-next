import type { DepthSnapshot, IgnoredTradeEvent, TradeEvent } from "./types";
import { hasL2CaptureGap } from "./capture";
export type { TradeEvent } from "./types";

export interface BacktestOptions {
  startingCash: number;
  startingMon: number;
  orderSizeMon: number;
  positionCapMon: number;
  /** Enforced Kuru base-token minimum; zero for generic historical fixtures without market metadata. */
  minimumOrderSizeMon?: number;
  feeBps: number;
  gasUsdPerUpdate: number;
  tickSize: number;
  baseHalfSpreadBps: number;
  volatilityMultiplier: number;
  quoteRefreshMs: number;
  /** Delay from submission to atomic old-order cancellation and replacement activation. */
  quoteActivationDelayMs?: number;
}

export const defaultBacktestOptions: BacktestOptions = {
  startingCash: 100,
  startingMon: 0,
  orderSizeMon: 10,
  positionCapMon: 100,
  minimumOrderSizeMon: 0,
  feeBps: 10,
  gasUsdPerUpdate: 0,
  tickSize: 0.000001,
  baseHalfSpreadBps: 8,
  volatilityMultiplier: 1.5,
  quoteRefreshMs: 10_000,
  quoteActivationDelayMs: 0,
};

export interface BacktestResult {
  assumptions: BacktestOptions & { fillRule: string; strategy: string; costsExcluded: string; replacementRule: string; activationQueueRule: string; executionScope: string };
  snapshots: number;
  firstTimestamp: number;
  lastTimestamp: number;
  fills: number;
  fillDetails: ReplayFillDetail[];
  buyFills: number;
  sellFills: number;
  ambiguousCrosses: number;
  /** Trades matching active or pending quote prices and opposing side; one count per public event. */
  exactPriceSideMatches: number;
  bidQuoteExactPriceMatches: number;
  askQuoteExactPriceMatches: number;
  /** Matching trades fully consumed by the displayed queue ahead of the hypothetical quote. */
  queueOnlyTradeEvents: number;
  /** Matching trades with volume beyond the queue but no simulated fill due to cash or position bounds. */
  riskBlockedTradeEvents: number;
  receiptTimingBlockedEvents: number;
  activationLatencyBlockedEvents: number;
  feesUsd: number;
  gasCostsUsd: number;
  gasBlockedUpdates: number;
  grossPnlUsd: number;
  netPnlUsd: number;
  endingCashUsd: number;
  endingMon: number;
  endingMidUsd: number;
  maxAbsInventoryMon: number;
  bidQuotesSuppressed: number;
  askQuotesSuppressed: number;
  quoteUpdates: number;
  quoteUpdatesApplied: number;
  quoteUpdatesReverted: number;
  pendingQuoteUpdateAtEnd: boolean;
  refreshesSkippedWhileUpdatePending: number;
  fillsWhileReplacementPending: number;
  replacementBoundaryBlockedEvents: number;
  midpointReplacementAmbiguities: number;
  evidenceStatus: "RESEARCH_PROXY_ONLY";
}

export interface ReplayFillDetail {
  timestamp: number;
  quoteTimestamp: number;
  side: "buy" | "sell";
  price: number;
  size: number;
  matchRule: "exact_price_trade_queue_proxy" | "midpoint_cross_through_proxy";
  queueAheadBefore?: number;
  queueConsumed?: number;
  trade?: TradeEvent;
}

export interface TradeCoverage { startTimestamp: number; endTimestamp: number }
export interface TradeTape { events: TradeEvent[]; coverage: TradeCoverage[]; ignored: IgnoredTradeEvent[] }
export interface TradeReplayWindow { window: TradeCoverage; snapshots: DepthSnapshot[] }
export type TradeReplayEvidenceStatus = "MIDPOINT_CROSS_THROUGH_PROXY" | "PUBLIC_TRADE_QUEUE_PROXY" | "NO_REPLAYABLE_TRADES_IN_SELECTED_WINDOW" | "NO_TRADE_EVENTS_IN_SELECTED_WINDOW";
interface RestingQuote { side: "buy" | "sell"; price: number; size: number; queueAhead: number; timestamp: number; activeAt: number; block: number }
interface PendingQuoteUpdate { appliesAt: number; bid: RestingQuote | null; ask: RestingQuote | null; keepBid: boolean; keepAsk: boolean }

/** Keep only exact-interval feed rows, plus the connection marker needed to preserve coverage. */
export function selectTradeFeedRowsForRange(contents: string, connection: TradeCoverage, selected: TradeCoverage): string[] {
  if (!Number.isFinite(connection.startTimestamp) || connection.endTimestamp <= connection.startTimestamp
    || !Number.isFinite(selected.startTimestamp) || !Number.isFinite(selected.endTimestamp) || selected.endTimestamp <= selected.startTimestamp) {
    throw new Error("Trade-feed connection and selected replay range must have valid increasing bounds.");
  }
  const rows: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("Invalid JSON while selecting trade-feed rows for the replay interval."); }
    if (!value || typeof value !== "object") throw new Error("Invalid trade-feed row while selecting the replay interval.");
    const row = value as Record<string, unknown>;
    const openingMarker = row.kind === "status" && row.status === "connected" && row.timestamp === connection.startTimestamp;
    if (openingMarker || typeof row.timestamp === "number" && row.timestamp >= selected.startTimestamp && row.timestamp < selected.endTimestamp) rows.push(line);
  }
  return rows;
}

export function tradeReplayEvidenceStatus(tradeTapeSelected: boolean, replayed: number, ignored: number): TradeReplayEvidenceStatus {
  if (!tradeTapeSelected) return "MIDPOINT_CROSS_THROUGH_PROXY";
  if (replayed > 0) return "PUBLIC_TRADE_QUEUE_PROXY";
  return ignored > 0 ? "NO_REPLAYABLE_TRADES_IN_SELECTED_WINDOW" : "NO_TRADE_EVENTS_IN_SELECTED_WINDOW";
}

/** Reject a receipt-required replay unless every selected event carries exact receipt provenance. */
export function assertReceiptVerifiedReplay(events: TradeEvent[], ignoredCount: number, expectedChainId: number | undefined, expectedMarket: string | undefined): void {
  if (!Number.isSafeInteger(ignoredCount) || ignoredCount < 0) throw new Error("Invalid ignored-trade count for receipt-required replay.");
  if (events.length === 0) throw new Error("Receipt-required replay has no usable trade events in the selected window.");
  if (!Number.isSafeInteger(expectedChainId) || !expectedMarket || !/^0x[\da-fA-F]{40}$/.test(expectedMarket)) throw new Error("Receipt-required replay needs verified chain and market metadata on its L2 capture.");
  const unverified = events.filter((event) => event.receiptVerified !== true
    || typeof event.transactionHash !== "string" || !/^0x[\da-fA-F]{64}$/.test(event.transactionHash)
    || !Number.isSafeInteger(event.receiptBlock) || Number(event.receiptBlock) < 0
    || !Number.isSafeInteger(event.receiptLogIndex) || Number(event.receiptLogIndex) < 0
    || event.receiptChainId !== expectedChainId || event.receiptMarket?.toLowerCase() !== expectedMarket.toLowerCase());
  if (unverified.length) throw new Error(`Receipt-required replay rejected ${unverified.length} trade event(s) without complete verified receipt provenance.`);
  if (ignoredCount > 0) throw new Error(`Receipt-required replay rejected ${ignoredCount} ignored feed event(s) that could not be reconciled.`);
}

export function selectTradeReplayWindow(
  coverage: TradeCoverage[],
  segments: DepthSnapshot[][],
  mode: "longest" | "latest" = "longest",
  minimumDurationMs = 0,
): TradeReplayWindow | null {
  if (!Number.isFinite(minimumDurationMs) || minimumDurationMs < 0) throw new Error("Minimum replay window duration must be finite and nonnegative.");
  const candidates = coverage.flatMap((window) => segments.map((segment) => {
    const snapshots = segment.filter((snapshot) => snapshot.timestamp >= window.startTimestamp && snapshot.timestamp < window.endTimestamp);
    if (snapshots.length < 2) return null;
    const startTimestamp = snapshots[0]!.timestamp;
    const endTimestamp = snapshots.at(-1)!.timestamp + 1;
    if (endTimestamp - startTimestamp < minimumDurationMs) return null;
    return {
      // Report the actual L2 interval replayed, not the larger feed-coverage
      // interval that may begin before a later L2 reconnect boundary.
      window: { startTimestamp, endTimestamp },
      snapshots,
    };
  })).filter((candidate): candidate is TradeReplayWindow => candidate !== null);
  candidates.sort((a, b) => mode === "latest"
    ? b.snapshots.at(-1)!.timestamp - a.snapshots.at(-1)!.timestamp || b.snapshots.length - a.snapshots.length
    : b.snapshots.length - a.snapshots.length || b.snapshots.at(-1)!.timestamp - a.snapshots.at(-1)!.timestamp);
  return candidates[0] ?? null;
}

/** Select one receipt-feed/L2 overlap inside explicit inclusive timestamp bounds. */
export function selectTradeReplayRange(
  coverage: TradeCoverage[],
  segments: DepthSnapshot[][],
  startTimestamp: number,
  endTimestamp: number,
  minimumDurationMs = 0,
): TradeReplayWindow | null {
  if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp) || endTimestamp <= startTimestamp) {
    throw new Error("Replay timestamp range must have finite bounds with end after start.");
  }
  if (!Number.isFinite(minimumDurationMs) || minimumDurationMs < 0) {
    throw new Error("Minimum replay window duration must be finite and nonnegative.");
  }
  const candidates = coverage.flatMap((window) => segments.map((segment) => {
    const snapshots = segment.filter((snapshot) => snapshot.timestamp >= startTimestamp && snapshot.timestamp <= endTimestamp
      && snapshot.timestamp >= window.startTimestamp && snapshot.timestamp < window.endTimestamp);
    if (snapshots.length < 2) return null;
    const actualStart = snapshots[0]!.timestamp;
    const actualEnd = snapshots.at(-1)!.timestamp + 1;
    if (actualEnd - actualStart < minimumDurationMs) return null;
    return { window: { startTimestamp: actualStart, endTimestamp: actualEnd }, snapshots };
  })).filter((candidate): candidate is TradeReplayWindow => candidate !== null);
  // An explicit interval that crosses capture or feed gaps is ambiguous; never silently select
  // just its latest fragment and label the result as the requested range.
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * Select a continuous L2 interval without requiring the auxiliary WebSocket trade tape to stay up.
 * The caller must reconstruct and receipt-verify chain Trade logs before running a trade replay.
 */
export function selectDepthReplayRange(
  snapshots: DepthSnapshot[],
  startTimestamp: number,
  endTimestamp: number,
  minimumDurationMs = 0,
): TradeReplayWindow | null {
  if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp) || endTimestamp <= startTimestamp) {
    throw new Error("Replay timestamp range must have finite bounds with end after start.");
  }
  if (!Number.isFinite(minimumDurationMs) || minimumDurationMs < 0) {
    throw new Error("Minimum replay window duration must be finite and nonnegative.");
  }
  const segments: DepthSnapshot[][] = [];
  let segment: DepthSnapshot[] = [];
  for (const snapshot of snapshots) {
    const previous = segment.at(-1);
    if (previous) {
      const expectedInterval = snapshot.captureIntervalMs ?? previous.captureIntervalMs ?? 1_000;
      const metadataChanged = snapshot.chainId !== previous.chainId
        || snapshot.market?.toLowerCase() !== previous.market?.toLowerCase()
        || snapshot.tickSize !== previous.tickSize
        || snapshot.sizePrecision !== previous.sizePrecision
        || snapshot.minSizeMon !== previous.minSizeMon
        || snapshot.makerFeeBps !== previous.makerFeeBps
        || snapshot.takerFeeBps !== previous.takerFeeBps;
      if (hasL2CaptureGap(previous.timestamp, snapshot.timestamp, expectedInterval)
        || snapshot.block < previous.block || snapshot.gapBefore || metadataChanged) {
        segments.push(segment);
        segment = [];
      }
    }
    segment.push(snapshot);
  }
  if (segment.length) segments.push(segment);

  const overlapping = segments.flatMap((rows) => {
    const selected = rows.filter((snapshot) => snapshot.timestamp >= startTimestamp && snapshot.timestamp <= endTimestamp);
    return selected.length ? [selected] : [];
  });
  // An explicit interval crossing even a short gap is ambiguous; never silently use one side.
  if (overlapping.length !== 1 || overlapping[0]!.length < 2) return null;
  const selected = overlapping[0]!;
  const actualStart = selected[0]!.timestamp;
  const actualEnd = selected.at(-1)!.timestamp + 1;
  if (actualEnd - actualStart < minimumDurationMs) return null;
  return { window: { startTimestamp: actualStart, endTimestamp: actualEnd }, snapshots: selected };
}

/** Preserve Kuru's raw 10^18 price / size integer tokens before JSON.parse rounds them to Number. */
export function parseKuruRawMessage(raw: string): unknown {
  const preserved = raw.replace(/("(?:p|s|ts|price|filledSize)"\s*:\s*)(-?\d+(?:[eE][+-]?\d+)?)(?=\s*[,}])/g, (_match, key: string, value: string) => `${key}"${value}"`);
  return JSON.parse(preserved);
}

/** Recognize Kuru's tagged frontend event and its SDK's untagged WssTradeEvent shape. */
export function isKuruTradeEvent(value: Record<string, unknown>): boolean {
  if (value.e === "Trade") return true;
  if (value.e !== undefined) return false;
  return value.price !== undefined && value.filledSize !== undefined
    && (value.orderId !== undefined || value.transactionHash !== undefined || value.transactionhash !== undefined);
}

export function normalizeKuruTrade(value: Record<string, unknown>, sizePrecision: number, timestamp: number): TradeEvent | null {
  if (!isKuruTradeEvent(value)) return null;
  // Without an aggressor side we cannot know which maker queue consumed this
  // trade. Skip it; retaining the full queue ahead is conservative for fills.
  // Kuru's public feed has used compact p/s/ib keys and the SDK's named
  // WssTradeEvent fields. `filledSize` is the executed size; `updatedSize` is
  // the maker order's remaining size and must not be substituted here.
  const priceValue = value.p ?? value.price;
  const sizeValue = value.s ?? value.filledSize;
  const isBuy = typeof value.ib === "boolean" ? value.ib : value.isBuy;
  if (priceValue === undefined || sizeValue === undefined || typeof isBuy !== "boolean") return null;
  if (!(sizePrecision > 0) || !Number.isFinite(timestamp)) throw new Error("Invalid Kuru market scale or receipt timestamp.");
  const rawInteger = (input: unknown) => {
    if (typeof input === "number" && !Number.isSafeInteger(input)) throw new Error("Kuru event integer exceeded safe JSON number precision.");
    if (typeof input !== "string" && typeof input !== "number" && typeof input !== "bigint") throw new Error("Kuru event integer is invalid.");
    return BigInt(String(input));
  };
  const rawPrice = rawInteger(priceValue);
  const rawSize = rawInteger(sizeValue);
  const price = Number(rawPrice) / 1e18;
  const size = Number(rawSize) / sizePrecision;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) throw new Error("Kuru trade has an invalid price or size.");
  const hashValue = value.th ?? value.transactionHash ?? value.transactionhash;
  const transactionHash = typeof hashValue === "string" && /^0x[\da-fA-F]{64}$/.test(hashValue) ? hashValue : undefined;
  const sourceTime = value.ts ?? value.triggerTime;
  const sourceTimestamp = typeof sourceTime === "string" || typeof sourceTime === "number" && Number.isFinite(sourceTime) ? String(sourceTime) : undefined;
  return { timestamp, price, size, takerSide: isBuy ? "buy" : "sell", rawPrice: rawPrice.toString(), rawSize: rawSize.toString(), ...(transactionHash ? { transactionHash } : {}), ...(sourceTimestamp ? { sourceTimestamp } : {}) };
}

/** Retain only public receipt provenance when a trade cannot safely affect the paper queue. */
export function normalizeIgnoredKuruTrade(value: Record<string, unknown>, timestamp: number): IgnoredTradeEvent | null {
  if (!isKuruTradeEvent(value)) return null;
  const rawInteger = (input: unknown) => {
    try {
      if (typeof input === "number" && !Number.isSafeInteger(input)) return undefined;
      if (typeof input !== "string" && typeof input !== "number" && typeof input !== "bigint") return undefined;
      const parsed = BigInt(String(input));
      return parsed >= 0n ? parsed.toString() : undefined;
    } catch { return undefined; }
  };
  const hashValue = value.th ?? value.transactionHash ?? value.transactionhash;
  const transactionHash = typeof hashValue === "string" && /^0x[\da-fA-F]{64}$/.test(hashValue) ? hashValue : undefined;
  const sourceTime = value.ts ?? value.triggerTime;
  const sourceTimestamp = typeof sourceTime === "string" || typeof sourceTime === "number" && Number.isFinite(sourceTime) ? String(sourceTime) : undefined;
  const rawPrice = rawInteger(value.p ?? value.price);
  const rawSize = rawInteger(value.s ?? value.filledSize);
  return { timestamp, reason: "trade lacks a reliable taker side or price/size",
    ...(transactionHash ? { transactionHash } : {}), ...(rawPrice !== undefined ? { rawPrice } : {}),
    ...(rawSize !== undefined ? { rawSize } : {}), ...(sourceTimestamp ? { sourceTimestamp } : {}) };
}

export function validateDepthSnapshot(value: unknown): value is DepthSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as DepthSnapshot;
  const validLevels = (levels: unknown) => Array.isArray(levels) && levels.length > 0 && levels.every((level) =>
    Array.isArray(level) && level.length >= 2 && Number.isFinite(level[0]) && level[0] > 0 && Number.isFinite(level[1]) && level[1] >= 0);
  return Number.isFinite(snapshot.timestamp) && Number.isFinite(snapshot.block)
    && (snapshot.chainId === undefined || Number.isSafeInteger(snapshot.chainId) && snapshot.chainId > 0)
    && (snapshot.tickSize === undefined || Number.isFinite(snapshot.tickSize) && snapshot.tickSize > 0)
    && (snapshot.sizePrecision === undefined || Number.isFinite(snapshot.sizePrecision) && snapshot.sizePrecision > 0)
    && (snapshot.minSizeMon === undefined || Number.isFinite(snapshot.minSizeMon) && snapshot.minSizeMon > 0)
    && (snapshot.captureIntervalMs === undefined || Number.isFinite(snapshot.captureIntervalMs) && snapshot.captureIntervalMs > 0)
    && (snapshot.rpcEndpointIndex === undefined || Number.isSafeInteger(snapshot.rpcEndpointIndex) && snapshot.rpcEndpointIndex >= 0)
    && (snapshot.gapBefore === undefined || typeof snapshot.gapBefore === "boolean")
    && (snapshot.makerFeeBps === undefined || Number.isFinite(snapshot.makerFeeBps) && snapshot.makerFeeBps >= 0)
    && validLevels(snapshot.bids) && validLevels(snapshot.asks)
    && snapshot.bids[0]![0] < snapshot.asks[0]![0];
}

function midOf(snapshot: DepthSnapshot) { return (snapshot.bids[0]![0] + snapshot.asks[0]![0]) / 2; }
function floorTick(price: number, tick: number) { return Number((Math.floor(price / tick + 1e-9) * tick).toFixed(10)); }
function ceilTick(price: number, tick: number) { return Number((Math.ceil(price / tick - 1e-9) * tick).toFixed(10)); }

function rollingVolatilityBps(points: { timestamp: number; mid: number }[], lookback = 20) {
  if (points.length < 4) return 0;
  const selected = points.slice(-(lookback + 1));
  const returns = selected.slice(1).map((point, i) => {
    const seconds = Math.max((point.timestamp - selected[i]!.timestamp) / 1_000, 0.001);
    return (point.mid - selected[i]!.mid) / selected[i]!.mid * 10_000 / Math.sqrt(seconds);
  });
  const mean = returns.reduce((sum, x) => sum + x, 0) / returns.length;
  return Math.sqrt(returns.reduce((sum, x) => sum + (x - mean) ** 2, 0) / returns.length);
}

/**
 * Replay an inventory-skewed, volatility-aware two-sided quote strategy.
 * With a trade tape, exact-price opposing trades consume one active displayed
 * queue proxy. Otherwise midpoint cross-through is the fill proxy. Pending
 * updates freeze replacement intentions until atomic cancellation/activation.
 * Public observations cannot establish live priority or actual maker execution.
 */
export function replayDepth(snapshots: DepthSnapshot[], options: BacktestOptions = defaultBacktestOptions, trades?: TradeEvent[]): BacktestResult {
  const quoteActivationDelayMs = options.quoteActivationDelayMs ?? 0;
  const minimumOrderSizeMon = options.minimumOrderSizeMon ?? 0;
  if (snapshots.length < 2) throw new Error("At least two valid L2 snapshots are required.");
  if (!Object.values(options).every((value) => value === undefined || typeof value === "number" && Number.isFinite(value))
    || !(options.startingCash >= 0 && options.startingMon >= 0 && options.orderSizeMon > 0 && options.positionCapMon >= options.orderSizeMon
    && Number.isFinite(minimumOrderSizeMon) && minimumOrderSizeMon >= 0 && options.orderSizeMon >= minimumOrderSizeMon
    && options.startingMon <= options.positionCapMon && options.feeBps >= 0 && options.gasUsdPerUpdate >= 0 && options.tickSize > 0 && options.baseHalfSpreadBps >= 0 && options.volatilityMultiplier >= 0 && options.quoteRefreshMs >= 1_000 && Number.isFinite(quoteActivationDelayMs) && quoteActivationDelayMs >= 0)) {
    throw new Error("Invalid backtest assumptions.");
  }
  for (let i = 0; i < snapshots.length; i++) {
    if (!validateDepthSnapshot(snapshots[i])) throw new Error(`Invalid or crossed L2 snapshot at row ${i + 1}.`);
    if (i > 0 && snapshots[i]!.timestamp <= snapshots[i - 1]!.timestamp) throw new Error(`Snapshot timestamps must increase (row ${i + 1}).`);
    if (i > 0 && snapshots[i]!.block < snapshots[i - 1]!.block) throw new Error(`Snapshot blocks must not move backwards (row ${i + 1}).`);
  }
  if (trades) {
    for (let i = 0; i < trades.length; i++) {
      const event = trades[i]!;
      if (!Number.isFinite(event.timestamp) || !(event.price > 0) || !(event.size > 0) || !["buy", "sell"].includes(event.takerSide)) throw new Error(`Invalid trade event at row ${i + 1}.`);
      if (i > 0 && event.timestamp < trades[i - 1]!.timestamp) throw new Error(`Trade timestamps must not move backwards (row ${i + 1}).`);
    }
  }

  let cash = options.startingCash;
  let inventory = options.startingMon;
  const initialMid = midOf(snapshots[0]!);
  const initialEquity = cash + inventory * initialMid;
  let fees = 0, gasCosts = 0, gasBlockedUpdates = 0, fills = 0, buyFills = 0, sellFills = 0, ambiguousCrosses = 0, exactPriceSideMatches = 0, bidQuoteExactPriceMatches = 0, askQuoteExactPriceMatches = 0, queueOnlyTradeEvents = 0, riskBlockedTradeEvents = 0, receiptTimingBlockedEvents = 0, activationLatencyBlockedEvents = 0, bidQuotesSuppressed = 0, askQuotesSuppressed = 0, quoteUpdates = 0, maxAbsInventory = Math.abs(inventory);
  const fillDetails: ReplayFillDetail[] = [];
  const activeQuotes: { bid: RestingQuote | null; ask: RestingQuote | null } = { bid: null, ask: null };
  let pendingUpdate: PendingQuoteUpdate | null = null;
  let quoteUpdatesApplied = 0, quoteUpdatesReverted = 0, refreshesSkippedWhileUpdatePending = 0;
  let fillsWhileReplacementPending = 0, replacementBoundaryBlockedEvents = 0, midpointReplacementAmbiguities = 0;
  let observedBook = snapshots[0]!;
  const mids: { timestamp: number; mid: number }[] = [];
  let tradeIndex = 0;
  let lastQuoteCheckAt = -Infinity;

  const fill = (quote: RestingQuote, amount: number, context: { timestamp: number; matchRule: ReplayFillDetail["matchRule"]; queueAheadBefore?: number; queueConsumed?: number; trade?: TradeEvent; } ) => {
    const record = (size: number) => {
      if (size <= 0) return;
      maxAbsInventory = Math.max(maxAbsInventory, Math.abs(inventory));
      if (pendingUpdate && context.timestamp < pendingUpdate.appliesAt
        && !(quote.side === "buy" ? pendingUpdate.keepBid : pendingUpdate.keepAsk)) fillsWhileReplacementPending++;
      fillDetails.push({ timestamp: context.timestamp, quoteTimestamp: quote.timestamp, side: quote.side, price: quote.price, size, matchRule: context.matchRule,
        ...(context.queueAheadBefore !== undefined ? { queueAheadBefore: context.queueAheadBefore } : {}),
        ...(context.queueConsumed !== undefined ? { queueConsumed: context.queueConsumed } : {}),
        ...(context.trade ? { trade: context.trade } : {}) });
    };
    if (quote.side === "buy") {
      const affordable = cash / (quote.price * (1 + options.feeBps / 10_000));
      const capped = options.positionCapMon - inventory;
      const size = Math.min(amount, affordable, capped);
      if (size <= 0) return 0;
      const spent = quote.price * size;
      const charged = spent * options.feeBps / 10_000;
      cash -= spent + charged; fees += charged; inventory += size; fills++; buyFills++;
      record(size);
      return size;
    }
    const size = Math.min(amount, inventory);
    if (size <= 0) return 0;
    const received = quote.price * size;
    const charged = received * options.feeBps / 10_000;
    cash += received - charged; fees += charged; inventory -= size; fills++; sellFills++;
    record(size);
    return size;
  };

  const quoteCost = (quote: RestingQuote | null) => quote ? quote.price * quote.size * (1 + options.feeBps / 10_000) : 0;
  const priceMatches = (quote: RestingQuote | null, event: TradeEvent) => !!quote && quote.size > 1e-9
    && event.takerSide !== quote.side && Math.abs(event.price - quote.price) <= options.tickSize * 0.51;
  const countExactMatch = (side: "buy" | "sell") => {
    exactPriceSideMatches++;
    if (side === "buy") bidQuoteExactPriceMatches++;
    else askQuoteExactPriceMatches++;
  };
  const receiptBlockCeiling = (appliesAt: number) => {
    // Future capture metadata only EXCLUDES uncertain fills; price and queue
    // initialization must never use observations after scheduled application.
    let left = 0, right = snapshots.length - 1;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (snapshots[middle]!.timestamp < appliesAt) left = middle + 1;
      else right = middle;
    }
    return snapshots[left]!.block;
  };
  const applyPendingUpdate = (book: DepthSnapshot): { changedBid: boolean; changedAsk: boolean } => {
    const update = pendingUpdate!;
    if (book.timestamp > update.appliesAt) throw new Error("Replay cannot use future depth to apply a quote update.");
    const nextBid = update.keepBid ? activeQuotes.bid : update.bid;
    const nextAsk = update.keepAsk ? activeQuotes.ask : update.ask;
    // Frozen calldata must still be fundable after old orders fill. Both legs are
    // checked against existing resources; proceeds from a future opposing fill
    // cannot fund placement. An invalid leg reverts the whole atomic update.
    const invalidBid = nextBid && (cash + 1e-9 < quoteCost(nextBid) || inventory + nextBid.size > options.positionCapMon + 1e-9
      || !update.keepBid && nextBid.price >= book.asks[0]![0]);
    const invalidAsk = nextAsk && (inventory + 1e-9 < nextAsk.size || !update.keepAsk && nextAsk.price <= book.bids[0]![0]);
    pendingUpdate = null;
    if (invalidBid || invalidAsk) {
      quoteUpdatesReverted++;
      return { changedBid: false, changedAsk: false };
    }
    const activate = (quote: RestingQuote | null, keep: boolean) => {
      if (!quote || keep) return quote;
      const levels = quote.side === "buy" ? book.bids : book.asks;
      return { ...quote, activeAt: update.appliesAt, block: receiptBlockCeiling(update.appliesAt),
        queueAhead: levels.find(([price]) => Math.abs(price - quote.price) <= options.tickSize * 0.5)?.[1] ?? 0 };
    };
    activeQuotes.bid = activate(nextBid, update.keepBid);
    activeQuotes.ask = activate(nextAsk, update.keepAsk);
    quoteUpdatesApplied++;
    return { changedBid: !update.keepBid, changedAsk: !update.keepAsk };
  };

  for (const snapshot of snapshots) {
    const mid = midOf(snapshot);
    // Resolve prior quotes before replacing them. Both-side penetration in one
    // observation has unknown event order, so this replay declines both fills.
    if (trades) {
      while (tradeIndex < trades.length && trades[tradeIndex]!.timestamp <= snapshot.timestamp) {
        const event = trades[tradeIndex++]!;
        if (pendingUpdate && pendingUpdate.appliesAt < event.timestamp) applyPendingUpdate(observedBook);
        const side = event.takerSide === "sell" ? "buy" : "sell";
        const quote = side === "buy" ? activeQuotes.bid : activeQuotes.ask;
        const pendingQuote = pendingUpdate ? side === "buy" ? pendingUpdate.bid : pendingUpdate.ask : null;
        const affected = pendingUpdate && !(side === "buy" ? pendingUpdate.keepBid : pendingUpdate.keepAsk);
        const activeMatches = priceMatches(quote, event) && event.timestamp > quote!.timestamp;
        const pendingMatches = affected && priceMatches(pendingQuote, event) && event.timestamp > pendingQuote!.timestamp;
        // Same-time public trades have no known order relative to the hypothetical
        // batch. Censor affected old AND replacement prices without changing queue.
        if (pendingUpdate && event.timestamp === pendingUpdate.appliesAt && affected && (activeMatches || pendingMatches)) {
          countExactMatch(side);
          replacementBoundaryBlockedEvents++;
          continue;
        }
        if (!activeMatches) {
          if (pendingMatches) { countExactMatch(side); activationLatencyBlockedEvents++; }
          continue;
        }
        if (quote) {
          countExactMatch(side);
          // Receipt-confirmed trades from the quote's block may have executed
          // before the hypothetical quote existed; their within-block order is unknown.
          if (event.receiptVerified && (!Number.isSafeInteger(event.receiptBlock) || Number(event.receiptBlock) <= quote.block)) {
            receiptTimingBlockedEvents++;
            continue;
          }
          const queueAheadBefore = quote.queueAhead;
          const queueConsumption = Math.min(queueAheadBefore, event.size);
          quote.queueAhead -= queueConsumption;
          const available = event.size - queueConsumption;
          if (available <= 0) { queueOnlyTradeEvents++; continue; }
          const executed = fill(quote, Math.min(quote.size, available), { timestamp: event.timestamp, matchRule: "exact_price_trade_queue_proxy", queueAheadBefore, queueConsumed: queueConsumption, trade: event });
          if (executed <= 0) riskBlockedTradeEvents++;
          quote.size -= executed;
          if (quote.size <= 1e-9) {
            if (quote.side === "buy") activeQuotes.bid = null;
            else activeQuotes.ask = null;
          }
        }
      }
    }
    // At an exact snapshot boundary that snapshot is eligible; between snapshots
    // only the last earlier observation is available to the hypothetical update.
    let changedAtThisObservation = { changedBid: false, changedAsk: false };
    if (pendingUpdate && pendingUpdate.appliesAt <= snapshot.timestamp) {
      const applyBook = snapshot.timestamp === pendingUpdate.appliesAt ? snapshot : observedBook;
      changedAtThisObservation = applyPendingUpdate(applyBook);
    }
    if (!trades) {
      const bidWouldCross = !!activeQuotes.bid && snapshot.timestamp > activeQuotes.bid.timestamp && mid <= activeQuotes.bid.price - options.tickSize;
      const askWouldCross = !!activeQuotes.ask && snapshot.timestamp > activeQuotes.ask.timestamp && mid >= activeQuotes.ask.price + options.tickSize;
      if (changedAtThisObservation.changedBid && bidWouldCross || changedAtThisObservation.changedAsk && askWouldCross) midpointReplacementAmbiguities++;
      const bidCrossed = bidWouldCross && !changedAtThisObservation.changedBid;
      const askCrossed = askWouldCross && !changedAtThisObservation.changedAsk;
      if (bidCrossed && askCrossed) {
        ambiguousCrosses++;
      } else if (bidCrossed && activeQuotes.bid) {
        fill(activeQuotes.bid, activeQuotes.bid.size, { timestamp: snapshot.timestamp, matchRule: "midpoint_cross_through_proxy" }); activeQuotes.bid = null;
      } else if (askCrossed && activeQuotes.ask) {
        fill(activeQuotes.ask, activeQuotes.ask.size, { timestamp: snapshot.timestamp, matchRule: "midpoint_cross_through_proxy" }); activeQuotes.ask = null;
      }
    }
    maxAbsInventory = Math.max(maxAbsInventory, Math.abs(inventory));
    mids.push({ timestamp: snapshot.timestamp, mid });
    observedBook = snapshot;

    if (snapshot.timestamp - lastQuoteCheckAt < options.quoteRefreshMs) continue;
    lastQuoteCheckAt = snapshot.timestamp;
    if (pendingUpdate) { refreshesSkippedWhileUpdatePending++; continue; }

    const projectedVolBps = rollingVolatilityBps(mids) * Math.sqrt(options.quoteRefreshMs / 1_000);
    const spreadHalf = Math.max(options.baseHalfSpreadBps, options.feeBps, projectedVolBps * options.volatilityMultiplier);
    const inventoryFraction = inventory / options.positionCapMon;
    const reservationMid = mid * (1 - inventoryFraction * spreadHalf / 10_000);
    const targetBid = floorTick(reservationMid * (1 - spreadHalf / 10_000), options.tickSize);
    const targetAsk = ceilTick(reservationMid * (1 + spreadHalf / 10_000), options.tickSize);
    const bestBid = snapshot.bids[0]![0], bestAsk = snapshot.asks[0]![0];
    const bidPrice = Math.min(targetBid, floorTick(bestBid, options.tickSize));
    const askPrice = Math.max(targetAsk, ceilTick(bestAsk, options.tickSize));
    const bidQueue = snapshot.bids.find(([price]) => Math.abs(price - bidPrice) <= options.tickSize * 0.5)?.[1] ?? 0;
    const askQueue = snapshot.asks.find(([price]) => Math.abs(price - askPrice) <= options.tickSize * 0.5)?.[1] ?? 0;
    let bidAllowed: RestingQuote | null = inventory + options.orderSizeMon <= options.positionCapMon && cash >= bidPrice * options.orderSizeMon * (1 + options.feeBps / 10_000)
      && bidPrice > 0 && bidPrice < bestAsk ? { side: "buy", price: bidPrice, size: options.orderSizeMon, queueAhead: bidQueue, timestamp: snapshot.timestamp, activeAt: snapshot.timestamp + quoteActivationDelayMs, block: snapshot.block } : null;
    let askAllowed: RestingQuote | null = inventory >= options.orderSizeMon && askPrice > bestBid
      ? { side: "sell", price: askPrice, size: options.orderSizeMon, queueAhead: askQueue, timestamp: snapshot.timestamp, activeAt: snapshot.timestamp + quoteActivationDelayMs, block: snapshot.block } : null;
    const unchanged = (old: RestingQuote | null, next: RestingQuote | null) => !!old && !!next && old.side === next.side && old.price === next.price && old.size === next.size;
    let nextBid: RestingQuote | null = unchanged(activeQuotes.bid, bidAllowed) ? activeQuotes.bid : bidAllowed;
    let nextAsk: RestingQuote | null = unchanged(activeQuotes.ask, askAllowed) ? activeQuotes.ask : askAllowed;
    if (nextBid !== activeQuotes.bid || nextAsk !== activeQuotes.ask) {
      // Delayed cancellations cannot spend collateral still backing the old bid.
      const retainedBidReserve = quoteActivationDelayMs > 0 ? quoteCost(activeQuotes.bid) : 0;
      if (cash + 1e-9 < options.gasUsdPerUpdate + retainedBidReserve) {
        gasBlockedUpdates++;
        nextBid = activeQuotes.bid;
        nextAsk = activeQuotes.ask;
      } else {
        const cashAfterGas = cash - options.gasUsdPerUpdate;
        if (nextBid && cashAfterGas < nextBid.price * nextBid.size * (1 + options.feeBps / 10_000)) nextBid = null;
        if (nextBid !== activeQuotes.bid || nextAsk !== activeQuotes.ask) {
          cash = cashAfterGas;
          gasCosts += options.gasUsdPerUpdate;
          quoteUpdates++;
          pendingUpdate = { appliesAt: snapshot.timestamp + quoteActivationDelayMs,
            bid: nextBid, ask: nextAsk, keepBid: nextBid === activeQuotes.bid, keepAsk: nextAsk === activeQuotes.ask };
          if (quoteActivationDelayMs === 0) applyPendingUpdate(snapshot);
        }
      }
    }
    if (!nextBid) bidQuotesSuppressed++;
    if (!nextAsk) askQuotesSuppressed++;
  }

  const endingMid = midOf(snapshots.at(-1)!);
  const endingEquity = cash + inventory * endingMid;
  const netPnl = endingEquity - initialEquity;
  const grossPnl = netPnl + fees + gasCosts;
  return {
    assumptions: { ...options, quoteActivationDelayMs,
      fillRule: trades ? "observed Kuru trade at exact active quote price consumes displayed queue-ahead volume once; ambiguous-side trades are ignored; receipt-verified trades from the first captured block at/after modeled activation or earlier are excluded because within-block order is unknown; this capture-block ceiling is not a proven inclusion block; queue cancellations/hidden state are not modeled"
        : "midpoint penetrates an active quote by at least one tick; full-size fills; queue and event order are unknown; changed quotes are censored in an observation spanning atomic application",
      strategy: "inventory-skewed two-sided quotes with volatility-adjusted half-spread",
      replacementRule: "one frozen pending atomic update at a time; changed old quotes remain executable until submission plus latency, then cancel and replacement activation occur together; unchanged quotes retain priority; exact-time boundary trades touching changed old/new prices are censored; insufficient resources or a crossing replacement reverts the whole update, preserves old survivors, and retains the attempted-update cost; gas cannot spend collateral backing a delayed old bid",
      activationQueueRule: "changed quotes join behind displayed depth in the latest L2 observation at/before scheduled application; this potentially stale depth is a queue proxy, not an observed transaction-time queue",
      executionScope: "hypothetical two-sided atomic quote-update replay; fully filled old targets are treated as no-op cancellations as an explicit replay assumption; deployment-specific cancellation permissions and event compatibility remain unverified; root execution submits one placement per batch and is not reproduced by this strategy",
      costsExcluded: "rebates, slippage, and margin or borrow costs; gas is a fixed USD scenario cost per submitted update, including reverted attempts and updates still pending at the end; no post-window liquidation or cancellation cost" },
    snapshots: snapshots.length, firstTimestamp: snapshots[0]!.timestamp, lastTimestamp: snapshots.at(-1)!.timestamp,
    fills, fillDetails, buyFills, sellFills, ambiguousCrosses, exactPriceSideMatches, bidQuoteExactPriceMatches, askQuoteExactPriceMatches, queueOnlyTradeEvents, riskBlockedTradeEvents, receiptTimingBlockedEvents, activationLatencyBlockedEvents, feesUsd: fees, gasCostsUsd: gasCosts, gasBlockedUpdates, grossPnlUsd: grossPnl, netPnlUsd: netPnl,
    endingCashUsd: cash, endingMon: inventory, endingMidUsd: endingMid, maxAbsInventoryMon: maxAbsInventory,
    bidQuotesSuppressed, askQuotesSuppressed, quoteUpdates, quoteUpdatesApplied, quoteUpdatesReverted,
    pendingQuoteUpdateAtEnd: pendingUpdate !== null, refreshesSkippedWhileUpdatePending, fillsWhileReplacementPending,
    replacementBoundaryBlockedEvents, midpointReplacementAmbiguities, evidenceStatus: "RESEARCH_PROXY_ONLY",
  };
}

export function parseDepthJsonl(contents: string): DepthSnapshot[] {
  const snapshots: DepthSnapshot[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid JSON on line ${index + 1}.`); }
    if (!validateDepthSnapshot(value)) throw new Error(`Invalid L2 snapshot on line ${index + 1}.`);
    snapshots.push(value);
  }
  return snapshots;
}

export function parseTradeJsonl(contents: string): TradeTape {
  const events: TradeEvent[] = [];
  const coverage: TradeCoverage[] = [];
  const ignored: IgnoredTradeEvent[] = [];
  let open: number | null = null;
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid trade JSON on line ${index + 1}.`); }
    if (!value || typeof value !== "object") throw new Error(`Invalid trade record on line ${index + 1}.`);
    const record = value as Record<string, unknown>;
    if (record.kind === "status" && record.status === "connected" && Number.isFinite(record.timestamp)) {
      if (open !== null) coverage.push({ startTimestamp: open, endTimestamp: Number(record.timestamp) });
      open = Number(record.timestamp);
    } else if (record.kind === "gap" && Number.isFinite(record.timestamp)) {
      if (open !== null) coverage.push({ startTimestamp: open, endTimestamp: Number(record.timestamp) });
      open = null;
    } else if (record.kind === "trade" && Number.isFinite(record.timestamp) && Number.isFinite(record.price) && Number.isFinite(record.size)
      && (record.takerSide === "buy" || record.takerSide === "sell")) {
      if (record.transactionHash !== undefined && (typeof record.transactionHash !== "string" || !/^0x[\da-fA-F]{64}$/.test(record.transactionHash))) throw new Error(`Invalid transaction hash on trade line ${index + 1}.`);
      if (record.sourceTimestamp !== undefined && typeof record.sourceTimestamp !== "string") throw new Error(`Invalid source timestamp on trade line ${index + 1}.`);
      if (record.rawPrice !== undefined && (typeof record.rawPrice !== "string" || !/^\d+$/.test(record.rawPrice)) || record.rawSize !== undefined && (typeof record.rawSize !== "string" || !/^\d+$/.test(record.rawSize))) throw new Error(`Invalid raw trade values on line ${index + 1}.`);
      if (record.receiptVerified !== undefined && record.receiptVerified !== true || record.receiptBlock !== undefined && (!Number.isSafeInteger(record.receiptBlock) || Number(record.receiptBlock) < 0) || record.receiptLogIndex !== undefined && (!Number.isSafeInteger(record.receiptLogIndex) || Number(record.receiptLogIndex) < 0)) throw new Error(`Invalid receipt provenance on trade line ${index + 1}.`);
      if (record.receiptChainId !== undefined && (!Number.isSafeInteger(record.receiptChainId) || Number(record.receiptChainId) < 1) || record.receiptMarket !== undefined && (typeof record.receiptMarket !== "string" || !/^0x[\da-fA-F]{40}$/.test(record.receiptMarket))) throw new Error(`Invalid receipt chain or market on trade line ${index + 1}.`);
      if (record.receiptVerified === true && (typeof record.transactionHash !== "string" || !Number.isSafeInteger(record.receiptBlock) || !Number.isSafeInteger(record.receiptLogIndex) || !Number.isSafeInteger(record.receiptChainId) || typeof record.receiptMarket !== "string")) throw new Error(`Incomplete verified receipt provenance on trade line ${index + 1}.`);
      events.push({ timestamp: Number(record.timestamp), price: Number(record.price), size: Number(record.size), takerSide: record.takerSide,
        ...(typeof record.transactionHash === "string" ? { transactionHash: record.transactionHash } : {}),
        ...(typeof record.sourceTimestamp === "string" ? { sourceTimestamp: record.sourceTimestamp } : {}),
        ...(typeof record.rawPrice === "string" && /^\d+$/.test(record.rawPrice) ? { rawPrice: record.rawPrice } : {}),
        ...(typeof record.rawSize === "string" && /^\d+$/.test(record.rawSize) ? { rawSize: record.rawSize } : {}),
        ...(record.receiptVerified === true ? { receiptVerified: true } : {}),
        ...(record.receiptFinalizedVerified === true ? { receiptFinalizedVerified: true } : {}),
        ...(typeof record.receiptBlock === "number" ? { receiptBlock: record.receiptBlock } : {}),
        ...(typeof record.receiptLogIndex === "number" ? { receiptLogIndex: record.receiptLogIndex } : {}),
        ...(typeof record.receiptChainId === "number" ? { receiptChainId: record.receiptChainId } : {}),
        ...(typeof record.receiptMarket === "string" ? { receiptMarket: record.receiptMarket } : {}) });
    } else if (record.kind === "ignored" && Number.isFinite(record.timestamp) && typeof record.reason === "string") {
      if (record.transactionHash !== undefined && (typeof record.transactionHash !== "string" || !/^0x[\da-fA-F]{64}$/.test(record.transactionHash))) throw new Error(`Invalid transaction hash on ignored trade line ${index + 1}.`);
      if (record.sourceTimestamp !== undefined && typeof record.sourceTimestamp !== "string") throw new Error(`Invalid source timestamp on ignored trade line ${index + 1}.`);
      if (record.rawPrice !== undefined && (typeof record.rawPrice !== "string" || !/^\d+$/.test(record.rawPrice)) || record.rawSize !== undefined && (typeof record.rawSize !== "string" || !/^\d+$/.test(record.rawSize))) throw new Error(`Invalid raw values on ignored trade line ${index + 1}.`);
      ignored.push({ timestamp: Number(record.timestamp), reason: record.reason,
        ...(typeof record.transactionHash === "string" ? { transactionHash: record.transactionHash } : {}),
        ...(typeof record.sourceTimestamp === "string" ? { sourceTimestamp: record.sourceTimestamp } : {}),
        ...(typeof record.rawPrice === "string" ? { rawPrice: record.rawPrice } : {}),
        ...(typeof record.rawSize === "string" ? { rawSize: record.rawSize } : {}) });
    } else {
      throw new Error(`Invalid trade record on line ${index + 1}.`);
    }
  }
  if (open !== null) coverage.push({ startTimestamp: open, endTimestamp: Number.POSITIVE_INFINITY });
  for (let i = 1; i < events.length; i++) if (events[i]!.timestamp < events[i - 1]!.timestamp) throw new Error(`Trade timestamps move backwards at row ${i + 1}.`);
  return { events, coverage, ignored };
}
