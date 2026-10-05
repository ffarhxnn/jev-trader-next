const $ = (id) => document.getElementById(id);
const fmt = (n, digits = 2) => Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
const money = (n) => `${n < 0 ? "−" : ""}$${fmt(Math.abs(n), 2)}`;
const safe = (value) => String(value ?? "");

function render(s) {
  document.body.dataset.status = s.modelStatus === "waiting" ? "waiting" : s.status;
  document.body.dataset.mode = s.mode;
  document.body.dataset.action = s.decision?.action ?? "hold";
  const waitSeconds = Math.max(0, Math.ceil(((s.nextRetryAt ?? Date.now()) - Date.now()) / 1000));
  const modelName = String(s.model ?? "");
  const notice = String(s.notice ?? "");
  const waitingLabel = notice.includes("HTTP 429") ? "PROVIDER COOLDOWN"
    : /requests are disabled|decisions are paused/i.test(notice) ? "MODEL REQUESTS OFF"
      : modelName === "stand-in momentum heuristic" ? `NEXT LOCAL DECISION · ${waitSeconds}s`
        : modelName.includes("OpenCode Zen") ? `NEXT JEV CALL · ${waitSeconds}s`
          : modelName.includes("Google Gemini") ? `NEXT GEMINI CALL · ${waitSeconds}s`
            : modelName.includes("OpenCode Go") ? `NEXT OPENCODE GO CALL · ${waitSeconds}s`
              : `NEXT MODEL REQUEST · ${waitSeconds}s`;
  const statusText = s.modelStatus === "waiting"
    ? waitingLabel
    : s.status === "live" ? (s.mode === "paper" ? "PAPER ACTIVE" : "DEMO RUNNING") : s.status === "connecting" ? "CONNECTING" : s.status.toUpperCase();
  $("status").innerHTML = `<i></i> ${statusText}`;
  $("mode").textContent = s.mode === "paper" ? "LIVE BOOK · PAPER ONLY" : "DETERMINISTIC DEMO";
  const source = $("market-source");
  if (source) source.textContent = s.book?.source === "Monad Kuru" ? "KURU ORDER BOOK · MONAD" : "SYNTHETIC PRICE PATH";
  const chartSource = $("chart-source");
  if (chartSource) chartSource.textContent = s.book?.source === "Monad Kuru" ? "Observed Monad Kuru mids" : "Generated path · demo";
  $("block").textContent = s.block ? s.block.toLocaleString() : "—";
  $("price").textContent = s.book ? fmt(s.book.mid, 6) : "—";
  $("spread").textContent = s.book ? `${fmt(s.book.spreadBps, 2)} bps` : "—";
  $("maker-fee").textContent = s.paperFeeBps == null ? "UNAVAILABLE" : `${fmt(s.paperFeeBps, 2)} bps`;
  $("model").textContent = s.model;
  const hasLastSignal = Boolean(s.decision && s.modelStatus === "waiting");
  $("decision-label").textContent = hasLastSignal ? "LAST SIGNAL" : "MODEL DECISION";
  $("decision").textContent = s.decision ? s.decision.action.toUpperCase() : s.modelStatus === "waiting" ? "WAIT" : "HOLD";
  const chosen = s.decision ? (s.decision.action === "buy" ? s.decision.buy : s.decision.action === "sell" ? s.decision.sell : 0.5) : 0.5;
  $("confidence").textContent = s.decision ? `${Math.round(chosen * 100)}%` : "—";
  $("buy-prob").textContent = `BUY ${s.decision ? Math.round(s.decision.buy * 100) : "—"}%`;
  $("sell-prob").textContent = `SELL ${s.decision ? Math.round(s.decision.sell * 100) : "—"}%`;
  $("buy-bar").style.width = `${Math.max(0, Math.min(100, s.decision ? s.decision.buy * 100 : 50))}%`;
  $("latency").textContent = s.decision ? `${Math.round(s.decision.latencyMs)} ms` : "—";
  $("quote").textContent = s.quote?.status === "resting" ? `${s.quote.side.toUpperCase()} ${fmt(s.quote.size, 0)} @ ${fmt(s.quote.price, 6)} · Q AHEAD ${fmt(s.quote.queueAhead ?? 0, 0)} · SIM` : "NO PAPER QUOTE";
  $("position").textContent = `${s.position.mon > 0 ? "LONG" : s.position.mon < 0 ? "SHORT" : "FLAT"} ${fmt(Math.abs(s.position.mon), 0)} MON · cash ${money(s.position.cash)}`;
  $("pnl").textContent = money(s.totals.pnlUsd);
  $("pnl").dataset.sign = s.totals.pnlUsd >= 0 ? "up" : "down";
  $("blocks").textContent = s.totals.blocks.toLocaleString();
  $("decisions").textContent = s.totals.decisions.toLocaleString();
  $("quotes").textContent = s.totals.quotes.toLocaleString();
  $("fills").textContent = s.totals.fills.toLocaleString();
  const lastTrade = s.totals.lastTradeAt ? ` · last ${Math.max(0, Math.floor((Date.now() - s.totals.lastTradeAt) / 1000))}s ago` : "";
  $("trade-stats").textContent = `${(s.totals.tradeEvents ?? 0).toLocaleString()} trades · ${(s.totals.ignoredTradeEvents ?? 0).toLocaleString()} ignored${lastTrade}`;
  $("fees").textContent = money(s.totals.feesUsd);
  const retryAt = s.nextRetryAt ? new Date(s.nextRetryAt).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }) : null;
  const nextAtLabel = modelName === "stand-in momentum heuristic" ? "Next local decision" : "Next retry";
  $("notice").textContent = s.notice + (retryAt ? ` ${nextAtLabel}: ${retryAt}.` : "");
  const chart = s.chart ?? [];
  try { drawPriceChart(chart, s.tape ?? []); }
  catch (error) {
    const chartSource = $("chart-source");
    if (chartSource) chartSource.textContent = `Chart unavailable · ${error instanceof Error ? error.message : "render error"}`;
    console.error("Price chart render failed", error);
  }
  const rows = (s.tape ?? []).map((f) => `<tr><td>${safe(f.block)}</td><td>SIM FILL</td><td class="${f.side}">${f.side.toUpperCase()}</td><td>${fmt(f.price, 6)}</td><td>${fmt(f.size, 0)} MON</td></tr>`);
  $("tape").innerHTML = rows.join("") || `<tr><td colspan="5" class="empty">No fills. Quotes remain simulated and may never fill.</td></tr>`;
  const src = s.book?.source ?? "Waiting for book";
  $("notice").dataset.source = src;
}

const svgNode = (name, attrs = {}, label = "") => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (label) { const title = svgNode("title"); title.textContent = label; node.append(title); }
  return node;
};

function drawPriceChart(series, fills) {
  const area = $("chart-area"), line = $("chart-line"), marks = $("chart-fills"), current = $("chart-current"), grid = $("chart-grid");
  for (const group of [marks, current, grid]) group.replaceChildren();
  if (!series?.length) { area.setAttribute("d", ""); line.setAttribute("d", ""); return; }

  const left = 12, right = 562, top = 15, bottom = 178;
  const start = series[0].ts, end = series.at(-1).ts, timeSpan = end - start || 1;
  const visibleFills = fills.filter((f) => Number.isFinite(f.ts) && Number.isFinite(f.price) && f.ts >= start && f.ts <= end);
  const prices = [...series.map((p) => p.price), ...visibleFills.map((f) => f.price)].filter(Number.isFinite);
  const min = Math.min(...prices), max = Math.max(...prices), center = (min + max) / 2;
  const pad = Math.max((max - min) * .18, Math.abs(center) * .00015, 1e-9);
  const lo = min - pad, hi = max + pad, span = hi - lo || 1;
  const x = (ts) => left + Math.max(0, Math.min(1, (ts - start) / timeSpan)) * (right - left);
  const y = (price) => bottom - ((price - lo) / span) * (bottom - top);
  const pts = series.filter((p) => Number.isFinite(p.price) && Number.isFinite(p.ts)).map((p) => [x(p.ts), y(p.price)]);
  const curve = (points) => {
    if (!points.length) return "";
    let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
    for (let i = 1; i < points.length; i++) {
      const [px, py] = points[i - 1], [cx, cy] = points[i];
      const mid = (px + cx) / 2;
      d += ` Q${px.toFixed(1)},${py.toFixed(1)} ${mid.toFixed(1)},${((py + cy) / 2).toFixed(1)}`;
    }
    const [px, py] = points.at(-1);
    return points.length > 1 ? `${d} T${px.toFixed(1)},${py.toFixed(1)}` : d;
  };
  const linePath = curve(pts);
  line.setAttribute("d", linePath);
  area.setAttribute("d", pts.length > 1 ? `${linePath} L${pts.at(-1)[0].toFixed(1)},${bottom} L${pts[0][0].toFixed(1)},${bottom} Z` : "");

  for (const fraction of [.2, .5, .8]) {
    const gy = top + (bottom - top) * fraction;
    grid.append(svgNode("line", { x1: left, x2: right, y1: gy, y2: gy, class: "chart-grid-line" }));
    const price = hi - span * fraction;
    const tick = svgNode("text", { x: right, y: gy - 5, class: "chart-tick", "text-anchor": "end" });
    tick.textContent = fmt(price, 6);
    grid.append(tick);
  }

  let lastLabelX = -100;
  for (const fill of visibleFills) {
    const fx = x(fill.ts), fy = y(fill.price), isBuy = fill.side === "buy", color = isBuy ? "var(--green)" : "var(--red)";
    const group = svgNode("g", { class: `fill-marker ${fill.side}` }, `${fill.side.toUpperCase()} fill ${fmt(fill.size, 0)} MON at ${fmt(fill.price, 6)} · block ${fill.block}`);
    group.append(svgNode("line", { x1: fx, x2: fx, y1: fy + (isBuy ? 6 : -6), y2: 194, stroke: color, class: "fill-stem" }));
    group.append(svgNode("circle", { cx: fx, cy: fy, r: 5, fill: color, class: "fill-bead" }));
    group.append(svgNode("circle", { cx: fx, cy: fy, r: 9, fill: "none", stroke: color, class: "fill-halo" }));
    group.append(svgNode("rect", { x: fx - 3, y: 194, width: 6, height: 14, rx: 3, fill: color, class: "activity-cell" }));
    if (Math.abs(fx - lastLabelX) >= 58) {
      const labelY = isBuy ? Math.max(top + 3, fy - 24) : Math.min(bottom - 20, fy + 10);
      const tag = svgNode("g", { class: `fill-tag ${fill.side}` });
      tag.append(svgNode("rect", { x: fx - 22, y: labelY, width: 44, height: 17, rx: 4 }));
      const text = svgNode("text", { x: fx, y: labelY + 11.5, "text-anchor": "middle" });
      text.textContent = isBuy ? "BUY" : "SELL";
      tag.append(text); group.append(tag); lastLabelX = fx;
    }
    marks.append(group);
  }

  const latest = series.at(-1), cx = x(latest.ts), cy = y(latest.price);
  current.append(svgNode("line", { x1: cx, x2: right, y1: cy, y2: cy, class: "current-guide" }));
  current.append(svgNode("circle", { cx, cy, r: 3.5, class: "current-dot" }));
}

fetch("/api/snapshot").then((r) => r.json()).then(render).catch(() => {});
const feed = new EventSource("/api/events");
for (const type of ["snapshot", "update", "status"]) feed.addEventListener(type, (event) => { try { render(JSON.parse(event.data)); } catch {} });
feed.onerror = () => { document.body.dataset.status = "degraded"; $("status").innerHTML = "<i></i> RECONNECTING"; };
