import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { IgnoredTradeEvent, TradeEvent } from "./types";

/** Preserve public receipt provenance without copying transport payloads or inferring a side. */
export function publicTradeAuditRecord(event: TradeEvent | IgnoredTradeEvent, accepted: boolean): Record<string, unknown> {
  if (!Number.isFinite(event.timestamp) || event.timestamp < 0) throw new Error("Invalid public trade receipt time.");
  const row: Record<string, unknown> = { kind: accepted ? "public_trade" : "public_trade_ignored", timestamp: event.timestamp };
  if (accepted) {
    const trade = event as TradeEvent;
    if (!(trade.price > 0) || !Number.isFinite(trade.price) || !(trade.size > 0) || !Number.isFinite(trade.size)
      || (trade.takerSide !== "buy" && trade.takerSide !== "sell")) throw new Error("Accepted public trade lacks reliable fields.");
    row.price = trade.price; row.size = trade.size; row.takerSide = trade.takerSide;
  } else row.reasonCode = "UNRELIABLE_TRADE_FIELDS";
  if (typeof event.transactionHash === "string" && /^0x[\da-f]{64}$/i.test(event.transactionHash)) row.transactionHash = event.transactionHash;
  for (const field of ["rawPrice", "rawSize"] as const) {
    const value = event[field];
    if (typeof value === "string" && /^\d{1,80}$/.test(value)) row[field] = value;
  }
  if (typeof event.sourceTimestamp === "string" && /^(?:\d{1,32}|0x[\da-f]{1,32})$/i.test(event.sourceTimestamp)) row.sourceTimestamp = event.sourceTimestamp;
  return row;
}

/** Local append-only trail. Callers provide only whitelisted, non-secret fields. */
export class PaperAuditLog {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
  }

  append(record: Record<string, unknown>) {
    if (typeof record.kind !== "string" || !Number.isFinite(record.timestamp)) {
      throw new Error("Paper audit records require a kind and finite timestamp.");
    }
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
