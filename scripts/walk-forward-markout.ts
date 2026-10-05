import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { summarizeDecisionMarkouts } from "../src/markout";
import { createPurgedWalkForwardSplit } from "../src/walk-forward";

const args = Bun.argv.slice(2);
const inputPaths = args.filter((arg) => !arg.startsWith("--"));
if (args.includes("--help") || inputPaths.length !== 2) {
  console.log("Usage: bun scripts/walk-forward-markout.ts <paper-audit.jsonl> <kuru-l2.jsonl> [--train-fraction 0.7] [--purge-ms 64000]");
  process.exit(args.includes("--help") ? 0 : 2);
}
function option(name: string, fallback: number) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a finite number.`);
  return value;
}
const auditText = readFileSync(resolve(inputPaths[0]!), "utf8");
const depthText = readFileSync(resolve(inputPaths[1]!), "utf8");
const split = createPurgedWalkForwardSplit(auditText, option("--train-fraction", 0.7), option("--purge-ms", 64_000));
console.log(JSON.stringify({
  evidenceStatus: "CHRONOLOGICAL_HOLDOUT_DESCRIPTIVE_ONLY",
  interpretation: "This purged split reduces horizon leakage around the boundary. It remains a single serially related paper session; it does not establish calibration, profitability, or live-fill behavior.",
  split: { cutoffTimestamp: split.cutoffTimestamp, purgeMs: split.purgeMs, training: split.train, holdout: split.holdout },
  training: summarizeDecisionMarkouts(split.trainAudit, depthText),
  holdout: summarizeDecisionMarkouts(split.holdoutAudit, depthText),
}, null, 2));
