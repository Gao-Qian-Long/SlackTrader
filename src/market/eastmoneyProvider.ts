import { invoke } from "@tauri-apps/api/core";
import type { DailyCandle, IntradayPoint, MarketProvider, MarketStatus, QuoteUpdate, Stock } from "./types";

type EastmoneyResponse<T> = { data: T | null };
type QuoteData = { f43: number; f57: string; f58: string; f59: number; f60: number; f86: number; f170: number };
type TrendData = { trends: string[] };
type KlineData = { klines: string[] };

const INDEXES_ON_SH = new Set(["000300", "000016", "000905", "000852", "000688"]);
export const SECTOR_ALIASES: Record<string, { dataSymbol: string; name: string }> = {
  // 同花顺行业代码 -> 东方财富同名行业板块代码
  "881129": { dataSymbol: "90.BK0448", name: "通信设备" },
};

export function normalizeInstrument(stock: Stock): Stock {
  const sector = SECTOR_ALIASES[stock.symbol];
  return sector ? { ...stock, kind: "sector", dataSymbol: sector.dataSymbol, name: sector.name } : stock;
}

const secid = (stock: Stock) => {
  const normalized = normalizeInstrument(stock);
  if (normalized.dataSymbol?.includes(".")) return normalized.dataSymbol;
  const symbol = normalized.dataSymbol ?? normalized.symbol;
  return `${symbol.startsWith("6") || symbol.startsWith("5") || symbol.startsWith("9") || INDEXES_ON_SH.has(symbol) ? 1 : 0}.${symbol}`;
};
const round = (value: number) => Math.round(value * 100) / 100;

function statusNow(): MarketStatus {
  // 使用北京时间（UTC+8）判断 A 股交易时段，避免本机时区影响结果
  const china = new Date(Date.now() + 8 * 3600 * 1000);
  const day = china.getUTCDay();
  if (day === 0 || day === 6) return "closed"; // 周末休市
  const minute = china.getUTCHours() * 60 + china.getUTCMinutes();
  if (minute < 570) return "preopen";
  if (minute < 690) return "trading";
  if (minute < 780) return "break";
  if (minute < 900) return "trading";
  return "closed";
}

async function fetchMarket<T>(url: string): Promise<T> {
  const raw = await invoke<string>("fetch_market_json", { url });
  const parsed = JSON.parse(raw) as EastmoneyResponse<T>;
  if (!parsed.data) throw new Error("行情接口没有返回数据");
  return parsed.data;
}

function parseTime(value: string): number {
  return Math.floor(new Date(`${value.replace(" ", "T")}+08:00`).getTime() / 1000);
}

export class EastmoneyMarketProvider implements MarketProvider {
  connect(stock: Stock, onUpdate: (update: QuoteUpdate) => void, onError?: (message: string) => void): () => void {
    let stopped = false;
    let timer = 0;
    let retryDelay = 3000;
    const MAX_RETRY_DELAY = 60_000;

    const refresh = async () => {
      let succeeded = false;
      try {
        const normalizedStock = normalizeInstrument(stock);
        const id = secid(normalizedStock);
        const [quote, trend] = await Promise.all([
          fetchMarket<QuoteData>(`https://push2.eastmoney.com/api/qt/stock/get?secid=${id}&fields=f43,f57,f58,f59,f60,f86,f170`),
          fetchMarket<TrendData>(`https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${id}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0&iscca=0`),
        ]);
        if (stopped) return;
        const divisor = 10 ** (quote.f59 || 2);
        const price = quote.f43 / divisor;
        const previousClose = quote.f60 / divisor;
        // 不突变传入的 stock，返回一份携带真实名称与前收价的新对象
        const refreshedStock: Stock = { ...normalizedStock, name: quote.f58 || normalizedStock.name, previousClose };
        const history: IntradayPoint[] = trend.trends.map(row => {
          const fields = row.split(",");
          return { time: parseTime(fields[0]), price: Number(fields[2]), average: Number(fields[7]) || Number(fields[2]), volume: Number(fields[5]) || 0 };
        }).filter(point => Number.isFinite(point.price));
        if (!history.length) throw new Error("今日分时数据暂不可用");
        const change = round(price - previousClose);
        const point = history[history.length - 1];
        const update: QuoteUpdate = {
          point,
          history,
          snapshot: {
            stock: refreshedStock, price, change,
            changePercent: round((price / previousClose - 1) * 100),
            volume: history.reduce((sum, item) => sum + item.volume, 0),
            status: statusNow(), timestamp: quote.f86 ? quote.f86 * 1000 : Date.now(),
          },
        };
        onUpdate(update);
        succeeded = true;
      } catch (error) {
        if (!stopped) onError?.(error instanceof Error ? error.message : "行情连接失败");
      } finally {
        if (stopped) return;
        timer = window.setTimeout(refresh, retryDelay);
        retryDelay = succeeded ? 3000 : Math.min(retryDelay * 2, MAX_RETRY_DELAY);
      }
    };

    void refresh();
    return () => { stopped = true; window.clearTimeout(timer); };
  }

  async getDailyCandles(stock: Stock): Promise<DailyCandle[]> {
    const data = await fetchMarket<KlineData>(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid(stock)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt=90`);
    return data.klines.map(row => {
      const fields = row.split(",");
      return { time: fields[0], open: Number(fields[1]), close: Number(fields[2]), high: Number(fields[3]), low: Number(fields[4]), volume: Number(fields[5]) || 0 };
    });
  }
}
