import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzePaperTradeCandidates } from "../src/paper-trade-analysis";

const args = Bun.argv.slice(2);
if (args.length !== 4 || args[2] !== "--tick-size" || args.includes("--help")) {
  console.log("Usage: bun scripts/paper-trade-analysis.ts <paper-audit.jsonl> <kuru-trades.jsonl> --tick-size <market-tick>");
  process.exit(args.includes("--help") ? 0 : 2);
}
const tickSize = Number(args[3]);
console.log(JSON.stringify(analyzePaperTradeCandidates(
  readFileSync(resolve(args[0]!), "utf8"),
  readFileSync(resolve(args[1]!), "utf8"),
  tickSize,
), null, 2));
