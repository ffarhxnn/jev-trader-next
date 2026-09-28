import { config } from "./config";
import { DemoBookReader, KuruBookReader, type BookReader } from "./book";
import { DemoModel, JevModel, type DecisionModel } from "./model";
import { PaperEngine } from "./paper";
import type { Snapshot } from "./types";

const reader: BookReader = config.mode === "paper" ? new KuruBookReader() : new DemoBookReader();
const model: DecisionModel = config.model === "jev" ? new JevModel(process.env.OPENCODE_API_KEY!) : new DemoModel();
const engine = new PaperEngine({ mode: config.mode, model });
const subscribers = new Set<(event: string, snapshot: Snapshot) => void>();
let snapshot = engine.snapshot();
engine.subscribe((next) => {
  snapshot = next;
  const type = next.modelStatus === "waiting" || next.modelStatus === "failed" ? "status" : "update";
  for (const send of subscribers) send(type, next);
});

const publicSnapshot = () => ({ ...snapshot, tape: snapshot.tape.slice(0, 12), chart: snapshot.chart.slice(-240) });
const mime = { "/": "text/html; charset=utf-8", "/style.css": "text/css; charset=utf-8", "/app.js": "text/javascript; charset=utf-8" } as Record<string, string>;
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
    if (url.pathname === "/api/snapshot") return Response.json(publicSnapshot(), { headers: { "cache-control": "no-store" } });
    if (url.pathname === "/api/events") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (event: string, data: Snapshot) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ ...data, tape: data.tape.slice(0, 12) })}\n\n`));
          const onChange = (event: string, data: Snapshot) => send(event, data);
          subscribers.add(onChange);
          send("snapshot", snapshot);
          const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 15_000);
          request.signal.addEventListener("abort", () => { clearInterval(heartbeat); subscribers.delete(onChange); try { controller.close(); } catch {} }, { once: true });
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
    }
    if (url.pathname in mime) return new Response(Bun.file(`web/${url.pathname === "/" ? "index.html" : url.pathname.slice(1)}`), { headers: { "content-type": mime[url.pathname]! } });
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Jev Trader ${config.mode} dashboard on http://${server.hostname}:${server.port}`);
let busy = false;
const pollMs = config.mode === "demo" ? 400 : config.pollMs;
const poll = async () => {
  if (!busy) {
    busy = true;
    try { await engine.onBook(await reader.read()); }
    catch { engine.setUnavailable("Public RPC is unavailable. No synthetic data is substituted in paper mode."); }
    finally { busy = false; }
  }
  setTimeout(poll, pollMs);
};
poll();
