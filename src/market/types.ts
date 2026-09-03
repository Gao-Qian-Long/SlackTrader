export type MarketStatus = "preopen" | "trading" | "break" | "closed";

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
}

export interface MarketProvider {
  connect(stock: Stock, onUpdate: (update: QuoteUpdate) => void, onError?: (message: string) => void): () => void;
  getDailyCandles(stock: Stock): Promise<DailyCandle[]>;
}
