import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperRiskLatch } from "../src/paper-risk-latch";

const market = "0x065c9d28e428a0db40191a54d33d5b7c71a9c394";
let directory = "";
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = ""; });

describe("persistent paper loss stop", () => {
  test("writes an owner-only state and restores it in a new store instance", () => {
    directory = mkdtempSync(join(tmpdir(), "jev-risk-latch-"));
    const path = join(directory, "data", "paper-risk-stop.json");
    const first = new PaperRiskLatch(path);
    expect(first.read(market)).toBeNull();
    const latched = first.latch({ market, latchedAt: 1_700_000_000_000, startingEquityUsd: 100, equityAtStopUsd: 80, lossLimitUsd: 20 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(latched);
    expect(new PaperRiskLatch(path).read(market)).toEqual(latched);
  });

  test("fails closed on unreadable, malformed, or different-market latch state", () => {
    directory = mkdtempSync(join(tmpdir(), "jev-risk-latch-"));
    const path = join(directory, "paper-risk-stop.json");
    writeFileSync(path, "{bad", { mode: 0o600 });
    const latch = new PaperRiskLatch(path);
    expect(() => latch.read(market)).toThrow("unreadable");
    writeFileSync(path, JSON.stringify({ version: 1, mode: "paper", reason: "MAX_MARK_TO_MARKET_LOSS", market, latchedAt: 1, startingEquityUsd: 100, equityAtStopUsd: 80, lossLimitUsd: 20 }));
    chmodSync(path, 0o600);
    expect(() => latch.read("0x1111111111111111111111111111111111111111")).toThrow("different market");
  });

  test("reset removes only a regular local latch", () => {
    directory = mkdtempSync(join(tmpdir(), "jev-risk-latch-"));
    const path = join(directory, "paper-risk-stop.json");
    const latch = new PaperRiskLatch(path);
    expect(latch.reset()).toBe(false);
    latch.latch({ market, latchedAt: 1_700_000_000_000, startingEquityUsd: 100, equityAtStopUsd: 80, lossLimitUsd: 20 });
    expect(latch.reset()).toBe(true);
    expect(latch.read(market)).toBeNull();
  });

  test("refuses to read or remove a symlinked latch", () => {
    directory = mkdtempSync(join(tmpdir(), "jev-risk-latch-"));
    const target = join(directory, "other-state.json");
    const path = join(directory, "paper-risk-stop.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, path);
    const latch = new PaperRiskLatch(path);
    expect(() => latch.read(market)).toThrow("regular local file");
    expect(() => latch.reset()).toThrow("regular local file");
    expect(readFileSync(target, "utf8")).toBe("{}");
  });
});
