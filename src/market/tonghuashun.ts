import type { DailyCandle, IntradayPoint, Stock } from "./types";
import { checkedQuote, normalizeInstrument, parseTime, type WireQuote } from "./marketData";

export function isTonghuashun(stock: Stock): boolean {
  return /^bk_\d{6}$/.test(normalizeInstrument(stock).dataSymbol ?? "");
}
export function tonghuashunId(stock: Stock): string {
  const id = normalizeInstrument(stock).dataSymbol;
  if (!id || !/^bk_\d{6}$/.test(id)) throw new Error("同花顺板块代码错误");
  return id;
}
// Only parse the exact expected callback's JSON argument; never execute remote JS.
function unwrap(raw: string, callback: string): any {
  const text = raw.trim().replace(/;$/, "").trim();
  const prefix = callback + "(";
  if (!text.startsWith(prefix) || !text.endsWith(")")) throw new Error("同花顺响应代码/回调不匹配");
  return JSON.parse(text.slice(prefix.length, -1));
}
function day(value: string): string {
  if (!/^\d{8}$/.test(value)) throw new Error("同花顺日期缺失");
  const result = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
  const ms = parseTime(`${result} 00:00:00`);
  if (new Date(ms + 8*3600_000).toISOString().slice(0,10) !== result) throw new Error("同花顺日期无效");
  return result;
}
export function parseTonghuashunQuote(raw: string, id: string): WireQuote {
  const d = unwrap(raw, `quotebridge_v6_realhead_${id}_last`).items;
  if (!d || d["5"] !== id.slice(3)) throw new Error("同花顺报价代码不匹配");
  // updateTime is the market time; 'time' is the response-generation time even after close.
  if (typeof d.updateTime !== "string") throw new Error("同花顺行情时间缺失");
  return checkedQuote({ name: d.name, price: Number(d["10"]), previousClose: Number(d["6"]),
    timestamp: parseTime(d.updateTime), volume: Number(d["13"]) || 0 });
}
export function parseTonghuashunMinute(raw: string, id: string, version = "v6"): { quote: WireQuote; history: IntradayPoint[] } {
  const d = unwrap(raw, `quotebridge_${version}_time_${id}_last`)[id];
  if (!d || typeof d.data !== "string") throw new Error("同花顺分时为空");
  const date = day(d.date);
  const history: IntradayPoint[] = d.data.split(";").filter(Boolean).map((row: string) => {
    const f = row.split(",");
    if (!/^\d{4}$/.test(f[0])) throw new Error("同花顺分时时间错误");
    const minute = Number(f[0].slice(0,2))*60 + Number(f[0].slice(2));
    if (Number(f[0].slice(2)) > 59 || !((minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900))) throw new Error("同花顺分时不在交易时段");
    const price = Number(f[1]);
    if (!Number.isFinite(price) || price <= 0) throw new Error("同花顺分时价格异常");
    // f[3] is a per-share metric (~60), not an index-point average (~9000).
    // Omit the average line rather than distort the index's price axis.
    return { time: parseTime(`${date} ${f[0].slice(0,2)}:${f[0].slice(2)}:00`)/1000, price, volume: Number(f[4]) || 0 };
  });
  const ordered = [...new Map(history.map(p => [p.time,p])).values()].sort((a,b)=>a.time-b.time);
  if (!ordered.length) throw new Error("同花顺分时为空");
  const last = ordered[ordered.length-1];
  const quote = checkedQuote({name:d.name, price:last.price, previousClose:Number(d.pre), timestamp:last.time*1000,
    volume:ordered.reduce((total,p)=>total+p.volume,0), note:"分时末笔"});
  return {quote, history:ordered};
}
function validCandle(c: DailyCandle): DailyCandle {
  if (![c.open,c.close,c.high,c.low].every(p=>Number.isFinite(p)&&p>0) || c.high<Math.max(c.open,c.close) || c.low>Math.min(c.open,c.close)) throw new Error("同花顺日K字段异常");
  return c;
}
export function parseTonghuashunDaily(raw: string, id: string, version = "v6"): DailyCandle[] {
  const d = unwrap(raw, `quotebridge_${version}_line_${id}_01_last`);
  if (typeof d.data !== "string" || !d.data) throw new Error("同花顺日K为空");
  return mergeTonghuashunDaily(d.data.split(";").filter(Boolean).map((row:string)=>{
    const f=row.split(",");
    return validCandle({time:day(f[0]),open:Number(f[1]),high:Number(f[2]),low:Number(f[3]),close:Number(f[4]),volume:Number(f[5])||0});
  }), []);
}
export function parseTonghuashunToday(raw: string, id: string, version = "v6"): DailyCandle {
  const d = unwrap(raw, `quotebridge_${version}_line_${id}_01_today`)[id];
  if (!d) throw new Error("同花顺当日日K为空");
  return validCandle({time:day(d["1"]),open:Number(d["7"]),high:Number(d["8"]),low:Number(d["9"]),close:Number(d["11"]),volume:Number(d["13"])||0});
}
export function mergeTonghuashunDaily(history: DailyCandle[], today: DailyCandle[]): DailyCandle[] {
  return [...new Map([...history,...today].map(c=>[c.time,c])).values()].sort((a,b)=>a.time.localeCompare(b.time)).slice(-90);
}
