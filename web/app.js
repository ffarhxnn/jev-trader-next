const $ = (id) => document.getElementById(id);
const fmt = (n, digits = 2) => Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
const money = (n) => `${n < 0 ? "−" : ""}$${fmt(Math.abs(n), 2)}`;
const safe = (value) => String(value ?? "");

function render(s) {
  document.body.dataset.status = s.modelStatus === "waiting" ? "waiting" : s.status;
  document.body.dataset.mode = s.mode;
  document.body.dataset.action = s.decision?.action ?? "hold";
  const statusText = s.modelStatus === "waiting" ? "WAITING" : s.status === "live" ? (s.mode === "paper" ? "PAPER ACTIVE" : "DEMO RUNNING") : s.status === "connecting" ? "CONNECTING" : s.status.toUpperCase();
  $("status").innerHTML = `<i></i> ${statusText}`;
  $("mode").textContent = s.mode === "paper" ? "LIVE BOOK · PAPER ONLY" : "DETERMINISTIC DEMO";
  const source = $("market-source");
  if (source) source.textContent = s.book?.source === "Monad Kuru" ? "KURU ORDER BOOK · MONAD" : "SYNTHETIC PRICE PATH";
  const chartSource = $("chart-source");
  if (chartSource) chartSource.textContent = s.book?.source === "Monad Kuru" ? "Observed Monad Kuru mids" : "Generated path · demo";
  $("block").textContent = s.block ? s.block.toLocaleString() : "—";
  $("price").textContent = s.book ? fmt(s.book.mid, 6) : "—";
  $("spread").textContent = s.book ? `${fmt(s.book.spreadBps, 2)} bps` : "—";
  $("model").textContent = s.model;
  $("decision").textContent = s.decision ? s.decision.action.toUpperCase() : s.modelStatus === "waiting" ? "WAIT" : "HOLD";
  const chosen = s.decision ? (s.decision.action === "buy" ? s.decision.buy : s.decision.action === "sell" ? s.decision.sell : 0.5) : 0.5;
  $("confidence").textContent = s.decision ? `${Math.round(chosen * 100)}%` : "—";
  $("buy-prob").textContent = `BUY ${s.decision ? Math.round(s.decision.buy * 100) : "—"}%`;
  $("sell-prob").textContent = `SELL ${s.decision ? Math.round(s.decision.sell * 100) : "—"}%`;
  $("buy-bar").style.width = `${Math.max(0, Math.min(100, s.decision ? s.decision.buy * 100 : 50))}%`;
  $("latency").textContent = s.decision ? `${Math.round(s.decision.latencyMs)} ms` : "—";
  $("quote").textContent = s.quote?.status === "resting" ? `${s.quote.side.toUpperCase()} ${fmt(s.quote.size, 0)} @ ${fmt(s.quote.price, 6)} · SIM` : "NO PAPER QUOTE";
  $("position").textContent = `${s.position.mon > 0 ? "LONG" : s.position.mon < 0 ? "SHORT" : "FLAT"} ${fmt(Math.abs(s.position.mon), 0)} MON · cash ${money(s.position.cash)}`;
  $("pnl").textContent = money(s.totals.pnlUsd);
  $("pnl").dataset.sign = s.totals.pnlUsd >= 0 ? "up" : "down";
  $("blocks").textContent = s.totals.blocks.toLocaleString();
  $("decisions").textContent = s.totals.decisions.toLocaleString();
  $("quotes").textContent = s.totals.quotes.toLocaleString();
  $("fills").textContent = s.totals.fills.toLocaleString();
  $("fees").textContent = money(s.totals.feesUsd);
  $("notice").textContent = s.notice + (s.nextRetryAt ? ` Retry after ${new Date(s.nextRetryAt).toLocaleTimeString()}.` : "");
  const chart = s.chart ?? [];
  if (chart.length > 1) {
    const prices = chart.map((p) => p.price), min = Math.min(...prices), max = Math.max(...prices), range = max - min || 1;
    const points = chart.map((p, i) => `${(i / (chart.length - 1)) * 600},${180 - ((p.price - min) / range) * 160}`).join(" ");
    $("chart").setAttribute("points", points);
  }
  const rows = (s.tape ?? []).map((f) => `<tr><td>${safe(f.block)}</td><td>SIM FILL</td><td class="${f.side}">${f.side.toUpperCase()}</td><td>${fmt(f.price, 6)}</td><td>${fmt(f.size, 0)} MON</td></tr>`);
  $("tape").innerHTML = rows.join("") || `<tr><td colspan="5" class="empty">No fills. Quotes remain simulated and may never fill.</td></tr>`;
  const src = s.book?.source ?? "Waiting for book";
  $("notice").dataset.source = src;
}

fetch("/api/snapshot").then((r) => r.json()).then(render).catch(() => {});
const feed = new EventSource("/api/events");
for (const type of ["snapshot", "update", "status"]) feed.addEventListener(type, (event) => { try { render(JSON.parse(event.data)); } catch {} });
feed.onerror = () => { document.body.dataset.status = "degraded"; $("status").innerHTML = "<i></i> RECONNECTING"; };
