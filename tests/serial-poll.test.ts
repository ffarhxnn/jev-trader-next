import { describe, expect, test } from "bun:test";
import { SerialPoll, type PollClock } from "../src/serial-poll";

type Timer = ReturnType<typeof setTimeout>;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

class FakeClock implements PollClock {
  time = 0;
  private id = 0;
  readonly timers = new Map<Timer, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delayMs: number): Timer => {
    const id = ++this.id as unknown as Timer;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  };
  clearTimeout = (id: Timer) => { this.timers.delete(id); };
  sleep = (ms: number) => new Promise<void>((resolve) => { this.setTimeout(resolve, ms); });
  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    await flush();
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      this.time = Math.max(this.time, next[1].at);
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = until;
    await flush();
  }
}

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("serial poll start cadence", () => {
  test("targets repeated start times instead of adding read and processing latency", async () => {
    const clock = new FakeClock();
    const starts: number[] = [];
    const poll = new SerialPoll(100, async () => {
      starts.push(clock.now());
      await clock.sleep(25); // Read latency.
      await clock.sleep(15); // Book processing latency.
    }, () => {}, clock);
    poll.start();
    poll.start(); // Starting twice cannot create a second loop.
    await clock.advance(440);
    expect(starts).toEqual([0, 100, 200, 300, 400]);
    poll.stop();
    expect(clock.timers.size).toBe(0);
  });

  test("skips deadlines during slow work without overlapping or catch-up bursts", async () => {
    const clock = new FakeClock();
    const starts: number[] = [];
    const durations = [250, 30, 410, 10];
    let active = 0;
    let maxActive = 0;
    const poll = new SerialPoll(100, async () => {
      starts.push(clock.now());
      maxActive = Math.max(maxActive, ++active);
      await clock.sleep(durations[starts.length - 1] ?? 10);
      --active;
    }, () => {}, clock);
    poll.start();
    await clock.advance(910);
    expect(starts).toEqual([0, 300, 400, 900]);
    expect(maxActive).toBe(1);
    poll.stop();
  });

  test("work finishing exactly on a deadline can start the next poll on time", async () => {
    const clock = new FakeClock();
    const starts: number[] = [];
    const poll = new SerialPoll(100, async () => {
      starts.push(clock.now());
      await clock.sleep(200);
    }, () => {}, clock);
    poll.start();
    await clock.advance(400);
    expect(starts).toEqual([0, 200, 400]);
    poll.stop();
    await clock.advance(200);
    expect(starts).toEqual([0, 200, 400]);
  });

  test("delayed timer delivery does not compress the following poll interval", async () => {
    const clock = new FakeClock();
    const starts: number[] = [];
    const poll = new SerialPoll(100, async () => { starts.push(clock.now()); }, () => {}, clock);
    poll.start();
    await flush();
    clock.time = 250; // The event loop was unable to deliver the 100ms timer.
    await clock.advance(0);
    expect(starts).toEqual([0, 250]);
    await clock.advance(99);
    expect(starts).toEqual([0, 250]);
    await clock.advance(1);
    expect(starts).toEqual([0, 250, 350]);
    poll.stop();
  });

  test("reports synchronous and asynchronous errors and continues the serial cadence", async () => {
    const clock = new FakeClock();
    const starts: number[] = [];
    const errors: unknown[] = [];
    const failure = new Error("Read failed");
    const poll = new SerialPoll(100, () => {
      starts.push(clock.now());
      if (starts.length === 1) throw failure;
      if (starts.length === 2) return clock.sleep(250).then(() => { throw failure; });
      return Promise.resolve();
    }, (error) => { errors.push(error); }, clock);
    poll.start();
    await clock.advance(500);
    expect(starts).toEqual([0, 100, 400, 500]);
    expect(errors).toEqual([failure, failure]);
    poll.stop();
  });

  test("stop during a wait clears it and permanently prevents further starts", async () => {
    const clock = new FakeClock();
    let starts = 0;
    const poll = new SerialPoll(100, async () => { ++starts; }, () => {}, clock);
    poll.start();
    await clock.advance(50);
    expect(clock.timers.size).toBe(1);
    poll.stop();
    poll.stop();
    poll.start();
    await clock.advance(1_000);
    expect(starts).toBe(1);
    expect(clock.timers.size).toBe(0);
  });

  test("stop during a pending read aborts the signal and discards its eventual result", async () => {
    const clock = new FakeClock();
    const read = deferred();
    let starts = 0;
    let processed = 0;
    let signal: AbortSignal | undefined;
    const poll = new SerialPoll(100, async (nextSignal) => {
      ++starts;
      signal = nextSignal;
      await read.promise;
      if (!nextSignal.aborted) ++processed;
    }, () => {}, clock);
    poll.start();
    await clock.advance(500);
    expect(starts).toBe(1);
    expect(clock.timers.size).toBe(0);
    poll.stop();
    expect(signal?.aborted).toBe(true);
    read.resolve();
    await clock.advance(1_000);
    expect(processed).toBe(0);
    expect(starts).toBe(1);
    expect(clock.timers.size).toBe(0);
  });

  test("a pending rejection after stop neither reports an error nor schedules work", async () => {
    const clock = new FakeClock();
    const read = deferred();
    const errors: unknown[] = [];
    const poll = new SerialPoll(100, () => read.promise, (error) => { errors.push(error); }, clock);
    poll.start();
    poll.stop();
    read.reject(new Error("Read failed after shutdown"));
    await clock.advance(1_000);
    expect(errors).toEqual([]);
    expect(clock.timers.size).toBe(0);
  });

  test("stop before start performs no work", () => {
    const clock = new FakeClock();
    let starts = 0;
    const poll = new SerialPoll(100, async () => { ++starts; }, () => {}, clock);
    poll.stop();
    poll.start();
    expect(starts).toBe(0);
    expect(clock.timers.size).toBe(0);
  });

  test("rejects invalid intervals", () => {
    for (const interval of [0, -1, NaN, Infinity]) {
      expect(() => new SerialPoll(interval, async () => {}, () => {})).toThrow("Poll interval must be positive and finite.");
    }
  });
});
