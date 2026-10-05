import { describe, expect, test } from "bun:test";
import { KuruTradeFeed } from "../src/trade-feed";
import type { KuruBookReader } from "../src/book";

class FakeSocket {
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  closed = false;
  sends = 0;
  send() { ++this.sends; }
  close() { this.closed = true; this.onclose?.({} as CloseEvent); }
  message(data: string) { this.onmessage?.({ data } as MessageEvent); }
}

describe("Kuru public trade feed liveness", () => {
  test("surfaces only minimal receipt fields for a trade without aggressor side", async () => {
    const socket = new FakeSocket();
    const ignored: unknown[] = [];
    const feed = new KuruTradeFeed(
      { getSizePrecision: async () => 100 } as KuruBookReader,
      () => {},
      () => {},
      (event) => ignored.push(event),
      "ws://test.invalid",
      1_000,
      () => 12,
      () => socket as unknown as WebSocket,
    );

    feed.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.onopen?.({} as Event);
    socket.message(JSON.stringify({ type: "subscribed", status: "success" }));
    socket.message(JSON.stringify({ type: "update", events: [{ e: "Trade", p: "27800000000000000", s: "100000000000", ts: "1790000000123", th: `0x${"e".repeat(64)}`, maker: "0x1234" }] }));
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatchObject({ reason: "trade lacks a reliable taker side or price/size", rawPrice: "27800000000000000", rawSize: "100000000000", sourceTimestamp: "1790000000123", transactionHash: `0x${"e".repeat(64)}` });
    expect((ignored[0] as { timestamp: number }).timestamp).toBe(12);
    feed.close();
  });

  test("uses the injected receipt clock for normalized trade events", async () => {
    const socket = new FakeSocket();
    const trades: unknown[] = [];
    const feed = new KuruTradeFeed(
      { getSizePrecision: async () => 100 } as KuruBookReader,
      (trade) => trades.push(trade),
      () => {},
      () => {},
      "ws://test.invalid",
      1_000,
      () => 37,
      () => socket as unknown as WebSocket,
    );
    feed.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.onopen?.({} as Event);
    socket.message(JSON.stringify({ type: "subscribed", status: "success" }));
    socket.message(JSON.stringify({ type: "update", events: [{ e: "Trade", p: "27800000000000000", s: "100000000000", ib: false }] }));
    expect(trades).toHaveLength(1);
    expect((trades[0] as { timestamp: number }).timestamp).toBe(37);
    feed.close();
  });

  test("accepts Kuru SDK named Trade fields and records the executed filled size", async () => {
    const socket = new FakeSocket();
    const trades: unknown[] = [];
    const feed = new KuruTradeFeed(
      { getSizePrecision: async () => 10_000_000_000 } as KuruBookReader,
      (trade) => trades.push(trade),
      () => {},
      () => {},
      "ws://test.invalid",
      1_000,
      () => 37,
      () => socket as unknown as WebSocket,
    );
    feed.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.onopen?.({} as Event);
    socket.message(JSON.stringify({ type: "subscribed", status: "success" }));
    socket.message(JSON.stringify({ type: "update", events: [{
      orderId: 9, makerAddress: `0x${"1".repeat(40)}`, takerAddress: `0x${"2".repeat(40)}`,
      isBuy: true, price: "27800000000000000", updatedSize: "990000000000",
      filledSize: "100000000000", transactionHash: `0x${"f".repeat(64)}`, triggerTime: 1790000000123,
    }] }));
    expect(trades).toEqual([{
      timestamp: 37, price: 0.0278, size: 10, takerSide: "buy", rawPrice: "27800000000000000",
      rawSize: "100000000000", transactionHash: `0x${"f".repeat(64)}`, sourceTimestamp: "1790000000123",
    }]);
    feed.close();
  });

  test("closes a silent socket and marks the stream unavailable after its freshness deadline", async () => {
    const socket = new FakeSocket();
    const statuses: boolean[] = [];
    const feed = new KuruTradeFeed(
      { getSizePrecision: async () => 100 } as KuruBookReader,
      () => {},
      (healthy) => statuses.push(healthy),
      () => {},
      "ws://test.invalid",
      20,
      Date.now,
      () => socket as unknown as WebSocket,
    );

    feed.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.onopen?.({} as Event);
    socket.message(JSON.stringify({ type: "subscribed", status: "success" }));
    expect(statuses).toEqual([true]);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(socket.closed).toBe(true);
    expect(statuses).toEqual([true, false]);
    feed.close();
  });

  test("book and event messages renew freshness even when there is no trade", async () => {
    const socket = new FakeSocket();
    const statuses: boolean[] = [];
    const feed = new KuruTradeFeed(
      { getSizePrecision: async () => 100 } as KuruBookReader,
      () => {},
      (healthy) => statuses.push(healthy),
      () => {},
      "ws://test.invalid",
      200,
      Date.now,
      () => socket as unknown as WebSocket,
    );

    feed.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.onopen?.({} as Event);
    socket.message(JSON.stringify({ type: "subscribed", status: "pending" }));
    expect(statuses).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    socket.message(JSON.stringify({ type: "snapshot", b: [], a: [] }));
    expect(statuses).toEqual([true]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    socket.message(JSON.stringify({ type: "update", events: [] }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(socket.closed).toBe(false);
    expect(statuses).toEqual([true]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(socket.closed).toBe(true);
    expect(statuses).toEqual([true, false]);
    feed.close();
  });
});

type Timer = ReturnType<typeof setTimeout>;
class FakeScheduler {
  private nextId = 0;
  readonly pending = new Map<Timer, { callback: () => void; delayMs: number }>();
  readonly canceled: Array<() => void> = [];
  setTimeout = (callback: () => void, delayMs: number): Timer => {
    const id = ++this.nextId as unknown as Timer;
    this.pending.set(id, { callback, delayMs });
    return id;
  };
  clearTimeout = (id: Timer) => {
    const task = this.pending.get(id);
    if (task) this.canceled.push(task.callback);
    this.pending.delete(id);
  };
  fireNext() {
    const entry = this.pending.entries().next().value;
    if (!entry) throw new Error("No scheduled task");
    const [id, task] = entry;
    this.pending.delete(id);
    task.callback();
  }
}

const flushConnection = async () => { await Promise.resolve(); await Promise.resolve(); };
const subscription = JSON.stringify({ type: "subscribed", status: "success" });
const tradeUpdate = (valid = true) => JSON.stringify({ type: "update", events: [{
  e: "Trade", p: "27800000000000000", s: "100000000000", ...(valid ? { ib: false } : {}),
}] });

function lifecycleFeed(reader: KuruBookReader = { getSizePrecision: async () => 100 } as KuruBookReader) {
  const sockets: FakeSocket[] = [];
  const trades: unknown[] = [];
  const ignored: unknown[] = [];
  const statuses: boolean[] = [];
  const scheduler = new FakeScheduler();
  let now = 0;
  const feed = new KuruTradeFeed(reader, (trade) => trades.push(trade), (healthy) => statuses.push(healthy),
    (event) => ignored.push(event), "ws://test.invalid", 100, () => now, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    }, scheduler);
  return { feed, sockets, trades, ignored, statuses, scheduler, advance: (ms: number) => { now += ms; } };
}

describe("Kuru trade feed lifecycle ownership", () => {
  test("late socket events after stopping cannot deliver or revive the feed", async () => {
    const state = lifecycleFeed();
    state.feed.start();
    await flushConnection();
    const socket = state.sockets[0]!;
    socket.message(subscription);
    state.feed.close();
    socket.onopen?.({} as Event);
    socket.message(tradeUpdate());
    socket.message(tradeUpdate(false));
    socket.onerror?.({} as Event);
    socket.onclose?.({} as CloseEvent);
    state.scheduler.canceled.forEach((callback) => callback());
    expect(socket.sends).toBe(0);
    expect(state.trades).toEqual([]);
    expect(state.ignored).toEqual([]);
    expect(state.statuses).toEqual([true, false]);
    expect(state.scheduler.pending.size).toBe(0);
  });

  test("a retired socket cannot affect its replacement or cancel its freshness timer", async () => {
    const state = lifecycleFeed();
    state.feed.start();
    await flushConnection();
    const oldSocket = state.sockets[0]!;
    oldSocket.message(subscription);
    oldSocket.onerror?.({} as Event);
    expect(state.scheduler.pending.size).toBe(1);
    state.scheduler.fireNext();
    await flushConnection();
    const replacement = state.sockets[1]!;
    replacement.message(subscription);
    oldSocket.onopen?.({} as Event);
    oldSocket.message(tradeUpdate());
    oldSocket.message(tradeUpdate(false));
    oldSocket.onerror?.({} as Event);
    oldSocket.onclose?.({} as CloseEvent);
    state.scheduler.canceled.forEach((callback) => callback());
    expect(state.trades).toEqual([]);
    expect(state.ignored).toEqual([]);
    expect(state.statuses).toEqual([true, false, true]);
    expect(state.scheduler.pending.size).toBe(1);
    expect(replacement.closed).toBe(false);
    state.advance(100);
    state.scheduler.fireNext();
    expect(replacement.closed).toBe(true);
    expect(state.statuses).toEqual([true, false, true, false]);
    expect(state.scheduler.pending.size).toBe(1);
    state.feed.close();
    expect(state.scheduler.pending.size).toBe(0);
  });

  test("duplicate starts share an attempt and stopped precision reads cannot create sockets after restart", async () => {
    const reads: Array<{ resolve: (value: number) => void; reject: (error: Error) => void }> = [];
    const state = lifecycleFeed({ getSizePrecision: () => new Promise<number>((resolve, reject) => {
      reads.push({ resolve, reject });
    }) } as KuruBookReader);
    state.feed.start();
    state.feed.start();
    expect(reads).toHaveLength(1);
    state.feed.close();
    state.feed.start();
    state.feed.start();
    expect(reads).toHaveLength(2);
    reads[1]!.resolve(100);
    await flushConnection();
    reads[0]!.resolve(100);
    await flushConnection();
    expect(state.sockets).toHaveLength(1);
    state.sockets[0]!.message(subscription);
    state.feed.start();
    expect(reads).toHaveLength(2);
    expect(state.scheduler.pending.size).toBe(1);
    state.feed.close();
  });

  test("a stopped precision rejection and canceled reconnect cannot restart the feed", async () => {
    let reject!: (error: Error) => void;
    const state = lifecycleFeed({ getSizePrecision: () => new Promise<number>((_, failure) => { reject = failure; }) } as KuruBookReader);
    state.feed.start();
    state.feed.close();
    reject(new Error("offline precision failure"));
    await flushConnection();
    expect(state.scheduler.pending.size).toBe(0);
    expect(state.sockets).toHaveLength(0);

    const retryState = lifecycleFeed();
    retryState.feed.start();
    await flushConnection();
    retryState.sockets[0]!.close();
    expect(retryState.scheduler.pending.size).toBe(1);
    retryState.feed.close();
    retryState.feed.start();
    retryState.scheduler.canceled.forEach((callback) => callback());
    await flushConnection();
    expect(retryState.sockets).toHaveLength(2);
    expect(retryState.scheduler.pending.size).toBe(1);
    retryState.feed.close();
  });

  test("renewed freshness ignores its canceled timer and retires a rejected subscription once", async () => {
    const state = lifecycleFeed();
    state.feed.start();
    await flushConnection();
    const socket = state.sockets[0]!;
    socket.message(subscription);
    state.advance(100);
    socket.message(JSON.stringify({ type: "snapshot", b: [], a: [] }));
    state.scheduler.canceled.forEach((callback) => callback());
    expect(socket.closed).toBe(false);
    expect(state.scheduler.pending.size).toBe(1);
    socket.message(JSON.stringify({ type: "subscribed", status: "rejected" }));
    socket.onclose?.({} as CloseEvent);
    socket.onerror?.({} as Event);
    expect(socket.closed).toBe(true);
    expect(state.statuses).toEqual([true, false]);
    expect(state.scheduler.pending.size).toBe(1);
    state.feed.close();
  });

  test("initial connection and subscription acknowledgment have a freshness deadline", async () => {
    const state = lifecycleFeed();
    state.feed.start();
    await flushConnection();
    const socket = state.sockets[0]!;
    socket.onopen?.({} as Event);
    expect(socket.sends).toBe(1);
    state.advance(100);
    state.scheduler.fireNext();
    expect(socket.closed).toBe(true);
    expect(state.statuses).toEqual([]);
    expect(state.scheduler.pending.size).toBe(1);
    socket.message(subscription);
    expect(state.statuses).toEqual([]);
    state.feed.close();
  });

  test("failed subscription sends retire even when transport close throws", async () => {
    const state = lifecycleFeed();
    state.feed.start();
    await flushConnection();
    const socket = state.sockets[0]!;
    socket.send = () => { throw new Error("offline send failure"); };
    socket.close = () => { throw new Error("offline close failure"); };
    expect(() => socket.onopen?.({} as Event)).not.toThrow();
    expect(state.scheduler.pending.size).toBe(1);
    socket.message(subscription);
    socket.message(tradeUpdate());
    expect(state.statuses).toEqual([]);
    expect(state.trades).toEqual([]);
    state.feed.close();
    expect(state.scheduler.pending.size).toBe(0);
  });

  test("explicit stop publishes unhealthy and clears timers when transport close throws", async () => {
    const state = lifecycleFeed();
    state.feed.start();
    await flushConnection();
    const socket = state.sockets[0]!;
    socket.message(subscription);
    socket.close = () => { throw new Error("offline close failure"); };
    expect(() => state.feed.close()).not.toThrow();
    expect(state.statuses).toEqual([true, false]);
    expect(state.scheduler.pending.size).toBe(0);
    socket.message(tradeUpdate(false));
    expect(state.ignored).toEqual([]);
  });
});
