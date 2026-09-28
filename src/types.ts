export type Side = "buy" | "sell";
export type Action = Side | "hold";

export interface Book {
  block: number;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  source: "Monad Kuru" | "synthetic demo";
}

export interface Decision {
  action: Action;
  buy: number;
  sell: number;
  latencyMs: number;
  model: string;
  source: "OpenCode Zen free Jev" | "local demo heuristic";
  reason?: string;
}

export interface PaperQuote {
  side: Side;
  price: number;
  size: number;
  block: number;
  status: "resting" | "filled" | "cancelled" | "rejected";
  note: string;
}

export interface Fill {
  side: Side;
  price: number;
  size: number;
  block: number;
  source: string;
}

export interface Snapshot {
  status: "connecting" | "live" | "degraded" | "stopped";
  mode: "paper" | "demo";
  model: string;
  modelStatus: "ready" | "waiting" | "failed";
  nextRetryAt: number | null;
  block: number;
  ts: number;
  book: Book | null;
  decision: Decision | null;
  quote: PaperQuote | null;
  position: { mon: number; cash: number; equity: number; unrealized: number };
  totals: { blocks: number; decisions: number; quotes: number; fills: number; feesUsd: number; realizedUsd: number; pnlUsd: number; late: number };
  chart: { ts: number; price: number }[];
  tape: Fill[];
  notice: string;
}
