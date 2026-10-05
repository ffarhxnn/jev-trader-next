import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Book, Decision } from "./types";
import { RateLimitWait, type DecisionModel, type ModelStatus } from "./model";

interface BudgetState { version: 1; days: Record<string, Record<string, number>> }
export interface RequestBudgetStatus { allowed: boolean; retryAt: number | null; reason: string | null }

function emptyState(): BudgetState { return { version: 1, days: {} }; }

function isValidState(value: unknown): value is BudgetState {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return false;
  const days = (value as { days?: unknown }).days;
  if (!days || typeof days !== "object" || Array.isArray(days)) return false;
  for (const [day, counts] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !counts || typeof counts !== "object" || Array.isArray(counts)) return false;
    for (const [key, count] of Object.entries(counts)) {
      if (!/^[\w.:-]{1,180}$/.test(key) || !Number.isSafeInteger(count) || Number(count) < 0) return false;
    }
  }
  return true;
}

/** Persisted per-model UTC-day request cap. It counts an attempt before network I/O, including failed calls. */
export class ProviderRequestBudget {
  constructor(
    readonly maxRequestsPerUtcDay: number,
    private readonly statePath: string | null = "data/provider-request-budget.json",
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxRequestsPerUtcDay) || maxRequestsPerUtcDay < 0 || maxRequestsPerUtcDay > 100_000) throw new Error("Provider request budget must be an integer from 0 to 100000.");
  }

  status(modelKey: string): RequestBudgetStatus {
    if (this.maxRequestsPerUtcDay === 0) return { allowed: false, retryAt: null, reason: "Provider requests have no daily cap; requests are disabled." };
    if (!this.statePath) return { allowed: false, retryAt: null, reason: "Provider request budget has no persistent state path; requests are paused." };
    let state: BudgetState;
    try { state = this.readState(); }
    catch { return { allowed: false, retryAt: null, reason: "Provider request budget state is invalid or unavailable; requests are paused." }; }
    const date = new Date(this.now()).toISOString().slice(0, 10);
    const count = state.days[date]?.[modelKey] ?? 0;
    if (count >= this.maxRequestsPerUtcDay) {
      const [year, month, day] = date.split("-").map(Number);
      const retryAt = Date.UTC(year!, month! - 1, day! + 1);
      return { allowed: false, retryAt, reason: `Daily request cap reached for ${modelKey}; it resets at 00:00 UTC.` };
    }
    return { allowed: true, retryAt: null, reason: null };
  }

  consume(modelKey: string): void {
    if (this.maxRequestsPerUtcDay === 0 || !this.statePath) {
      throw new RateLimitWait(Number.MAX_SAFE_INTEGER, "Provider requests are disabled because the request budget is not persistently configured.");
    }
    const lockPath = `${this.statePath}.lock`;
    const fd = this.acquireLock(lockPath);
    try {
      // Read and increment under one cross-process lock; status() alone is advisory.
      const state = this.readState();
      const date = new Date(this.now()).toISOString().slice(0, 10);
      const count = state.days[date]?.[modelKey] ?? 0;
      if (count >= this.maxRequestsPerUtcDay) {
        const [year, month, day] = date.split("-").map(Number);
        throw new RateLimitWait(Date.UTC(year!, month! - 1, day! + 1), `Daily request cap reached for ${modelKey}; it resets at 00:00 UTC.`);
      }
      state.days[date] ??= {};
      state.days[date]![modelKey] = count + 1;
      for (const oldDay of Object.keys(state.days)) if (oldDay < date) delete state.days[oldDay];
      this.writeState(state);
    } finally {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch { /* a leftover lock fails closed on the next attempt */ }
    }
  }

  private acquireLock(lockPath: string): number {
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 2_000;
    while (true) {
      let fd: number;
      try {
        fd = openSync(lockPath, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid, createdAt: Date.now() }));
          fsyncSync(fd);
          chmodSync(lockPath, 0o600);
          return fd;
        } catch (error) {
          closeSync(fd);
          try { unlinkSync(lockPath); } catch { /* best-effort cleanup */ }
          throw error;
        }
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
        if (this.removeDeadOwnerLock(lockPath)) continue;
        if (Date.now() >= deadline) throw new RateLimitWait(this.now() + 1_000, "Another process is updating the provider request budget; no request was sent.");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }

  private removeDeadOwnerLock(lockPath: string): boolean {
    try {
      const metadata = lstatSync(lockPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
      const value = JSON.parse(readFileSync(lockPath, "utf8")) as { version?: unknown; pid?: unknown };
      if (value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return false;
      try {
        process.kill(Number(value.pid), 0);
        return false;
      } catch (error) {
        if ((error as { code?: string }).code !== "ESRCH") return false;
        unlinkSync(lockPath);
        return true;
      }
    } catch {
      // Malformed or unsafe lock state blocks requests instead of being removed.
      return false;
    }
  }

  private readState(): BudgetState {
    if (!this.statePath) return emptyState();
    try {
      const metadata = lstatSync(this.statePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Budget state must be a regular file.");
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (!isValidState(parsed)) throw new Error("Budget state is malformed.");
      return parsed;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  private writeState(state: BudgetState) {
    if (!this.statePath) return;
    const directory = dirname(this.statePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    let fileFd: number | null = null;
    try {
      fileFd = openSync(temporary, "wx", 0o600);
      writeFileSync(fileFd, JSON.stringify(state), "utf8");
      fsyncSync(fileFd);
      chmodSync(temporary, 0o600);
      closeSync(fileFd);
      fileFd = null;
      renameSync(temporary, this.statePath);
      const directoryFd = openSync(directory, "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch (error) {
      if (fileFd !== null) closeSync(fileFd);
      try { unlinkSync(temporary); } catch { /* best-effort temporary-file cleanup */ }
      throw error;
    }
  }
}

/** Applies the daily budget in front of any hosted model while leaving demo and paused implementations unchanged. */
export class BudgetedProviderModel implements DecisionModel {
  readonly name: string;
  private readonly key: string;

  constructor(private readonly inner: DecisionModel, private readonly budget: ProviderRequestBudget, provider: string) {
    this.name = inner.name;
    this.key = `${provider}:${inner.name.toLowerCase().replace(/[^a-z0-9.:-]+/g, "-")}`;
  }

  status(): ModelStatus {
    const inner = this.inner.status();
    if (inner.state !== "ready") return inner;
    const budget = this.budget.status(this.key);
    if (budget.allowed) return inner;
    return { state: budget.retryAt === null ? "failed" : "waiting", retryAt: budget.retryAt, reason: budget.reason };
  }

  async decide(book: Book, mids: number[]): Promise<Decision> {
    const status = this.status();
    if (status.state === "failed") throw new Error(status.reason ?? "Provider request budget failed closed.");
    if (status.state === "waiting") throw new RateLimitWait(status.retryAt ?? Number.MAX_SAFE_INTEGER, status.reason ?? "Provider request is waiting.");
    this.budget.consume(this.key);
    return this.inner.decide(book, mids);
  }
}
