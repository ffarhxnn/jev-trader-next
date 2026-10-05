import type { Book, DepthSnapshot } from "./types";
import { validateDepthSnapshot } from "./research";

/** Capture only the public book actually supplied to the decision, at local receipt time. */
export function captureDecisionReplayInput(book: Book): DepthSnapshot | null {
  if (book.source !== "Monad Kuru" || !Number.isFinite(book.receivedAt)
    || book.chainId !== 143 || !book.market || !/^0x[\da-fA-F]{40}$/.test(book.market)
    || !Number.isFinite(book.sizePrecision) || !(Number(book.sizePrecision) > 0)
    || !Number.isFinite(book.minSizeMon) || !(Number(book.minSizeMon) > 0)
    || !Number.isFinite(book.tickSize) || !(Number(book.tickSize) > 0)
    || !Number.isFinite(book.makerFeeBps) || !book.bids || !book.asks) return null;
  const snapshot: DepthSnapshot = {
    timestamp: book.receivedAt!, block: book.block, chainId: book.chainId,
    market: book.market.toLowerCase(), tickSize: book.tickSize,
    sizePrecision: book.sizePrecision, minSizeMon: book.minSizeMon,
    makerFeeBps: book.makerFeeBps,
    ...(book.takerFeeBps !== undefined ? { takerFeeBps: book.takerFeeBps } : {}),
    ...(book.captureIntervalMs !== undefined ? { captureIntervalMs: book.captureIntervalMs } : {}),
    bids: book.bids.map(([price, size]) => [price, size]),
    asks: book.asks.map(([price, size]) => [price, size]),
  };
  if (!validateDepthSnapshot(snapshot) || snapshot.bids[0]![0] !== book.bid || snapshot.asks[0]![0] !== book.ask
    || (book.bid + book.ask) / 2 !== book.mid || !Number.isSafeInteger(snapshot.block) || snapshot.block < 1) return null;
  return snapshot;
}
