import { invoke } from "@tauri-apps/api/core";
import { eastmoneyId, marketStatus } from "./marketData";
import { parseRelatedSectors, parseSectorSeries, parseTradeDetails, supportsMarketDepth } from "./detailData";
import type { Stock, RelatedSector, SectorSeries, TradePage } from "./types";

type Dependencies = { request: (url: string) => Promise<string>; now: () => number; schedule: (fn: () => void, ms: number) => number; cancel: (id: number) => void };
export class DetailMarketProvider {
  private deps: Dependencies;
  private sectors = new Map<string, { at: number; value: RelatedSector[] }>();
  private failed = new Map<string, { until: number; count: number }>();
  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = { request: url => invoke<string>("fetch_market_json", { url }), now: Date.now, schedule: (fn, ms) => window.setTimeout(fn, ms), cancel: id => window.clearTimeout(id), ...deps };
  }
  private async read<T>(key: string, url: string, parse: (raw: string) => T): Promise<T> {
    const failure = this.failed.get(key);
    if (failure && failure.until > this.deps.now()) throw new Error("数据源冷却中");
    try {
      const result = parse(await this.deps.request(url)); this.failed.delete(key); return result;
    } catch (error) {
      const count = (failure?.count ?? 0) + 1;
      const retryAfter = Number(/retryAfterMs=(\d+)/.exec(String(error))?.[1] ?? 0);
      this.failed.set(key, { count, until: this.deps.now() + Math.max(retryAfter, Math.min(300_000, 10_000 * 2 ** Math.min(count - 1, 5))) });
      throw error;
    }
  }
  async getRelatedSectors(stock: Stock): Promise<RelatedSector[]> {
    if (!supportsMarketDepth(stock)) return [];
    const id = eastmoneyId(stock), cached = this.sectors.get(id);
    if (cached && this.deps.now() - cached.at < 600_000) return cached.value;
    const value = await this.read(`related:${id}`, `https://push2.eastmoney.com/api/qt/slist/get?secid=${id}&fields=f12,f14&pi=0&pz=200&po=1&np=1&fltt=2&invt=2&spt=3`, parseRelatedSectors);
    if (this.sectors.size >= 100) this.sectors.delete(this.sectors.keys().next().value!);
    this.sectors.set(id, { at: this.deps.now(), value }); return value;
  }
  private poll<T>(load: () => Promise<T>, interval: number, receive: (result: T) => void, fail: (message: string) => void): () => void {
    let stopped = false, failures = 0;
    let timer = this.deps.schedule(() => void run(), 150);
    const run = async () => {
      try { const result = await load(); if (!stopped) { failures = 0; receive(result); } }
      catch (error) { if (!stopped) { failures++; fail(error instanceof Error ? error.message : String(error)); } }
      finally {
        if (!stopped) timer = this.deps.schedule(() => void run(), Math.min(300_000, (marketStatus(this.deps.now()) === "trading" ? interval : 60_000) * 2 ** Math.min(failures, 5)));
      }
    };
    return () => { stopped = true; this.deps.cancel(timer); };
  }
  connectTrades(stock: Stock, receive: (page: TradePage) => void, fail: (message: string) => void): () => void {
    if (!supportsMarketDepth(stock)) return () => {};
    const id = eastmoneyId(stock), [market, symbol] = id.split(".");
    return this.poll(async () => ({ trades: await this.read(`trades:${id}`, `https://push2.eastmoney.com/api/qt/stock/details/get?secid=${id}&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55&pos=-30&iscca=1`, raw => parseTradeDetails(raw, symbol, Number(market))), source: "东方财富·分笔聚合", receivedAt: this.deps.now() }), 5000, receive, fail);
  }
  connectSector(sector: RelatedSector, receive: (series: SectorSeries) => void, fail: (message: string) => void): () => void {
    if (!/^BK\d{4}$/.test(sector.code)) throw new Error("关联板块代码错误");
    return this.poll(async () => {
      const errors: string[] = [];
      for (const [host, source] of [["push2his.eastmoney.com", "东方财富"], ["push2delay.eastmoney.com", "东方财富备用·可能延迟"]]) {
        try {
          return await this.read(`sector:${host}:${sector.code}`, `https://${host}/api/qt/stock/trends2/get?secid=90.${sector.code}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0&iscca=0`, raw => parseSectorSeries(raw, sector, source));
        } catch (error) { errors.push(String(error)); }
      }
      throw new Error(errors.join("；"));
    }, 30_000, receive, fail);
  }
}
