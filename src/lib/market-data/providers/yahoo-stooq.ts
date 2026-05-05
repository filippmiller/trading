import { fetchDailyBars as fetchExistingDailyBars } from "@/lib/data";
import { normalizeSymbol } from "@/lib/symbols";
import type { DailyBar, DailyBarRequest, MarketDataProvider } from "@/lib/market-data/types";

export const yahooStooqProvider: MarketDataProvider = {
  name: "yahoo_stooq",
  capabilities: {
    supportsUniverse: false,
    supportsDailyBars: true,
    supportsIntradayBars: false,
    supportsSnapshots: false,
    supportsMovers: false,
    requiresApiKey: false,
    notes: [
      "Uses the existing Stooq daily CSV fetch with Yahoo chart fallback.",
      "Research fallback only; not the long-term source of truth for intraday production data.",
    ],
  },
  async fetchDailyBars(request: DailyBarRequest): Promise<DailyBar[]> {
    const symbol = normalizeSymbol(request.symbol);
    const rows = await fetchExistingDailyBars(symbol);
    return rows.map((row) => ({
      symbol,
      ts: `${row.date}T00:00:00.000Z`,
      timeframe: "1d",
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      provider: "yahoo_stooq",
    }));
  },
};
