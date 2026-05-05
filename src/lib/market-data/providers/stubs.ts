import { ProviderNotConfiguredError } from "@/lib/market-data/providers/errors";
import type { MarketDataProvider, MarketDataProviderName } from "@/lib/market-data/types";

function configuredProvider(
  name: MarketDataProviderName,
  envVars: string[],
  notes: string[],
): MarketDataProvider {
  const isConfigured = envVars.every((envVar) => Boolean(process.env[envVar]));
  const unavailable = async () => {
    throw new ProviderNotConfiguredError(name, envVars);
  };

  return {
    name,
    capabilities: {
      supportsUniverse: name === "polygon" || name === "alpaca" || name === "fmp",
      supportsDailyBars: true,
      supportsIntradayBars: name !== "fmp",
      supportsSnapshots: name !== "fmp",
      supportsMovers: name === "twelve_data",
      requiresApiKey: true,
      notes: isConfigured ? notes : [`Not configured. ${notes.join(" ")}`],
    },
    fetchDailyBars: unavailable,
    fetchIntradayBars: unavailable,
    fetchUniverse: unavailable,
    fetchMovers: unavailable,
    fetchSnapshots: unavailable,
  };
}

export const polygonProvider = configuredProvider("polygon", ["POLYGON_API_KEY"], [
  "Scaffold for Polygon/Massive aggregates and ticker reference APIs.",
]);

export const alpacaProvider = configuredProvider(
  "alpaca",
  ["ALPACA_API_KEY", "ALPACA_SECRET_KEY"],
  ["Scaffold for Alpaca market data and later broker/paper integration."],
);

export const fmpProvider = configuredProvider("fmp", ["FMP_API_KEY"], [
  "Scaffold for Financial Modeling Prep company profile, screener, and fundamentals metadata.",
]);

export const twelveDataProvider = configuredProvider("twelve_data", ["TWELVE_DATA_API_KEY"], [
  "Scaffold for Twelve Data market movers and time series APIs.",
]);
