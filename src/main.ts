import { version as APP_VERSION } from "../package.json";
import { mountUpdatePanel } from "./updatePanel";
import "./styles.css";
import { CandlestickSeries, ColorType, createChart, type BusinessDay, type IChartApi, type ISeriesApi } from "lightweight-charts";
import { availableMonitors, currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import { register } from "@tauri-apps/plugin-global-shortcut";
import { EastmoneyMarketProvider, normalizeInstrument, SECTOR_ALIASES } from "./market/eastmoneyProvider";
import type { SourcePreference } from "./market/marketData";
import type { QuoteUpdate, Stock } from "./market/types";
import { DetailPanel } from "./detailPanel";

const DEFAULT_STOCKS: Stock[] = [
  { symbol: "600519", name: "贵州茅台", previousClose: 1482.30, seed: 11 },
  { symbol: "000001", name: "平安银行", previousClose: 11.84, seed: 23 },
  { symbol: "300750", name: "宁德时代", previousClose: 264.56, seed: 37 },
  { symbol: "000300", name: "沪深300", previousClose: 4012.75, seed: 51 },
];

type ChartMode = "intraday" | "daily";
type Theme = { background: string; text: string; muted: string; up: string; down: string; line: string; average: string; candleUp: string; candleDown: string; volumeUp: string; volumeDown: string };
const DEFAULT_THEME: Theme = { background: "#22272b", text: "#8a9298", muted: "#596168", up: "#8e969c", down: "#737b81", line: "#858f96", average: "#686b6d", candleUp: "#df3f45", candleDown: "#20a66a", volumeUp: "#8a6265", volumeDown: "#52766a" };

function loadStocks(): Stock[] {
  try {
    const saved = JSON.parse(localStorage.getItem("stocks") ?? "null") as Stock[] | null;
    return (saved?.length ? saved : [...DEFAULT_STOCKS]).map(normalizeInstrument);
  } catch { return [...DEFAULT_STOCKS]; }
}

function loadTheme(): Theme {
  try { return { ...DEFAULT_THEME, ...JSON.parse(localStorage.getItem("theme") ?? "{}") }; }
  catch { return { ...DEFAULT_THEME }; }
}

const isTauri = "__TAURI_INTERNALS__" in window;
const appWindow = getCurrentWindow();
const provider = new EastmoneyMarketProvider();
const savedSource = localStorage.getItem("quoteSourcePreference") ?? "auto";
provider.setPreference((["auto", "tencent", "sina", "eastmoney"].includes(savedSource) ? savedSource : "auto") as SourcePreference);
let stocks = loadStocks();
let theme = loadTheme();
let currentIndex = Math.min(Number(localStorage.getItem("stockIndex") ?? 0), stocks.length - 1);
let chartMode = (localStorage.getItem("chartMode") as ChartMode | null) ?? "intraday";
const hasMicroV2 = localStorage.getItem("microV2") === "ready";
let compact = hasMicroV2 ? localStorage.getItem("compact") !== "false" : true;
let detailed = false;
let sectorComparison = localStorage.getItem("sectorComparison") === "true";
localStorage.setItem("microV2", "ready");
let opacity = Number(localStorage.getItem("opacity") ?? 82);
let disconnect: (() => void) | undefined;
let chart: IChartApi;
let candleSeries: ISeriesApi<"Candlestick">;
let latestUpdate: QuoteUpdate | undefined;
let resizeGeneration = 0;
let isWindowDragging = false;
let ignoreNextFocusLoss = false;
let dailyRequestGeneration = 0;
let lastDailyFetch = 0;
let dailyZoomAdjusted = false;
let themeRaf = 0;
let microAnchorPosition: { x: number; y: number } | null = null;
let positionSaveTimer = 0;
const WINDOW_POSITION_KEY = "microWindowPositionV1";

const icons = {
  shrink: '<svg viewBox="0 0 24 24"><path d="M8 3v5H3M16 21v-5h5M3 8l6-6M21 16l-6 6"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a8 8 0 0 0-1.7-1L14.5 3h-5L9 6a8 8 0 0 0-1.7 1L5 6 3 9.5 5 11a7 7 0 0 0 0 2l-2 1.5L5 18l2.4-1a8 8 0 0 0 1.7 1l.4 3h5l.4-3a8 8 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5a7 7 0 0 0 .1-1Z"/></svg>',
  hide: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
};

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <main class="shell" style="opacity:${opacity / 100}">
    <header class="topbar" data-drag-handle>
      <div class="identity" data-drag-handle><div class="stock-name">--</div><div class="symbol">------ · SH</div></div>
      <div class="quote" data-drag-handle><div class="price flat">--</div><div class="change flat" data-role="change-primary">-- &nbsp; --%</div></div>
      <nav class="window-actions"><button class="icon-button compact-button" aria-label="收回">${icons.shrink}</button><button class="icon-button hide-button" aria-label="隐藏">${icons.hide}</button></nav>
    </header>
    <section class="market-layout"><div class="chart-column"><section class="chart-wrap">
      <div class="status-pill"><span class="status-dot"></span><span class="status-text">连接真实行情…</span></div>
      <div class="chart-tabs"><button data-mode="intraday">分时</button><button data-mode="daily">日K</button></div>
      <canvas id="intraday-chart"></canvas><div id="chart"></div>
    </section><section class="sector-pane"><div class="sector-header"><span>关联板块</span><select id="related-sector" aria-label="选择关联板块"></select><span class="sector-meta"></span><button class="sector-retry" hidden type="button">重试</button></div><canvas id="sector-chart"></canvas></section></div>
    <aside class="depth-panel" aria-label="市场五档盘口和成交明细"><div class="depth-heading">五档盘口 <span>金额：元</span></div><div class="book-status">等待报价</div><table class="book-table"><thead><tr><th>档位</th><th>价格</th><th>手数</th><th>金额</th></tr></thead><tbody class="book-rows"></tbody></table><div class="book-totals">五档买额 — · 卖额 —</div><div class="depth-heading trades-heading">分笔成交 <span>聚合记录 / 非逐笔</span></div><div class="trades-status">明细加载中</div><div class="trade-scroll"><table class="trade-table"><thead><tr><th>源时间</th><th>价格</th><th>手数</th><th>方向</th></tr></thead><tbody class="trade-rows"></tbody></table></div></aside></section>
    <footer class="footer"><div class="watchlist"></div><button class="sector-toggle" aria-label="开关关联板块走势" aria-pressed="${sectorComparison}">板块</button><button class="detail-button" aria-label="打开详细分时图" aria-pressed="false">详细图</button><button class="icon-button settings-button" aria-label="设置">${icons.settings}</button></footer>
    <div class="update-notice" hidden><span></span><button class="update-view" type="button">查看</button><button class="update-later" type="button">稍后</button></div>
    <aside class="settings">
      <div class="settings-title settings-drag">持仓编辑 <span>拖动窗口</span></div>
      <form class="stock-form"><input id="stock-code" inputmode="numeric" maxlength="6" placeholder="股票/板块代码" required><input id="stock-quantity" inputmode="decimal" placeholder="数量（板块可空）"><input id="stock-cost" inputmode="decimal" placeholder="成本（板块可空）"><button type="submit">保存</button></form>
      <div class="stock-form-actions"><span class="form-message"></span><button class="remove-stock" type="button">删除当前</button></div>
      <div class="settings-title theme-title">颜色与显示</div>
      <div class="theme-grid">${([['background','背景'],['text','主文字'],['muted','次文字'],['up','上涨'],['down','下跌'],['line','分时线'],['average','均价线'],['candleUp','K线上涨'],['candleDown','K线下跌'],['volumeUp','量柱上涨'],['volumeDown','量柱下跌']] as [keyof Theme,string][]).map(([key,label]) => `<label><span>${label}</span><input type="color" data-theme="${key}" value="${theme[key]}"></label>`).join("")}</div>
      <label class="setting-row"><span>透明度</span><input id="opacity" type="range" min="65" max="100" value="${opacity}"><output>${opacity}%</output></label>
      <button class="reset-theme" type="button">恢复低调配色</button>
      <div class="shortcut"><span>显示 / 隐藏</span><kbd>Alt + Shift + S</kbd></div>
      <label class="source-setting">个股报价优先级<select id="quote-source"><option value="auto">自动（腾讯优先）</option><option value="tencent">腾讯优先</option><option value="sina">新浪优先</option><option value="eastmoney">东方财富优先</option></select></label>
      <section class="update-panel" aria-label="软件更新"><div class="update-version"></div><div class="update-status" role="status"></div><progress hidden></progress><label class="source-setting">更新网络<select class="update-network" aria-label="更新网络连接方式"><option value="auto">自动（直连优先）</option><option value="direct">直连</option><option value="system">系统代理</option></select></label><div class="update-route"></div><div class="update-actions"><button class="update-check" type="button">检查更新</button><button class="update-install" type="button" hidden>下载并安装</button></div><div class="update-hint">点击下载即同意校验后打开安装向导，软件将退出。覆盖安装保留持仓和设置。</div><pre class="update-notes" hidden></pre></section>
      <div class="data-source">v${APP_VERSION} · 报价5秒 / 分时30秒 · 休市降频<br>881129 使用同花顺原板块 · 无模拟回退</div>
      <details class="market-diagnostics"><summary>行情详情（点击查看）</summary><div id="market-details">等待行情</div></details>
      <div class="attribution">Charts by <a href="https://www.tradingview.com/" target="_blank">TradingView</a></div>
    </aside>
    <div class="compact-row" data-drag-handle aria-label="滚轮换股 · 双击展开 · 右键设置 · 中键隐藏"><span class="stock-name" data-drag-handle>--</span><svg class="spark" viewBox="0 0 42 18"><path fill="none" stroke-width="1" d=""/></svg><span class="price flat" data-drag-handle>--</span><span class="change flat" data-drag-handle data-role="change-secondary">--%</span><div class="compact-actions"><button class="icon-button compact-button" aria-label="展开">${icons.shrink}</button></div></div>
  </main>`;

const shell = document.querySelector<HTMLElement>(".shell")!;
const detailPanel = new DetailPanel({ active: () => detailed && !compact && !document.hidden, compare: () => sectorComparison && chartMode === "intraday", stock: () => stocks[currentIndex], quote: () => latestUpdate, theme: () => theme });
const statusLabels = { preopen: "等待开盘", trading: "实时行情", break: "午间休市", closed: "已收盘" };

function toBusinessDay(date: string): BusinessDay {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function setupChart() {
  const formatTime = (time: unknown) => {
    if (typeof time === "number") return new Date(time * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    if (typeof time === "string") {
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(time);
      return match ? `${match[2]}/${match[3]}` : time;
    }
    if (time && typeof time === "object" && "month" in time && "day" in time) return `${String(time.month).padStart(2, "0")}/${String(time.day).padStart(2, "0")}`;
    return "";
  };
  chart = createChart(document.querySelector<HTMLElement>("#chart")!, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: theme.muted, fontFamily: '"Segoe UI", sans-serif', fontSize: 9, attributionLogo: false },
    localization: { locale: "zh-CN", timeFormatter: formatTime },
    grid: { vertLines: { color: "rgba(255,255,255,.025)" }, horzLines: { color: "rgba(255,255,255,.035)" } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: .12, bottom: .27 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, tickMarkFormatter: formatTime, rightOffset: 4, barSpacing: 3.2, minBarSpacing: 1.3, fixLeftEdge: true },
    crosshair: { vertLine: { color: "rgba(170,185,198,.20)", labelVisible: false }, horzLine: { color: "rgba(170,185,198,.18)", labelVisible: false } },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: false, axisPressedMouseMove: false },
  });
  candleSeries = chart.addSeries(CandlestickSeries, { visible: false, upColor: theme.candleUp, downColor: theme.candleDown, borderVisible: false, wickUpColor: theme.candleUp, wickDownColor: theme.candleDown });
}

function applyTheme(next = theme) {
  theme = next;
  const root = document.documentElement.style;
  Object.entries(theme).forEach(([key, value]) => root.setProperty(key === "line" ? "--line-color" : `--${key}`, value));
  localStorage.setItem("theme", JSON.stringify(theme));
  if (!chart) return;
  chart.applyOptions({ layout: { textColor: theme.muted } });
  candleSeries.applyOptions({ upColor: theme.candleUp, downColor: theme.candleDown, wickUpColor: theme.candleUp, wickDownColor: theme.candleDown });
  drawIntradayChart();
  detailPanel.drawSector();
  if (latestUpdate) {
    const changeClass = classForChange(latestUpdate.snapshot.change);
    renderSparkline(latestUpdate.history.slice(-36).map(point => point.price), changeClass);
  }
}

function classForChange(value: number) { return value > 0 ? "up" : value < 0 ? "down" : "flat"; }
function formatMoney(value: number, compactValue = false) {
  const sign = value >= 0 ? "+" : "−";
  const amount = Math.abs(value);
  if (compactValue && amount >= 10_000) return `${sign}${(amount / 10_000).toFixed(1)}万`;
  return `${sign}${amount.toFixed(compactValue ? 0 : 2)}`;
}

function positionMetrics(update: QuoteUpdate) {
  const quantity = update.snapshot.stock.quantity ?? 0;
  const cost = update.snapshot.stock.costPrice ?? 0;
  const today = update.snapshot.change * quantity;
  const total = cost > 0 ? (update.snapshot.price - cost) * quantity : 0;
  const returnPercent = cost > 0 ? ((update.snapshot.price - cost) / cost) * 100 : 0;
  return { quantity, cost, today, total, returnPercent, hasPosition: quantity > 0 && cost > 0 };
}

function render(update: QuoteUpdate) {
  latestUpdate = update;
  const { snapshot, history } = update;
  const changeClass = classForChange(snapshot.change);
  const metrics = positionMetrics(update);
  const marketTime = new Date(snapshot.timestamp).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const marketDate = new Date(snapshot.timestamp + 8 * 3600_000).toISOString().slice(0, 10);
  const oldTrade = snapshot.status === "trading" && Date.now() - snapshot.timestamp > 60_000;
  document.querySelectorAll<HTMLElement>(".stock-name").forEach(el => el.textContent = snapshot.stock.name);
  const marketLabel = snapshot.stock.kind === "sector" ? `${update.quoteSource ?? ""}板块` : snapshot.stock.symbol.startsWith("6") ? "SH" : "SZ";
  document.querySelector<HTMLElement>(".symbol")!.textContent = `${snapshot.stock.symbol} · ${marketLabel}`;
  document.querySelectorAll<HTMLElement>(".price").forEach(el => { el.textContent = snapshot.price.toFixed(2); el.className = `price ${changeClass}`; });
  const primaryChange = document.querySelector<HTMLElement>('[data-role="change-primary"]')!;
  const secondaryChange = document.querySelector<HTMLElement>('[data-role="change-secondary"]')!;
  primaryChange.innerHTML = `${snapshot.change >= 0 ? "+" : ""}${snapshot.change.toFixed(2)} &nbsp; ${snapshot.changePercent >= 0 ? "+" : ""}${snapshot.changePercent.toFixed(2)}%`;
  const compactPercent = `${snapshot.changePercent >= 0 ? "+" : ""}${snapshot.changePercent.toFixed(2)}%`;
  secondaryChange.textContent = metrics.hasPosition ? `${formatMoney(metrics.today, true)} ${compactPercent}` : compactPercent;
  primaryChange.className = `change ${changeClass}`;
  secondaryChange.className = `change ${classForChange(metrics.hasPosition ? metrics.today : snapshot.change)}`;
  const statusText = document.querySelector<HTMLElement>(".status-text")!;
  statusText.textContent = metrics.hasPosition
    ? `今 ${formatMoney(metrics.today)} · 总 ${formatMoney(metrics.total)} · ${marketTime.slice(0, 5)}`
    : chartMode === "daily" ? `日K · 红涨绿跌 · Ctrl滚轮缩放` : `${oldTrade ? "末笔" : statusLabels[snapshot.status]} · ${marketTime}`;
  if (update.quoteError) statusText.textContent = `报价待恢复 · 最后数据 ${marketTime}`;
  else if (chartMode === "intraday" && update.historyMessage) statusText.textContent += " · 分时待更新";
  document.querySelector<HTMLElement>("#market-details")!.textContent = `报价源：${update.quoteSource ?? "东方财富"} · 行情时间 ${marketDate} ${marketTime} 北京时间 · 分时源：${update.historySource ?? "待连接"}${update.historyMessage ? ` · ${update.historyMessage}` : ""}${update.quoteError ? ` · ${update.quoteError}` : ""}${metrics.hasPosition ? ` · 收益率 ${metrics.returnPercent >= 0 ? "+" : ""}${metrics.returnPercent.toFixed(2)}%` : ""}`;
  document.querySelector(".status-dot")!.classList.toggle("live", chartMode === "intraday" && snapshot.status === "trading" && !update.quoteError);
  document.querySelector(".status-dot")!.classList.toggle("stale", oldTrade || Boolean(update.quoteError));
  renderSparkline(history.slice(-36).map(point => point.price), changeClass);
  void renderChart();
  detailPanel.renderBook(); detailPanel.drawSector();
}

const DAILY_REFRESH_MS = 60_000;

async function renderChart() {
  if (!latestUpdate) return;
  if (chartMode === "intraday") {
    drawIntradayChart();
    return;
  }
  // 日K无需跟随报价刷新，按最小间隔低频拉取
  if (Date.now() - lastDailyFetch < DAILY_REFRESH_MS) return;
  lastDailyFetch = Date.now();
  const generation = ++dailyRequestGeneration;
  try {
    const candles = await provider.getDailyCandles(stocks[currentIndex]);
    if (generation !== dailyRequestGeneration || chartMode !== "daily") return;
    candleSeries.setData(candles.map(({ volume: _volume, time, ...candle }) => ({ ...candle, time: toBusinessDay(time) })));
    if (!dailyZoomAdjusted) chart.timeScale().fitContent();
  } catch (error) {
    if (generation !== dailyRequestGeneration || chartMode !== "daily") return;
    document.querySelector<HTMLElement>(".status-text")!.textContent = error instanceof Error ? error.message : "日K获取失败";
  }
}

function drawIntradayChart() {
  if (!latestUpdate || chartMode !== "intraday" || compact) return;
  const canvas = document.querySelector<HTMLCanvasElement>("#intraday-chart")!;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width < 80 || height < 50) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d")!;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const history = latestUpdate.history;
  if (!history.length) {
    context.font = '10px "Segoe UI", sans-serif'; context.fillStyle = theme.muted; context.textAlign = "center";
    context.fillText("分时待更新，报价独立刷新", width / 2, height / 2);
    return;
  }
  const previousClose = latestUpdate.snapshot.stock.previousClose;
    const left = detailed ? 43 : 29, right = width - (detailed ? 52 : 38), top = detailed ? 24 : 18, axisBottom = height - (detailed ? 22 : 14);
    const volumeHeight = detailed && sectorComparison ? 0 : Math.max(0, Math.min(detailed ? 64 : 26, (axisBottom - top - 32) * .3));
    const volumeTop = axisBottom - volumeHeight;
    const priceBottom = volumeHeight > 0 ? volumeTop - 5 : axisBottom;
  const priceHeight = Math.max(24, priceBottom - top);
  const maxDeviation = Math.max(previousClose * .01, ...history.flatMap(point => [Math.abs(point.price - previousClose), Math.abs((point.average ?? point.price) - previousClose)])) * 1.12;
  const high = previousClose + maxDeviation;
  const low = previousClose - maxDeviation;
  const plotWidth = right - left;
  const xForTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000 + 8 * 3600_000);
    const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
    const sessionMinute = minute <= 11 * 60 + 30 ? minute - (9 * 60 + 30) : 120 + minute - 13 * 60;
    return left + Math.max(0, Math.min(240, sessionMinute)) / 240 * plotWidth;
  };
  const yForPrice = (value: number) => top + (high - value) / (high - low) * priceHeight;

    context.font = `${detailed ? 10 : 8}px "Segoe UI", sans-serif`;
  context.lineWidth = 1;
  context.textBaseline = "middle";
  for (let index = 0; index < 5; index += 1) {
    const fraction = index / 4;
    const y = top + fraction * priceHeight;
    const value = high - fraction * (high - low);
    const percent = (value / previousClose - 1) * 100;
    context.strokeStyle = index === 2 ? "rgba(150,160,168,.22)" : "rgba(150,160,168,.09)";
    context.setLineDash(index === 2 ? [3, 3] : []);
    context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
    context.fillStyle = percent > .001 ? theme.up : percent < -.001 ? theme.down : theme.muted;
    context.textAlign = "right"; context.fillText(`${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`, left - 3, y);
    context.textAlign = "left"; context.fillText(value.toFixed(previousClose >= 1000 ? 0 : 2), right + 3, y);
  }
  context.setLineDash([]);

    const timeMarks = detailed
      ? [{ minute: 0, label: "09:30" }, { minute: 60, label: "10:30" }, { minute: 120, label: "11:30/13:00" }, { minute: 180, label: "14:00" }, { minute: 240, label: "15:00" }]
      : [{ minute: 0, label: "09:30" }, { minute: 120, label: "11:30/13:00" }, { minute: 240, label: "15:00" }];
    for (const mark of timeMarks) {
    if (detailed && plotWidth < 300 && mark.minute !== 0 && mark.minute !== 240 && (plotWidth < 180 || mark.minute !== 120)) continue;
    const x = left + mark.minute / 240 * plotWidth;
    context.strokeStyle = "rgba(150,160,168,.08)";
    context.beginPath(); context.moveTo(x, top); context.lineTo(x, axisBottom); context.stroke();
    context.fillStyle = theme.muted;
    context.textAlign = mark.minute === 0 ? "left" : mark.minute === 240 ? "right" : "center";
    context.fillText(mark.label, x, height - 6);
  }

  const drawLine = (selector: (point: typeof history[number]) => number, color: string, lineWidth: number) => {
    context.strokeStyle = color; context.lineWidth = lineWidth; context.lineJoin = "round"; context.lineCap = "round";
    context.beginPath();
    history.forEach((point, index) => { const x = xForTime(point.time), y = yForPrice(selector(point)); index ? context.lineTo(x, y) : context.moveTo(x, y); });
    context.stroke();
  };
  if (history.every(point => point.average !== undefined && Number.isFinite(point.average))) drawLine(point => point.average!, theme.average, 1);
    drawLine(point => point.price, theme.line, 1.35);

    // Each point carries interval volume, not the day's cumulative volume.
    // Price and volume share the same compressed trading-session time axis.
    if (volumeHeight > 0) {
      const maxVolume = Math.max(0, ...history.map(point => Number.isFinite(point.volume) ? point.volume : 0));
      context.save();
      context.beginPath(); context.rect(left, volumeTop, plotWidth, volumeHeight); context.clip();
      context.globalAlpha = .65;
      const barWidth = Math.max(.7, Math.min(3, plotWidth / 241 * .75));
      history.forEach((point, index) => {
        if (!Number.isFinite(point.volume) || point.volume <= 0 || maxVolume <= 0) return;
        const previousPrice = index ? history[index - 1].price : previousClose;
        context.fillStyle = point.price > previousPrice ? theme.volumeUp : point.price < previousPrice ? theme.volumeDown : theme.muted;
        const barHeight = point.volume / maxVolume * volumeHeight;
        const x = Math.max(left, Math.min(right - barWidth, xForTime(point.time) - barWidth / 2));
        context.fillRect(x, axisBottom - barHeight, barWidth, barHeight);
      });
      context.restore();
      context.fillStyle = theme.muted; context.textAlign = "right";
      context.fillText(maxVolume > 0 ? "量" : "量—", left - 3, volumeTop + volumeHeight / 2);
      if (detailed && maxVolume > 0) {
        const formatVolume = (value: number) => value >= 1e8 ? `${(value / 1e8).toFixed(1)}亿` : value >= 1e4 ? `${(value / 1e4).toFixed(1)}万` : Math.round(value).toString();
        context.textAlign = "left";
        context.fillText(formatVolume(maxVolume), right + 4, volumeTop + 5);
        context.fillText("0", right + 4, axisBottom - 5);
      }
    }
}

function renderSparkline(values: number[], changeClass: string) {
  const element = document.querySelector<SVGPathElement>(".spark path")!;
  if (values.length < 2) { element.setAttribute("d", ""); return; }
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const path = values.map((value, index) => `${index ? "L" : "M"}${(index / (values.length - 1) * 42).toFixed(1)},${(16 - (value - min) / range * 14).toFixed(1)}`).join(" ");
  element.setAttribute("d", path);
  element.setAttribute("stroke", changeClass === "up" ? theme.up : changeClass === "down" ? theme.down : theme.line);
}

function renderWatchlist() {
  const list = document.querySelector<HTMLElement>(".watchlist")!;
  list.textContent = "";
  stocks.forEach((stock, index) => {
    const tab = document.createElement("button");
    tab.className = `stock-tab ${index === currentIndex ? "active" : ""}`;
    tab.setAttribute("aria-label", `${stock.name} ${stock.symbol}`);
    tab.textContent = stock.name;
    tab.addEventListener("click", () => selectStock(index));
    list.appendChild(tab);
  });
}

function populatePositionEditor() {
  const stock = stocks[currentIndex];
  const code = document.querySelector<HTMLInputElement>("#stock-code");
  const quantity = document.querySelector<HTMLInputElement>("#stock-quantity");
  const cost = document.querySelector<HTMLInputElement>("#stock-cost");
  if (!stock || !code || !quantity || !cost) return;
  code.value = stock.symbol;
  quantity.value = stock.quantity ? String(stock.quantity) : "";
  cost.value = stock.costPrice ? String(stock.costPrice) : "";
}

function selectStock(index: number) {
  currentIndex = (index + stocks.length) % stocks.length;
  const selectedIndex = currentIndex;
  localStorage.setItem("stockIndex", String(currentIndex));
  renderWatchlist();
  populatePositionEditor();
  const sourceSelect = document.querySelector<HTMLSelectElement>("#quote-source")!;
  sourceSelect.disabled = stocks[currentIndex].kind === "sector";
  sourceSelect.setAttribute("aria-label", sourceSelect.disabled ? "板块固定使用对应原始数据源，个股优先级不适用" : "选择个股报价优先来源");
  disconnect?.();
  latestUpdate = undefined;
  detailPanel.sync();
  candleSeries.setData([]);
  document.querySelector<HTMLCanvasElement>("#intraday-chart")!.getContext("2d")!.clearRect(0, 0, 3000, 3000);
  document.querySelectorAll<HTMLElement>(".stock-name").forEach(el => el.textContent = stocks[selectedIndex].name);
  document.querySelector<HTMLElement>(".symbol")!.textContent = stocks[selectedIndex].symbol;
  document.querySelectorAll<HTMLElement>(".price, .change").forEach(el => el.textContent = "--");
  renderSparkline([], "flat");
  dailyRequestGeneration++; // 使在途的旧日K请求失效
  lastDailyFetch = 0;
  dailyZoomAdjusted = false;
  document.querySelector<HTMLElement>(".status-text")!.textContent = "连接真实行情…";
  document.querySelector<HTMLElement>("#market-details")!.textContent = "正在连接行情";
  disconnect = provider.connect(stocks[selectedIndex], update => {
    stocks[selectedIndex] = update.snapshot.stock;
    saveStocks();
    render(update);
  }, message => {
    const status = document.querySelector<HTMLElement>(".status-text")!;
    status.textContent = latestUpdate ? "报价待恢复 · 保留末笔" : "报价待恢复";
    document.querySelector<HTMLElement>("#market-details")!.textContent = message;
    document.querySelector(".status-dot")!.classList.remove("live");
    document.querySelector(".status-dot")!.classList.add("stale");
  });
}

function setChartMode(mode: ChartMode) {
  chartMode = mode;
  dailyRequestGeneration++; // 使在途的旧图表请求失效
  localStorage.setItem("chartMode", mode);
  document.querySelectorAll<HTMLButtonElement>(".chart-tabs button").forEach(button => button.classList.toggle("active", button.dataset.mode === mode));
  document.querySelector(".chart-wrap")!.classList.toggle("intraday", mode === "intraday");
  candleSeries.applyOptions({ visible: mode === "daily" });
  chart.applyOptions({ timeScale: { timeVisible: mode === "intraday" } });
  if (mode === "daily") { lastDailyFetch = 0; dailyZoomAdjusted = false; } // 切换模式时立即拉取日K并复位范围
  if (latestUpdate) render(latestUpdate);
  detailPanel.sync();
}

async function setCompact(next: boolean) {
  const wasCompact = compact;
  if (next) detailed = false;
  document.body.classList.toggle("detailed", detailed);
  const detailButton = document.querySelector<HTMLButtonElement>(".detail-button")!;
  detailButton.textContent = detailed ? "返回小图" : "详细图";
  detailButton.setAttribute("aria-label", detailed ? "返回小图" : "打开详细分时图");
  detailButton.setAttribute("aria-pressed", String(detailed));
  compact = next; localStorage.setItem("compact", String(compact)); document.body.classList.toggle("compact", compact);
  detailPanel.sync();
  if (isTauri) {
    const generation = ++resizeGeneration;
    const [monitor, position, oldSize] = await Promise.all([currentMonitor(), appWindow.outerPosition(), appWindow.outerSize()]);
    if (generation !== resizeGeneration) return;
    let logicalWidth = next ? 232 : detailed ? 780 : 300;
    let logicalHeight = next ? 28 : detailed ? 440 : 176;
    let pendingPosition: PhysicalPosition | null = null;
    if (monitor) {
      const scale = monitor.scaleFactor;
      if (detailed) {
        logicalWidth = Math.min(logicalWidth, Math.floor(monitor.workArea.size.width / scale) - 16);
        logicalHeight = Math.min(logicalHeight, Math.floor(monitor.workArea.size.height / scale) - 16);
      }
      const targetWidth = logicalWidth * scale;
      const targetHeight = logicalHeight * scale;
      const workLeft = monitor.workArea.position.x;
      const workTop = monitor.workArea.position.y;
      const workRight = workLeft + monitor.workArea.size.width;
      const workBottom = workTop + monitor.workArea.size.height;
      const margin = Math.round(8 * scale);
      if (!next && wasCompact) microAnchorPosition = { x: position.x, y: position.y };

      let targetX = position.x;
      let targetY = position.y;
      if (!next) {
        const rightGap = workRight - (position.x + oldSize.width);
        const bottomGap = workBottom - (position.y + oldSize.height);
        if (rightGap < 80 * scale) targetX = position.x + oldSize.width - targetWidth;
        if (bottomGap < 80 * scale) targetY = position.y + oldSize.height - targetHeight;
      } else if (microAnchorPosition) {
        targetX = microAnchorPosition.x;
        targetY = microAnchorPosition.y;
      }
      targetX = Math.round(Math.max(workLeft + margin, Math.min(targetX, workRight - targetWidth - margin)));
      targetY = Math.round(Math.max(workTop + margin, Math.min(targetY, workBottom - targetHeight - margin)));
      pendingPosition = new PhysicalPosition(targetX, targetY);
      if (!next) {
        await appWindow.setPosition(pendingPosition);
        if (generation !== resizeGeneration) return;
      }
    }
    await appWindow.setSize(new LogicalSize(logicalWidth, logicalHeight));
    if (next && pendingPosition && generation === resizeGeneration) await appWindow.setPosition(pendingPosition);
  }
  if (!compact) setTimeout(() => { chart?.timeScale().fitContent(); drawIntradayChart(); }, 80);
}

async function toggleDetailed() {
  detailed = !detailed;
  document.querySelector(".settings")?.classList.remove("open");
  if (detailed) setChartMode("intraday");
  await setCompact(false);
}

async function toggleVisible() {
  if (!isTauri) return;
  if (await appWindow.isVisible()) await appWindow.hide(); else { await appWindow.show(); await appWindow.setFocus(); }
}

async function restoreWindowPosition() {
  const raw = localStorage.getItem(WINDOW_POSITION_KEY);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw) as { x: number; y: number };
    if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return;
    const monitors = await availableMonitors();
    const fallback = await currentMonitor();
    const monitor = monitors.find(item => {
      const area = item.workArea;
      return saved.x >= area.position.x && saved.x < area.position.x + area.size.width
        && saved.y >= area.position.y && saved.y < area.position.y + area.size.height;
    }) ?? fallback ?? monitors[0];
    if (!monitor) return;
    const margin = Math.round(8 * monitor.scaleFactor);
    const width = Math.round(232 * monitor.scaleFactor);
    const height = Math.round(28 * monitor.scaleFactor);
    const area = monitor.workArea;
    const x = Math.round(Math.max(area.position.x + margin, Math.min(saved.x, area.position.x + area.size.width - width - margin)));
    const y = Math.round(Math.max(area.position.y + margin, Math.min(saved.y, area.position.y + area.size.height - height - margin)));
    microAnchorPosition = { x, y };
    await appWindow.setPosition(new PhysicalPosition(x, y));
  } catch (error) {
    console.warn("恢复窗口位置失败", error);
  }
}

function saveStocks() { localStorage.setItem("stocks", JSON.stringify(stocks)); }

function wireEvents() {
  const sourceSelect = document.querySelector<HTMLSelectElement>("#quote-source")!;
  sourceSelect.value = ["auto", "tencent", "sina", "eastmoney"].includes(savedSource) ? savedSource : "auto";
  sourceSelect.addEventListener("change", () => {
    localStorage.setItem("quoteSourcePreference", sourceSelect.value);
    provider.setPreference(sourceSelect.value as SourcePreference);
    selectStock(currentIndex);
  });
  document.querySelectorAll<HTMLButtonElement>(".compact-button").forEach(button => button.addEventListener("click", () => void setCompact(!compact)));
  document.querySelector<HTMLButtonElement>(".detail-button")!.addEventListener("click", () => void toggleDetailed());
  document.querySelector<HTMLButtonElement>(".sector-toggle")!.addEventListener("click", () => {
    sectorComparison = !sectorComparison; localStorage.setItem("sectorComparison", String(sectorComparison));
    document.querySelector(".sector-toggle")!.setAttribute("aria-pressed", String(sectorComparison));
    if (sectorComparison && chartMode !== "intraday") setChartMode("intraday");
    detailPanel.sync(); drawIntradayChart();
  });
  document.addEventListener("visibilitychange", () => detailPanel.sync());
  document.querySelectorAll<HTMLButtonElement>(".hide-button").forEach(button => button.addEventListener("click", () => void (isTauri && appWindow.hide())));
  const settings = document.querySelector(".settings")!;
  document.querySelector(".settings-button")!.addEventListener("click", () => settings.classList.toggle("open"));
  document.querySelectorAll<HTMLButtonElement>(".chart-tabs button").forEach(button => button.addEventListener("click", () => setChartMode(button.dataset.mode as ChartMode)));

  document.querySelector<HTMLFormElement>(".stock-form")!.addEventListener("submit", event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const code = document.querySelector<HTMLInputElement>("#stock-code")!.value.trim();
    const quantityInput = document.querySelector<HTMLInputElement>("#stock-quantity")!;
    const costInput = document.querySelector<HTMLInputElement>("#stock-cost")!;
    const message = document.querySelector<HTMLElement>(".form-message")!;
    const quantityText = quantityInput.value.trim();
    const costText = costInput.value.trim();
    const quantity = quantityText ? Number(quantityText) : undefined;
    const costPrice = costText ? Number(costText) : undefined;
    const sector = SECTOR_ALIASES[code];
    const positionValid = quantity === undefined && costPrice === undefined
      || quantity !== undefined && costPrice !== undefined && Number.isFinite(quantity) && quantity > 0 && Number.isFinite(costPrice) && costPrice > 0;
    if (!/^\d{6}$/.test(code) || !positionValid) { message.textContent = "代码无效，数量和成本需同时填写"; return; }
    const existing = stocks.findIndex(stock => stock.symbol === code);
    if (existing >= 0) {
      stocks[existing] = normalizeInstrument({ ...stocks[existing], quantity, costPrice });
      saveStocks(); message.textContent = sector ? "板块观察项已更新" : "持仓已更新"; selectStock(existing); return;
    }
    stocks.push(normalizeInstrument({ symbol: code, name: sector?.name ?? `股票${code}`, previousClose: costPrice ?? 1, seed: Number(code.slice(-4)) || stocks.length * 17, quantity, costPrice }));
    saveStocks(); selectStock(stocks.length - 1); message.textContent = sector ? "通信设备板块已添加" : "已添加";
  });

  document.querySelector<HTMLButtonElement>(".remove-stock")!.addEventListener("click", () => {
    const message = document.querySelector<HTMLElement>(".form-message")!;
    if (stocks.length === 1) { message.textContent = "至少保留一只"; return; }
    disconnect?.(); stocks.splice(currentIndex, 1); currentIndex = Math.min(currentIndex, stocks.length - 1);
    saveStocks(); selectStock(currentIndex); message.textContent = "已删除";
  });

  document.querySelectorAll<HTMLInputElement>("[data-theme]").forEach(input => {
    input.addEventListener("pointerdown", () => { ignoreNextFocusLoss = true; });
    input.addEventListener("input", () => {
      const nextTheme = { ...theme, [input.dataset.theme!]: input.value };
      cancelAnimationFrame(themeRaf);
      themeRaf = requestAnimationFrame(() => applyTheme(nextTheme));
    });
  });
  document.querySelector<HTMLButtonElement>(".reset-theme")!.addEventListener("click", () => {
    document.querySelectorAll<HTMLInputElement>("[data-theme]").forEach(input => input.value = DEFAULT_THEME[input.dataset.theme as keyof Theme]); applyTheme({ ...DEFAULT_THEME });
  });
  const slider = document.querySelector<HTMLInputElement>("#opacity")!;
  slider.addEventListener("input", () => { opacity = Number(slider.value); shell.style.opacity = String(opacity / 100); slider.nextElementSibling!.textContent = `${opacity}%`; localStorage.setItem("opacity", String(opacity)); });
  const dailyChart = document.querySelector<HTMLElement>("#chart")!;
  dailyChart.addEventListener("wheel", event => {
    if (chartMode !== "daily" || !event.ctrlKey) return;
    event.preventDefault(); event.stopPropagation();
    const scale = chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    if (!range) return;
    const span = Math.max(1, range.to - range.from);
    const anchor = scale.coordinateToLogical(event.offsetX) ?? (range.from + range.to) / 2;
    const ratio = Math.max(0, Math.min(1, (anchor - range.from) / span));
    const nextSpan = Math.max(8, Math.min(150, span * (event.deltaY < 0 ? .8 : 1.25)));
    scale.setVisibleLogicalRange({ from: anchor - nextSpan * ratio, to: anchor + nextSpan * (1 - ratio) });
    dailyZoomAdjusted = true;
  }, { passive: false });
  dailyChart.addEventListener("dblclick", () => {
    if (chartMode !== "daily") return;
    dailyZoomAdjusted = false; chart.timeScale().fitContent();
  });
  window.addEventListener("wheel", event => {
    if (event.ctrlKey) { event.preventDefault(); return; }
    if ((event.target as Element).closest("#chart")) return;
    if (detailed || (event.target as Element).closest("select,.depth-panel,.sector-pane")) return;
    if (!settings.classList.contains("open")) selectStock(currentIndex + (event.deltaY > 0 ? 1 : -1));
  }, { passive: false });
  const compactRow = document.querySelector<HTMLElement>(".compact-row")!;
  compactRow.addEventListener("dblclick", () => void setCompact(false));
  compactRow.addEventListener("auxclick", event => { if (event.button === 1) void (isTauri && appWindow.hide()); });
  compactRow.addEventListener("contextmenu", event => {
    event.preventDefault();
    void setCompact(false).then(() => settings.classList.add("open"));
  });
  window.addEventListener("keydown", event => {
    if (event.key === "Escape") { settings.classList.remove("open"); void setCompact(true); }
  });
  new ResizeObserver(() => drawIntradayChart()).observe(document.querySelector(".chart-wrap")!);
  document.querySelectorAll<HTMLElement>(".topbar, .compact-row, .settings-drag").forEach(handle => handle.addEventListener("pointerdown", event => {
    if (event.button === 0 && !(event.target as HTMLElement).closest("button,input")) {
      if (!isTauri || isWindowDragging) return;
      isWindowDragging = true;
      void appWindow.startDragging()
        .then(() => appWindow.setFocus())
        .catch(error => console.warn("窗口拖动失败", error))
        .finally(() => {
          window.setTimeout(() => { isWindowDragging = false; }, 320);
        });
    }
  }));
}

async function initDesktop() {
  if (!isTauri) return;
  await appWindow.setAlwaysOnTop(false); await appWindow.setSkipTaskbar(true);
  await restoreWindowPosition();
  await appWindow.onMoved(({ payload }) => {
    if (!compact) return;
    window.clearTimeout(positionSaveTimer);
    positionSaveTimer = window.setTimeout(() => {
      const position = { x: payload.x, y: payload.y };
      microAnchorPosition = position;
      localStorage.setItem(WINDOW_POSITION_KEY, JSON.stringify(position));
    }, 180);
  });
  await appWindow.onFocusChanged(({ payload: focused }) => {
    if (!focused) {
      window.setTimeout(() => {
        if (isWindowDragging) return;
        if (ignoreNextFocusLoss) { ignoreNextFocusLoss = false; return; }
        document.querySelector(".settings")?.classList.remove("open");
        void setCompact(true);
      }, 90);
    } else {
      ignoreNextFocusLoss = false;
    }
  });
  try { await register("Alt+Shift+S", event => { if (event.state === "Pressed") void toggleVisible(); }); } catch (error) { console.warn("快捷键注册失败", error); }
}

applyTheme(theme);
setupChart();
wireEvents();
renderWatchlist();
selectStock(currentIndex);
setChartMode(chartMode);
if (isTauri) void initDesktop().then(() => setCompact(compact));
else void setCompact(compact);
const disposeUpdater = mountUpdatePanel(shell, APP_VERSION, isTauri, async () => {
  if (isTauri) await appWindow.show();
  await setCompact(false);
  document.querySelector(".settings")!.classList.add("open");
  document.querySelector(".update-panel")!.scrollIntoView({ block: "start" });
  if (isTauri) await appWindow.setFocus();
});
window.addEventListener("beforeunload", () => { disconnect?.(); detailPanel.dispose(); disposeUpdater(); });
