import { hasL2CaptureGap } from "./capture";
import { validateDepthSnapshot } from "./research";
import { captureDecisionReplayInput } from "./decision-replay-input";
import type { Book, DepthSnapshot } from "./types";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const metadata = (s: DepthSnapshot) => JSON.stringify([s.chainId, s.market, s.tickSize, s.sizePrecision,
  s.minSizeMon, s.makerFeeBps, s.takerFeeBps]);

/** Deduplicate republications, but retain conflicting observations so extraction fails closed. */
export class PaperBookObservationCapture {
  private receivedAt: number | undefined;
  private fingerprint: string | undefined;

  observe(book: Book | null, publishedAt: number) {
    if (!book || book.receivedAt === undefined) return null;
    const inputSnapshot = captureDecisionReplayInput(book);
    const fingerprint = JSON.stringify(inputSnapshot);
    if (book.receivedAt === this.receivedAt && fingerprint === this.fingerprint) return null;
    this.receivedAt = book.receivedAt;
    this.fingerprint = fingerprint;
    return { kind: "book_observed", timestamp: book.receivedAt, observedAt: book.receivedAt, publishedAt, inputSnapshot };
  }
}

/** Extract only explicit observed books, in file order; never reconstruct a book from a decision. */
export function extractPaperBookTimeline(contents: string): DepthSnapshot[] {
  const result: DepthSnapshot[] = [];
  const observations = new Map<number, string>();
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { throw new Error(`Invalid paper audit JSON at row ${index + 1}.`); }
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Invalid paper audit row ${index + 1}.`);
    if (row.kind !== "book_observed") continue;
    const fail = () => { throw new Error(`Invalid observed book input at row ${index + 1}.`); };
    const input = row.inputSnapshot;
    if (!validateDepthSnapshot(input)) fail();
    const s = input as DepthSnapshot;
    if (!finite(row.timestamp) || row.timestamp < 0 || row.timestamp !== s.timestamp
      || (row.observedAt !== undefined && row.observedAt !== row.timestamp)
      || !finite(row.publishedAt) || row.publishedAt < row.timestamp
      || (row.schemaVersion !== undefined && row.schemaVersion !== 1)
      || !Number.isSafeInteger(s.block) || s.block < 1 || s.chainId !== 143
      || typeof s.market !== "string" || !/^0x[\da-fA-F]{40}$/.test(s.market)
      || !finite(s.tickSize) || s.tickSize <= 0 || !finite(s.sizePrecision) || !/^10*$/.test(String(s.sizePrecision))
      || !finite(s.minSizeMon) || s.minSizeMon <= 0
      || !finite(s.makerFeeBps) || s.makerFeeBps < 0 || s.makerFeeBps > 10_000
      || (s.takerFeeBps !== undefined && (!finite(s.takerFeeBps) || s.takerFeeBps < 0 || s.takerFeeBps > 10_000))
      || !finite(s.captureIntervalMs) || s.captureIntervalMs <= 0) fail();
    const tickUnits = Math.round(s.tickSize! * 1e8);
    if (!Number.isSafeInteger(tickUnits) || tickUnits < 1
      || Math.abs(tickUnits / 1e8 - s.tickSize!) > Number.EPSILON * s.tickSize! * 4) fail();
    for (const [side, levels] of [["buy", s.bids], ["sell", s.asks]] as const) {
      let prior: number | null = null;
      for (const level of levels) {
        const [price] = level, raw = price * 1e8, rounded = Math.round(raw);
        if (level.length !== 2 || !Number.isSafeInteger(rounded) || rounded <= 0 || rounded > 0xffffffff
          || rounded % tickUnits !== 0 || Math.abs(raw - rounded) > Math.min(0.125, Number.EPSILON * Math.max(1, Math.abs(raw)) * 2)
          || (prior !== null && (side === "buy" ? price >= prior : price <= prior))) fail();
        prior = price;
      }
    }
    // Rebuild rather than spread the source: audit rows may carry private decision fields.
    const snapshot: DepthSnapshot = {
      timestamp: s.timestamp, block: s.block, chainId: 143, market: s.market!.toLowerCase(),
      tickSize: s.tickSize, sizePrecision: s.sizePrecision, minSizeMon: s.minSizeMon,
      makerFeeBps: s.makerFeeBps, ...(s.takerFeeBps !== undefined ? { takerFeeBps: s.takerFeeBps } : {}),
      captureIntervalMs: s.captureIntervalMs,
      bids: s.bids.map(([p, q]) => [p, q]), asks: s.asks.map(([p, q]) => [p, q]),
      ...(s.gapBefore === true ? { gapBefore: true } : {}),
    };
    const identity = JSON.stringify(snapshot);
    const seen = observations.get(snapshot.timestamp);
    if (seen !== undefined) {
      if (seen !== identity) throw new Error(`Contradictory duplicate book observation at row ${index + 1}.`);
      continue;
    }
    const previous = result.at(-1);
    if (previous) {
      if (snapshot.timestamp <= previous.timestamp || snapshot.block < previous.block)
        throw new Error(`Observed book time/block rollback at row ${index + 1}.`);
      if (metadata(snapshot) !== metadata(previous)) throw new Error(`Changed observed book market metadata at row ${index + 1}.`);
      if (hasL2CaptureGap(previous.timestamp, snapshot.timestamp, Math.max(previous.captureIntervalMs!, snapshot.captureIntervalMs!)))
        snapshot.gapBefore = true;
    }
    observations.set(snapshot.timestamp, identity);
    result.push(snapshot);
  }
  if (!result.length) throw new Error("Missing observed-book timeline: explicit book_observed records are required; decision inputs cannot substitute.");
  return result;
}
