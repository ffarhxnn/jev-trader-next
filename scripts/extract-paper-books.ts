import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractPaperBookTimeline } from "../src/paper-book-timeline";

const args = process.argv.slice(2);
try {
  if (args.length !== 2 || args.some(arg => arg.startsWith("--")))
    throw new Error("Usage: bun --no-env-file scripts/extract-paper-books.ts <paper-audit.jsonl> <out-depth.jsonl>");
  const snapshots = extractPaperBookTimeline(readFileSync(resolve(args[0]!), "utf8"));
  writeFileSync(resolve(args[1]!), snapshots.map(row => JSON.stringify(row)).join("\n") + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ observations: snapshots.length, firstObservedAt: snapshots[0]!.timestamp,
    lastObservedAt: snapshots.at(-1)!.timestamp, gaps: snapshots.filter(row => row.gapBefore).length,
    chainId: snapshots[0]!.chainId, market: snapshots[0]!.market }));
} catch (error) {
  // Filesystem error messages may echo a source path; expose only the error code.
  const code = (error as NodeJS.ErrnoException)?.code;
  console.error(code ? `Paper book extraction failed (${code}).` : error instanceof Error ? error.message : "Paper book extraction failed.");
  process.exitCode = 1;
}
