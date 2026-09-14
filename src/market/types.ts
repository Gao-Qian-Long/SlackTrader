export type MarketStatus = "preopen" | "auction" | "trading" | "break" | "closed";
export type MarketSource = "tencent" | "sina" | "eastmoney" | "ths";
export type MarketRequestKind = "quote" | "minute" | "daily";
export type MarketErrorCode = "timeout" | "connection" | "rate_limit" | "invalid_response" | "stale";

export interface SourceHealth {
  key: string;
  kind: MarketRequestKind;
  source: MarketSource;
  lastSuccessAt?: number;
  consecutiveFailures: number;
  latencyEwmaMs?: number;
  cooldownUntil: number;
  lastErrorCode?: MarketErrorCode;
}

export interface MarketHealthSnapshot { generatedAt: number; endpoints: SourceHealth[] }
export interface SourceSwitch { from: MarketSource; to: MarketSource; at: number; reason: "failure" | "health" }
export interface DiagnosticResult { source: MarketSource; ok: boolean; latencyMs: number; errorCode?: MarketErrorCode }

export interface Stock {
  symbol: string;
  name: string;
  previousClose: number;
  seed: number;
  kind?: "stock" | "index" | "sector";
  /** 行情源原生代码；同花顺 881129 使用 bk_881129，升级时迁移旧映射。 */
  dataSymbol?: string;
  quantity?: number;
  costPrice?: number;
}

export interface IntradayPoint {
  time: number;
  price: number;
  average?: number;
  /** Volume in this minute (shares); adapters convert cumulative feeds first. */
  volume: number;
}

/** A real quote sample received during the 09:15-09:25 opening auction. */
export interface AuctionPoint extends IntradayPoint {
  /** Cumulative auction-period volume reported by the quote source. */
  reportedVolume: number;
}

export interface DailyCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface QuoteSnapshot {
  stock: Stock;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  status: MarketStatus;
  timestamp: number;
  orderBook?: OrderBook;
}

export interface BookLevel { level: number; price: number; shares: number }
export interface OrderBook { bids: BookLevel[]; asks: BookLevel[] }
export interface RelatedSector { code: string; name: string }
export interface SectorSeries { sector: RelatedSector; previousClose: number; history: IntradayPoint[]; source: string }
export interface TradeDetail { time: string; price: number; shares: number; side: "buy" | "sell" | "neutral" }
export interface TradePage { trades: TradeDetail[]; source: string; receivedAt: number }

export interface QuoteUpdate {
  quoteSource?: string;
  quoteError?: string;
  historySource?: string;
  historyMessage?: string;
  snapshot: QuoteSnapshot;
  point: IntradayPoint;
  history: IntradayPoint[];
  auction?: AuctionPoint[];
  auctionMessage?: string;
  health?: MarketHealthSnapshot;
  quoteAgeMs?: number;
  historyAgeMs?: number;
  sourceSwitched?: SourceSwitch;
}

export interface MarketProvider {
  connect(stock: Stock, onUpdate: (update: QuoteUpdate) => void, onError?: (message: string) => void): () => void;
  getDailyCandles(stock: Stock): Promise<DailyCandle[]>;
  getHealthSnapshot(): MarketHealthSnapshot;
  diagnoseCurrentStock(stock: Stock): Promise<DiagnosticResult[]>;
}
