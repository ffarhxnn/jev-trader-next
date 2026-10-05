import { describe, expect, test } from "bun:test";
import { summarizePaperAudit } from "../src/paper-audit-report";

describe("paper audit report", () => {
  test("summarizes decisions, quote outcomes, fills, and execution latency", () => {
    const report = summarizePaperAudit([
      { kind: "session_start", timestamp: 1 },
      { kind: "decision", timestamp: 2, action: "sell", positionMon: 0, quote: null, latencyMs: 400, actionDisposition: "blocked_no_inventory" },
      { kind: "decision", timestamp: 3, action: "buy", positionMon: 0, quote: { side: "buy" }, latencyMs: 600 },
      { kind: "quote_resting", timestamp: 3, side: "buy" },
      { kind: "fill", timestamp: 4, side: "buy", size: 2, feesUsd: 0.01 },
      { kind: "safety_state", timestamp: 4, status: "live", modelStatus: "ready" },
    ].map((record) => JSON.stringify(record)).join("\n"));

    expect(report.evidenceStatus).toBe("PAPER_AUDIT_DESCRIPTIVE_ONLY");
    expect(report.decisions).toBe(2);
    expect(report.actions).toEqual({ buy: 1, sell: 1, hold: 0, other: 0 });
    expect(report.blockedNoInventory).toBe(1);
    expect(report.sellSignalsWithoutInventory).toBe(1);
    expect(report.unbackedSellQuotes).toBe(0);
    expect(report.fills).toBe(1);
    expect(report.filledSizeMon).toBe(2);
    expect(report.feesUsd).toBe(0.01);
    expect(report.latencyMs).toEqual({ median: 400, p95: 600 });
    expect(report.safetyStates).toEqual(["live:ready"]);
  });

  test("excludes sessions explicitly aborted for invalid paper assumptions", () => {
    const report = summarizePaperAudit([
      { kind: "session_start", timestamp: 1 },
      { kind: "decision", timestamp: 2, action: "sell", positionMon: 0, quote: { side: "sell" } },
      { kind: "session_aborted", timestamp: 3, excludeFromValidation: true, reasonCategory: "invalid_assumption" },
    ].map((record) => JSON.stringify(record)).join("\n"));

    expect(report.evidenceStatus).toBe("EXCLUDED_ABORTED_SESSION");
    expect(report.unbackedSellQuotes).toBe(1);
    expect(report.exclusionReason).toBe("invalid_assumption");
  });

  test("checks quote-linked partial fills and terminal lifecycle events", () => {
    const report = summarizePaperAudit([
      { kind: "session_start", timestamp: 1 },
      { kind: "quote_resting", timestamp: 2, quoteId: "q1", size: 5 },
      { kind: "fill", timestamp: 3, quoteId: "q1", size: 2, remainingSize: 3 },
      { kind: "fill", timestamp: 4, quoteId: "q1", size: 3, remainingSize: 0 },
      { kind: "quote_resting", timestamp: 5, quoteId: "q2", size: 4 },
      { kind: "quote_cancelled", timestamp: 6, quoteId: "q2", remainingSize: 4 },
    ].map((record) => JSON.stringify(record)).join("\n"));

    expect(report.quoteLifecycle).toEqual({
      evidenceStatus: "ID_LINKED", uniqueQuoteIds: 2, eventsWithoutQuoteId: 0,
      orphanLifecycleEvents: 0, stillRestingAtEnd: 0,
    });
  });
});
