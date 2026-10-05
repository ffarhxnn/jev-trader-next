interface AuditRecord {
  kind: string;
  timestamp: number;
  [key: string]: unknown;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? sorted.at(-1)!;
}

export function summarizePaperAudit(contents: string) {
  const records: AuditRecord[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid paper audit JSON on line ${index + 1}.`); }
    if (!value || typeof value !== "object") throw new Error(`Invalid paper audit record on line ${index + 1}.`);
    const record = value as AuditRecord;
    if (typeof record.kind !== "string" || !Number.isFinite(record.timestamp)) throw new Error(`Invalid paper audit record on line ${index + 1}.`);
    if (record.schemaVersion !== undefined && record.schemaVersion !== 1) throw new Error(`Unsupported paper audit schema on line ${index + 1}.`);
    records.push(record);
  }
  if (!records.length) throw new Error("Paper audit file contains no records.");

  const abort = records.find((record) => record.kind === "session_aborted" && record.excludeFromValidation === true);
  const decisions = records.filter((record) => record.kind === "decision");
  const fills = records.filter((record) => record.kind === "fill");
  const latencies = decisions.map((record) => record.latencyMs).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const actionCounts = { buy: 0, sell: 0, hold: 0, other: 0 };
  for (const record of decisions) {
    if (record.action === "buy" || record.action === "sell" || record.action === "hold") actionCounts[record.action]++;
    else actionCounts.other++;
  }
  const unbackedSellQuotes = decisions.filter((record) => record.action === "sell" && typeof record.positionMon === "number" && record.positionMon <= 0
    && Boolean(record.quote && typeof record.quote === "object" && (record.quote as Record<string, unknown>).side === "sell")).length;
  const fillSizeMon = fills.reduce((sum, record) => sum + (typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0), 0);
  const feesUsd = [...fills].reverse().find((record) => typeof record.feesUsd === "number")?.feesUsd ?? null;
  const lifecycle = records.filter((record) => record.kind === "quote_resting" || record.kind === "quote_cancelled" || record.kind === "fill");
  const lifecycleIds = lifecycle.map((record) => record.quoteId ?? (record.fill as Record<string, unknown> | undefined)?.quoteId);
  const lifecycleIdsPresent = lifecycleIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  const activeQuotes = new Map<string, number>();
  let orphanLifecycleEvents = 0;
  for (const record of lifecycle) {
    const id = record.quoteId ?? (record.fill as Record<string, unknown> | undefined)?.quoteId;
    if (typeof id !== "string" || !id) continue;
    if (record.kind === "quote_resting") activeQuotes.set(id, typeof record.size === "number" ? record.size : Number.NaN);
    else if (!activeQuotes.has(id)) orphanLifecycleEvents++;
    else if (record.kind === "quote_cancelled" || typeof record.remainingSize === "number" && record.remainingSize <= 0) activeQuotes.delete(id);
    else if (record.kind === "fill" && typeof record.remainingSize === "number") activeQuotes.set(id, record.remainingSize);
  }
  return {
    evidenceStatus: abort ? "EXCLUDED_ABORTED_SESSION" : "PAPER_AUDIT_DESCRIPTIVE_ONLY",
    exclusionReason: abort?.reasonCategory ?? null,
    records: records.length,
    sessionStartedAt: records.find((record) => record.kind === "session_start")?.timestamp ?? records[0]!.timestamp,
    lastRecordAt: records.at(-1)!.timestamp,
    decisions: decisions.length,
    actions: actionCounts,
    blockedNoInventory: decisions.filter((record) => record.actionDisposition === "blocked_no_inventory").length,
    sellSignalsWithoutInventory: decisions.filter((record) => record.action === "sell" && typeof record.positionMon === "number" && record.positionMon <= 0).length,
    unbackedSellQuotes,
    restingQuotes: records.filter((record) => record.kind === "quote_resting").length,
    canceledQuotes: records.filter((record) => record.kind === "quote_cancelled").length,
    fills: fills.length,
    quoteLifecycle: {
      evidenceStatus: lifecycle.length === 0 ? "NO_LIFECYCLE_EVENTS" : lifecycleIdsPresent.length === lifecycle.length ? "ID_LINKED" : lifecycleIdsPresent.length === 0 ? "LEGACY_NO_QUOTE_IDS" : "PARTIAL_ID_COVERAGE",
      uniqueQuoteIds: new Set(lifecycleIdsPresent).size,
      eventsWithoutQuoteId: lifecycle.length - lifecycleIdsPresent.length,
      orphanLifecycleEvents,
      stillRestingAtEnd: activeQuotes.size,
    },
    filledSizeMon: fillSizeMon,
    feesUsd,
    latencyMs: { median: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    safetyStates: [...new Set(records.filter((record) => record.kind === "safety_state").map((record) => `${record.status}:${record.modelStatus}`))],
    interpretation: "Descriptive paper history only; not a profitability estimate or live-execution validation.",
  };
}
