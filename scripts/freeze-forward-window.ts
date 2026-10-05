import { freezeForwardCapture } from "../src/freeze-forward-capture";
const args = Bun.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: bun --no-env-file scripts/freeze-forward-window.ts <protocol.json> --out-prefix <existing-directory/prefix>");
} else {
  try {
    if (args.length !== 3 || !args[0]!.endsWith(".json") || args[1] !== "--out-prefix" || !args[2] || args[2]!.startsWith("--")) throw new Error("INVALID_ARGUMENTS");
    console.log(JSON.stringify(freezeForwardCapture(args[0]!, args[2]!)));
  } catch(error) {
    // Do not print raw source rows, paths from filesystem errors, or arbitrary exception messages.
    const code = error && typeof error === "object" && "code" in error && error.code === "EEXIST" ? "OUTPUT_ALREADY_EXISTS"
      : error instanceof Error && ["INVALID_ARGUMENTS", "SOURCE_CHANGED", "SOURCE_SIZE_OR_TYPE", "SOURCE_PATH_MISMATCH", "OUTPUT_SOURCE_COLLISION", "FROZEN_OUTPUT_CHANGED"].includes(error.message) ? error.message : "INVALID_FORWARD_CAPTURE";
    console.log(JSON.stringify({status:"FREEZE_FAILED",code}));
    process.exitCode = 1;
  }
}
