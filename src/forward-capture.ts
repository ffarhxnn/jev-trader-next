import { extractPaperBookTimeline } from "./paper-book-timeline";
import { prepareSinglePlacementAudit } from "./single-placement-audit";
import type { DepthSnapshot } from "./types";

export const FORWARD_MARKET = "0x065c9d28e428a0db40191a54d33d5b7c71a9c394";
export const FORWARD_ASSUMPTIONS = {
  startingCashUsd: 100, startingMon: 0, orderSizeMon: 200, positionCapMon: 1000, maxLossUsd: 20,
  insideTicks: 1, maxSpreadBps: 50, gasUsdPerUpdate: 0.01, orderLatencyMsScenarios: [0, 500, 1000, 3000],
  receiptConfirmationDelayMs: 1000, minimumWindowSeconds: 600, minimumFillFloor: 20,
};
export const FORWARD_WINDOW_RULE = "First complete uninterrupted interval spanning at least 600 seconds after corrected producer restart; source selection independent of decisions, fills or PnL. End at first observation at or after first observation + 600 seconds. Discard earlier incomplete segments without scoring as full windows.";
export const FORWARD_BOOK_POLICY = "paper-kuru-advancing-block-watchdog-trade-and-model-guard-v1";
export const FORWARD_TRADE_POLICY = "generation-owned-sockets-and-timers-v1";
export interface ForwardProtocol {
  schemaVersion: 4; declaredAt: string; sourceAudit: string; sourceContract: string; windowRule: string;
  fixedAssumptions: typeof FORWARD_ASSUMPTIONS; model: string; holdoutScored: false; realMoneyReady: false;
  bookFreshnessPolicy: string; bookStaleAfterMs: 5000; tradeFeedLifecyclePolicy: string; tradeFeedStaleAfterMs: 60000;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a public record object.");
  return value as Record<string, unknown>;
};
const pick = (row: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter(k => row[k] !== undefined).map(k => [k, row[k]]));
const protocolKeys = ["schemaVersion", "declaredAt", "sourceAudit", "sourceContract", "windowRule", "fixedAssumptions", "model", "holdoutScored", "realMoneyReady", "bookFreshnessPolicy", "bookStaleAfterMs", "tradeFeedLifecyclePolicy", "tradeFeedStaleAfterMs"];
export function validateForwardProtocol(value: unknown): ForwardProtocol {
  const row = object(value), assumptions = object(row.fixedAssumptions);
  if (row.schemaVersion !== 4 || typeof row.declaredAt !== "string" || !Number.isFinite(Date.parse(row.declaredAt))
    || typeof row.sourceAudit !== "string" || !/^paper-audit-[\dTZ-]+\.jsonl$/.test(row.sourceAudit)
    || row.sourceContract !== "same-audit-explicit-observed-book-sequence" || row.windowRule !== FORWARD_WINDOW_RULE
    || row.model !== "local heuristic only, fixed supplied actions; not Jev rerun"
    || row.holdoutScored !== false || row.realMoneyReady !== false || row.bookFreshnessPolicy !== FORWARD_BOOK_POLICY
    || row.bookStaleAfterMs !== 5000 || row.tradeFeedLifecyclePolicy !== FORWARD_TRADE_POLICY || row.tradeFeedStaleAfterMs !== 60000)
    throw new Error("Forward protocol policy or source contract mismatch.");
  const keys = Object.keys(FORWARD_ASSUMPTIONS);
  if (Object.keys(assumptions).length !== keys.length || keys.some(k => JSON.stringify(assumptions[k]) !== JSON.stringify(FORWARD_ASSUMPTIONS[k as keyof typeof FORWARD_ASSUMPTIONS])))
    throw new Error("Forward protocol fixed assumptions mismatch.");
  return { ...pick(row, protocolKeys), fixedAssumptions: { ...FORWARD_ASSUMPTIONS, orderLatencyMsScenarios: [...FORWARD_ASSUMPTIONS.orderLatencyMsScenarios] } } as unknown as ForwardProtocol;
}
const sessionKeys = ["kind", "timestamp", "mode", "model", "market", "orderSizeMon", "positionCapMon", "startingCashUsd", "lossStopUsd", "pollMs", "bookStaleAfterMs", "bookFreshnessPolicy", "tradeFeedStaleAfterMs", "tradeFeedLifecyclePolicy", "quotePricingPolicy", "quoteInsideTicks"];
const depthKeys = ["timestamp", "block", "chainId", "market", "tickSize", "sizePrecision", "minSizeMon", "makerFeeBps", "takerFeeBps", "captureIntervalMs", "gapBefore"];
function publicDepth(value: unknown) {
  const row = object(value);
  const levels = (value: unknown) => {
    if (!Array.isArray(value) || value.some(level => !Array.isArray(level) || level.length !== 2 || level.some(x => typeof x !== "number")))
      throw new Error("Invalid public depth levels.");
    return value.map(level => [level[0], level[1]]);
  };
  return { ...pick(row, depthKeys), bids: levels(row.bids), asks: levels(row.asks) };
}
/** Keep only fields needed by strict book extraction and decision replay; never copy arbitrary rows. */
export function sanitizeForwardAudit(contents: string): string {
  const rows: Record<string, unknown>[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = object(JSON.parse(line)); } catch { throw new Error(`Invalid complete audit row ${index + 1}.`); }
    if (row.kind === "session_start") rows.push(pick(row, sessionKeys));
    else if (row.kind === "book_observed") rows.push({ ...pick(row, ["kind", "timestamp", "observedAt", "publishedAt", "schemaVersion"]), inputSnapshot: publicDepth(row.inputSnapshot) });
    else if (row.kind === "decision") {
      if (typeof row.bookReceivedAt !== "number" || !Number.isFinite(row.bookReceivedAt)) throw new Error("Decision lacks its input receipt time.");
      rows.push({ ...pick(row, ["kind", "timestamp", "bookReceivedAt", "block", "chainId", "bestBid", "bestAsk", "mid", "spreadBps", "action", "model", "decisionSource"]), inputSnapshot: publicDepth(row.inputSnapshot) });
    }
  }
  return rows.map(row => JSON.stringify(row)).join("\n") + "\n";
}
export interface ForwardSelection {
  protocol: ForwardProtocol; auditContents: string; snapshots: DepthSnapshot[];
  startTimestamp: number; endTimestamp: number; incompleteSegmentsDiscarded: number;
  decisions: number; completionsCensoredAtEnd: number;
}
/** Selection never inspects actions, fills, PnL, or later segment length. */
export function selectForwardCapture(protocolValue: unknown, contents: string, sourceAuditName: string): ForwardSelection | null {
  const protocol = validateForwardProtocol(protocolValue);
  if (sourceAuditName !== protocol.sourceAudit) throw new Error("Audit filename differs from declared protocol source.");
  const auditContents = sanitizeForwardAudit(contents);
  const rows = auditContents.trim().split("\n").map(line => object(JSON.parse(line)));
  const sessions = rows.filter(row => row.kind === "session_start");
  const session = sessions[0];
  if (sessions.length !== 1 || rows[0] !== session || !session || typeof session.timestamp !== "number" || !Number.isFinite(session.timestamp)
    || session.mode !== "paper" || session.model !== "stand-in momentum heuristic" || session.market !== FORWARD_MARKET
    || session.orderSizeMon !== 200 || session.positionCapMon !== 1000 || session.startingCashUsd !== 100 || session.lossStopUsd !== 20
    || session.pollMs !== 1000 || session.bookFreshnessPolicy !== protocol.bookFreshnessPolicy || session.bookStaleAfterMs !== protocol.bookStaleAfterMs
    || session.tradeFeedLifecyclePolicy !== protocol.tradeFeedLifecyclePolicy || session.tradeFeedStaleAfterMs !== protocol.tradeFeedStaleAfterMs
    || session.quotePricingPolicy !== "whole-tick-improvement-or-touch-v1" || session.quoteInsideTicks !== 1)
    throw new Error("Session start differs from required lifecycle, freshness, model or financial policies.");
  const timeline = extractPaperBookTimeline(auditContents);
  if (timeline.some(s => s.market !== FORWARD_MARKET || s.chainId !== 143 || s.timestamp < (session.timestamp as number) || s.captureIntervalMs !== session.pollMs))
    throw new Error("Observed book provenance or session cadence mismatch.");
  let start = 0, discarded = 0;
  for (let i = 0; i < timeline.length; i++) {
    if (i > 0 && timeline[i]!.gapBefore) { start = i; ++discarded; }
    if (timeline[i]!.timestamp - timeline[start]!.timestamp < protocol.fixedAssumptions.minimumWindowSeconds * 1000) continue;
    const snapshots = timeline.slice(start, i + 1), first = snapshots[0]!, last = snapshots.at(-1)!;
    const selectedRows = rows.filter(row => row.kind === "session_start"
      || row.kind === "book_observed" && Number(row.timestamp) >= first.timestamp && Number(row.timestamp) <= last.timestamp
      || row.kind === "decision" && Number(row.bookReceivedAt) >= first.timestamp && Number(row.bookReceivedAt) <= last.timestamp);
    for (const row of selectedRows) if (row.kind === "decision" && (row.model !== session.model || row.decisionSource !== "local demo heuristic"))
      throw new Error("Selected decision differs from the fixed local heuristic source.");
    // Preserve extractor-derived boundary gap even after dropping preceding incomplete books.
    const byTime = new Map(snapshots.map(s => [s.timestamp, s]));
    for (const row of selectedRows) if (row.kind === "book_observed") {
      const snapshot = byTime.get(Number(row.timestamp))!;
      row.inputSnapshot = snapshot;
    }
    const frozenAudit = selectedRows.map(row => JSON.stringify(row)).join("\n") + "\n";
    const prepared = prepareSinglePlacementAudit(frozenAudit, snapshots, first.timestamp, last.timestamp, true);
    return { protocol, auditContents: frozenAudit, snapshots, startTimestamp: first.timestamp, endTimestamp: last.timestamp,
      incompleteSegmentsDiscarded: discarded, decisions: prepared.decisions.length, completionsCensoredAtEnd: prepared.completionsCensoredAtEnd };
  }
  return null;
}
