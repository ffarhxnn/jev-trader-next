/** Treat a missing capture interval as a book-state gap; queued orders cannot be inferred across it. */
export function hasL2CaptureGap(previousTimestamp: number | null, currentTimestamp: number, captureIntervalMs: number): boolean {
  if (!Number.isFinite(currentTimestamp) || !Number.isFinite(captureIntervalMs) || captureIntervalMs <= 0) {
    throw new Error("L2 capture timestamps and interval must be finite, with a positive interval.");
  }
  if (previousTimestamp === null) return false;
  if (!Number.isFinite(previousTimestamp)) throw new Error("Previous L2 capture timestamp must be finite.");
  return currentTimestamp <= previousTimestamp
    || currentTimestamp - previousTimestamp > Math.max(3_000, captureIntervalMs * 3);
}
