import { expect, test } from "bun:test";
import { DEFAULT_READ_RPC_TIMEOUT_MS, readRpcConnectionInfo, readWithRpcFailover } from "../src/rpc-failover";

test("read-only RPC requests use a bounded HTTP timeout", () => {
  expect(readRpcConnectionInfo("https://rpc.example")).toEqual({ url: "https://rpc.example", timeout: DEFAULT_READ_RPC_TIMEOUT_MS });
  expect(DEFAULT_READ_RPC_TIMEOUT_MS).toBe(5_000);
  expect(() => readRpcConnectionInfo("https://rpc.example", 0)).toThrow("positive integer timeout");
});

test("read-only RPC failover retries sequentially and returns the serving endpoint index", async () => {
  const seen: number[] = [];
  const result = await readWithRpcFailover(["primary", "backup-a", "backup-b"], 0, async (provider, index) => {
    seen.push(index);
    if (provider !== "backup-a") throw new Error(`unavailable:${provider}`);
    return { block: 123 };
  });
  expect(seen).toEqual([0, 1]);
  expect(result).toEqual({ value: { block: 123 }, endpointIndex: 1 });
});

test("read-only RPC failover prefers its last healthy endpoint and then wraps sequentially", async () => {
  const seen: number[] = [];
  const result = await readWithRpcFailover([0, 1, 2], 2, async (provider, index) => {
    seen.push(index);
    if (provider === 2) throw new Error("stale endpoint");
    return provider;
  });
  expect(seen).toEqual([2, 0]);
  expect(result).toEqual({ value: 0, endpointIndex: 0 });
});

test("read-only RPC failover surfaces failure when every endpoint is unavailable", async () => {
  const seen: number[] = [];
  await expect(readWithRpcFailover([0, 1], 0, async (_provider, index) => {
    seen.push(index);
    throw new Error(`failed:${index}`);
  })).rejects.toThrow("failed:1");
  expect(seen).toEqual([0, 1]);
});

test("read-only RPC failover rejects an empty endpoint list", async () => {
  await expect(readWithRpcFailover([], 0, async () => 1)).rejects.toThrow("At least one read-only RPC provider is required");
});
