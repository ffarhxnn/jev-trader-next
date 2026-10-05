import { describe, expect, test } from "bun:test";
import { analyzePaperTradeCandidates } from "../src/paper-trade-analysis";

describe("paper quote and public trade comparison", () => {
  test("counts only in-window exact-price trades with the opposing taker side", () => {
    const audit = [
      { kind: "session_start", timestamp: 900 },
      { kind: "quote_resting", timestamp: 1_000, quoteId: "q1", side: "buy", price: 1, size: 5, queueAhead: 2 },
      { kind: "quote_cancelled", timestamp: 3_000, quoteId: "q1" },
    ].map((row) => JSON.stringify(row)).join("\n");
    const trades = [
      { kind: "status", status: "connected", timestamp: 500 },
      { kind: "trade", timestamp: 1_500, price: 1, size: 2, takerSide: "buy" },
      { kind: "trade", timestamp: 2_000, price: 1, size: 3, takerSide: "sell" },
      { kind: "trade", timestamp: 2_500, price: 1.02, size: 4, takerSide: "sell" },
      { kind: "trade", timestamp: 3_500, price: 1, size: 10, takerSide: "sell" },
    ].map((row) => JSON.stringify(row)).join("\n");
    const result = analyzePaperTradeCandidates(audit, trades, 0.01);
    expect(result).toMatchObject({
      evidenceStatus: "PUBLIC_TRADE_CANDIDATES_ONLY", quoteIds: 1, observedTradeEvents: 4,
      quotesWithFeedCoverage: 1, candidateTradePrints: 1, quotesWithCandidatePrints: 1,
      totalMatchingTradeVolumeMon: 3,
    });
  });

  test("does not silently join legacy snapshot-diff audits without quote IDs", () => {
    const audit = JSON.stringify({ kind: "quote_resting", timestamp: 1, price: 1, side: "buy" });
    expect(() => analyzePaperTradeCandidates(audit, "", 0.01)).toThrow("Quote-linked lifecycle records are required");
  });

  test.each(["buy", "sell"] as const)("keeps %s exact and through candidates disjoint, covered, and strictly interior", (side) => {
    const encode = (rows: object[]) => rows.map((row) => JSON.stringify(row)).join("\n");
    const opposing = side === "buy" ? "sell" : "buy";
    const through = side === "buy" ? 0.9 : 1.1;
    const nonCrossing = side === "buy" ? 1.1 : 0.9;
    const trade = (timestamp: number, price: number, size = 1, takerSide = opposing) =>
      ({ kind: "trade", timestamp, price, size, takerSide });
    const audit = encode([
      { kind: "quote_resting", timestamp: 100, quoteId: "q", side, price: 1 },
      { kind: "quote_cancelled", timestamp: 900, quoteId: "q" },
    ]);
    const result = analyzePaperTradeCandidates(audit, encode([
      { kind: "status", status: "connected", timestamp: 0 },
      trade(100, 1), trade(100, side === "buy" ? 0.8 : 1.2), // Creation ordering is unknown for both categories.
      trade(200, 1, 2), trade(200, side === "buy" ? 0.875 : 1.125, 3), // Half-tick remains exact.
      trade(300, through), // Inside half-tick tolerance, hence exact.
      trade(350, side === "buy" ? 0.8 : 1.2, 4),
      trade(400, nonCrossing + (side === "buy" ? 0.2 : -0.2)),
      trade(450, through, 20, side), // Wrong aggressor side.
      { kind: "gap", timestamp: 500 },
      trade(550, 1, 30), trade(600, side === "buy" ? 0.8 : 1.2, 30),
      { kind: "status", status: "connected", timestamp: 700 },
      trade(900, 1), trade(900, side === "buy" ? 0.8 : 1.2),
      trade(950, 1),
    ]), 0.25);
    expect(result).toMatchObject({
      candidateTradePrints: 3, quotesWithCandidatePrints: 1, totalMatchingTradeVolumeMon: 6,
      throughPriceCandidateTradePrints: 1, quotesWithThroughPriceCandidatePrints: 1,
      totalThroughPriceCandidateTradeVolumeMon: 4, combinedCandidateTradePrints: 4,
      boundaryCensoredCandidateTradePrints: 4, quotesWithFeedCoverage: 1,
      evidenceStatus: "PUBLIC_TRADE_CANDIDATES_ONLY",
    });
    expect(result.fillInterpretation).toContain("only candidates");
    expect(result.fillInterpretation).toContain("trading approval");
    expect(result).not.toHaveProperty("fills");
    expect(result).not.toHaveProperty("pnl");
  });

  test("censors the audit end boundary for an uncancelled quote and requires feed coverage", () => {
    const audit = [
      { kind: "quote_resting", timestamp: 100, quoteId: "q", side: "sell", price: 1 },
      { kind: "session_end", timestamp: 300 },
    ].map((row) => JSON.stringify(row)).join("\n");
    const trades = [
      { kind: "trade", timestamp: 150, price: 1.2, size: 10, takerSide: "buy" },
      { kind: "status", status: "connected", timestamp: 200 },
      { kind: "trade", timestamp: 300, price: 1, size: 10, takerSide: "buy" },
      { kind: "trade", timestamp: 300, price: 1.2, size: 10, takerSide: "buy" },
    ].map((row) => JSON.stringify(row)).join("\n");
    expect(analyzePaperTradeCandidates(audit, trades, 0.01)).toMatchObject({
      candidateTradePrints: 0, throughPriceCandidateTradePrints: 0,
      combinedCandidateTradePrints: 0, boundaryCensoredCandidateTradePrints: 2,
    });
  });
});
