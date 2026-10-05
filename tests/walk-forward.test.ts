import { describe, expect, test } from "bun:test";
import { createPurgedWalkForwardSplit } from "../src/walk-forward";

function audit(times: number[]) {
  return [
    { kind: "session_start", mode: "paper", market: "0x065c9d28e428a0db40191a54d33d5b7c71a9c394" },
    ...times.map((timestamp, index) => ({ kind: "decision", timestamp, action: index % 2 ? "sell" : "buy" })),
  ].map((row) => JSON.stringify(row)).join("\n");
}

describe("purged chronological markout split", () => {
  test("keeps training and holdout apart by the requested purge interval", () => {
    const result = createPurgedWalkForwardSplit(audit([100_000, 110_000, 120_000, 130_000, 140_000, 150_000, 160_000, 170_000, 180_000, 190_000]), 0.6, 5_000);
    expect(result.cutoffTimestamp).toBe(160_000);
    expect(result.train.endTimestamp).toBe(150_000);
    expect(result.holdout.startTimestamp).toBe(170_000);
    expect(result.train.decisions).toBe(6);
    expect(result.holdout.decisions).toBe(3);
    expect(result.train.directionalDecisions).toBe(6);
    expect(JSON.parse(result.trainAudit.split("\n")[0]!).mode).toBe("paper");
  });

  test("rejects multiple sessions, short histories, bad ordering, and empty purged sides", () => {
    const text = audit([100_000, 110_000, 120_000, 130_000]);
    expect(() => createPurgedWalkForwardSplit(text.replace("\n{", "\n{\"kind\":\"session_start\",\"mode\":\"paper\",\"market\":\"0x065c9d28e428a0db40191a54d33d5b7c71a9c394\"}\n{"))).toThrow("one paper session");
    expect(() => createPurgedWalkForwardSplit(audit([100_000, 110_000, 120_000]))).toThrow("At least four");
    expect(() => createPurgedWalkForwardSplit(audit([100_000, 130_000, 120_000, 150_000]))).toThrow("chronological");
    expect(() => createPurgedWalkForwardSplit(text, 0.5, 100_000)).toThrow("leaves no training or holdout");
    expect(() => createPurgedWalkForwardSplit(text, 1, 1)).toThrow("split fraction");
  });
});
