import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FORWARD_ASSUMPTIONS, FORWARD_BOOK_POLICY, FORWARD_TRADE_POLICY, FORWARD_MARKET, FORWARD_WINDOW_RULE } from "../src/forward-capture";

test("real freeze and replay CLIs satisfy runner bindings on an explicitly synthetic offline fixture", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "jev-forward-integration-"));
  try {
    const sourceAudit = "paper-audit-2026-10-01T00-00-00-000Z.jsonl";
    const protocol = { schemaVersion: 4, declaredAt: "2026-10-01T00:00:00Z", sourceAudit,
      sourceContract: "same-audit-explicit-observed-book-sequence", windowRule: FORWARD_WINDOW_RULE,
      fixedAssumptions: FORWARD_ASSUMPTIONS, model: "local heuristic only, fixed supplied actions; not Jev rerun",
      holdoutScored: false, realMoneyReady: false, bookFreshnessPolicy: FORWARD_BOOK_POLICY,
      bookStaleAfterMs: 5000, tradeFeedLifecyclePolicy: FORWARD_TRADE_POLICY, tradeFeedStaleAfterMs: 60000 };
    const start = Date.parse(protocol.declaredAt) + 1000;
    const book = (i: number) => ({ timestamp: start + i * 1000, block: 100 + i, chainId: 143,
      market: FORWARD_MARKET, tickSize: 0.000001, sizePrecision: 1e10, minSizeMon: 200,
      makerFeeBps: 0, takerFeeBps: 0, captureIntervalMs: 1000, bids: [[0.03, 42]], asks: [[0.030002, 71]] });
    const rows: unknown[] = [{ kind: "session_start", timestamp: start - 1000, mode: "paper",
      model: "stand-in momentum heuristic", market: FORWARD_MARKET, orderSizeMon: 200,
      positionCapMon: 1000, startingCashUsd: 100, lossStopUsd: 20, pollMs: 1000,
      bookStaleAfterMs: 5000, bookFreshnessPolicy: FORWARD_BOOK_POLICY,
      tradeFeedStaleAfterMs: 60000, tradeFeedLifecyclePolicy: FORWARD_TRADE_POLICY,
      quotePricingPolicy: "whole-tick-improvement-or-touch-v1", quoteInsideTicks: 1 }];
    for (let i = 0; i <= 600; i++) rows.push({ kind: "book_observed", timestamp: book(i).timestamp,
      observedAt: book(i).timestamp, publishedAt: book(i).timestamp + 1, inputSnapshot: book(i) });
    rows.push({ kind: "decision", timestamp: start + 10, bookReceivedAt: start, block: 100,
      chainId: 143, bestBid: 0.03, bestAsk: 0.030002, mid: 0.030001, spreadBps: 0.666644,
      action: "hold", model: "stand-in momentum heuristic", decisionSource: "local demo heuristic",
      inputSnapshot: book(0) });
    const protocolPath = join(directory, "protocol.json");
    writeFileSync(protocolPath, JSON.stringify(protocol) + "\n");
    writeFileSync(join(directory, sourceAudit), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    const run = join(directory, "run");
    mkdirSync(run, { mode: 0o700 });
    // These asserted receipt fields are synthetic test inputs, never chain evidence.
    const tape = join(run, "synthetic-trades.jsonl");
    writeFileSync(tape, [
      { kind: "status", status: "connected", timestamp: start },
      { kind: "trade", timestamp: start + 1000, price: 0.03, size: 200, takerSide: "sell",
        rawPrice: "30000000000000000", rawSize: "2000000000000", transactionHash: "0x" + "a".repeat(64),
        receiptVerified: true, receiptFinalizedVerified: true, receiptBlock: 101, receiptLogIndex: 0,
        receiptChainId: 143, receiptMarket: FORWARD_MARKET },
      { kind: "gap", timestamp: start + 600001 },
    ].map(r => JSON.stringify(r)).join("\n") + "\n");
    const python = `import importlib.util,json,pathlib,sys
root,protocol,directory,bun,tape=map(pathlib.Path,sys.argv[1:])
spec=importlib.util.spec_from_file_location('forward_runner',root/'scripts/run-forward-validation.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
r=module.Runner(directory,protocol.read_bytes(),str(bun),deadline_seconds=25,protocol_path=protocol)
frozen=r.invoke('freeze-forward-window.ts',[protocol,'--out-prefix',directory/'frozen'])
assert frozen['ok'] and frozen['result']['status']=='FROZEN_FORWARD_WINDOW'
r.freeze(frozen['result']);r.pins[tape]=module.digest(tape.read_bytes())
results=[]
for latency in [0,500,1000,3000]:
 outcome=r.invoke('single-placement-replay.ts',r.replay_args(tape,latency))
 assert outcome['ok'],outcome.get('code')
 report=outcome['result'];assert r.replay_valid(report,tape,latency)
 assert report['validationStatus']=='INSUFFICIENT_SAMPLE' and report['realMoneyReady'] is False
 results.append(latency)
print(json.dumps({'syntheticOnly':True,'latencies':results}))`;
    const result = Bun.spawnSync(["python3", "-c", python, root, protocolPath, run, process.execPath, tape], {
      cwd: root, env: { PATH: dirname(process.execPath) + ":/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" },
      stdout: "pipe", stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error("Offline integration fixture failed: " + result.stderr.toString());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('{"syntheticOnly": true, "latencies": [0, 500, 1000, 3000]}');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
