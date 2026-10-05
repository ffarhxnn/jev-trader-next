import { describe, expect, test } from "bun:test";
import { hasL2CaptureGap } from "../src/capture";

describe("L2 capture continuity", () => {
  test("marks non-increasing timestamps and pauses longer than three capture intervals", () => {
    expect(hasL2CaptureGap(null, 1_000, 1_000)).toBe(false);
    expect(hasL2CaptureGap(1_000, 4_000, 1_000)).toBe(false);
    expect(hasL2CaptureGap(1_000, 4_001, 1_000)).toBe(true);
    expect(hasL2CaptureGap(1_000, 10_000, 3_000)).toBe(false);
    expect(hasL2CaptureGap(1_000, 10_001, 3_000)).toBe(true);
    expect(hasL2CaptureGap(4_000, 4_000, 1_000)).toBe(true);
    expect(hasL2CaptureGap(4_000, 3_999, 1_000)).toBe(true);
  });

  test("rejects invalid timestamp or interval input", () => {
    expect(() => hasL2CaptureGap(null, Number.NaN, 1_000)).toThrow("finite");
    expect(() => hasL2CaptureGap(1_000, 2_000, 0)).toThrow("positive interval");
    expect(() => hasL2CaptureGap(Number.NaN, 2_000, 1_000)).toThrow("Previous L2");
  });
});
