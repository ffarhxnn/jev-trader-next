export interface KuruBookQualification {
  state: "EMPTY" | "ONE_SIDED" | "CROSSED" | "LOCKED" | "TWO_SIDED";
  bestBid: number | null;
  bestAsk: number | null;
  spreadBps: number | null;
  twoSidedPositiveDepth: boolean;
}

type Level = readonly number[];

function validLevels(levels: readonly Level[]) {
  return levels.filter((level) => Number.isFinite(level[0]) && level[0]! > 0 && Number.isFinite(level[1]) && level[1]! > 0);
}

/** Read-only gate for whether captured Kuru top-of-book data can support a two-sided lifecycle test. */
export function qualifyKuruBook(bids: readonly Level[], asks: readonly Level[]): KuruBookQualification {
  const validBids = validLevels(bids).sort((a, b) => b[0]! - a[0]!);
  const validAsks = validLevels(asks).sort((a, b) => a[0]! - b[0]!);
  const bestBid = validBids[0]?.[0] ?? null;
  const bestAsk = validAsks[0]?.[0] ?? null;
  const bothSides = bestBid !== null && bestAsk !== null;
  const spreadBps = bothSides ? (bestAsk! - bestBid!) / ((bestAsk! + bestBid!) / 2) * 10_000 : null;
  const state = !validBids.length && !validAsks.length ? "EMPTY"
    : !bothSides ? "ONE_SIDED"
      : bestBid! > bestAsk! ? "CROSSED"
        : bestBid === bestAsk ? "LOCKED" : "TWO_SIDED";
  return { state, bestBid, bestAsk, spreadBps, twoSidedPositiveDepth: state === "TWO_SIDED" };
}
