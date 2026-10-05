import { expect, test } from "bun:test";
import { assertFinalizedReconstructionReceipts, type SuccessfulTradeReceipt } from "../src/chain-trade-reconstruction";

const tx = `0x${"a".repeat(64)}`, blockHash = `0x${"b".repeat(64)}`, other = `0x${"c".repeat(64)}`;
const receipt: SuccessfulTradeReceipt = { transactionHash: tx, blockNumber: 100, blockHash, status: 1,
  transactionIndex: 1, logs: [{ address: `0x${"1".repeat(40)}`, topics: [], data: "0x", blockNumber: 100,
    blockHash, transactionHash: tx, transactionIndex: 1, logIndex: 0 }] };
const block = { number: 100, hash: blockHash, transactions: [other, tx] };
const check = (r = receipt, b = block, head: { number: unknown; hash: unknown } = { number: "0x65", hash: other }) => assertFinalizedReconstructionReceipts(new Map([[tx, r]]), new Map([[100, b]]), head);

test("new reconstruction proves finalized height and exact canonical transaction-index inclusion", () => {
  expect(() => check()).not.toThrow();
  expect(() => check(receipt, block, { number: 100, hash: blockHash })).not.toThrow();
  for (const head of [{ number: 99, hash: blockHash }, { number: 100, hash: other }, { number: null, hash: blockHash }, { number: 101, hash: "0x" }]) {
    expect(() => check(receipt, block, head)).toThrow();
  }
});

test("missing receipt index, contradictory receipt logs and malformed block membership fail closed", () => {
  for (const r of [{ ...receipt, transactionIndex: undefined }, { ...receipt, transactionIndex: 0 }, { ...receipt, status: 0 },
    { ...receipt, logs: [{ ...receipt.logs[0]!, transactionIndex: 0 }] }, { ...receipt, logs: [{ ...receipt.logs[0]!, removed: true }] }]) {
    expect(() => check(r)).toThrow();
  }
  for (const b of [{ ...block, hash: other }, { ...block, transactions: [tx, other] },
    { ...block, transactions: [tx, tx] }, { ...block, transactions: ["bad", tx] }]) {
    expect(() => check(receipt, b)).toThrow();
  }
  expect(() => assertFinalizedReconstructionReceipts(new Map(), new Map(), { number: 101, hash: other })).toThrow();
});
