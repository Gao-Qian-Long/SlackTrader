import { invoke } from "@tauri-apps/api/core";
import type { DailyCandle, IntradayPoint, MarketProvider, QuoteUpdate, Stock } from "./types";
import { chinaDate, eastmoneyId, isSector, mainlandId, marketStatus, normalizeInstrument, parseEastmoneyDaily,
  parseEastmoneyMinute, parseEastmoneyQuote, parseSinaQuote, parseTencentDaily, parseTencentMinute, parseTencentQuote,
  round, SOURCE_NAMES, type QuoteSource, type SourcePreference, type WireQuote } from "./marketData";
export { normalizeInstrument, SECTOR_ALIASES } from "./marketData";

type Dependencies = {
  request: (url: string) => Promise<string>;
  now: () => number;
  schedule: (fn: () => void, ms: number) => number;
  cancel: (timer: number) => void;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

// 保留旧导出名，使旧调用点和保存的观察列表继续兼容。
export class EastmoneyMarketProvider implements MarketProvider {
  private deps: Dependencies;
  private preference: SourcePreference = "auto";
  private failures = new Map<string, { count: number; until: number; message: string }>();
  private cache = new Map<string, { at: number; promise: Promise<string> }>();
  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = { request: url => invoke<string>("fetch_market_json", { url }), now: Date.now,
      schedule: (fn,ms) => window.setTimeout(fn,ms), cancel: id => window.clearTimeout(id), ...deps };
  }
  setPreference(value: SourcePreference) { this.preference = value; }
  private read(url: string, ttl: number): Promise<string> {
    const cached = this.cache.get(url);
    if (cached && this.deps.now() - cached.at < ttl) return cached.promise;
    const promise = this.deps.request(url);
    this.cache.set(url, { at: this.deps.now(), promise });
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
    void promise.catch(() => { if (this.cache.get(url)?.promise === promise) this.cache.delete(url); });
    return promise;
  }
  private async choose<T>(candidates: { source: QuoteSource; key: string; run: () => Promise<T> }[]): Promise<{ source: QuoteSource; value: T }> {
    const errors: string[] = [];
    for (const c of candidates) {
      const previous = this.failures.get(c.key);
      if (previous && previous.until > this.deps.now()) {
        errors.push(`${SOURCE_NAMES[c.source]}冷却${Math.ceil((previous.until-this.deps.now())/1000)}秒：${previous.message}`);
        continue;
      }
      try {
        const value = await c.run();
        this.failures.delete(c.key);
        return { source: c.source, value };
      } catch (error) {
        const message = errorText(error);
        const count = (previous?.count ?? 0) + 1;
        const retryAfter = Number(/retryAfterMs=(\d+)/.exec(message)?.[1] ?? 0);
        this.failures.set(c.key, { count, message, until: this.deps.now() + Math.max(retryAfter, Math.min(300_000, 30_000 * 2 ** Math.min(count-1,4))) });
        errors.push(`${SOURCE_NAMES[c.source]}：${message}`);
      }
    }
    throw new Error(errors.join("；"));
  }
  private sources(stock: Stock): QuoteSource[] {
    if (isSector(stock)) return ["eastmoney"];
    const order: QuoteSource[] = ["tencent", "sina", "eastmoney"];
    return this.preference === "auto" ? order : [this.preference, ...order.filter(s => s !== this.preference)];
  }
  private async quote(stock: Stock) {
    return this.choose(this.sources(stock).map(source => ({ source, key: `quote:${source}`, run: async () => {
      if (source === "eastmoney") {
        const id = eastmoneyId(stock);
        return parseEastmoneyQuote(await this.read(`https://push2.eastmoney.com/api/qt/stock/get?secid=${id}&fields=f43,f57,f58,f59,f60,f86,f170`, 4500), id);
      }
      const id = mainlandId(stock);
      return source === "tencent"
        ? parseTencentQuote(await this.read(`https://qt.gtimg.cn/q=${id}`, 4500), id)
        : parseSinaQuote(await this.read(`https://hq.sinajs.cn/list=${id}`, 4500), id);
    } })));
  }
  private chartSources(stock: Stock): ("tencent" | "eastmoney")[] {
    if (isSector(stock)) return ["eastmoney"];
    return this.preference === "eastmoney" ? ["eastmoney","tencent"] : ["tencent","eastmoney"];
  }
  private async history(stock: Stock) {
    return this.choose(this.chartSources(stock).map(source => ({ source, key: `minute:${source}`, run: async () => {
      if (source === "tencent") {
        const id = mainlandId(stock);
        return parseTencentMinute(await this.read(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${id}`, 29_000), id);
      }
      return parseEastmoneyMinute(await this.read(`https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${eastmoneyId(stock)}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0&iscca=0`, 29_000));
    } })));
  }
  connect(stock: Stock, onUpdate: (update: QuoteUpdate) => void, onError?: (message: string) => void): () => void {
    const normalized = normalizeInstrument(stock);
    let stopped = false, quoteTimer = 0, historyTimer = 0, quoteFailures = 0;
    let latest: WireQuote | undefined, quoteSource: QuoteSource | undefined, historySource: QuoteSource | undefined;
    let history: IntradayPoint[] = [], historyMessage: string | undefined = "分时加载中";
    let quoteError: string | undefined;
    const publish = () => {
      if (stopped || !latest || !quoteSource) return;
      // 跨交易日不把旧曲线画在新昨收坐标上；绝不生成分时价格。
      const sameDate = history.length > 0 && chinaDate(history[history.length-1].time * 1000) === chinaDate(latest.timestamp);
      const visibleHistory = sameDate ? history : [];
      const change = round(latest.price - latest.previousClose);
      onUpdate({ history: visibleHistory, point: visibleHistory[visibleHistory.length-1] ?? { time: latest.timestamp/1000, price: latest.price, average: latest.price, volume: 0 },
        snapshot: { stock: { ...normalized, name: latest.name, previousClose: latest.previousClose }, price: latest.price, change,
          changePercent: round(change/latest.previousClose*100), volume: latest.volume, timestamp: latest.timestamp, status: marketStatus(this.deps.now()) },
        quoteSource: SOURCE_NAMES[quoteSource], quoteError,
        historySource: historySource ? SOURCE_NAMES[historySource] : undefined,
        historyMessage: history.length && !sameDate ? "分时日期与报价不一致，等待更新" : historyMessage });
    };
    const refreshQuote = async () => {
      try {
        const result = await this.quote(normalized);
        if (stopped) return;
        latest = result.value; quoteSource = result.source; quoteError = undefined; quoteFailures = 0;
        publish();
      } catch (error) {
        if (stopped) return;
        quoteFailures++;
        quoteError = `${isSector(normalized) ? "板块原数据源异常（未替换为其他板块）：" : ""}${errorText(error)}`;
        if (latest) publish();
        onError?.(quoteError);
      } finally {
        if (!stopped) {
          const base = marketStatus(this.deps.now()) === "trading" ? 5000 : 60_000;
          quoteTimer = this.deps.schedule(() => void refreshQuote(), Math.min(300_000, base * 2 ** Math.min(quoteFailures,6)));
        }
      }
    };
    const refreshHistory = async () => {
      try {
        const result = await this.history(normalized);
        if (stopped) return;
        history = result.value; historySource = result.source; historyMessage = undefined;
      } catch (error) {
        if (stopped) return;
        historyMessage = `分时待恢复：${errorText(error)}`;
      } finally {
        if (!stopped) {
          publish();
          historyTimer = this.deps.schedule(() => void refreshHistory(), marketStatus(this.deps.now()) === "trading" ? 30_000 : 300_000);
        }
      }
    };
    // 切换标的时轻微防抖，并共享短时缓存，减少连续滚轮切换的重复请求。
    quoteTimer = this.deps.schedule(() => void refreshQuote(), 150);
    historyTimer = this.deps.schedule(() => void refreshHistory(), 150);
    return () => { stopped = true; this.deps.cancel(quoteTimer); this.deps.cancel(historyTimer); };
  }
  async getDailyCandles(stock: Stock): Promise<DailyCandle[]> {
    const result = await this.choose(this.chartSources(stock).map(source => ({ source, key: `daily:${source}`, run: async () => {
      if (source === "tencent") {
        const id = mainlandId(stock);
        return parseTencentDaily(await this.read(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${id},day,,,90,qfq`, 59_000), id);
      }
      return parseEastmoneyDaily(await this.read(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${eastmoneyId(stock)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt=90`, 59_000));
    } })));
    return result.value;
  }
}
