import { closeSync, chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

export interface PaperRiskStop {
  version: 1;
  mode: "paper";
  reason: "MAX_MARK_TO_MARKET_LOSS";
  market: string;
  latchedAt: number;
  startingEquityUsd: number;
  equityAtStopUsd: number;
  lossLimitUsd: number;
}

function validStop(value: unknown): value is PaperRiskStop {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return state.version === 1 && state.mode === "paper" && state.reason === "MAX_MARK_TO_MARKET_LOSS"
    && typeof state.market === "string" && /^0x[\da-f]{40}$/.test(state.market)
    && Number.isFinite(state.latchedAt) && Number(state.latchedAt) > 0
    && Number.isFinite(state.startingEquityUsd) && Number(state.startingEquityUsd) > 0
    && Number.isFinite(state.equityAtStopUsd) && Number(state.equityAtStopUsd) >= 0
    && Number.isFinite(state.lossLimitUsd) && Number(state.lossLimitUsd) > 0;
}

/** Local paper-only circuit breaker. It contains no wallet, provider, or transaction data. */
export class PaperRiskLatch {
  readonly path: string;

  constructor(path = "data/paper-risk-stop.json") { this.path = resolve(path); }

  read(expectedMarket: string): PaperRiskStop | null {
    if (!/^0x[\da-fA-F]{40}$/.test(expectedMarket)) throw new Error("Expected paper market must be a valid EVM address.");
    if (!existsSync(this.path)) return null;
    const metadata = lstatSync(this.path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("Paper risk stop path must be a regular local file.");
    chmodSync(this.path, 0o600);
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.path, "utf8")); }
    catch { throw new Error("Paper risk stop state is unreadable; paper trading remains disabled until it is reviewed."); }
    if (!validStop(value)) throw new Error("Paper risk stop state is invalid; paper trading remains disabled until it is reviewed.");
    if (value.market !== expectedMarket.toLowerCase()) throw new Error("Paper risk stop belongs to a different market; review it before starting a new paper session.");
    return value;
  }

  latch(input: Omit<PaperRiskStop, "version" | "mode" | "reason" | "market"> & { market: string }) {
    const state: PaperRiskStop = {
      version: 1, mode: "paper", reason: "MAX_MARK_TO_MARKET_LOSS",
      market: input.market.toLowerCase(), latchedAt: input.latchedAt,
      startingEquityUsd: input.startingEquityUsd, equityAtStopUsd: input.equityAtStopUsd,
      lossLimitUsd: input.lossLimitUsd,
    };
    if (!validStop(state)) throw new Error("Invalid paper risk stop state.");
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | null = null;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd); fd = null;
      renameSync(temporary, this.path);
      chmodSync(this.path, 0o600);
      const directoryFd = openSync(directory, "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch (error) {
      if (fd !== null) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    return state;
  }

  reset() {
    if (!existsSync(this.path)) return false;
    const metadata = lstatSync(this.path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("Paper risk stop path must be a regular local file.");
    unlinkSync(this.path);
    return true;
  }
}
