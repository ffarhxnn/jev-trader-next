import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperAuditLog, publicTradeAuditRecord } from "../src/paper-audit";

let directory = "";
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
});

describe("paper audit log", () => {
  test("ignored trades retain receipt evidence without inferring direction or copying private extras", () => {
    const event = { timestamp: 12, reason: "untrusted transport reason", rawPrice: "31982000000000000", rawSize: "62930999618356",
      transactionHash: `0x${"a".repeat(64)}`, sourceTimestamp: "0x6abe4198", apiKey: "synthetic-private-marker", prompt: "synthetic-private-prompt",
      takerSide: "sell" as const, receiptVerified: true };
    const row = publicTradeAuditRecord(event, false);
    expect(row).toEqual({ kind: "public_trade_ignored", timestamp: 12, reasonCode: "UNRELIABLE_TRADE_FIELDS",
      rawPrice: event.rawPrice, rawSize: event.rawSize, transactionHash: event.transactionHash, sourceTimestamp: event.sourceTimestamp });
    expect(JSON.stringify(row)).not.toContain("synthetic-private");
    expect(row.takerSide).toBeUndefined();
    expect(row.receiptVerified).toBeUndefined();
  });

  test("accepted trade auditing requires reliable direction and excludes arbitrary provenance strings", () => {
    const event = { timestamp: 13, price: 0.031982, size: 5, takerSide: "buy" as const, transactionHash: "not-a-hash",
      sourceTimestamp: "synthetic-private-marker", rawSize: "-1", rawPrice: "1e16" };
    expect(publicTradeAuditRecord(event, true)).toEqual({ kind: "public_trade", timestamp: 13, price: event.price, size: 5, takerSide: "buy" });
    expect(() => publicTradeAuditRecord({ ...event, takerSide: undefined } as never, true)).toThrow("reliable fields");
    expect(() => publicTradeAuditRecord({ ...event, timestamp: NaN }, true)).toThrow("receipt time");
  });

  test("appends parseable records to a private local file", () => {
    directory = mkdtempSync(join(tmpdir(), "jev-paper-audit-"));
    const log = new PaperAuditLog(join(directory, "nested", "events.jsonl"));
    log.append({ kind: "decision", timestamp: 10, block: 4, action: "buy" });
    log.append({ kind: "fill", timestamp: 11, block: 5, action: "buy" });

    const records = readFileSync(log.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toEqual([
      { kind: "decision", timestamp: 10, block: 4, action: "buy" },
      { kind: "fill", timestamp: 11, block: 5, action: "buy" },
    ]);
    expect(statSync(log.path).mode & 0o777).toBe(0o600);
  });

  test("rejects records without a finite timestamp", () => {
    directory = mkdtempSync(join(tmpdir(), "jev-paper-audit-"));
    const log = new PaperAuditLog(join(directory, "events.jsonl"));
    expect(() => log.append({ kind: "decision", timestamp: Number.NaN })).toThrow("finite timestamp");
  });
});
