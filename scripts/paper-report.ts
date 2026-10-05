import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { summarizePaperAudit } from "../src/paper-audit-report";

const paths = Bun.argv.slice(2);
if (!paths.length || paths.includes("--help")) {
  console.log("Usage: bun scripts/paper-report.ts <paper-audit.jsonl> [more-session-files.jsonl ...]");
  process.exit(paths.includes("--help") ? 0 : 2);
}

console.log(JSON.stringify(paths.map((path) => ({ file: resolve(path), ...summarizePaperAudit(readFileSync(resolve(path), "utf8")) })), null, 2));
