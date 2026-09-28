const number = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
};

export const config = Object.freeze({
  host: process.env.HOST ?? "127.0.0.1",
  port: number("PORT", 3015),
  mode: (process.env.APP_MODE ?? "demo") as "paper" | "demo",
  rpcUrl: process.env.READ_RPC_URL ?? "https://rpc.monad.xyz",
  market: process.env.MARKET ?? "0x065C9d28E428A0db40191a54d33d5b7c71a9C394",
  model: process.env.MODEL ?? "demo",
  zenModel: "jev-1.13-free",
  zenBaseUrl: "https://opencode.ai/zen/v1",
  decisionIntervalMs: number("JEV_DECISION_INTERVAL_MS", 10_000),
  timeoutMs: number("JEV_TIMEOUT_MS", 8_000),
  pollMs: number("BOOK_POLL_MS", 1_000),
  orderSizeMon: number("PAPER_ORDER_SIZE_MON", 200),
  maxPositionMon: number("PAPER_MAX_POSITION_MON", 1_000),
  initialCashUsd: number("PAPER_CASH_USD", 100),
  maxLossUsd: number("PAPER_MAX_LOSS_USD", 20),
  feeBps: number("PAPER_FEE_BPS", 0),
});

if (config.host !== "127.0.0.1" && config.host !== "localhost") {
  throw new Error("This paper dashboard only binds to loopback.");
}
if (config.port < 1 || config.port > 65535 || config.decisionIntervalMs < 1000 || config.decisionIntervalMs > 120_000 || config.timeoutMs < 250 || config.timeoutMs > 30_000) {
  throw new Error("Invalid port, Jev cadence, or timeout configuration.");
}
if (process.env.APP_MODE !== undefined && process.env.APP_MODE !== "demo" && process.env.APP_MODE !== "paper") throw new Error("APP_MODE must be demo or paper.");
if (config.mode === "paper" && config.model !== "jev") throw new Error("Paper mode requires MODEL=jev. Use APP_MODE=demo for the labeled offline demo.");
if (config.model !== "demo" && config.model !== "jev") throw new Error("MODEL must be demo or jev.");
if (config.model === "jev" && (!process.env.OPENCODE_API_KEY || process.env.JEV_MODEL_ID && process.env.JEV_MODEL_ID !== config.zenModel)) throw new Error("Jev mode requires OPENCODE_API_KEY and the fixed free jev-1.13-free model.");
if (config.orderSizeMon <= 0 || config.maxPositionMon < config.orderSizeMon || config.initialCashUsd <= 0 || config.maxLossUsd <= 0 || config.feeBps < 0 || config.feeBps > 100) throw new Error("Invalid paper risk configuration.");
