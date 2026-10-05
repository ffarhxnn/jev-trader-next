import { config } from "./config";
import { resolve } from "node:path";
import { DemoBookReader, KuruBookReader, type BookReader } from "./book";
import { DemoModel, GeminiModel, JevModel, OpenCodeGoModel, PausedModel, type DecisionModel } from "./model";
import { PaperEngine } from "./paper";
import { PaperAuditLog, publicTradeAuditRecord } from "./paper-audit";
import { captureDecisionReplayInput } from "./decision-replay-input";
import { PaperBookObservationCapture } from "./paper-book-timeline";
import { PaperRiskLatch } from "./paper-risk-latch";
import { BudgetedProviderModel, ProviderRequestBudget } from "./provider-request-budget";
import { KuruTradeFeed } from "./trade-feed";
import { SerialPoll } from "./serial-poll";
import type { Snapshot } from "./types";

const reader: BookReader = config.mode === "paper" ? new KuruBookReader() : new DemoBookReader();
const model: DecisionModel = config.model === "jev"
  ? new JevModel(config.jevRequestsEnabled ? process.env.OPENCODE_API_KEY : undefined)
  : config.model === "gemini"
    ? new GeminiModel(process.env.GEMINI_REQUESTS_ENABLED === "1" ? process.env.GEMINI_API_KEY : undefined)
    : config.model === "opencode-go"
      ? new OpenCodeGoModel(process.env.OPENCODE_GO_REQUESTS_ENABLED === "1" ? process.env.OPENCODE_GO_API_KEY : undefined)
      : config.model === "paused" ? new PausedModel() : new DemoModel();
const requestBudget = new ProviderRequestBudget(config.modelMaxRequestsPerUtcDay, resolve("data/provider-request-budget.json"));
const budgetedModel: DecisionModel = ["jev", "gemini", "opencode-go"].includes(config.model)
  ? new BudgetedProviderModel(model, requestBudget, config.model)
  : model;
const paperRiskLatch = config.mode === "paper" ? new PaperRiskLatch(resolve("data/paper-risk-stop.json")) : null;
const existingRiskStop = paperRiskLatch?.read(config.market) ?? null;
const engine = new PaperEngine({ mode: config.mode, model: budgetedModel, riskStop: existingRiskStop, persistRiskStop: (state) => paperRiskLatch?.latch(state) });
const audit = config.mode === "paper"
  ? new PaperAuditLog(resolve(`data/paper-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`))
  : null;
if (audit) audit.append({
  kind: "session_start", timestamp: Date.now(), mode: config.mode, model: budgetedModel.name,
  market: config.market.toLowerCase(), orderSizeMon: config.orderSizeMon,
  positionCapMon: config.maxPositionMon, startingCashUsd: config.initialCashUsd,
  lossStopUsd: config.maxLossUsd, pollMs: config.pollMs,
  bookStaleAfterMs: config.staleAfterMs, bookFreshnessPolicy: "paper-kuru-advancing-block-watchdog-trade-and-model-guard-v1",
  tradeFeedStaleAfterMs: config.tradeFeedStaleAfterMs, tradeFeedLifecyclePolicy: "generation-owned-sockets-and-timers-v1",
  quotePricingPolicy: "whole-tick-improvement-or-touch-v1", quoteInsideTicks: 1,
  publicTradeAuditPolicy: "whitelisted-accepted-and-ignored-provenance-v1",
});
const tradeFeed = config.mode === "paper" && reader instanceof KuruBookReader
  ? new KuruTradeFeed(reader, (trade) => {
    audit?.append(publicTradeAuditRecord(trade, true));
    engine.onTrade(trade);
  }, (healthy) => {
    audit?.append({ kind: "public_trade_feed_state", timestamp: Date.now(), healthy });
    engine.setTradeFeedHealthy(healthy);
  }, (event) => {
    if (event) audit?.append(publicTradeAuditRecord(event, false));
    engine.onIgnoredTrade();
  })
  : null;
tradeFeed?.start();
const subscribers = new Set<(event: string, snapshot: Snapshot) => void>();
let snapshot = engine.snapshot();
let auditedDecisions = 0;
let auditedStatus: string | null = null;
const observedBookCapture = new PaperBookObservationCapture();
engine.subscribeLifecycle((event) => {
  if (!audit) return;
  if (event.kind === "quote_resting") audit.append({
    kind: event.kind, timestamp: event.timestamp, block: event.block, quoteId: event.quote.quoteId,
    side: event.quote.side, price: event.quote.price, size: event.quote.size,
    queueAhead: event.quote.queueAhead ?? null, positionMon: event.positionMon, cashUsd: event.cashUsd,
  });
  else if (event.kind === "quote_cancelled") audit.append({
    kind: event.kind, timestamp: event.timestamp, block: event.block, quoteId: event.quoteId,
    side: event.side, price: event.price, remainingSize: event.remainingSize, reason: event.reason,
  });
  else audit.append({
    kind: event.kind, timestamp: event.timestamp, quoteId: event.fill.quoteId, block: event.fill.block,
    side: event.fill.side, price: event.fill.price, size: event.fill.size, remainingSize: event.remainingSize, source: event.fill.source,
    tradeTransactionHash: event.fill.tradeTransactionHash ?? null, tradeSourceTimestamp: event.fill.tradeSourceTimestamp ?? null,
    positionMon: event.positionMon, cashUsd: event.cashUsd, equityUsd: event.equityUsd, feesUsd: event.feesUsd,
  });
});
engine.subscribe((next) => {
  if (audit) {
    const observedBook = observedBookCapture.observe(next.book, next.ts);
    if (observedBook) audit.append(observedBook);
    if (next.totals.decisions > auditedDecisions) {
      if (next.decision && next.book) {
        audit.append({
          kind: "decision", timestamp: next.ts, bookReceivedAt: next.book.receivedAt ?? null,
          block: next.block, chainId: next.book.chainId ?? null, bestBid: next.book.bid, bestAsk: next.book.ask,
          mid: next.book.mid, spreadBps: next.book.spreadBps, tickSize: next.book.tickSize ?? null,
          makerFeeBps: next.paperFeeBps, action: next.decision.action,
          buyProbability: next.decision.buy, sellProbability: next.decision.sell,
          latencyMs: next.decision.latencyMs, model: next.decision.model,
          decisionSource: next.decision.source,
          inputSnapshot: captureDecisionReplayInput(next.book),
          actionDisposition: next.quote?.side === next.decision.action ? "quote_resting" : next.decision.action === "sell" && next.position.mon <= 0 ? "blocked_no_inventory" : next.decision.action === "hold" ? "hold" : "blocked_by_risk_gate",
          positionMon: next.position.mon, cashUsd: next.position.cash, equityUsd: next.position.equity,
          quote: next.quote ? { side: next.quote.side, price: next.quote.price, size: next.quote.size, queueAhead: next.quote.queueAhead ?? null } : null,
        });
      }
      auditedDecisions = next.totals.decisions;
    }
    const status = `${next.status}:${next.modelStatus}`;
    if (status !== auditedStatus) {
      audit.append({
        kind: "safety_state", timestamp: next.ts, status: next.status,
        modelStatus: next.modelStatus, tradeEvents: next.totals.tradeEvents,
        ignoredTradeEvents: next.totals.ignoredTradeEvents,
      });
      auditedStatus = status;
    }
  }
  snapshot = next;
  const type = next.modelStatus === "waiting" || next.modelStatus === "failed" ? "status" : "update";
  for (const send of subscribers) send(type, next);
});

const publicSnapshot = () => ({ ...snapshot, tape: snapshot.tape.slice(0, 12), chart: snapshot.chart.slice(-240) });
const mime = { "/": "text/html; charset=utf-8", "/style.css": "text/css; charset=utf-8", "/app.js": "text/javascript; charset=utf-8" } as Record<string, string>;
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
    if (url.pathname === "/api/snapshot") return Response.json(publicSnapshot(), { headers: { "cache-control": "no-store" } });
    if (url.pathname === "/api/events") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (event: string, data: Snapshot) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ ...data, tape: data.tape.slice(0, 12) })}\n\n`));
          const onChange = (event: string, data: Snapshot) => send(event, data);
          subscribers.add(onChange);
          send("snapshot", snapshot);
          const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 15_000);
          request.signal.addEventListener("abort", () => { clearInterval(heartbeat); subscribers.delete(onChange); try { controller.close(); } catch {} }, { once: true });
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
    }
    if (url.pathname in mime) return new Response(Bun.file(`web/${url.pathname === "/" ? "index.html" : url.pathname.slice(1)}`), { headers: { "content-type": mime[url.pathname]! } });
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Jev Trader ${config.mode} dashboard on http://${server.hostname}:${server.port}`);
// Expiry must not wait for the serial RPC poll or a pending model request.
const freshnessWatchdog = config.mode === "paper"
  ? setInterval(() => engine.checkBookFreshness(), Math.max(50, Math.min(1_000, Math.floor(config.staleAfterMs / 4))))
  : null;
let shuttingDown = false;
const pollMs = config.mode === "demo" ? 400 : config.pollMs;
const poll = new SerialPoll(pollMs, async (signal) => {
  const book = await reader.read();
  if (!signal.aborted) await engine.onBook(book);
}, () => {
  engine.setUnavailable("Public RPC is unavailable. No synthetic data is substituted in paper mode.");
});
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  poll.stop();
  if (freshnessWatchdog !== null) clearInterval(freshnessWatchdog);
  audit?.append({ kind: "session_end", timestamp: Date.now(), reason: "process_shutdown" });
  tradeFeed?.close();
  server.stop();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
poll.start();
