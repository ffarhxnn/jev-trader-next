import { parseTradeJsonl } from "./research";

type RecordRow = { kind: string; timestamp: number; [key: string]: unknown };

/** Compare quote lifetimes with the public trade tape; candidate prints are not proof of fills. */
export function analyzePaperTradeCandidates(auditContents: string, tradeContents: string, tickSize: number) {
  if (!(tickSize > 0) || !Number.isFinite(tickSize)) throw new Error("A positive market tick size is required.");
  const records: RecordRow[] = [];
  for (const [index, line] of auditContents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { throw new Error(`Invalid audit JSON on line ${index + 1}.`); }
    if (!record || typeof record !== "object" || typeof (record as RecordRow).kind !== "string" || !Number.isFinite((record as RecordRow).timestamp)) {
      throw new Error(`Invalid audit record on line ${index + 1}.`);
    }
    records.push(record as RecordRow);
  }
  const lifecycle = records.filter((record) => ["quote_resting", "quote_cancelled", "fill"].includes(record.kind));
  const quoteIds = lifecycle.map((record) => record.quoteId ?? (record.fill as Record<string, unknown> | undefined)?.quoteId);
  if (lifecycle.length && quoteIds.some((id) => typeof id !== "string" || !id)) throw new Error("Quote-linked lifecycle records are required; legacy audit files cannot be joined safely.");

  const { events, coverage, ignored } = parseTradeJsonl(tradeContents);
  const quotes = new Map<string, { side: "buy" | "sell"; price: number; start: number; end: number }>();
  for (const row of lifecycle) {
    const id = String(row.quoteId ?? (row.fill as Record<string, unknown> | undefined)?.quoteId);
    if (row.kind === "quote_resting") {
      if (row.side !== "buy" && row.side !== "sell" || typeof row.price !== "number" || !Number.isFinite(row.price)) throw new Error(`Invalid resting quote ${id}.`);
      quotes.set(id, { side: row.side, price: row.price, start: row.timestamp, end: Number.POSITIVE_INFINITY });
    } else {
      const quote = quotes.get(id);
      if (!quote) throw new Error(`Lifecycle event references unknown quote ${id}.`);
      if (row.kind === "quote_cancelled" || row.kind === "fill" && typeof row.remainingSize === "number" && row.remainingSize <= 0) quote.end = Math.min(quote.end, row.timestamp);
    }
  }

  let candidateTradePrints = 0;
  let quotesWithCandidatePrints = 0;
  let quotesWithFeedCoverage = 0;
  let totalMatchingTradeVolume = 0;
  let throughPriceCandidateTradePrints = 0;
  let quotesWithThroughPriceCandidatePrints = 0;
  let totalThroughPriceCandidateTradeVolume = 0;
  let boundaryCensoredCandidateTradePrints = 0;
  for (const quote of quotes.values()) {
    const stop = Number.isFinite(quote.end) ? quote.end : records.at(-1)?.timestamp ?? quote.start;
    if (coverage.some((window) => window.startTimestamp < stop && window.endTimestamp > quote.start)) quotesWithFeedCoverage++;
    const opposingTaker = quote.side === "buy" ? "sell" : "buy";
    const coveredOpposing = events.filter((event) => event.timestamp >= quote.start && event.timestamp <= stop
      && event.takerSide === opposingTaker
      && coverage.some((window) => event.timestamp >= window.startTimestamp && event.timestamp < window.endTimestamp));
    const isExact = (price: number) => Math.abs(price - quote.price) <= tickSize * 0.5;
    const isThrough = (price: number) => !isExact(price)
      && (quote.side === "buy" ? price < quote.price : price > quote.price);
    // Counts are quote/print pairs; shared timestamps do not establish event ordering.
    boundaryCensoredCandidateTradePrints += coveredOpposing.filter((event) =>
      (event.timestamp === quote.start || event.timestamp === stop) && (isExact(event.price) || isThrough(event.price))).length;
    const interior = coveredOpposing.filter((event) => event.timestamp > quote.start && event.timestamp < stop);
    const matches = interior.filter((event) => isExact(event.price));
    const throughMatches = interior.filter((event) => isThrough(event.price));
    if (matches.length) quotesWithCandidatePrints++;
    candidateTradePrints += matches.length;
    totalMatchingTradeVolume += matches.reduce((sum, event) => sum + event.size, 0);
    if (throughMatches.length) quotesWithThroughPriceCandidatePrints++;
    throughPriceCandidateTradePrints += throughMatches.length;
    totalThroughPriceCandidateTradeVolume += throughMatches.reduce((sum, event) => sum + event.size, 0);
  }
  return {
    evidenceStatus: "PUBLIC_TRADE_CANDIDATES_ONLY" as const,
    quoteIds: quotes.size,
    observedTradeEvents: events.length,
    ignoredTradeEvents: ignored.length,
    quotesWithFeedCoverage,
    candidateTradePrints,
    quotesWithCandidatePrints,
    totalMatchingTradeVolumeMon: totalMatchingTradeVolume,
    throughPriceCandidateTradePrints,
    quotesWithThroughPriceCandidatePrints,
    totalThroughPriceCandidateTradeVolumeMon: totalThroughPriceCandidateTradeVolume,
    combinedCandidateTradePrints: candidateTradePrints + throughPriceCandidateTradePrints,
    boundaryCensoredCandidateTradePrints,
    fillInterpretation: "Exact-price and through-price public trade prints are only candidates. They do not prove timing, queue or counterfactual price priority, or account inclusion; they cannot confirm fills, a fill floor or PnL, or support strategy selection or trading approval. Counts and volumes are quote/print pairs; lifetime boundary candidates are censored because timestamp ordering is ambiguous.",
  };
}
