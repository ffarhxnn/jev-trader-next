import { describe, expect, test } from "bun:test";
import { qualifyKuruBook } from "../src/market-qualification";

describe("Kuru test market book qualification", () => {
  test("requires positive depth on both sides of an uncrossed book", () => {
    const result = qualifyKuruBook([[99, 10], [98, 20]], [[101, 8], [102, 12]]);
    expect(result.state).toBe("TWO_SIDED");
    expect(result.twoSidedPositiveDepth).toBe(true);
    expect(result.bestBid).toBe(99);
    expect(result.bestAsk).toBe(101);
    expect(result.spreadBps).toBeCloseTo(200, 10);
  });

  test("rejects empty, one-sided, locked, crossed, and nonpositive depth", () => {
    expect(qualifyKuruBook([], []).state).toBe("EMPTY");
    expect(qualifyKuruBook([], [[101, 1]]).state).toBe("ONE_SIDED");
    expect(qualifyKuruBook([[99, 1]], [[99, 3]]).state).toBe("LOCKED");
    expect(qualifyKuruBook([[100, 1]], [[99, 3]]).state).toBe("CROSSED");
    expect(qualifyKuruBook([[99, 0]], [[101, 1]]).state).toBe("ONE_SIDED");
    expect(qualifyKuruBook([[99, Number.NaN]], [[101, Number.POSITIVE_INFINITY]]).state).toBe("EMPTY");
  });
});
