import type { DepthSnapshot } from "./types";
import type { ReplayDecision } from "./single-placement-replay";
import { captureDecisionReplayInput } from "./decision-replay-input";
import { selectDepthReplayRange } from "./research";
import { extractPaperBookTimeline } from "./paper-book-timeline";

// Property order and address casing are representation details; observation contents are not.
const canonicalBook = (s: DepthSnapshot) => JSON.stringify([s.timestamp, s.block, s.chainId, s.market?.toLowerCase(),
  s.tickSize, s.sizePrecision, s.minSizeMon, s.makerFeeBps, s.takerFeeBps, s.captureIntervalMs,
  s.gapBefore ?? false, s.rpcEndpointIndex, s.bids, s.asks]);
// gapBefore is derived by timeline extraction, not part of the book supplied to the model.
const canonicalDecisionBook = (s: DepthSnapshot) => canonicalBook({ ...s, gapBefore: false });

export interface PreparedDecisionReplay {
  snapshots: DepthSnapshot[];
  decisions: ReplayDecision[];
  selectedDecisionRows: number;
  completionsCensoredAtEnd: number;
  inputSnapshotsAdded: number;
  interpretation: string;
}

/** No nearest-time or future-block inference: selected decisions must contain their actual input. */
export function prepareSinglePlacementAudit(contents: string, captured: DepthSnapshot[], start: number, end: number,
  requireObservedTimeline = false): PreparedDecisionReplay {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Replay timestamp range must have finite bounds with end after start.");
  let selected: { snapshots: DepthSnapshot[] } | null;
  if (requireObservedTimeline) {
    const observed = extractPaperBookTimeline(contents).filter(s => s.timestamp >= start && s.timestamp <= end);
    const supplied = captured.filter(s => s.timestamp >= start && s.timestamp <= end);
    if (observed.length < 2 || observed.slice(1).some(s => s.gapBefore)) throw new Error("Strict observed timeline requires one continuous observed L2 interval.");
    if (supplied.length !== observed.length || supplied.some((s, i) => canonicalBook(s) !== canonicalBook(observed[i]!)))
      throw new Error("Supplied depth must exactly match every observed book in the selected audit interval; omissions, additions and metadata changes are refused.");
    selected = { snapshots: supplied };
  } else selected = selectDepthReplayRange(captured, start, end);
  if (!selected) throw new Error("Single-placement replay needs one continuous captured L2 interval.");
  const first = selected.snapshots[0]!, last = selected.snapshots.at(-1)!;
  const decisions: ReplayDecision[] = [];
  const inputs: DepthSnapshot[] = [];
  const keys = new Set<string>();
  let selectedDecisionRows = 0, completionsCensoredAtEnd = 0;
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid paper audit JSON at row ${index + 1}.`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid paper audit row ${index + 1}.`);
    const row = value as Record<string, unknown>;
    if (row.kind !== "decision") continue;
    const receivedAt = row.bookReceivedAt;
    if (typeof receivedAt !== "number" || !Number.isFinite(receivedAt)) throw new Error(`Decision row ${index + 1} lacks its input receipt time.`);
    if (receivedAt < first.timestamp || receivedAt > last.timestamp) continue;
    selectedDecisionRows++;
    if (typeof row.timestamp !== "number" || !Number.isFinite(row.timestamp) || row.timestamp < receivedAt
      || !["buy", "sell", "hold"].includes(String(row.action)) || typeof row.model !== "string" || !row.model.trim()
      || !["local demo heuristic", "OpenCode Zen free Jev", "OpenCode Zen paid Jev", "OpenCode Go API", "Google Gemini API"].includes(String(row.decisionSource))) {
      throw new Error(`Decision row ${index + 1} has invalid completion or model provenance.`);
    }
    if (!row.inputSnapshot || typeof row.inputSnapshot !== "object" || Array.isArray(row.inputSnapshot)) {
      throw new Error(`Decision row ${index + 1} has no complete recorded input snapshot; legacy nearest-book mapping is refused.`);
    }
    const raw = row.inputSnapshot as DepthSnapshot;
    const snapshot = captureDecisionReplayInput({ source: "Monad Kuru", ...raw,
      receivedAt, bid: Number(row.bestBid), ask: Number(row.bestAsk), mid: Number(row.mid), spreadBps: Number(row.spreadBps) });
    if (!snapshot || raw.timestamp !== receivedAt || snapshot.block !== row.block || snapshot.chainId !== row.chainId
      || snapshot.chainId !== first.chainId || snapshot.market?.toLowerCase() !== first.market?.toLowerCase()
      || snapshot.tickSize !== first.tickSize || snapshot.sizePrecision !== first.sizePrecision
      || snapshot.minSizeMon !== first.minSizeMon || snapshot.makerFeeBps !== first.makerFeeBps
      || snapshot.takerFeeBps !== first.takerFeeBps) {
      throw new Error(`Decision row ${index + 1} does not match its public input or selected capture metadata.`);
    }
    if (requireObservedTimeline) {
      const observed = selected.snapshots.find(s => s.timestamp === snapshot.timestamp);
      if (!observed || canonicalDecisionBook(observed) !== canonicalDecisionBook(snapshot))
        throw new Error(`Decision row ${index + 1} must already exactly match a selected observed book; inferred or inserted decision books are refused.`);
    }
    const key = `${snapshot.timestamp}:${snapshot.block}`;
    if (keys.has(key)) throw new Error("Multiple decisions use the same recorded input; replay needs an unambiguous ordered audit.");
    keys.add(key);
    // Its public input was observed even when the response arrives beyond the replay boundary.
    if (!requireObservedTimeline) inputs.push(snapshot);
    if (row.timestamp > last.timestamp) { completionsCensoredAtEnd++; continue; }
    decisions.push({ bookTimestamp: snapshot.timestamp, bookBlock: snapshot.block, decidedAt: row.timestamp,
      action: row.action as ReplayDecision["action"], model: row.model, source: String(row.decisionSource) });
  }
  if (!decisions.length) throw new Error("No complete recorded decisions overlap the selected capture interval.");
  const merged = requireObservedTimeline ? selected.snapshots : [...selected.snapshots, ...inputs].sort((a, b) => a.timestamp - b.timestamp);
  const snapshots: DepthSnapshot[] = [];
  for (const row of merged) {
    const prior = snapshots.at(-1);
    if (prior?.timestamp === row.timestamp) {
      if (prior.block !== row.block || JSON.stringify(prior.bids) !== JSON.stringify(row.bids) || JSON.stringify(prior.asks) !== JSON.stringify(row.asks)) {
        throw new Error("Different book observations share a wall-clock timestamp; ordering cannot be inferred.");
      }
      continue;
    }
    if (prior && row.block < prior.block) {
      throw new Error("Capture and decision-input arrival order disagree on block progression; use a single causal book timeline.");
    }
    snapshots.push(row);
  }
  decisions.sort((a, b) => a.decidedAt - b.decidedAt);
  return { snapshots, decisions, selectedDecisionRows, completionsCensoredAtEnd,
    inputSnapshotsAdded: snapshots.length - selected.snapshots.length,
    interpretation: `${requireObservedTimeline ? "Strict lineage: supplied depth exactly matches explicit book_observed records in the same audit, and every selected decision input already matches that observed timeline; no decision books are inserted. " : "Exact public input snapshots are checked against the captured L2 timeline. "}Completed supplied actions are fixed counterfactual inputs; the model is not rerun against changed inventory or execution history. Missing legacy inputs, ambiguous timestamp collisions and interleaved block rollback are refused. Completion times are local audit publication times, not proven model-return or chain-inclusion times.` };
}
