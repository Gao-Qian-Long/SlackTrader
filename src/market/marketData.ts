import type { DailyCandle, IntradayPoint, MarketStatus, Stock } from "./types";

export type QuoteSource = "tencent" | "sina" | "eastmoney" | "ths";
export type SourcePreference = "auto" | Exclude<QuoteSource, "ths">;
export const SOURCE_NAMES: Record<QuoteSource, string> = { tencent: "腾讯", sina: "新浪", eastmoney: "东方财富", ths: "同花顺" };
const SH_INDEXES = new Set(["000300", "000016", "000905", "000852", "000688"]);
export const SECTOR_ALIASES: Record<string, { dataSymbol: string; name: string }> = {
  "881129": { dataSymbol: "bk_881129", name: "通信设备" },
};
export function normalizeInstrument(stock: Stock): Stock {
  const sector = SECTOR_ALIASES[stock.symbol];
  return sector ? { ...stock, kind: "sector", ...sector } : stock;
}
export function eastmoneyId(stock: Stock): string {
  const normalized = normalizeInstrument(stock);
  if (normalized.dataSymbol?.startsWith("bk_")) throw new Error("同花顺板块使用原代码，不映射到东方财富");
  if (normalized.dataSymbol?.includes(".")) return normalized.dataSymbol;
  const symbol = normalized.dataSymbol ?? normalized.symbol;
  return `${/^[65]/.test(symbol) || SH_INDEXES.has(symbol) ? 1 : 0}.${symbol}`;
}
export function isSector(stock: Stock): boolean {
  return normalizeInstrument(stock).kind === "sector" || eastmoneyId(stock).startsWith("90.");
}
export function mainlandId(stock: Stock): string {
  if (isSector(stock)) throw new Error("板块保持原行情口径，不跨平台替换");
  const [market, code] = eastmoneyId(stock).split(".");
  if (!/^\d{6}$/.test(code)) throw new Error("股票代码格式错误");
  return `${market === "1" ? "sh" : /^[489]/.test(code) ? "bj" : "sz"}${code}`;
}
export const round = (value: number) => Math.round(value * 100) / 100;
export function chinaDate(ms: number): string { return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10); }
export function marketStatus(ms = Date.now()): MarketStatus {
  const date = new Date(ms + 8 * 3600_000);
  if ([0, 6].includes(date.getUTCDay())) return "closed";
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return minute < 570 ? "preopen" : minute < 690 ? "trading" : minute < 780 ? "break" : minute < 900 ? "trading" : "closed";
}
export function parseTime(value: string): number {
  const formatted = /^\d{14}$/.test(value)
    ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(8,10)}:${value.slice(10,12)}:${value.slice(12,14)}`
    : value.replace(" ", "T");
  const time = Date.parse(`${formatted}+08:00`);
  if (!Number.isFinite(time)) throw new Error("行情时间格式错误");
  return time;
}
export interface WireQuote { name: string; price: number; previousClose: number; timestamp: number; volume: number; note?: string }
export function checkedQuote(q: WireQuote): WireQuote {
  if (!q.name || !Number.isFinite(q.price) || q.price <= 0 || !Number.isFinite(q.previousClose) || q.previousClose <= 0
      || !Number.isFinite(q.timestamp) || q.timestamp < Date.UTC(2000, 0, 1)) throw new Error("报价字段为空或异常");
  return q;
}
export function parseTencentQuote(raw: string, id: string): WireQuote {
  const fields = raw.match(new RegExp(`v_${id}="([^"]*)"`))?.[1].split("~");
  if (!fields || fields.length < 33 || fields[2] !== id.slice(2)) throw new Error("腾讯报价代码不匹配或为空");
  return checkedQuote({ name: fields[1], price: Number(fields[3]), previousClose: Number(fields[4]), timestamp: parseTime(fields[30]), volume: Number(fields[6]) * 100 || 0 });
}
export function parseSinaQuote(raw: string, id: string): WireQuote {
  const fields = raw.match(new RegExp(`hq_str_${id}="([^"]*)"`))?.[1].split(",");
  if (!fields || fields.length < 32) throw new Error("新浪报价代码不匹配或为空");
  return checkedQuote({ name: fields[0], price: Number(fields[3]), previousClose: Number(fields[2]), timestamp: parseTime(`${fields[30]} ${fields[31]}`), volume: Number(fields[8]) || 0 });
}
export function parseEastmoneyQuote(raw: string, id: string): WireQuote {
  const d = JSON.parse(raw).data;
  if (!d || d.f57 !== id.split(".")[1]) throw new Error("东方财富报价代码不匹配或为空");
  const divisor = 10 ** (Number.isInteger(d.f59) ? d.f59 : 2);
  return checkedQuote({ name: d.f58, price: typeof d.f43 === "number" ? d.f43 / divisor : NaN,
    previousClose: typeof d.f60 === "number" ? d.f60 / divisor : NaN, timestamp: Number(d.f86) * 1000, volume: 0 });
}
function orderedPoints(points: IntradayPoint[]): IntradayPoint[] {
  const sorted = [...new Map(points.filter(p => Number.isFinite(p.time) && Number.isFinite(p.price) && p.price > 0)
    .map(p => [p.time, p])).values()].sort((a,b) => a.time - b.time);
  if (!sorted.length) throw new Error("分时数据为空");
  return sorted;
}
export function parseTencentMinute(raw: string, id: string): IntradayPoint[] {
  const d = JSON.parse(raw).data?.[id]?.data;
  if (!d || !/^\d{8}$/.test(d.date) || !Array.isArray(d.data)) throw new Error("腾讯分时数据为空");
  const day = `${d.date.slice(0,4)}-${d.date.slice(4,6)}-${d.date.slice(6,8)}`;
  const points = orderedPoints(d.data.map((row: string) => {
    const [time, px, vol, amount] = row.trim().split(/\s+/);
    const price = Number(px), volume = Number(vol) * 100;
    const average = volume > 0 && Number(amount) > 0 ? Number(amount) / volume : price;
    return { time: parseTime(`${day} ${time.slice(0,2)}:${time.slice(2,4)}:00`) / 1000, price, volume,
      average: Number.isFinite(average) && average > 0 ? average : price };
  }));
  // Tencent sends cumulative lots. Compute VWAP above before converting to
  // interval shares, after time ordering/deduplication. Ignore invalid resets.
  let previousVolume = 0;
  return points.map(point => {
    const cumulative = Number.isFinite(point.volume) && point.volume >= 0 ? point.volume : previousVolume;
    const volume = Math.max(0, cumulative - previousVolume);
    previousVolume = Math.max(previousVolume, cumulative);
    return { ...point, volume };
  });
}
export function parseEastmoneyMinute(raw: string): IntradayPoint[] {
  const rows = JSON.parse(raw).data?.trends;
  if (!Array.isArray(rows)) throw new Error("东方财富分时数据为空");
  return orderedPoints(rows.map((row: string) => {
    const f = row.split(","), price = Number(f[2]);
    return { time: parseTime(f[0]) / 1000, price, average: Number(f[7]) > 0 ? Number(f[7]) : price, volume: Number(f[5]) * 100 || 0 };
  }));
}
function candles(rows: string[][]): DailyCandle[] {
  const parsed = rows.map(f => ({ time: f[0], open: Number(f[1]), close: Number(f[2]), high: Number(f[3]), low: Number(f[4]), volume: Number(f[5]) || 0 }))
    .filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c.time) && [c.open,c.close,c.high,c.low].every(v => Number.isFinite(v) && v > 0) && c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close));
  if (!parsed.length) throw new Error("日K数据为空");
  return [...new Map(parsed.map(c => [c.time,c])).values()].sort((a,b) => a.time.localeCompare(b.time));
}
export function parseTencentDaily(raw: string, id: string): DailyCandle[] {
  const d = JSON.parse(raw).data?.[id];
  const rows = d?.qfqday ?? d?.day;
  if (!Array.isArray(rows)) throw new Error("腾讯日K数据为空");
  return candles(rows);
}
export function parseEastmoneyDaily(raw: string): DailyCandle[] {
  const rows = JSON.parse(raw).data?.klines;
  if (!Array.isArray(rows)) throw new Error("东方财富日K数据为空");
  return candles(rows.map((row: string) => row.split(",")));
}
