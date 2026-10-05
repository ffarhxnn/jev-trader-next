import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { BudgetedProviderModel, ProviderRequestBudget } from "../src/provider-request-budget";
import type { DecisionModel } from "../src/model";
import type { Book, Decision } from "../src/types";

const book: Book = { block: 1, bid: 0.02, ask: 0.02001, mid: 0.020005, spreadBps: 5, source: "Monad Kuru" };
const decision: Decision = { action: "hold", buy: 0.5, sell: 0.5, latencyMs: 0, model: "test-model", source: "OpenCode Go API" };
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readyModel(onCall: () => Promise<Decision>): DecisionModel {
  return { name: "Muse Spark 1.3 Contributor", status: () => ({ state: "ready", retryAt: null, reason: null }), decide: onCall };
}

describe("persisted provider request cap", () => {
  test("counts before calls, persists across restarts, and isolates model allowances", () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-budget-"));
    const path = join(dir, "budget.json");
    const now = Date.parse("2026-09-30T12:00:00Z");
    try {
      const first = new ProviderRequestBudget(2, path, () => now);
      expect(first.status("opencode-go:muse-spark-1.3-contributor").allowed).toBe(true);
      first.consume("opencode-go:muse-spark-1.3-contributor");
      const restarted = new ProviderRequestBudget(2, path, () => now);
      expect(restarted.status("opencode-go:muse-spark-1.3-contributor").allowed).toBe(true);
      restarted.consume("opencode-go:muse-spark-1.3-contributor");
      expect(restarted.status("opencode-go:muse-spark-1.3-contributor")).toMatchObject({
        allowed: false, retryAt: Date.parse("2026-10-01T00:00:00Z"),
      });
      expect(restarted.status("opencode-go:kimi-k3").allowed).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).not.toContain("apiKey");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("resets at the next UTC day and treats zero as closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-budget-day-"));
    const path = join(dir, "budget.json");
    let now = Date.parse("2026-09-30T23:59:59.000Z");
    try {
      const budget = new ProviderRequestBudget(1, path, () => now);
      budget.consume("jev:jev-1.13-free");
      expect(budget.status("jev:jev-1.13-free").allowed).toBe(false);
      now = Date.parse("2026-10-01T00:00:00.000Z");
      expect(budget.status("jev:jev-1.13-free").allowed).toBe(true);
      expect(new ProviderRequestBudget(0, null, () => now).status("jev:jev-1.13-free").allowed).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("fails closed when a positive cap has no persistent state path", () => {
    const budget = new ProviderRequestBudget(1, null);
    expect(budget.status("jev:jev-1.13-free")).toMatchObject({ allowed: false, retryAt: null });
    expect(() => budget.consume("jev:jev-1.13-free")).toThrow("not persistently configured");
  });

  test("serializes the cap across independent app instances sharing one state file", () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-budget-shared-"));
    const path = join(dir, "budget.json");
    try {
      const first = new ProviderRequestBudget(1, path);
      const second = new ProviderRequestBudget(1, path);
      first.consume("opencode-go:muse-spark-1.3-contributor");
      expect(() => second.consume("opencode-go:muse-spark-1.3-contributor")).toThrow("Daily request cap reached");
      const state = JSON.parse(readFileSync(path, "utf8"));
      expect(Object.values(state.days)[0]).toEqual({ "opencode-go:muse-spark-1.3-contributor": 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("does not overshoot the cap when independent processes consume concurrently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-budget-concurrent-"));
    const path = join(dir, "budget.json");
    const worker = join(dir, "consume-budget.ts");
    const modelKey = "opencode-go:muse-spark-1.3-contributor";
    writeFileSync(worker, `
      import { ProviderRequestBudget } from ${JSON.stringify(resolve(projectRoot, "src/provider-request-budget.ts"))};
      try {
        new ProviderRequestBudget(4, process.argv[2]).consume(${JSON.stringify(modelKey)});
        console.log("consumed");
      } catch (error) {
        if ((error as Error).name === "RateLimitWait") console.log("capped");
        else throw error;
      }
    `);
    try {
      const children = Array.from({ length: 12 }, () => Bun.spawn([process.execPath, worker, path], { stdout: "pipe", stderr: "pipe" }));
      const outcomes = await Promise.all(children.map(async (child) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        if (exitCode !== 0) throw new Error(stderr || `Budget worker exited with ${exitCode}.`);
        return stdout.trim();
      }));
      const consumed = outcomes.filter((value) => value === "consumed").length;
      expect(consumed).toBeGreaterThan(0);
      expect(consumed).toBeLessThanOrEqual(4);
      expect(outcomes.filter((value) => value === "capped")).toHaveLength(12 - consumed);
      const state = JSON.parse(readFileSync(path, "utf8"));
      const today = new Date().toISOString().slice(0, 10);
      expect(state.days[today][modelKey]).toBe(consumed);
      expect(state.days[today][modelKey]).toBeLessThanOrEqual(4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("fails closed on corrupt state", () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-budget-corrupt-"));
    const path = join(dir, "budget.json");
    try {
      writeFileSync(path, "not-json");
      expect(new ProviderRequestBudget(3, path).status("jev:jev-1.13-free").allowed).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("blocks the next hosted call after the cap, even when a prior attempt failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-budget-model-"));
    const path = join(dir, "budget.json");
    let calls = 0;
    const model = new BudgetedProviderModel(readyModel(async () => { calls++; throw new Error("provider failed after request began"); }), new ProviderRequestBudget(1, path), "opencode-go");
    try {
      await expect(model.decide(book, [])).rejects.toThrow("provider failed");
      expect(calls).toBe(1);
      expect(model.status().state).toBe("waiting");
      await expect(model.decide(book, [])).rejects.toMatchObject({ name: "RateLimitWait" });
      expect(calls).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
