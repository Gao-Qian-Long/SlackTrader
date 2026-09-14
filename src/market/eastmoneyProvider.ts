import { invoke } from "@tauri-apps/api/core";
import type { AuctionPoint, DailyCandle, DiagnosticResult, IntradayPoint, MarketProvider, MarketRequestKind, MarketSource, QuoteUpdate, SourceSwitch, Stock } from "./types";
import { isTonghuashun, tonghuashunId, parseTonghuashunQuote, parseTonghuashunMinute, parseTonghuashunDaily, parseTonghuashunToday, mergeTonghuashunDaily } from "./tonghuashun";
import { chinaDate, eastmoneyId, isSector, mainlandId, marketStatus, normalizeInstrument, parseEastmoneyDaily,
  parseEastmoneyMinute, parseEastmoneyQuote, parseSinaQuote, parseTencentDaily, parseTencentMinute, parseTencentQuote, isOpeningAuctionTime,
  round, SOURCE_NAMES, type QuoteSource, type SourcePreference, type WireQuote } from "./marketData";
import { ERROR_LABELS, LocalDiagnosticLog, SourceHealthTracker, classifyMarketError, freshness } from "./marketHealth";
export { normalizeInstrument, SECTOR_ALIASES } from "./marketData";

type Dependencies = {
  request: (url: string) => Promise<string>;
  now: () => number;
  schedule: (fn: () => void, ms: number) => number;
  cancel: (timer: number) => void;
};
// 保留旧导出名，使旧调用点和保存的观察列表继续兼容。
export class EastmoneyMarketProvider implements MarketProvider {
  private deps: Dependencies;
  private preference: SourcePreference = "auto";
  private health: SourceHealthTracker;
  private cache = new Map<string, { at: number; promise: Promise<string> }>();
  private auctionSamples = new Map<string, Map<number, AuctionPoint>>();
  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = { request: url => invoke<string>("fetch_market_json", { url }), now: Date.now,
      schedule: (fn,ms) => window.setTimeout(fn,ms), cancel: id => window.clearTimeout(id), ...deps };
    const storage = typeof localStorage === "undefined" ? undefined : localStorage;
    this.health = new SourceHealthTracker(this.deps.now, new LocalDiagnosticLog(storage, this.deps.now));
  }
  setPreference(value: SourcePreference) { this.preference = value; }
  getHealthSnapshot() { return this.health.snapshot(); }
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = this.deps.schedule(() => reject(new Error("请求超时")), ms);
      promise.then(value => { this.deps.cancel(timer); resolve(value); }, error => { this.deps.cancel(timer); reject(error); });
    });
  }
  private read(url: string, ttl: number): Promise<string> {
    const cached = this.cache.get(url);
    if (cached && this.deps.now() - cached.at < ttl) return cached.promise;
    const promise = this.deps.request(url);
    this.cache.set(url, { at: this.deps.now(), promise });
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
    void promise.catch(() => { if (this.cache.get(url)?.promise === promise) this.cache.delete(url); });
    return promise;
  }
  private async choose<T>(kind: MarketRequestKind, candidates: { source: QuoteSource; key: string; run: () => Promise<T> }[], adaptive = this.preference === "auto"): Promise<{ source: QuoteSource; value: T }> {
    const errors: string[] = [];
    for (const c of this.health.order(candidates, adaptive)) {
      const previous = this.health.get(c.key);
      if (previous && previous.cooldownUntil > this.deps.now()) {
        errors.push(`${SOURCE_NAMES[c.source]}冷却${Math.ceil((previous.cooldownUntil-this.deps.now())/1000)}秒：${ERROR_LABELS[previous.lastErrorCode ?? "invalid_response"]}`);
        continue;
      }
      const started = this.deps.now();
      try {
        const value = await c.run();
        this.health.success(c.key, kind, c.source, Math.max(0, this.deps.now() - started));
        return { source: c.source, value };
      } catch (error) {
        const code = this.health.failure(c.key, kind, c.source, error, Math.max(0, this.deps.now() - started));
        errors.push(`${SOURCE_NAMES[c.source]}：${ERROR_LABELS[code]}`);
      }
    }
    throw new Error(errors.join("；"));
  }
  private sources(stock: Stock): QuoteSource[] {
    if (isSector(stock)) return ["eastmoney"];
    const order: QuoteSource[] = ["tencent", "sina", "eastmoney"];
    return this.preference === "auto" ? order : [this.preference, ...order.filter(s => s !== this.preference)];
  }
  private async tonghuashunTime(stock: Stock) {
    const id = tonghuashunId(stock);
    return this.choose("minute", ["v6", "v4"].map(version => ({ source: "ths" as const, key: `minute:ths:${version}`, run: async () =>
      parseTonghuashunMinute(await this.read(`https://d.10jqka.com.cn/${version}/time/${id}/last.js`, 29_000), id, version) })));
  }
  private async quoteFromSource(stock: Stock, source: Exclude<QuoteSource,"ths">, ttl: number, bypassCache = false) {
    const id = source === "eastmoney" ? eastmoneyId(stock) : mainlandId(stock);
    const url = source === "eastmoney"
      ? `https://push2.eastmoney.com/api/qt/stock/get?secid=${id}&fields=f43,f57,f58,f59,f60,f86,f170`
      : source === "tencent" ? `https://qt.gtimg.cn/q=${id}` : `https://hq.sinajs.cn/list=${id}`;
    const raw = bypassCache ? await this.deps.request(url) : await this.read(url, ttl);
    return source === "eastmoney" ? parseEastmoneyQuote(raw, id) : source === "tencent" ? parseTencentQuote(raw, id) : parseSinaQuote(raw, id);
  }
  private async quote(stock: Stock) {
    const quoteTtl = marketStatus(this.deps.now()) === "auction" ? 2500 : 4500;
    if (isTonghuashun(stock)) {
      const id = tonghuashunId(stock);
      return this.choose("quote", [
        { source: "ths", key: "ths:quote", run: async () => parseTonghuashunQuote(await this.read(`https://d.10jqka.com.cn/v6/realhead/${id}/last.js`, quoteTtl), id) },
        { source: "ths", key: "ths:quote-minute", run: async () => (await this.tonghuashunTime(stock)).value.quote },
      ]);
    }
    return this.choose("quote", this.sources(stock).map(source => ({ source, key: `quote:${source}`, run: () => this.quoteFromSource(stock, source as Exclude<QuoteSource,"ths">, quoteTtl) })));
  }
  private chartSources(stock: Stock): ("tencent" | "eastmoney")[] {
    if (isSector(stock)) return ["eastmoney"];
    return this.preference === "eastmoney" ? ["eastmoney","tencent"] : ["tencent","eastmoney"];
  }
  private async history(stock: Stock) {
    if (isTonghuashun(stock)) {
      const result = await this.tonghuashunTime(stock);
      return { source: result.source, value: result.value.history };
    }
    return this.choose("minute", this.chartSources(stock).map(source => ({ source, key: `minute:${source}`, run: async () => {
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
    let sourceSwitched: SourceSwitch | undefined;
    const currentAuction = () => {
      const key = `${normalized.symbol}:${chinaDate(this.deps.now())}`;
      const samples = this.auctionSamples.get(key) ?? new Map<number, AuctionPoint>();
      this.auctionSamples.set(key, samples);
      return samples;
    };
    const captureAuction = () => {
      if (!latest || isSector(normalized) || chinaDate(latest.timestamp) !== chinaDate(this.deps.now()) || !isOpeningAuctionTime(latest.timestamp)) return;
      const auction = currentAuction();
      // Record only source-timestamped auction quotes. Prices or history are never synthesized.
      const second = Math.floor(latest.timestamp / 1000);
      auction.set(second, { time: second, price: latest.price, average: latest.price, volume: 0, reportedVolume: Math.max(0, latest.volume) });
      const ordered = [...auction.values()].sort((a,b) => a.time-b.time);
      let previous = 0;
      for (const point of ordered) { point.volume = Math.max(0, point.reportedVolume - previous); previous = Math.max(previous, point.reportedVolume); }
      while (auction.size > 360) auction.delete(auction.keys().next().value!);
    };
    const publish = () => {
      if (stopped || !latest || !quoteSource) return;
      // 跨交易日不把旧曲线画在新昨收坐标上；绝不生成分时价格。
      const sameDate = history.length > 0 && chinaDate(history[history.length-1].time * 1000) === chinaDate(latest.timestamp);
      const visibleHistory = sameDate ? history : [];
      const change = round(latest.price - latest.previousClose);
      const status = marketStatus(this.deps.now());
      const lastHistoryPoint = visibleHistory[visibleHistory.length - 1];
      const age = freshness(status, this.deps.now(), latest.timestamp, lastHistoryPoint ? lastHistoryPoint.time * 1000 : undefined);
      captureAuction();
      const auctionHistory = [...currentAuction().values()].sort((a,b) => a.time-b.time);
      onUpdate({ history: visibleHistory, auction: auctionHistory,
        auctionMessage: isSector(normalized) ? "板块不提供集合竞价" : auctionHistory.length ? undefined : "等待真实竞价报价（需在09:15-09:25运行）",
        point: visibleHistory[visibleHistory.length-1] ?? { time: latest.timestamp/1000, price: latest.price, average: latest.price, volume: 0 },
        snapshot: { stock: { ...normalized, name: latest.name, previousClose: latest.previousClose }, price: latest.price, change,
          changePercent: round((latest.price-latest.previousClose)/latest.previousClose*100), volume: latest.volume, timestamp: latest.timestamp, status, orderBook: latest.orderBook },
        quoteSource: `${SOURCE_NAMES[quoteSource]}${latest.note ? `（${latest.note}）` : ""}`, quoteError,
        historySource: historySource ? SOURCE_NAMES[historySource] : undefined,
        historyMessage: history.length && !sameDate ? "分时日期与报价不一致，等待更新" : historyMessage,
        health: this.health.snapshot(), quoteAgeMs: age.quoteAgeMs, historyAgeMs: age.historyAgeMs,
        sourceSwitched: sourceSwitched && this.deps.now() - sourceSwitched.at < 10_000 ? sourceSwitched : undefined });
    };
    const refreshQuote = async () => {
      try {
        const result = await this.quote(normalized);
        if (stopped) return;
        if (quoteSource && quoteSource !== result.source) {
          const previousHealth = this.health.get(`quote:${quoteSource}`);
          sourceSwitched = { from: quoteSource as MarketSource, to: result.source as MarketSource, at: this.deps.now(), reason: previousHealth?.consecutiveFailures ? "failure" : "health" };
        }
        latest = result.value; quoteSource = result.source; quoteError = undefined; quoteFailures = 0;
        publish();
      } catch (error) {
        if (stopped) return;
        quoteFailures++;
        const target = isSector(normalized) ? `板块数据源待恢复（${isTonghuashun(normalized) ? "同花顺" : "东方财富"}）` : "报价待恢复";
        quoteError = `${target}：${ERROR_LABELS[classifyMarketError(error)]}`;
        if (latest) publish();
        onError?.(quoteError);
      } finally {
        if (!stopped) {
          const status = marketStatus(this.deps.now());
          const base = status === "auction" ? 3000 : status === "trading" ? 5000 : 60_000;
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
        historyMessage = `分时待恢复：${ERROR_LABELS[classifyMarketError(error)]}`;
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
    if (isTonghuashun(stock)) {
      const id = tonghuashunId(stock);
      const [history, today] = await Promise.all([
        this.choose("daily", ["v6", "v4"].map(version => ({ source: "ths" as const, key: `daily:ths:${version}`, run: async () =>
          parseTonghuashunDaily(await this.read(`https://d.10jqka.com.cn/${version}/line/${id}/01/last.js`, 59_000), id, version) }))),
        this.choose("daily", ["v6", "v4"].map(version => ({ source: "ths" as const, key: `daily:ths-today:${version}`, run: async () =>
          parseTonghuashunToday(await this.read(`https://d.10jqka.com.cn/${version}/line/${id}/01/today.js`, 59_000), id, version) }))),
      ]);
      return mergeTonghuashunDaily(history.value, [today.value]);
    }
    const result = await this.choose("daily", this.chartSources(stock).map(source => ({ source, key: `daily:${source}`, run: async () => {
      if (source === "tencent") {
        const id = mainlandId(stock);
        return parseTencentDaily(await this.read(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${id},day,,,90,qfq`, 59_000), id);
      }
      return parseEastmoneyDaily(await this.read(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${eastmoneyId(stock)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&end=20500101&lmt=90`, 59_000));
    } })));
    return result.value;
  }
  async diagnoseCurrentStock(stock: Stock): Promise<DiagnosticResult[]> {
    const normalized = normalizeInstrument(stock);
    const sources: MarketSource[] = isTonghuashun(normalized) ? ["ths"] : isSector(normalized) ? ["eastmoney"] : ["tencent","sina","eastmoney"];
    const results: DiagnosticResult[] = [];
    for (const source of sources) {
      const started = this.deps.now(), key = `quote:${source}`;
      try {
        if (source === "ths") {
          const id = tonghuashunId(normalized);
          await this.withTimeout(this.deps.request(`https://d.10jqka.com.cn/v6/realhead/${id}/last.js`).then(raw => parseTonghuashunQuote(raw,id)), 5000);
        } else await this.withTimeout(this.quoteFromSource(normalized, source, 0, true), 5000);
        const latencyMs = Math.max(0, this.deps.now() - started);
        this.health.success(key, "quote", source, latencyMs);
        const result = { source, ok: true, latencyMs } satisfies DiagnosticResult;
        this.health.diagnostic(result); results.push(result);
      } catch (error) {
        const latencyMs = Math.max(0, this.deps.now() - started), errorCode = classifyMarketError(error);
        this.health.failure(key, "quote", source, error, latencyMs);
        const result = { source, ok: false, latencyMs, errorCode } satisfies DiagnosticResult;
        this.health.diagnostic(result); results.push(result);
      }
    }
    return results;
  }
}
