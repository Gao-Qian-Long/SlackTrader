export type MarketStatus = "preopen" | "trading" | "break" | "closed";

export interface Stock {
  symbol: string;
  name: string;
  previousClose: number;
  seed: number;
  kind?: "stock" | "index" | "sector";
  /** 行情源使用的代码；例如同花顺 881129 对应东方财富 90.BK0448。 */
  dataSymbol?: string;
  quantity?: number;
  costPrice?: number;
}

export interface IntradayPoint {
  time: number;
  price: number;
  average: number;
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
}

export interface QuoteUpdate {
  snapshot: QuoteSnapshot;
  point: IntradayPoint;
  history: IntradayPoint[];
}

export interface MarketProvider {
  connect(stock: Stock, onUpdate: (update: QuoteUpdate) => void, onError?: (message: string) => void): () => void;
  getDailyCandles(stock: Stock): Promise<DailyCandle[]>;
}
