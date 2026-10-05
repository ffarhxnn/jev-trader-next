import { describe, expect, it } from "bun:test";
import { assertMonadRpcChainId, parseRpcChainId } from "../src/book";

describe("Monad RPC chain guard", () => {
  it("accepts the expected chain id in common JSON-RPC forms", () => {
    expect(parseRpcChainId("0x8f")).toBe(143);
    expect(parseRpcChainId("143")).toBe(143);
    expect(parseRpcChainId(143)).toBe(143);
    expect(() => assertMonadRpcChainId("0x8f")).not.toThrow();
  });

  it("rejects another network and malformed chain ids", () => {
    expect(() => assertMonadRpcChainId("0x1")).toThrow("expected Monad 143; received 1");
    expect(() => assertMonadRpcChainId("not-a-chain")).toThrow("received invalid");
    expect(parseRpcChainId(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });
});
