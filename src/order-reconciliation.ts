import { utils } from "ethers";

const ORDER_EVENTS = new utils.Interface([
  "event OrderCreated(uint40 orderId,address owner,uint96 size,uint32 price,bool isBuy)",
  "event OrdersCanceled(uint40[] orderId,address owner)",
  "event Trade(uint40 orderId,address makerAddress,bool isBuy,uint256 price,uint96 updatedSize,address takerAddress,address txOrigin,uint96 filledSize)",
]);

export interface KuruReceiptLog { address: string; topics: string[]; data: string; logIndex?: number }
export interface KuruOrderReceipt { transactionHash: string; status: number | null; blockNumber: number; confirmations: number; logs: KuruReceiptLog[] }
export interface ExpectedKuruOrder { transactionHash: string; market: string; account: string; side: "buy" | "sell"; rawPrice: string; rawSize: string }
export interface ExpectedMakerOrder { orderId: string; makerAddress: string; side: "buy" | "sell"; rawPrice: string; rawSize: string }

export type OrderReceiptVerdict = "WRONG_CHAIN" | "RECEIPT_MISMATCH" | "REVERTED" | "INSUFFICIENT_CONFIRMATIONS" | "NO_MATCHING_ORDER_CREATED" | "AMBIGUOUS_ORDER_CREATED" | "ORDER_CREATED";
export type CancelReceiptVerdict = "WRONG_CHAIN" | "RECEIPT_MISMATCH" | "REVERTED" | "INSUFFICIENT_CONFIRMATIONS" | "CANCEL_NOT_CONFIRMED" | "UNEXPECTED_ORDER_CANCELLED" | "ORDERS_CANCELLED";
export type FillReceiptVerdict = "WRONG_CHAIN" | "RECEIPT_MISMATCH" | "REVERTED" | "INSUFFICIENT_CONFIRMATIONS" | "NO_MATCHING_ORDER_FILL" | "ORDER_FILLED";

function validAddress(value: string) { return /^0x[\da-fA-F]{40}$/.test(value); }
function validHash(value: string) { return /^0x[\da-fA-F]{64}$/.test(value); }
function normalizeIds(ids: string[]) {
  if (!ids.length || ids.some((id) => !/^\d+$/.test(id) || BigInt(id) >= 2n ** 40n)) throw new Error("Expected Kuru order IDs must be nonempty uint40 decimal strings.");
  return new Set(ids.map((id) => BigInt(id).toString()));
}
function validateContext(receipt: KuruOrderReceipt, transactionHash: string, market: string, account: string, minimumConfirmations: number) {
  if (!validHash(transactionHash) || !validHash(receipt.transactionHash) || !validAddress(market) || !validAddress(account)
    || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0
    || !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < 0
    || !Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < 1) {
    throw new Error("Invalid Kuru receipt reconciliation context.");
  }
}
function receiptGate(receipt: KuruOrderReceipt, transactionHash: string, observedChainId: number, expectedChainId: number, minimumConfirmations: number) {
  if (!Number.isSafeInteger(expectedChainId) || expectedChainId <= 0 || !Number.isSafeInteger(observedChainId) || observedChainId <= 0) throw new Error("Verified chain IDs must be positive safe integers.");
  if (observedChainId !== expectedChainId) return "WRONG_CHAIN" as const;
  if (receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) return "RECEIPT_MISMATCH" as const;
  if (receipt.status !== 1) return "REVERTED" as const;
  if (receipt.confirmations < minimumConfirmations) return "INSUFFICIENT_CONFIRMATIONS" as const;
  return null;
}

/** Match a successful Kuru placement receipt to one exact account, side, price, and size. */
export function reconcileOrderCreatedReceipt(
  receipt: KuruOrderReceipt,
  expected: ExpectedKuruOrder,
  observedChainId: number,
  expectedChainId: number,
  minimumConfirmations = 1,
): { verdict: OrderReceiptVerdict; orderId: string | null; blockNumber: number | null } {
  validateContext(receipt, expected.transactionHash, expected.market, expected.account, minimumConfirmations);
  if (!(expected.side === "buy" || expected.side === "sell") || !/^\d+$/.test(expected.rawPrice) || !/^\d+$/.test(expected.rawSize)
    || BigInt(expected.rawPrice) > 2n ** 32n - 1n || BigInt(expected.rawSize) > 2n ** 96n - 1n) {
    throw new Error("Expected order price, size, or side is invalid for Kuru's event schema.");
  }
  const gate = receiptGate(receipt, expected.transactionHash, observedChainId, expectedChainId, minimumConfirmations);
  if (gate) return { verdict: gate, orderId: null, blockNumber: receipt.blockNumber };
  const matches: string[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== expected.market.toLowerCase()) continue;
    try {
      const parsed = ORDER_EVENTS.parseLog({ topics: log.topics, data: log.data });
      if (parsed.name !== "OrderCreated" || String(parsed.args.owner).toLowerCase() !== expected.account.toLowerCase()) continue;
      if (Boolean(parsed.args.isBuy) !== (expected.side === "buy")
        || BigInt(parsed.args.price.toString()).toString() !== BigInt(expected.rawPrice).toString()
        || BigInt(parsed.args.size.toString()).toString() !== BigInt(expected.rawSize).toString()) continue;
      matches.push(BigInt(parsed.args.orderId.toString()).toString());
    } catch { /* unrelated or malformed log; it cannot confirm the requested order */ }
  }
  if (!matches.length) return { verdict: "NO_MATCHING_ORDER_CREATED", orderId: null, blockNumber: receipt.blockNumber };
  if (matches.length !== 1) return { verdict: "AMBIGUOUS_ORDER_CREATED", orderId: null, blockNumber: receipt.blockNumber };
  return { verdict: "ORDER_CREATED", orderId: matches[0]!, blockNumber: receipt.blockNumber };
}

/** Require a successful receipt event from the configured market and account for every requested cancellation. */
export function reconcileOrdersCancelledReceipt(
  receipt: KuruOrderReceipt,
  expected: { transactionHash: string; market: string; account: string; orderIds: string[] },
  observedChainId: number,
  expectedChainId: number,
  minimumConfirmations = 1,
): { verdict: CancelReceiptVerdict; cancelledOrderIds: string[]; blockNumber: number | null } {
  validateContext(receipt, expected.transactionHash, expected.market, expected.account, minimumConfirmations);
  const requested = normalizeIds(expected.orderIds);
  const gate = receiptGate(receipt, expected.transactionHash, observedChainId, expectedChainId, minimumConfirmations);
  if (gate) return { verdict: gate, cancelledOrderIds: [], blockNumber: receipt.blockNumber };
  const cancelled = new Set<string>();
  let unexpectedCancellation = false;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== expected.market.toLowerCase()) continue;
    try {
      const parsed = ORDER_EVENTS.parseLog({ topics: log.topics, data: log.data });
      if (parsed.name !== "OrdersCanceled" || String(parsed.args.owner).toLowerCase() !== expected.account.toLowerCase()) continue;
      for (const id of parsed.args.orderId as { toString(): string }[]) {
        const normalized = BigInt(id.toString()).toString();
        cancelled.add(normalized);
        if (!requested.has(normalized)) unexpectedCancellation = true;
      }
    } catch { /* unrelated or malformed log; it cannot confirm a cancellation */ }
  }
  const cancelledOrderIds = [...cancelled].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  if (unexpectedCancellation) return { verdict: "UNEXPECTED_ORDER_CANCELLED", cancelledOrderIds, blockNumber: receipt.blockNumber };
  if (cancelled.size !== requested.size) return { verdict: "CANCEL_NOT_CONFIRMED", cancelledOrderIds, blockNumber: receipt.blockNumber };
  return { verdict: "ORDERS_CANCELLED", cancelledOrderIds, blockNumber: receipt.blockNumber };
}

/** Reconcile later on-chain maker fills to exact order IDs, maker, side, and price. */
export function reconcileOrderFillReceipt(
  receipt: KuruOrderReceipt,
  expected: { transactionHash: string; market: string; orders: ExpectedMakerOrder[] },
  observedChainId: number,
  expectedChainId: number,
  minimumConfirmations = 1,
): { verdict: FillReceiptVerdict; fills: { orderId: string; side: "buy" | "sell"; rawPrice: string; rawSize: string; remainingRawSize: string; logIndex: number }[]; blockNumber: number | null } {
  if (!validHash(expected.transactionHash) || !validAddress(expected.market) || !expected.orders.length) throw new Error("Expected maker orders and receipt context are required.");
  const orderIds = normalizeIds(expected.orders.map((order) => order.orderId));
  const orders = new Map<string, ExpectedMakerOrder>();
  for (const order of expected.orders) {
    if (!validAddress(order.makerAddress) || !(order.side === "buy" || order.side === "sell")
      || !/^\d+$/.test(order.rawPrice) || BigInt(order.rawPrice) >= 2n ** 256n
      || !/^\d+$/.test(order.rawSize) || BigInt(order.rawSize) <= 0n || BigInt(order.rawSize) >= 2n ** 96n) {
      throw new Error("Expected maker order has invalid address, side, uint256 price, or uint96 size.");
    }
    const id = BigInt(order.orderId).toString();
    if (orders.has(id)) throw new Error("Expected maker order IDs must be unique.");
    orders.set(id, order);
  }
  // `normalizeIds` also validates each uint40 ID; keep this explicit read so the set is part of the checked context.
  if (orderIds.size !== orders.size) throw new Error("Expected maker order IDs must be unique.");
  validateContext(receipt, expected.transactionHash, expected.market, expected.orders[0]!.makerAddress, minimumConfirmations);
  const gate = receiptGate(receipt, expected.transactionHash, observedChainId, expectedChainId, minimumConfirmations);
  if (gate) return { verdict: gate, fills: [], blockNumber: receipt.blockNumber };
  const fills: { orderId: string; side: "buy" | "sell"; rawPrice: string; rawSize: string; remainingRawSize: string; logIndex: number }[] = [];
  const seenLogIndices = new Set<number>();
  const remainingByOrder = new Map([...orders].map(([id, order]) => [id, BigInt(order.rawSize)]));
  const invalidOrders = new Set<string>();
  const indexedLogs = receipt.logs.map((log, index) => ({ log, index, logIndex: log.logIndex ?? index }))
    .sort((a, b) => a.logIndex - b.logIndex || a.index - b.index);
  indexedLogs.forEach(({ log, index, logIndex }) => {
    if (log.address.toLowerCase() !== expected.market.toLowerCase()) return;
    try {
      const parsed = ORDER_EVENTS.parseLog({ topics: log.topics, data: log.data });
      if (parsed.name !== "Trade") return;
      const orderId = BigInt(parsed.args.orderId.toString()).toString();
      const order = orders.get(orderId);
      if (!order || String(parsed.args.makerAddress).toLowerCase() !== order.makerAddress.toLowerCase()) return;
      const isTakerBuy = Boolean(parsed.args.isBuy);
      const makerSide = isTakerBuy ? "sell" : "buy";
      const rawPrice = BigInt(parsed.args.price.toString()).toString();
      const rawSize = BigInt(parsed.args.filledSize.toString()).toString();
      const remainingRawSize = BigInt(parsed.args.updatedSize.toString()).toString();
      if (invalidOrders.has(orderId)) return;
      if (makerSide !== order.side || rawPrice !== BigInt(order.rawPrice).toString() || BigInt(rawSize) <= 0n
        || BigInt(rawSize) >= 2n ** 96n || BigInt(remainingRawSize) >= 2n ** 96n
        || !Number.isSafeInteger(logIndex) || logIndex < 0 || seenLogIndices.has(logIndex)) {
        invalidOrders.add(orderId);
        return;
      }
      const previousRemaining = remainingByOrder.get(orderId)!;
      if (BigInt(rawSize) > previousRemaining || previousRemaining - BigInt(rawSize) !== BigInt(remainingRawSize)) {
        invalidOrders.add(orderId);
        return;
      }
      seenLogIndices.add(logIndex);
      remainingByOrder.set(orderId, BigInt(remainingRawSize));
      fills.push({ orderId, side: order.side, rawPrice, rawSize, remainingRawSize, logIndex });
    } catch { /* unrelated or malformed log; it cannot confirm a maker fill */ }
  });
  if (invalidOrders.size) return { verdict: "RECEIPT_MISMATCH", fills: [], blockNumber: receipt.blockNumber };
  return { verdict: fills.length ? "ORDER_FILLED" : "NO_MATCHING_ORDER_FILL", fills, blockNumber: receipt.blockNumber };
}
