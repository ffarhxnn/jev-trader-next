import { describe, expect, test } from "bun:test";

const configUrl = new URL("../src/config.ts", import.meta.url).href;
function importConfig(modelId: string, paidOptIn?: string, requestsEnabled?: string, includeApiKey = true, requestCap?: string, maxSpreadBps?: string) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    APP_MODE: "paper",
    MODEL: "jev",
    JEV_MODEL_ID: modelId,
  };
  if (includeApiKey) env.OPENCODE_API_KEY = "test-only";
  if (paidOptIn !== undefined) env.JEV_ALLOW_PAID = paidOptIn;
  if (requestsEnabled !== undefined) env.JEV_REQUESTS_ENABLED = requestsEnabled;
  if (requestCap !== undefined) env.MODEL_MAX_REQUESTS_PER_UTC_DAY = requestCap;
  if (maxSpreadBps !== undefined) env.MAX_MARKET_SPREAD_BPS = maxSpreadBps;
  return Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", "-e", `import(${JSON.stringify(configUrl)})`],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function importLocalDemoPaper(enabled?: string) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", APP_MODE: "paper", MODEL: "demo" };
  if (enabled !== undefined) env.PAPER_LOCAL_DEMO_ENABLED = enabled;
  return Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", "-e", `import(${JSON.stringify(configUrl)})`],
    env, stdout: "pipe", stderr: "pipe",
  });
}

describe("Jev model billing opt-in", () => {
  test("local demo heuristic needs a separate opt-in before it can drive real-book paper mode", () => {
    const blocked = importLocalDemoPaper();
    expect(blocked.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(blocked.stderr)).toContain("PAPER_LOCAL_DEMO_ENABLED=1");
    expect(importLocalDemoPaper("0").exitCode).not.toBe(0);
    expect(importLocalDemoPaper("1").exitCode).toBe(0);
  });

  test("blocks paid Jev without the explicit switch and allows it with the switch", () => {
    const blocked = importConfig("jev-1.13");
    expect(blocked.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(blocked.stderr)).toContain("Paid Jev is disabled by default");

    const enabled = importConfig("jev-1.13", "1");
    expect(enabled.exitCode).toBe(0);
  });

  test("keeps free Jev usable without the paid switch", () => {
    expect(importConfig("jev-1.13-free").exitCode).toBe(0);
  });

  test("keeps provider requests disabled unless explicitly enabled", async () => {
    const { config } = await import("../src/config");
    expect(config.jevRequestsEnabled).toBe(false);
    const uncapped = importConfig("jev-1.13-free", undefined, "1");
    expect(uncapped.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(uncapped.stderr)).toContain("positive MODEL_MAX_REQUESTS_PER_UTC_DAY cap");
    expect(importConfig("jev-1.13-free", undefined, "1", true, "3").exitCode).toBe(0);
    expect(importConfig("jev-1.13-free", undefined, undefined, false).exitCode).toBe(0);
  });

  test("validates the maximum paper-market spread", () => {
    expect(importConfig("jev-1.13-free", undefined, undefined, true, undefined, "50").exitCode).toBe(0);
    expect(importConfig("jev-1.13-free", undefined, undefined, true, undefined, "0").exitCode).not.toBe(0);
    expect(importConfig("jev-1.13-free", undefined, undefined, true, undefined, "10001").exitCode).not.toBe(0);
  });
});
