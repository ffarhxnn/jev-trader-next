import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractPaperBookTimeline, PaperBookObservationCapture } from "../src/paper-book-timeline";
import type { Book } from "../src/types";

function book(timestamp = 1000, block = 10) {
  return { timestamp, block, chainId: 143, market: `0x${"1".repeat(40)}`, tickSize: 0.000001,
    sizePrecision: 1e10, minSizeMon: 200, makerFeeBps: 0, takerFeeBps: 0, captureIntervalMs: 1000,
    bids: [[0.03, 42]], asks: [[0.030002, 71]] };
}
function observation(inputSnapshot: unknown = book(), timestamp = 1000, publishedAt = timestamp + 200) {
  return { kind: "book_observed", timestamp, observedAt: timestamp, publishedAt, inputSnapshot };
}
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");

test("producer retains a changed book at the same receipt millisecond and deduplicates republications", () => {
  const capture = new PaperBookObservationCapture();
  const input: Book = { ...book(), receivedAt: 1000, source: "Monad Kuru", bid: 0.03, ask: 0.030002,
    mid: (0.03 + 0.030002) / 2, spreadBps: 0.66, bids: [[0.03, 42]], asks: [[0.030002, 71]] };
  expect(capture.observe(null, 1100)).toBeNull();
  const first = capture.observe(input, 1200);
  expect(first?.publishedAt).toBe(1200);
  expect(first?.timestamp).toBe(1000);
  expect(capture.observe(input, 1500)).toBeNull();
  const conflicting = capture.observe({ ...input, block: 11 }, 1600);
  expect(conflicting?.inputSnapshot?.block).toBe(11);
  expect(() => extractPaperBookTimeline(jsonl(first, conflicting))).toThrow("Contradictory duplicate");
  expect(capture.observe({ ...input, block: 11 }, 1700)).toBeNull();
  const depthChanged = capture.observe({ ...input, block: 11, bids: [[0.03, 43]] }, 1800);
  expect(depthChanged).not.toBeNull();
  expect(() => extractPaperBookTimeline(jsonl(conflicting, depthChanged))).toThrow("Contradictory duplicate");
  // The first audit snapshot stays fixed even if the engine's public book object is later changed.
  input.bids![0]![1] = 99;
  expect(first?.inputSnapshot?.bids[0]![1]).toBe(42);
});

test("exact observation time remains independent of publication time and decision rows", () => {
  const rows = extractPaperBookTimeline(jsonl(observation(), { kind: "decision", timestamp: 1999, inputSnapshot: book(1999) }, observation(book(2000, 11), 2000, 4500)));
  expect(rows.map(row => [row.timestamp, row.block])).toEqual([[1000, 10], [2000, 11]]);
  expect(rows.some(row => "publishedAt" in row)).toBe(false);
});

test("repeated publications deduplicate identical observation identity but reject contradictions", () => {
  expect(extractPaperBookTimeline(jsonl(observation(), observation(book(), 1000, 3000)))).toHaveLength(1);
  expect(() => extractPaperBookTimeline(jsonl(observation(), observation({ ...book(), block: 11 })))).toThrow("Contradictory duplicate");
  expect(() => extractPaperBookTimeline(jsonl(observation(), observation({ ...book(), bids: [[0.03, 43]] })))).toThrow("Contradictory duplicate");
});

test("legacy decision-only and missing or malformed observed books fail closed", () => {
  expect(() => extractPaperBookTimeline(jsonl({ kind: "decision", inputSnapshot: book() }))).toThrow("Missing observed-book timeline");
  for (const input of [null, {}, { ...book(), chainId: 1 }, { ...book(), block: 1.5 }, { ...book(), makerFeeBps: -1 },
    { ...book(), takerFeeBps: null }, { ...book(), captureIntervalMs: 0 }, { ...book(), sizePrecision: 123 },
    { ...book(), tickSize: 0.000000001 }, { ...book(), asks: [[0.030002, 1], [0.030001, 1]] }]) {
    expect(() => extractPaperBookTimeline(jsonl(observation(input)))).toThrow("Invalid observed book input");
  }
  expect(() => extractPaperBookTimeline(jsonl(observation(book(), 999)))).toThrow("Invalid observed book input");
  expect(() => extractPaperBookTimeline(jsonl(observation(book(), 1000, 999)))).toThrow("Invalid observed book input");
});

test("time and block rollbacks are refused without sorting", () => {
  expect(() => extractPaperBookTimeline(jsonl(observation(), observation(book(999, 11), 999)))).toThrow("rollback");
  expect(() => extractPaperBookTimeline(jsonl(observation(), observation(book(2000, 9), 2000)))).toThrow("rollback");
});

test("real cadence gaps are marked without inferred bridging; adjacent positive cadence may change", () => {
  const rows = extractPaperBookTimeline(jsonl(observation(), observation(book(4001, 11), 4001),
    observation({ ...book(9000, 12), captureIntervalMs: 2000 }, 9000)));
  expect(rows.map(row => row.timestamp)).toEqual([1000, 4001, 9000]);
  expect(rows.map(row => row.gapBefore ?? false)).toEqual([false, true, false]);
  expect(extractPaperBookTimeline(jsonl(observation(), observation(book(4000, 10), 4000)))[1]!.gapBefore).toBeUndefined();
});

test("market, tick, precision, minimum and fee changes are refused", () => {
  for (const change of [{ market: `0x${"2".repeat(40)}` }, { tickSize: 0.000002 }, { sizePrecision: 1e9 },
    { minSizeMon: 300 }, { makerFeeBps: 1 }, { takerFeeBps: 1 }]) {
    expect(() => extractPaperBookTimeline(jsonl(observation(), observation({ ...book(2000, 11), ...change }, 2000)))).toThrow("metadata");
  }
});

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test("CLI writes only public depth into an exclusively created owner-only file", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-extract-books-")); directories.push(directory);
  const source = join(directory, "source.jsonl"), output = join(directory, "depth.jsonl");
  writeFileSync(source, jsonl({ ...observation({ ...book(), prompt: "PRIVATE_SENTINEL", account: "PRIVATE_SENTINEL", rpcEndpointIndex: 1 }),
    response: "PRIVATE_SENTINEL", model: "PRIVATE_SENTINEL" }, { kind: "decision", response: "PRIVATE_SENTINEL" }));
  const run = () => Bun.spawnSync([process.execPath, "--no-env-file", resolve(import.meta.dir, "../scripts/extract-paper-books.ts"), source, output]);
  const first = run();
  expect(first.exitCode).toBe(0);
  expect(JSON.parse(first.stdout.toString()).observations).toBe(1);
  const extracted = readFileSync(output, "utf8");
  expect(JSON.parse(extracted)).toEqual(book());
  expect(extracted + first.stdout.toString() + first.stderr.toString()).not.toContain("PRIVATE_SENTINEL");
  expect(statSync(output).mode & 0o777).toBe(0o600);
  const second = run();
  expect(second.exitCode).not.toBe(0);
  expect(second.stderr.toString()).toContain("EEXIST");
  expect(readFileSync(output, "utf8")).toBe(extracted);
});
