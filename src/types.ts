export type Side = "buy" | "sell";
export type Action = Side | "hold";

export interface Book {
  block: number;
  chainId?: number;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  tickSize?: number;
  makerFeeBps?: number;
  market?: string;
  sizePrecision?: number;
  minSizeMon?: number;
  takerFeeBps?: number;
  captureIntervalMs?: number;
  /** Local receipt time for this book observation; not a chain timestamp. */
  receivedAt?: number;
  source: "Monad Kuru" | "synthetic demo";
  bids?: [price: number, size: number][];
  asks?: [price: number, size: number][];
}

/** Public Kuru L2 snapshot captured for offline research; contains no account data. */
export interface DepthSnapshot {
  timestamp: number;
  block: number;
  chainId?: number;
  market?: string;
  tickSize?: number;
  sizePrecision?: number;
  /** Minimum executable base-token order size recorded from Kuru market parameters. */
  minSizeMon?: number;
  makerFeeBps?: number;
  takerFeeBps?: number;
  captureIntervalMs?: number;
  /** Index in the configured read-only RPC endpoint list; URLs are intentionally not persisted. */
  rpcEndpointIndex?: number;
  gapBefore?: boolean;
  bids: [price: number, size: number][];
  asks: [price: number, size: number][];
}

export interface TradeEvent {
  timestamp: number;
  price: number;
  size: number;
  takerSide: "buy" | "sell";
  /** Public transaction identifier, when supplied by Kuru's frontend stream. */
  transactionHash?: string;
  /** Raw source timestamp as sent by Kuru; units/semantics are not assumed. */
  sourceTimestamp?: string;
  /** Exact public feed integer tokens, retained for receipt-event reconciliation. */
  rawPrice?: string;
  rawSize?: string;
  /** Receipt-derived fields; present only in offline receipt-enriched tapes. */
  receiptVerified?: boolean;
  /** New reconstruction verified exact canonical transaction-index inclusion under a finalized header. */
  receiptFinalizedVerified?: boolean;
  receiptBlock?: number;
  receiptLogIndex?: number;
  receiptChainId?: number;
  receiptMarket?: string;
}

/** Minimal public provenance retained for a Trade feed record that cannot safely affect the paper queue. */
export interface IgnoredTradeEvent {
  timestamp: number;
  reason: string;
  transactionHash?: string;
  rawPrice?: string;
  rawSize?: string;
  sourceTimestamp?: string;
}

export interface Decision {
  action: Action;
  buy: number;
  sell: number;
  latencyMs: number;
  model: string;
  source: "OpenCode Zen free Jev" | "OpenCode Zen paid Jev" | "OpenCode Go API" | "Google Gemini API" | "local demo heuristic";
  reason?: string;
}

export interface PaperQuote {
  quoteId: string;
  side: Side;
  price: number;
  size: number;
  queueAhead?: number;
  placedAt?: number;
  block: number;
  status: "resting" | "filled" | "cancelled" | "rejected";
  note: string;
}

export interface Fill {
  quoteId: string;
  side: Side;
  price: number;
  size: number;
  block: number;
  ts: number;
  source: string;
  tradeTransactionHash?: string;
  tradeSourceTimestamp?: string;
}

export type PaperLifecycleEvent =
  | { kind: "quote_resting"; timestamp: number; block: number; quote: PaperQuote; positionMon: number; cashUsd: number }
  | { kind: "quote_cancelled"; timestamp: number; block: number; quoteId: string; side: Side; price: number; remainingSize: number; reason: string }
  | { kind: "fill"; timestamp: number; fill: Fill; remainingSize: number; positionMon: number; cashUsd: number; equityUsd: number; feesUsd: number };

export interface Snapshot {
  status: "connecting" | "live" | "degraded" | "stopped";
  mode: "paper" | "demo";
  paperFeeBps: number | null;
  model: string;
  modelStatus: "ready" | "waiting" | "failed";
  nextRetryAt: number | null;
  block: number;
  ts: number;
  book: Book | null;
  decision: Decision | null;
  quote: PaperQuote | null;
  position: { mon: number; cash: number; equity: number; unrealized: number };
  totals: { blocks: number; decisions: number; quotes: number; fills: number; feesUsd: number; realizedUsd: number; pnlUsd: number; late: number; tradeEvents: number; ignoredTradeEvents: number; lastTradeAt: number | null };
  chart: { ts: number; price: number }[];
  tape: Fill[];
  notice: string;
}
