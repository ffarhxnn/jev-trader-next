export interface PurgedAuditSplit {
  session: Record<string, unknown>;
  trainAudit: string;
  holdoutAudit: string;
  cutoffTimestamp: number;
  purgeMs: number;
  train: { startTimestamp: number; endTimestamp: number; decisions: number; directionalDecisions: number };
  holdout: { startTimestamp: number; endTimestamp: number; decisions: number; directionalDecisions: number };
}

export function createPurgedWalkForwardSplit(auditContents: string, trainFraction = 0.7, purgeMs = 64_000): PurgedAuditSplit {
  if (!(trainFraction > 0 && trainFraction < 1) || !Number.isFinite(trainFraction)
    || !Number.isSafeInteger(purgeMs) || purgeMs < 1) throw new Error("Invalid chronological split fraction or purge interval.");
  let session: Record<string, unknown> | null = null;
  const decisions: Record<string, unknown>[] = [];
  for (const [index, line] of auditContents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid audit JSON on line ${index + 1}.`); }
    if (!value || typeof value !== "object") throw new Error(`Invalid audit record on line ${index + 1}.`);
    const record = value as Record<string, unknown>;
    if (record.kind === "session_start") {
      if (session) throw new Error("Walk-forward analysis accepts one paper session per audit file.");
      session = record;
    }
    if (record.kind === "decision") {
      if (!Number.isFinite(record.timestamp)) throw new Error(`Invalid decision timestamp on line ${index + 1}.`);
      decisions.push(record);
    }
  }
  if (!session || session.mode !== "paper" || typeof session.market !== "string") throw new Error("Walk-forward analysis requires one actual paper-session audit.");
  if (decisions.length < 4) throw new Error("At least four audited decisions are required for a purged chronological split.");
  for (let i = 1; i < decisions.length; i++) if (Number(decisions[i]!.timestamp) < Number(decisions[i - 1]!.timestamp)) throw new Error("Audited decision timestamps must be chronological.");
  const splitIndex = Math.floor(decisions.length * trainFraction);
  if (splitIndex <= 0 || splitIndex >= decisions.length) throw new Error("The requested split leaves an empty side.");
  const cutoffTimestamp = Number(decisions[splitIndex]!.timestamp);
  const train = decisions.filter((record) => Number(record.timestamp) < cutoffTimestamp - purgeMs);
  const holdout = decisions.filter((record) => Number(record.timestamp) >= cutoffTimestamp + purgeMs);
  if (!train.length || !holdout.length) throw new Error("The purge interval leaves no training or holdout decisions.");
  const toAudit = (rows: Record<string, unknown>[]) => [session!, ...rows].map((row) => JSON.stringify(row)).join("\n");
  const summarize = (rows: Record<string, unknown>[]) => ({
    startTimestamp: Number(rows[0]!.timestamp), endTimestamp: Number(rows.at(-1)!.timestamp), decisions: rows.length,
    directionalDecisions: rows.filter((row) => row.action === "buy" || row.action === "sell").length,
  });
  return { session, trainAudit: toAudit(train), holdoutAudit: toAudit(holdout), cutoffTimestamp, purgeMs, train: summarize(train), holdout: summarize(holdout) };
}
