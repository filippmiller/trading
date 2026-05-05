export type MarketDataProviderName =
  | "yahoo_stooq"
  | "polygon"
  | "alpaca"
  | "fmp"
  | "twelve_data";

export type MarketTimeframe = "1m" | "5m" | "1h" | "1d";

export type MarketSession = "PRE" | "RTH" | "POST" | "CLOSED" | "UNKNOWN";

export type UniverseSource =
  | "SP500"
  | "NASDAQ"
  | "NASDAQ100"
  | "MOVERS"
  | "REPEATED_MOVERS"
  | "CUSTOM";

export type UniverseSymbol = {
  symbol: string;
  name?: string | null;
  exchange?: string | null;
  assetType: "EQUITY" | "ETF" | "ADR" | "UNKNOWN";
  active: boolean;
  source: UniverseSource | string;
  cik?: string | null;
  raw?: unknown;
};

export type MarketBar = {
  symbol: string;
  ts: string;
  timeframe: MarketTimeframe;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  provider: MarketDataProviderName | string;
};

export type DailyBar = Omit<MarketBar, "timeframe"> & {
  timeframe: "1d";
};

export type IntradayBar = Omit<MarketBar, "timeframe"> & {
  timeframe: Exclude<MarketTimeframe, "1d">;
};

export type MarketMover = {
  symbol: string;
  name?: string | null;
  price: number;
  dayChangePct: number;
  volume?: number | null;
  rank?: number | null;
  direction: "GAINER" | "LOSER" | "VOLUME" | "GAP_UP" | "GAP_DOWN";
  raw?: unknown;
};

export type MarketSnapshot = {
  symbol: string;
  capturedAt: string;
  provider: MarketDataProviderName | string;
  marketSession: MarketSession;
  price: number;
  prevClose?: number | null;
  dayChangePct?: number | null;
  volume?: number | null;
  relativeVolume?: number | null;
  marketCap?: number | null;
  raw?: unknown;
};

export type ProviderCapabilities = {
  supportsUniverse: boolean;
  supportsDailyBars: boolean;
  supportsIntradayBars: boolean;
  supportsSnapshots: boolean;
  supportsMovers: boolean;
  requiresApiKey: boolean;
  notes: string[];
};

export type DailyBarRequest = {
  symbol: string;
  range?: "1mo" | "3mo" | "6mo" | "1y" | "2y" | "5y" | "max";
};

export type IntradayBarRequest = {
  symbol: string;
  timeframe: Exclude<MarketTimeframe, "1d">;
  range?: "1d" | "5d" | "1mo" | "3mo";
};

export type MarketDataProvider = {
  name: MarketDataProviderName | string;
  capabilities: ProviderCapabilities;
  fetchDailyBars?(request: DailyBarRequest): Promise<DailyBar[]>;
  fetchIntradayBars?(request: IntradayBarRequest): Promise<IntradayBar[]>;
  fetchUniverse?(source: UniverseSource): Promise<UniverseSymbol[]>;
  fetchMovers?(direction: MarketMover["direction"], limit?: number): Promise<MarketMover[]>;
  fetchSnapshots?(symbols: string[]): Promise<MarketSnapshot[]>;
};

export type TickerUniverseProvider = Pick<MarketDataProvider, "name" | "capabilities" | "fetchUniverse">;
