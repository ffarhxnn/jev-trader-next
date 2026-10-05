import { isKuruTradeEvent, normalizeIgnoredKuruTrade, normalizeKuruTrade, parseKuruRawMessage } from "./research";
import type { KuruBookReader } from "./book";
import type { TradeEvent } from "./types";
import { config } from "./config";

type Timer = ReturnType<typeof setTimeout>;
interface FeedScheduler {
  setTimeout(callback: () => void, delayMs: number): Timer;
  clearTimeout(timer: Timer): void;
}

/** Read-only subscription to public Kuru trades. */
export class KuruTradeFeed {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private delayMs = 1_000;
  private stopped = true;
  private generation = 0;
  private connected = false;
  private lastMessageAt: number | null = null;

  constructor(
    private readonly reader: KuruBookReader,
    private readonly onTrade: (trade: TradeEvent) => void,
    private readonly onStatus: (healthy: boolean) => void,
    private readonly onIgnored: (event: ReturnType<typeof normalizeIgnoredKuruTrade>) => void = () => {},
    private readonly wsUrl = process.env.KURU_WS_URL ?? "wss://ws.kuru.io",
    private readonly staleAfterMs = config.tradeFeedStaleAfterMs,
    private readonly now: () => number = Date.now,
    private readonly createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
    private readonly scheduler: FeedScheduler = { setTimeout, clearTimeout },
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  close() {
    this.stopped = true;
    ++this.generation;
    const socket = this.socket;
    this.socket = null;
    this.clearTimers();
    this.lastMessageAt = null;
    this.setConnected(false);
    if (socket) this.closeTransport(socket);
  }

  private async connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    try {
      const sizePrecision = await this.reader.getSizePrecision();
      if (!this.isCurrent(generation)) return;
      const socket = this.createSocket(this.wsUrl);
      this.socket = socket;
      socket.onopen = () => {
        if (!this.isCurrent(generation, socket)) return;
        try {
          socket.send(JSON.stringify({ type: "subscribe", channel: "frontendOrderbook", market: config.market.toLowerCase() }));
        } catch {
          this.retire(generation, socket, true);
        }
      };
      socket.onmessage = (message) => {
        if (!this.isCurrent(generation, socket)) return;
        try {
          const data = parseKuruRawMessage(String(message.data)) as {
            type?: string; status?: string; events?: Array<Record<string, unknown>>;
            b?: unknown[]; a?: unknown[];
          };
          if (data.type === "subscribed") {
            if (data.status === "pending") {
              this.lastMessageAt = this.now();
              this.scheduleStaleCheck(socket, generation);
              return;
            }
            if (data.status !== "success") throw new Error("Kuru trade subscription was rejected.");
            this.lastMessageAt = this.now();
            this.scheduleStaleCheck(socket, generation);
            this.delayMs = 1_000;
            this.setConnected(true);
            return;
          }
          const isSnapshot = data.type === "snapshot" || Array.isArray(data.b) && Array.isArray(data.a);
          const hasEvents = Array.isArray(data.events);
          if (!isSnapshot && !hasEvents) throw new Error("Kuru feed returned an unrecognized message.");
          this.lastMessageAt = this.now();
          this.scheduleStaleCheck(socket, generation);
          this.delayMs = 1_000;
          this.setConnected(true);
          for (const event of data.events ?? []) {
            if (!this.isCurrent(generation, socket)) return;
            if (!isKuruTradeEvent(event)) continue;
            const receivedAt = this.now();
            const trade = normalizeKuruTrade(event, sizePrecision, receivedAt);
            if (trade) this.onTrade(trade);
            else this.onIgnored(normalizeIgnoredKuruTrade(event, receivedAt));
          }
        } catch {
          this.retire(generation, socket, true);
        }
      };
      socket.onerror = () => this.retire(generation, socket, true);
      socket.onclose = () => this.retire(generation, socket, false);
      this.lastMessageAt = this.now();
      this.scheduleStaleCheck(socket, generation);
    } catch {
      if (!this.isCurrent(generation)) return;
      this.setConnected(false);
      this.scheduleReconnect(generation);
    }
  }

  private isCurrent(generation: number, socket?: WebSocket) {
    return !this.stopped && this.generation === generation && (socket === undefined || this.socket === socket);
  }

  private clearTimers() {
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
    if (this.staleTimer !== undefined) this.scheduler.clearTimeout(this.staleTimer);
    this.timer = undefined;
    this.staleTimer = undefined;
  }

  private retire(generation: number, socket: WebSocket, closeSocket: boolean) {
    if (!this.isCurrent(generation, socket)) return;
    const nextGeneration = ++this.generation;
    this.socket = null;
    this.lastMessageAt = null;
    this.clearTimers();
    this.setConnected(false);
    if (closeSocket) this.closeTransport(socket);
    this.scheduleReconnect(nextGeneration);
  }

  private closeTransport(socket: WebSocket) {
    // Lifecycle ownership is already invalidated even if the transport cannot close.
    try { socket.close(); } catch {}
  }

  private scheduleReconnect(generation: number) {
    if (!this.isCurrent(generation)) return;
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
    const timer = this.scheduler.setTimeout(() => {
      if (!this.isCurrent(generation) || this.timer !== timer) return;
      this.timer = undefined;
      void this.connect();
    }, this.delayMs);
    this.timer = timer;
    this.delayMs = Math.min(this.delayMs * 2, 30_000);
  }

  private scheduleStaleCheck(socket: WebSocket, generation: number) {
    if (this.staleTimer !== undefined) this.scheduler.clearTimeout(this.staleTimer);
    const timer = this.scheduler.setTimeout(() => {
      if (!this.isCurrent(generation, socket) || this.staleTimer !== timer || this.lastMessageAt === null) return;
      this.staleTimer = undefined;
      if (this.now() - this.lastMessageAt >= this.staleAfterMs) {
        this.retire(generation, socket, true);
        return;
      }
      this.scheduleStaleCheck(socket, generation);
    }, this.staleAfterMs);
    this.staleTimer = timer;
  }

  private setConnected(healthy: boolean) {
    if (this.connected === healthy) return;
    this.connected = healthy;
    this.onStatus(healthy);
  }
}
