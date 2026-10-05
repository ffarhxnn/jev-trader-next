import { describe, expect, test } from "bun:test";
import { utils } from "ethers";
import { reconcileOrderCreatedReceipt, reconcileOrderFillReceipt, reconcileOrdersCancelledReceipt } from "../src/order-reconciliation";

const market = "0x065c9d28e428a0db40191a54d33d5b7c71a9c394";
const account = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const other = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const hash = `0x${"1".repeat(64)}`;
const abi = require("@kuru-labs/kuru-sdk/abi/OrderBook.json").abi;
const kuru = new utils.Interface(abi);
const orderEvents = new utils.Interface([
  "event OrderCreated(uint40 orderId,address owner,uint96 size,uint32 price,bool isBuy)",
  "event OrdersCanceled(uint40[] orderId,address owner)",
  "event Trade(uint40 orderId,address makerAddress,bool isBuy,uint256 price,uint96 updatedSize,address takerAddress,address txOrigin,uint96 filledSize)",
]);

function receipt(logs: { address: string; topics: string[]; data: string }[], changes: Record<string, unknown> = {}) {
  return { transactionHash: hash, status: 1, blockNumber: 42, confirmations: 12, logs, ...changes };
}
function created(overrides: { address?: string; owner?: string; size?: string; price?: string; isBuy?: boolean; orderId?: string } = {}) {
  const { topics, data } = kuru.encodeEventLog("OrderCreated", [overrides.orderId ?? "17", overrides.owner ?? account, overrides.size ?? "250000000000", overrides.price ?? "27000", overrides.isBuy ?? true]);
  return { address: overrides.address ?? market, topics, data };
}
function cancelled(ids: string[], owner = account, address = market) {
  const { topics, data } = kuru.encodeEventLog("OrdersCanceled", [ids, owner]);
  return { address, topics, data };
}
function traded(orderId: string, makerAddress: string, isTakerBuy: boolean, overrides: { address?: string; price?: string; updatedSize?: string; filledSize?: string } = {}) {
  const { topics, data } = kuru.encodeEventLog("Trade", [orderId, makerAddress, isTakerBuy, overrides.price ?? "27000", overrides.updatedSize ?? "500", other, account, overrides.filledSize ?? "250"]);
  return { address: overrides.address ?? market, topics, data };
}

describe("Kuru order receipt reconciliation", () => {
  test("event topics match the installed Kuru ABI and exact order event confirms placement", () => {
    expect(orderEvents.getEventTopic("OrderCreated")).toBe(kuru.getEventTopic("OrderCreated"));
    expect(orderEvents.getEventTopic("OrdersCanceled")).toBe(kuru.getEventTopic("OrdersCanceled"));
    expect(orderEvents.getEventTopic("Trade")).toBe(kuru.getEventTopic("Trade"));
    expect(reconcileOrderCreatedReceipt(receipt([created()]), {
      transactionHash: hash, market, account, side: "buy", rawPrice: "27000", rawSize: "250000000000",
    }, 10143, 10143, 2)).toEqual({ verdict: "ORDER_CREATED", orderId: "17", blockNumber: 42 });
  });

  test("rejects wrong-chain, mismatched, reverted, and under-confirmed receipts", () => {
    const expected = { transactionHash: hash, market, account, side: "buy" as const, rawPrice: "27000", rawSize: "250000000000" };
    expect(reconcileOrderCreatedReceipt(receipt([created()]), expected, 143, 10143).verdict).toBe("WRONG_CHAIN");
    expect(reconcileOrderCreatedReceipt(receipt([created()], { transactionHash: `0x${"2".repeat(64)}` }), expected, 10143, 10143).verdict).toBe("RECEIPT_MISMATCH");
    expect(reconcileOrderCreatedReceipt(receipt([created()], { status: 0 }), expected, 10143, 10143).verdict).toBe("REVERTED");
    expect(reconcileOrderCreatedReceipt(receipt([created()], { confirmations: 1 }), expected, 10143, 10143, 2).verdict).toBe("INSUFFICIENT_CONFIRMATIONS");
  });

  test("does not match a log from another market, owner, side, price, or size", () => {
    const expected = { transactionHash: hash, market, account, side: "buy" as const, rawPrice: "27000", rawSize: "250000000000" };
    for (const log of [created({ address: other }), created({ owner: other }), created({ isBuy: false }), created({ price: "27001" }), created({ size: "250000000001" })]) {
      expect(reconcileOrderCreatedReceipt(receipt([log]), expected, 143, 143).verdict).toBe("NO_MATCHING_ORDER_CREATED");
    }
    expect(reconcileOrderCreatedReceipt(receipt([created(), created({ orderId: "18" })]), expected, 143, 143).verdict).toBe("AMBIGUOUS_ORDER_CREATED");
  });

  test("confirms only requested cancellations emitted by the configured account and market", () => {
    const expected = { transactionHash: hash, market, account, orderIds: ["17", "18"] };
    expect(reconcileOrdersCancelledReceipt(receipt([cancelled(["18", "17"])]), expected, 143, 143)).toEqual({ verdict: "ORDERS_CANCELLED", cancelledOrderIds: ["17", "18"], blockNumber: 42 });
    expect(reconcileOrdersCancelledReceipt(receipt([cancelled(["17"])]), expected, 143, 143).verdict).toBe("CANCEL_NOT_CONFIRMED");
    expect(reconcileOrdersCancelledReceipt(receipt([cancelled(["17", "18"], other)]), expected, 143, 143).verdict).toBe("CANCEL_NOT_CONFIRMED");
    expect(reconcileOrdersCancelledReceipt(receipt([cancelled(["17", "18", "19"])]), expected, 143, 143)).toEqual({
      verdict: "UNEXPECTED_ORDER_CANCELLED", cancelledOrderIds: ["17", "18", "19"], blockNumber: 42,
    });
    expect(() => reconcileOrdersCancelledReceipt(receipt([]), { ...expected, orderIds: [] }, 143, 143)).toThrow("nonempty uint40");
  });

  test("reconciles partial maker fills by market, order ID, maker, side, price, and log index", () => {
    const expected = { transactionHash: hash, market, orders: [
      { orderId: "17", makerAddress: account, side: "buy" as const, rawPrice: "27000", rawSize: "750" },
      { orderId: "18", makerAddress: account, side: "sell" as const, rawPrice: "27001", rawSize: "75" },
    ] };
    expect(reconcileOrderFillReceipt(receipt([
      traded("17", account, false, { filledSize: "250", updatedSize: "500" }),
      traded("18", account, true, { price: "27001", filledSize: "75", updatedSize: "0" }),
      traded("17", other, false),
      traded("17", account, false, { address: other }),
    ]), expected, 143, 143)).toEqual({
      verdict: "ORDER_FILLED",
      fills: [
        { orderId: "17", side: "buy", rawPrice: "27000", rawSize: "250", remainingRawSize: "500", logIndex: 0 },
        { orderId: "18", side: "sell", rawPrice: "27001", rawSize: "75", remainingRawSize: "0", logIndex: 1 },
      ],
      blockNumber: 42,
    });
    expect(reconcileOrderFillReceipt(receipt([traded("17", account, false)], { confirmations: 1 }), expected, 143, 143, 2).verdict).toBe("INSUFFICIENT_CONFIRMATIONS");
    expect(reconcileOrderFillReceipt(receipt([traded("17", account, false)]), { ...expected, transactionHash: `0x${"2".repeat(64)}` }, 143, 143).verdict).toBe("RECEIPT_MISMATCH");
  });

  test("rejects a matching maker order ID reported with a conflicting side or price", () => {
    const expected = { transactionHash: hash, market, orders: [
      { orderId: "17", makerAddress: account, side: "buy" as const, rawPrice: "27000", rawSize: "500" },
    ] };
    for (const conflict of [traded("17", account, true), traded("17", account, false, { price: "27001" })]) {
      const result = reconcileOrderFillReceipt(receipt([conflict]), expected, 143, 143);
      expect(result.verdict).toBe("RECEIPT_MISMATCH");
      expect(result.fills).toEqual([]);
    }
  });

  test("rejects inconsistent, overfilled, and out-of-order maker fill sequences", () => {
    const expected = { transactionHash: hash, market, orders: [
      { orderId: "17", makerAddress: account, side: "buy" as const, rawPrice: "27000", rawSize: "500" },
    ] };
    expect(reconcileOrderFillReceipt(receipt([traded("17", account, false, { filledSize: "501", updatedSize: "0" })]), expected, 143, 143).verdict).toBe("RECEIPT_MISMATCH");
    expect(reconcileOrderFillReceipt(receipt([traded("17", account, false, { filledSize: "200", updatedSize: "200" })]), expected, 143, 143).verdict).toBe("RECEIPT_MISMATCH");
    const later = { ...traded("17", account, false, { filledSize: "100", updatedSize: "300" }), logIndex: 9 };
    const earlier = { ...traded("17", account, false, { filledSize: "200", updatedSize: "300" }), logIndex: 8 };
    const result = reconcileOrderFillReceipt(receipt([later, earlier]), expected, 143, 143);
    expect(result.verdict).toBe("RECEIPT_MISMATCH");
    expect(result.fills).toEqual([]);
  });

  test("rejects invalid and duplicate order IDs before interpreting fill logs", () => {
    const expected = { transactionHash: hash, market, orders: [
      { orderId: "17", makerAddress: account, side: "buy" as const, rawPrice: "27000", rawSize: "500" },
      { orderId: "17", makerAddress: account, side: "buy" as const, rawPrice: "27000", rawSize: "500" },
    ] };
    expect(() => reconcileOrderFillReceipt(receipt([]), expected, 143, 143)).toThrow("unique");
    expect(() => reconcileOrderFillReceipt(receipt([]), { ...expected, orders: [{ ...expected.orders[0]!, orderId: "1099511627776" }] }, 143, 143)).toThrow("uint40");
  });
});
