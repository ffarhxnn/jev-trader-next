const number = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
};

const defaultReadRpcFallbackUrls = [
  "https://rpc1.monad.xyz",
  "https://rpc2.monad.xyz",
  "https://rpc3.monad.xyz",
];
const configuredReadRpcFallbackUrls = process.env.READ_RPC_FALLBACK_URLS === undefined
  ? defaultReadRpcFallbackUrls
  : process.env.READ_RPC_FALLBACK_URLS.split(",").map((url) => url.trim()).filter(Boolean);
const readRpcUrl = process.env.READ_RPC_URL ?? "https://rpc.monad.xyz";
const readRpcUrls = [...new Set([readRpcUrl, ...configuredReadRpcFallbackUrls])];
for (const endpoint of readRpcUrls) {
  let parsed: URL;
  try { parsed = new URL(endpoint); }
  catch { throw new Error("READ_RPC_URL and READ_RPC_FALLBACK_URLS must contain valid HTTPS URLs."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Read-only Monad RPC URLs must use HTTPS and must not contain credentials, query strings, or fragments.");
  }
}

export const config = Object.freeze({
  host: process.env.HOST ?? "127.0.0.1",
  port: number("PORT", 3015),
  mode: (process.env.APP_MODE ?? "demo") as "paper" | "demo",
  rpcUrl: readRpcUrl,
  rpcUrls: readRpcUrls,
  market: process.env.MARKET ?? "0x065C9d28E428A0db40191a54d33d5b7c71a9C394",
  model: process.env.MODEL ?? "demo",
  localDemoPaperEnabled: process.env.PAPER_LOCAL_DEMO_ENABLED === "1",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite",
  opencodeGoModel: process.env.OPENCODE_GO_MODEL_ID ?? "kimi-k3",
  opencodeGoProtocol: process.env.OPENCODE_GO_PROTOCOL ?? "chat",
  zenModel: process.env.JEV_MODEL_ID ?? "jev-1.13-free",
  jevRequestsEnabled: process.env.JEV_REQUESTS_ENABLED === "1",
  zenBaseUrl: "https://opencode.ai/zen/v1",
  decisionIntervalMs: number("MODEL_DECISION_INTERVAL_MS", number("JEV_DECISION_INTERVAL_MS", 10_000)),
  timeoutMs: number("JEV_TIMEOUT_MS", 8_000),
  modelMaxRequestsPerUtcDay: number("MODEL_MAX_REQUESTS_PER_UTC_DAY", 0),
  pollMs: number("BOOK_POLL_MS", 1_000),
  staleAfterMs: number("BOOK_STALE_AFTER_MS", 5_000),
  tradeFeedStaleAfterMs: number("KURU_WS_STALE_AFTER_MS", 60_000),
  maxMarketSpreadBps: number("MAX_MARKET_SPREAD_BPS", 50),
  orderSizeMon: number("PAPER_ORDER_SIZE_MON", 200),
  maxPositionMon: number("PAPER_MAX_POSITION_MON", 1_000),
  initialCashUsd: number("PAPER_CASH_USD", 100),
  maxLossUsd: number("PAPER_MAX_LOSS_USD", 20),
  feeBps: process.env.PAPER_FEE_BPS === undefined || process.env.PAPER_FEE_BPS === "" ? null : number("PAPER_FEE_BPS", 0),
});

if (config.host !== "127.0.0.1" && config.host !== "localhost") {
  throw new Error("This paper dashboard only binds to loopback.");
}
if (config.port < 1 || config.port > 65535 || config.decisionIntervalMs < 1000 || config.decisionIntervalMs > 120_000 || config.timeoutMs < 250 || config.timeoutMs > 30_000 || config.pollMs < 250 || config.staleAfterMs < config.pollMs || config.staleAfterMs > 120_000 || config.tradeFeedStaleAfterMs < 5_000 || config.tradeFeedStaleAfterMs > 600_000) {
  throw new Error("Invalid port, Jev cadence, or timeout configuration.");
}
if (config.maxMarketSpreadBps <= 0 || config.maxMarketSpreadBps > 10_000) throw new Error("MAX_MARKET_SPREAD_BPS must be greater than 0 and no more than 10000.");
if (!Number.isSafeInteger(config.modelMaxRequestsPerUtcDay) || config.modelMaxRequestsPerUtcDay < 0 || config.modelMaxRequestsPerUtcDay > 100_000) throw new Error("MODEL_MAX_REQUESTS_PER_UTC_DAY must be an integer from 0 to 100000.");
if (process.env.APP_MODE !== undefined && process.env.APP_MODE !== "demo" && process.env.APP_MODE !== "paper") throw new Error("APP_MODE must be demo or paper.");
if (config.mode === "paper" && !["jev", "gemini", "opencode-go", "paused"].includes(config.model)
  && !(config.model === "demo" && config.localDemoPaperEnabled)) {
  throw new Error("Paper mode requires a provider, MODEL=paused, or MODEL=demo with PAPER_LOCAL_DEMO_ENABLED=1.");
}
if (config.model !== "demo" && config.model !== "jev" && config.model !== "gemini" && config.model !== "opencode-go" && config.model !== "paused") throw new Error("MODEL must be demo, jev, gemini, opencode-go, or paused.");
if (!["jev-1.13-free", "jev-1.13"].includes(config.zenModel)) throw new Error("JEV_MODEL_ID must be jev-1.13-free or jev-1.13.");
if (config.model === "jev" && config.jevRequestsEnabled && !process.env.OPENCODE_API_KEY) throw new Error("Enabled Jev requests require OPENCODE_API_KEY.");
if (config.model === "gemini" && process.env.GEMINI_REQUESTS_ENABLED === "1" && !process.env.GEMINI_API_KEY) throw new Error("Enabled Gemini requests require GEMINI_API_KEY.");
if (config.model === "opencode-go" && process.env.OPENCODE_GO_REQUESTS_ENABLED === "1" && !process.env.OPENCODE_GO_API_KEY) throw new Error("Enabled OpenCode Go requests require OPENCODE_GO_API_KEY.");
const providerRequestsEnabled = config.model === "jev" && config.jevRequestsEnabled
  || config.model === "gemini" && process.env.GEMINI_REQUESTS_ENABLED === "1"
  || config.model === "opencode-go" && process.env.OPENCODE_GO_REQUESTS_ENABLED === "1";
if (providerRequestsEnabled && config.modelMaxRequestsPerUtcDay === 0) throw new Error("Enabled provider requests require a positive MODEL_MAX_REQUESTS_PER_UTC_DAY cap.");
if (!/^gemini-[a-zA-Z0-9.-]+$/.test(config.geminiModel)) throw new Error("GEMINI_MODEL must be a Gemini model ID.");
if (!/^[a-zA-Z0-9.-]+$/.test(config.opencodeGoModel)) throw new Error("OPENCODE_GO_MODEL_ID must be a simple model ID.");
if (config.opencodeGoProtocol !== "chat" && config.opencodeGoProtocol !== "responses") throw new Error("OPENCODE_GO_PROTOCOL must be chat or responses.");
if (config.model === "jev" && config.zenModel === "jev-1.13" && process.env.JEV_ALLOW_PAID !== "1") throw new Error("Paid Jev is disabled by default. Set JEV_ALLOW_PAID=1 only after setting a provider spending limit.");
if (config.orderSizeMon <= 0 || config.maxPositionMon < config.orderSizeMon || config.initialCashUsd <= 0 || config.maxLossUsd <= 0 || config.feeBps !== null && (config.feeBps < 0 || config.feeBps > 100)) throw new Error("Invalid paper risk configuration.");
