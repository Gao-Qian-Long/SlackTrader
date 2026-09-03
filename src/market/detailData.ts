import { parseEastmoneyMinute, isSector } from "./marketData";
import type { Stock, RelatedSector, SectorSeries, TradeDetail } from "./types";

export function supportsMarketDepth(stock: Stock): boolean {
  return stock.kind !== "index" && !isSector(stock) && /^\d{6}$/.test(stock.symbol)
    && !["000300", "000016", "000905", "000852", "000688"].includes(stock.symbol);
}

export function parseRelatedSectors(raw: string): RelatedSector[] {
  const body = JSON.parse(raw);
  if (body.rc !== 0 || !Array.isArray(body.data?.diff)) throw new Error("关联板块数据为空");
  const rows = body.data.diff.filter((row: { f12: unknown; f14: unknown }) => typeof row.f12 === "string" && /^BK\d{4}$/.test(row.f12) && typeof row.f14 === "string" && row.f14.trim());
  return [...new Map<string, RelatedSector>(rows.map((row: { f12: string; f14: string }) => [row.f12, { code: row.f12, name: row.f14 }])).values()];
}

export function parseSectorSeries(raw: string, sector: RelatedSector, source: string): SectorSeries {
  const body = JSON.parse(raw), data = body.data;
  if (body.rc !== 0 || data?.code !== sector.code || Number(data.market) !== 90) throw new Error("板块代码与响应不一致");
  const previousClose = Number(data.preClose);
  if (!Number.isFinite(previousClose) || previousClose <= 0) throw new Error("板块昨收缺失");
  const history = parseEastmoneyMinute(raw).filter(point => {
    const date = new Date(point.time * 1000 + 8 * 3600_000), minute = date.getUTCHours() * 60 + date.getUTCMinutes();
    return (minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900);
  });
  if (!history.length) throw new Error("板块交易时段分时待更新");
  return { sector, previousClose, history, source };
}

export function parseTradeDetails(raw: string, symbol: string, market: number): TradeDetail[] {
  const body = JSON.parse(raw), data = body.data;
  if (body.rc !== 0 || data?.code !== symbol || Number(data.market) !== market || !Array.isArray(data.details)) throw new Error("成交明细响应不匹配");
  const rows: TradeDetail[] = data.details.map((row: string) => {
    if (typeof row !== "string") throw new Error("成交记录格式错误");
    const [time, px, lots, , side] = row.split(",");
    const price = Number(px), shares = Number(lots) * 100;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(shares) || shares <= 0) throw new Error("成交记录字段错误");
    return { time, price, shares, side: side === "2" ? "buy" : side === "1" ? "sell" : "neutral" };
  });
  // The endpoint sends aggregated prints, not exchange tick-by-tick executions.
  // Keep equal-time records; do not derive trades from quote price/volume deltas.
  return rows.sort((a, b) => b.time.localeCompare(a.time));
}
