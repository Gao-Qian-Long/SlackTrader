import { DetailMarketProvider } from "./market/detailProvider";
import { supportsMarketDepth } from "./market/detailData";
import { chinaDate, eastmoneyId } from "./market/marketData";
import type { QuoteUpdate, Stock, RelatedSector, SectorSeries, TradePage, BookLevel } from "./market/types";

type Options = { active: () => boolean; compare: () => boolean; stock: () => Stock; quote: () => QuoteUpdate | undefined; theme: () => { muted: string; line: string; up: string; down: string } };
const element = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const timeText = (ms: number) => new Date(ms).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const amount = (value: number) => value >= 1e8 ? `${(value / 1e8).toFixed(2)}亿` : value >= 1e4 ? `${(value / 1e4).toFixed(2)}万` : value.toFixed(0);

export class DetailPanel {
  private provider = new DetailMarketProvider();
  private tradeKey = "";
  private sectorKey = "";
  private generation = 0;
  private stopTrades?: () => void;
  private stopSector?: () => void;
  private retryTimer = 0;
  private sectors: RelatedSector[] = [];
  private series?: SectorSeries;
  private message = "板块加载中";
  private selected: Record<string, string> = {};
  constructor(private options: Options) {
    try { const saved = JSON.parse(localStorage.getItem("sectorSelectionsV1") ?? "{}"); if (saved && typeof saved === "object" && !Array.isArray(saved)) this.selected = saved; } catch { /* Use an empty per-stock selection. */ }
    element<HTMLSelectElement>("#related-sector").addEventListener("change", () => {
      const code = element<HTMLSelectElement>("#related-sector").value;
      if (!this.sectors.some(sector => sector.code === code)) return;
      this.selected[this.sectorKey] = code; localStorage.setItem("sectorSelectionsV1", JSON.stringify(this.selected));
      this.subscribeSector(this.sectors.find(sector => sector.code === code)!);
    });
    element(".sector-retry").addEventListener("click", () => { this.sectorKey = ""; this.sync(); });
    new ResizeObserver(() => this.drawSector()).observe(element(".sector-pane"));
  }
  sync() {
    const active = this.options.active(), stock = this.options.stock(), supported = supportsMarketDepth(stock);
    const key = active && supported ? eastmoneyId(stock) : "";
    if (key !== this.tradeKey) {
      this.stopTrades?.(); this.tradeKey = key;
      element(".trade-rows").replaceChildren();
      element(".trades-status").textContent = key ? "明细加载中" : "个股支持市场成交明细";
      if (key) this.stopTrades = this.provider.connectTrades(stock, page => {
        if (this.tradeKey === key && this.options.active()) this.renderTrades(page);
      }, () => { if (this.tradeKey === key) element(".trades-status").textContent = "明细待恢复 · 已有记录为旧数据"; });
    }
    if (active && !supported) element(".trades-status").textContent = "指数/板块不展示个股成交明细";
    const showSector = active && this.options.compare();
    document.body.classList.toggle("sector-open", showSector);
    const sectorKey = showSector && supported ? key : "";
    if (sectorKey !== this.sectorKey) {
      this.sectorKey = sectorKey; this.generation++; this.stopSector?.(); clearTimeout(this.retryTimer);
      this.series = undefined; this.sectors = []; element("#related-sector").replaceChildren();
      if (sectorKey) void this.loadSectors(stock, this.generation);
    }
    if (showSector && !supported) this.message = "请选择个股查看关联板块";
    this.renderBook(); this.drawSector();
  }
  private async loadSectors(stock: Stock, generation: number) {
    this.message = "关联板块加载中"; this.drawSector();
    element<HTMLButtonElement>(".sector-retry").hidden = true;
    try {
      const sectors = await this.provider.getRelatedSectors(stock);
      if (generation !== this.generation || !this.sectorKey || !this.options.active()) return;
      this.sectors = sectors;
      const select = element<HTMLSelectElement>("#related-sector");
      select.replaceChildren(...sectors.map(sector => { const option = document.createElement("option"); option.value = sector.code; option.textContent = sector.name; return option; }));
      if (!sectors.length) { this.message = "此标的暂无关联板块"; this.drawSector(); return; }
      const sector = sectors.find(item => item.code === this.selected[this.sectorKey]) ?? sectors[0];
      select.value = sector.code; this.subscribeSector(sector);
    } catch {
      if (generation !== this.generation || !this.sectorKey) return;
      this.message = "板块列表待恢复"; this.drawSector();
      element<HTMLButtonElement>(".sector-retry").hidden = false;
      this.retryTimer = window.setTimeout(() => void this.loadSectors(stock, generation), 30_000);
    }
  }
  private subscribeSector(sector: RelatedSector) {
    this.stopSector?.(); this.series = undefined; this.message = "板块分时加载中";
    const generation = this.generation, code = sector.code;
    this.drawSector();
    this.stopSector = this.provider.connectSector(sector, series => {
      if (generation !== this.generation || element<HTMLSelectElement>("#related-sector").value !== code || !this.options.active()) return;
      this.series = series; this.message = ""; this.drawSector();
    }, () => { if (generation === this.generation && element<HTMLSelectElement>("#related-sector").value === code) { this.message = "板块待恢复 · 保留末笔"; this.drawSector(); } });
  }
  renderBook() {
    if (!this.options.active()) return;
    const update = this.options.quote(), supported = supportsMarketDepth(this.options.stock());
    const book = supported ? update?.snapshot.orderBook : undefined;
    const body = element(".book-rows"); body.replaceChildren();
    const row = (side: string, level: number, item?: BookLevel) => {
      const tr = document.createElement("tr"); tr.className = side === "买" ? "market-buy" : "market-sell";
      for (const value of [`${side}${level}`, item ? item.price.toFixed(2) : "—", item ? (item.shares / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—", item ? amount(item.price * item.shares) : "—"]) {
        const td = document.createElement("td"); td.textContent = value; tr.append(td);
      }
      body.append(tr);
    };
    for (let level = 5; level >= 1; level--) row("卖", level, book?.asks.find(item => item.level === level));
    for (let level = 1; level <= 5; level++) row("买", level, book?.bids.find(item => item.level === level));
    element(".book-status").textContent = !supported ? "指数/板块不展示个股盘口" : !update ? "等待报价" : !book ? "此报价源暂无五档" : `${update.quoteError ? "旧快照 · " : ""}${update.quoteSource} ${timeText(update.snapshot.timestamp)}`;
    const total = (rows?: BookLevel[]) => rows?.length ? amount(rows.reduce((sum, item) => sum + item.price * item.shares, 0)) : "—";
    element(".book-totals").textContent = `五档买额 ${total(book?.bids)} · 卖额 ${total(book?.asks)}`;
  }
  private renderTrades(page: TradePage) {
    element(".trades-status").textContent = `${page.source} · 收到 ${timeText(page.receivedAt)}`;
    const body = element(".trade-rows"); body.replaceChildren();
    for (const trade of page.trades) {
      const row = document.createElement("tr"); row.className = trade.side === "buy" ? "market-buy" : trade.side === "sell" ? "market-sell" : "";
      for (const text of [trade.time, trade.price.toFixed(2), (trade.shares / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 }), trade.side === "buy" ? "买" : trade.side === "sell" ? "卖" : "中"]) { const cell = document.createElement("td"); cell.textContent = text; row.append(cell); }
      body.append(row);
    }
    if (!page.trades.length) element(".trades-status").textContent = "数据源暂无成交明细";
  }
  drawSector() {
    if (!this.options.active() || !this.options.compare()) return;
    const canvas = element<HTMLCanvasElement>("#sector-chart"), width = canvas.clientWidth, height = canvas.clientHeight;
    if (width < 100 || height < 40) return;
    const ratio = window.devicePixelRatio || 1, context = canvas.getContext("2d")!;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    const theme = this.options.theme(), series = this.series;
    context.font = '9px "Segoe UI", sans-serif'; context.fillStyle = theme.muted; context.textBaseline = "middle";
    const meta = element(".sector-meta"); meta.textContent = this.message;
    if (!series) { context.textAlign = "center"; context.fillText(this.message, width / 2, height / 2); return; }
    const last = series.history[series.history.length - 1], quote = this.options.quote();
    if (quote && chinaDate(quote.snapshot.timestamp) !== chinaDate(last.time * 1000)) {
      meta.textContent = "板块与个股日期不同"; context.textAlign = "center"; context.fillText("等待同交易日板块数据", width / 2, height / 2); return;
    }
    meta.textContent = `${this.message || series.source} · ${timeText(last.time * 1000).slice(0, 5)}`;
    const left = 43, right = width - 52, top = 10, bottom = height - 19;
    const deviation = Math.max(series.previousClose * .01, ...series.history.map(point => Math.abs(point.price - series.previousClose))) * 1.12;
    const high = series.previousClose + deviation, low = series.previousClose - deviation;
    const x = (minute: number) => left + minute / 240 * (right - left);
    for (let i = 0; i < 5; i++) {
      const value = high - i / 4 * (high - low), y = top + i / 4 * (bottom - top), change = (value / series.previousClose - 1) * 100;
      context.setLineDash(i === 2 ? [3, 3] : []); context.strokeStyle = i === 2 ? "rgba(150,160,168,.22)" : "rgba(150,160,168,.09)";
      context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
      context.fillStyle = change > .001 ? theme.up : change < -.001 ? theme.down : theme.muted;
      context.textAlign = "right"; context.fillText(`${change > 0 ? "+" : ""}${change.toFixed(1)}%`, left - 3, y);
      context.textAlign = "left"; context.fillText(value.toFixed(0), right + 3, y);
    }
    context.setLineDash([]); context.strokeStyle = theme.line; context.lineWidth = 1.25; context.beginPath();
    series.history.forEach((point, index) => {
      const date = new Date(point.time * 1000 + 8 * 3600_000), minute = date.getUTCHours() * 60 + date.getUTCMinutes();
      const px = x(minute <= 690 ? minute - 570 : 120 + minute - 780), py = top + (high - point.price) / (high - low) * (bottom - top);
      if (index) context.lineTo(px, py); else context.moveTo(px, py);
    }); context.stroke(); context.fillStyle = theme.muted;
    const marks = [[0, "09:30"], [60, "10:30"], [120, "11:30/13:00"], [180, "14:00"], [240, "15:00"]] as const;
    for (const [minute, label] of marks.filter(([minute]) => right - left >= 300 || minute === 0 || minute === 240 || (right - left >= 180 && minute === 120))) {
      context.textAlign = minute === 0 ? "left" : minute === 240 ? "right" : "center"; context.fillText(label, x(minute), height - 6);
    }
  }
  dispose() { this.stopTrades?.(); this.stopSector?.(); clearTimeout(this.retryTimer); this.generation++; this.tradeKey = ""; this.sectorKey = ""; }
}
