import { expect, test } from "bun:test";
import { prepareSinglePlacementAudit } from "../src/single-placement-audit";
import type { DepthSnapshot } from "../src/types";

const market = `0x${"1".repeat(40)}`;
const depth = (timestamp: number, block: number): DepthSnapshot => ({ timestamp, block, chainId: 143, market,
  tickSize: 0.000001, sizePrecision: 1e10, minSizeMon: 200, makerFeeBps: 0, takerFeeBps: 0,
  captureIntervalMs: 1000, bids: [[0.03, 42]], asks: [[0.030002, 71]] });
const snapshots = [depth(1000, 100), depth(2000, 110), depth(3000, 120), depth(4000, 130)];
const row = (input = depth(1500, 105), completed = 1600) => ({ kind: "decision", timestamp: completed,
  bookReceivedAt: input.timestamp, block: input.block, chainId: 143, bestBid: 0.03, bestAsk: 0.030002,
  mid: 0.030001, spreadBps: 0.666644, action: "buy", model: "test stand-in", decisionSource: "local demo heuristic", inputSnapshot: input });
const prepare = (rows: object[]) => prepareSinglePlacementAudit(rows.map(r => JSON.stringify(r)).join("\n"), snapshots, 1000, 4000);

test("audit replay uses the exact decision input between independent capture observations", () => {
  const result = prepare([row()]);
  expect(result.snapshots.map(r => r.timestamp)).toEqual([1000, 1500, 2000, 3000, 4000]);
  expect(result.decisions).toEqual([{ bookTimestamp: 1500, bookBlock: 105, decidedAt: 1600,
    action: "buy", model: "test stand-in", source: "local demo heuristic" }]);
  expect(result.inputSnapshotsAdded).toBe(1);
  expect(result.selectedDecisionRows).toBe(1);
});

test("legacy, future input, wrong public identity, or mismatched touch cannot be inferred from a nearby book", () => {
  for (const patch of [{ inputSnapshot: undefined }, { bookReceivedAt: null }, { bestBid: 0.029 }, { block: 106 },
    { chainId: 1 }, { inputSnapshot: { ...depth(1500, 105), timestamp: 1600 } },
    { inputSnapshot: { ...depth(1500, 105), minSizeMon: 10 } }, { timestamp: 1499 }]) {
    expect(() => prepare([{ ...row(), ...patch }])).toThrow();
  }
});

test("completion beyond the capture end is counted and censored without exposing its action", () => {
  const result = prepare([row(), row(depth(3500, 125), 4100)]);
  expect(result.selectedDecisionRows).toBe(2);
  expect(result.completionsCensoredAtEnd).toBe(1);
  expect(result.decisions).toHaveLength(1);
  expect(result.snapshots.some(r => r.timestamp === 3500)).toBe(true);
});

test("ambiguous equal-time books, duplicate input decisions and capture gaps fail closed", () => {
  expect(() => prepare([row(depth(2000, 111), 2100)])).toThrow("ordering");
  expect(() => prepare([row(depth(1500, 115))])).toThrow("single causal book timeline");
  expect(() => prepare([row(), { ...row(), timestamp: 1700 }])).toThrow("Multiple decisions");
  expect(() => prepareSinglePlacementAudit(JSON.stringify(row()), [snapshots[0]!, { ...snapshots[1]!, gapBefore: true }, snapshots[2]!], 1000, 3000)).toThrow("continuous");
});

const observedRows = (books = snapshots) => books.map(inputSnapshot => ({ kind: "book_observed",
  timestamp: inputSnapshot.timestamp, observedAt: inputSnapshot.timestamp, publishedAt: inputSnapshot.timestamp + 50, inputSnapshot }));
const strict = (decisions = [row(snapshots[0]!, 1600)], supplied = snapshots, observed = observedRows()) =>
  prepareSinglePlacementAudit([...observed, ...decisions].map(r => JSON.stringify(r)).join("\n"), supplied, 1000, 4000, true);

test("strict lineage preserves exact observed books and censors future completion without insertion", () => {
  const result = strict([row(snapshots[0]!, 1600), row(snapshots[2]!, 4100)]);
  expect(result.snapshots).toEqual(snapshots);
  expect(result.inputSnapshotsAdded).toBe(0);
  expect(result.selectedDecisionRows).toBe(2);
  expect(result.completionsCensoredAtEnd).toBe(1);
  expect(result.decisions).toHaveLength(1);
  expect(result.interpretation).toContain("Strict lineage");
  expect(result.interpretation).toContain("fixed counterfactual");
  expect(result.interpretation).toContain("no decision books are inserted");
});

test("strict mode refuses absent source, omitted boundary/interior books and extra books", () => {
  expect(() => strict(undefined, snapshots, [])).toThrow("Missing observed-book timeline");
  for (const supplied of [snapshots.slice(1), snapshots.slice(0, -1), snapshots.filter(s => s.timestamp !== 2000),
    [snapshots[0]!, depth(1500, 105), ...snapshots.slice(1)]]) {
    expect(() => strict(undefined, supplied)).toThrow("exactly match every observed book");
  }
  expect(() => strict([row()])).toThrow("must already exactly match");
  expect(() => strict(undefined, snapshots, observedRows(snapshots.filter(s => s.timestamp !== 2000)))).toThrow("exactly match every observed book");
});

test("strict canonical comparison ignores property order but refuses depth, cadence and metadata tampering", () => {
  const reordered = snapshots.map(s => Object.fromEntries(Object.entries(s).reverse()) as unknown as DepthSnapshot);
  expect(strict(undefined, reordered).snapshots).toEqual(reordered);
  for (const patch of [{ captureIntervalMs: 2000 }, { makerFeeBps: 1 }, { bids: [[0.03, 43]] as [number, number][] },
    { gapBefore: true }, { rpcEndpointIndex: 0 }]) {
    expect(() => strict(undefined, [snapshots[0]!, { ...snapshots[1]!, ...patch }, ...snapshots.slice(2)])).toThrow("exactly match every observed book");
  }
  expect(() => strict([{ ...row(snapshots[0]!, 1600), inputSnapshot: { ...snapshots[0]!, captureIntervalMs: 2000 } }])).toThrow("must already exactly match");
  expect(() => strict([{ ...row(snapshots[0]!, 1600), inputSnapshot: { ...snapshots[0]!, bids: [[0.03, 43]] } }])).toThrow("must already exactly match");
});

test("strict observed source rejects explicit or genuine gaps and contradictory observed metadata", () => {
  const explicitGap = snapshots.map((s, i) => i === 1 ? { ...s, gapBefore: true } : s);
  expect(() => strict(undefined, explicitGap, observedRows(explicitGap))).toThrow("continuous");
  const genuineGap = [depth(1000, 100), depth(5001, 110), depth(6000, 120)];
  expect(() => prepareSinglePlacementAudit(observedRows(genuineGap).map(r => JSON.stringify(r)).join("\n"), genuineGap, 1000, 6000, true)).toThrow("continuous");
  const changed = snapshots.map((s, i) => i === 1 ? { ...s, minSizeMon: 300 } : s);
  expect(() => strict(undefined, changed, observedRows(changed))).toThrow("metadata");
  expect(() => strict(undefined, snapshots, [...observedRows(), observedRows([{ ...snapshots[0]!, captureIntervalMs: 2000 }])[0]!])).toThrow("Contradictory duplicate");
});

test("strict segment may start just after a real gap, preserving its boundary marker and exact decision input", () => {
  const observed = [depth(1000, 100), depth(5001, 110), depth(6000, 120), depth(7000, 130)];
  const selected = [{ ...observed[1]!, gapBefore: true }, observed[2]!, observed[3]!];
  const audit = [...observedRows(observed), row(observed[1]!, 5100)].map(r => JSON.stringify(r)).join("\n");
  const result = prepareSinglePlacementAudit(audit, selected, 5001, 7000, true);
  expect(result.snapshots).toEqual(selected);
  expect(result.snapshots[0]!.gapBefore).toBe(true);
  expect(result.decisions[0]!.bookTimestamp).toBe(5001);
  expect(result.inputSnapshotsAdded).toBe(0);
  expect(() => prepareSinglePlacementAudit(audit, observed.slice(1), 5001, 7000, true)).toThrow("exactly match every observed book");
  expect(() => prepareSinglePlacementAudit(audit, [observed[0]!, ...selected], 1000, 7000, true)).toThrow("continuous");
  expect(() => prepareSinglePlacementAudit(audit, [{ ...selected[0]!, captureIntervalMs: 2000 }, ...selected.slice(1)], 5001, 7000, true)).toThrow("exactly match every observed book");
});
