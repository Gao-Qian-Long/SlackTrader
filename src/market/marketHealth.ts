import type { DiagnosticResult, MarketErrorCode, MarketHealthSnapshot, MarketRequestKind, MarketSource, SourceHealth } from "./types";

export const DIAGNOSTIC_STORAGE_KEY = "marketDiagnosticsV1";
export const ERROR_LABELS: Record<MarketErrorCode, string> = {
  timeout: "请求超时", connection: "连接失败", rate_limit: "接口限流", invalid_response: "响应异常", stale: "数据过期",
};

export function classifyMarketError(error: unknown): MarketErrorCode {
  const text = error instanceof Error ? error.message : String(error);
  if (/429|retryAfterMs|限流/i.test(text)) return "rate_limit";
  if (/timeout|timed out|超时/i.test(text)) return "timeout";
  if (/connect|dns|network|连接|网络|传输中断/i.test(text)) return "connection";
  if (/stale|过期|日期.*不一致/i.test(text)) return "stale";
  return "invalid_response";
}

export interface DiagnosticEntry {
  at: number; kind: MarketRequestKind; source: MarketSource; durationMs: number;
  outcome: "failure" | "recovery" | "diagnostic"; code?: MarketErrorCode;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class LocalDiagnosticLog {
  constructor(private storage?: StorageLike, private now: () => number = Date.now) {}
  read(): DiagnosticEntry[] {
    if (!this.storage) return [];
    try {
      const cutoff = this.now() - 7 * 86400_000;
      const raw = JSON.parse(this.storage.getItem(DIAGNOSTIC_STORAGE_KEY) ?? "[]");
      return Array.isArray(raw) ? raw.filter(entry => entry && Number.isFinite(entry.at) && entry.at >= cutoff
        && ["quote","minute","daily"].includes(entry.kind) && ["tencent","sina","eastmoney","ths"].includes(entry.source)) : [];
    } catch { this.storage.removeItem(DIAGNOSTIC_STORAGE_KEY); return []; }
  }
  append(entry: DiagnosticEntry) {
    if (!this.storage) return;
    const clean: DiagnosticEntry = { at: entry.at, kind: entry.kind, source: entry.source,
      durationMs: Math.max(0, Math.round(entry.durationMs)), outcome: entry.outcome, ...(entry.code ? { code: entry.code } : {}) };
    const rows = [...this.read(), clean].slice(-200);
    while (rows.length > 1 && JSON.stringify(rows).length > 65_536) rows.shift();
    this.storage.setItem(DIAGNOSTIC_STORAGE_KEY, JSON.stringify(rows));
  }
}

export class SourceHealthTracker {
  private endpoints = new Map<string, SourceHealth>();
  constructor(private now: () => number = Date.now, private log = new LocalDiagnosticLog()) {}
  private endpoint(key: string, kind: MarketRequestKind, source: MarketSource) {
    let value = this.endpoints.get(key);
    if (!value) {
      value = { key, kind, source, consecutiveFailures: 0, cooldownUntil: 0 };
      this.endpoints.set(key, value);
    }
    return value;
  }
  success(key: string, kind: MarketRequestKind, source: MarketSource, latencyMs: number) {
    const value = this.endpoint(key, kind, source), recovered = value.consecutiveFailures > 0;
    value.latencyEwmaMs = value.latencyEwmaMs === undefined ? latencyMs : value.latencyEwmaMs * .75 + latencyMs * .25;
    value.lastSuccessAt = this.now(); value.consecutiveFailures = 0; value.cooldownUntil = 0; value.lastErrorCode = undefined;
    if (recovered) this.log.append({ at: this.now(), kind, source, durationMs: Math.round(latencyMs), outcome: "recovery" });
  }
  failure(key: string, kind: MarketRequestKind, source: MarketSource, error: unknown, latencyMs: number) {
    const value = this.endpoint(key, kind, source), code = classifyMarketError(error);
    value.consecutiveFailures += 1; value.lastErrorCode = code;
    const text = error instanceof Error ? error.message : String(error);
    const retryAfter = Number(/retryAfterMs=(\d+)/.exec(text)?.[1] ?? 0);
    value.cooldownUntil = this.now() + Math.max(retryAfter, Math.min(300_000, 30_000 * 2 ** Math.min(value.consecutiveFailures - 1, 4)));
    this.log.append({ at: this.now(), kind, source, durationMs: Math.round(latencyMs), outcome: "failure", code });
    return code;
  }
  diagnostic(result: DiagnosticResult) {
    this.log.append({ at: this.now(), kind: "quote", source: result.source, durationMs: Math.round(result.latencyMs), outcome: "diagnostic", code: result.errorCode });
  }
  order<T extends { key: string; source: MarketSource }>(candidates: T[], adaptive: boolean): T[] {
    if (!adaptive) return candidates;
    return candidates.map((candidate, index) => ({ candidate, index, health: this.endpoints.get(candidate.key) }))
      .sort((a,b) => {
        const ah=a.health,bh=b.health, ac=(ah?.cooldownUntil ?? 0)>this.now(),bc=(bh?.cooldownUntil ?? 0)>this.now();
        const ap=Boolean(ah?.consecutiveFailures) && !ac, bp=Boolean(bh?.consecutiveFailures) && !bc;
        return Number(ac)-Number(bc) || Number(bp)-Number(ap) || (ah?.consecutiveFailures ?? 0)-(bh?.consecutiveFailures ?? 0)
          || (ah?.latencyEwmaMs ?? 2000)-(bh?.latencyEwmaMs ?? 2000) || a.index-b.index;
      }).map(item => item.candidate);
  }
  get(key: string) { return this.endpoints.get(key); }
  snapshot(): MarketHealthSnapshot {
    return { generatedAt: this.now(), endpoints: [...this.endpoints.values()].map(value => ({ ...value })).sort((a,b) => a.key.localeCompare(b.key)) };
  }
}

export function freshness(status: "preopen"|"auction"|"trading"|"break"|"closed", now: number, quoteAt: number, historyAt?: number) {
  const quoteAgeMs = Math.max(0, now - quoteAt), historyAgeMs = historyAt === undefined ? undefined : Math.max(0, now - historyAt);
  return { quoteAgeMs, historyAgeMs,
    quoteStale: status === "auction" ? quoteAgeMs > 10_000 : status === "trading" ? quoteAgeMs > 15_000 : false,
    historyStale: status === "trading" && historyAgeMs !== undefined ? historyAgeMs > 90_000 : false };
}
