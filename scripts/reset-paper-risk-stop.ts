import { PaperRiskLatch } from "../src/paper-risk-latch";

const args = Bun.argv.slice(2);
if (args.length !== 1 || args[0] !== "--acknowledge-paper-reset") {
  console.error("Usage: bun run risk:reset -- --acknowledge-paper-reset");
  process.exit(2);
}

const removed = new PaperRiskLatch("data/paper-risk-stop.json").reset();
console.log(removed
  ? "Removed the local paper loss-stop latch. Restart paper mode to begin a new simulated session."
  : "No saved paper loss-stop latch exists.");
