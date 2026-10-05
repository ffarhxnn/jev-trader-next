import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { summarizeDecisionMarkouts } from "../src/markout";

const args = Bun.argv.slice(2);
if (args.includes("--help") || args.length !== 2) {
  console.log("Usage: bun scripts/markout.ts <paper-audit.jsonl> <kuru-l2.jsonl>");
  process.exit(args.includes("--help") ? 0 : 2);
}

const [auditPath, depthPath] = args;
console.log(JSON.stringify(summarizeDecisionMarkouts(
  readFileSync(resolve(auditPath!), "utf8"),
  readFileSync(resolve(depthPath!), "utf8"),
), null, 2));
