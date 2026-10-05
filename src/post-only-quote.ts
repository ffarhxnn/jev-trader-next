export interface PostOnlyQuoteOptions { priceDecimals: number; tickUnits: number; insideTicks: number }

/** Shared Kuru price rule: improve by whole ticks, or join when improvement would cross. */
export function postOnlyQuotePrice(book: { bid: number; ask: number }, side: "buy" | "sell", options: PostOnlyQuoteOptions): number | null {
  const { priceDecimals, tickUnits, insideTicks } = options;
  if (!Number.isFinite(book.bid) || !Number.isFinite(book.ask) || book.bid <= 0 || book.ask <= book.bid
    || (side !== "buy" && side !== "sell") || !Number.isSafeInteger(priceDecimals) || priceDecimals < 0 || priceDecimals > 18
    || !Number.isSafeInteger(tickUnits) || tickUnits <= 0 || !Number.isSafeInteger(insideTicks) || insideTicks < 0) return null;
  const scale = 10 ** priceDecimals;
  const rawBid = book.bid * scale, rawAsk = book.ask * scale;
  const bid = Math.round(rawBid), ask = Math.round(rawAsk);
  const roundingTolerance = (raw: number) => Math.min(0.125, Number.EPSILON * Math.max(1, Math.abs(raw)) * 2);
  if (Math.abs(rawBid - bid) > roundingTolerance(rawBid) || Math.abs(rawAsk - ask) > roundingTolerance(rawAsk)) return null;
  const step = tickUnits * insideTicks;
  if (![bid, ask, step].every(Number.isSafeInteger) || bid <= 0 || ask <= bid
    || bid % tickUnits !== 0 || ask % tickUnits !== 0) return null;
  let price = side === "buy" ? bid + step : ask - step;
  if (side === "buy" && price >= ask) price = bid;
  if (side === "sell" && price <= bid) price = ask;
  if (!Number.isSafeInteger(price) || price <= 0 || price % tickUnits !== 0) return null;
  const result = price / scale;
  return side === "buy" ? result < book.ask ? result : null : result > book.bid ? result : null;
}
