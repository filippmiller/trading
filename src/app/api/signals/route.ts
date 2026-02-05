import { NextResponse } from "next/server";

import { loadPrices } from "@/lib/data";
import { checkSignalToday, Signal } from "@/lib/signals";
import { scenarios } from "@/lib/scenarios";
import { getAvailableSymbols } from "@/lib/data";

export type SignalResult = {
  scenarioName: string;
  symbol: string;
  signal: Signal;
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbolParam = searchParams.get("symbol");

  try {
    // Get symbols to scan
    let symbols: string[];
    if (symbolParam) {
      symbols = [symbolParam];
    } else {
      symbols = await getAvailableSymbols();
    }

    if (!symbols.length) {
      return NextResponse.json({ signals: [], message: "No symbols available" });
    }

    const results: SignalResult[] = [];
    const lookbackDays = 30; // Need enough bars to detect streaks

    for (const symbol of symbols) {
      // Load recent price data
      let prices;
      try {
        prices = await loadPrices(lookbackDays, symbol);
      } catch {
        continue; // Skip if no data
      }

      if (prices.length < 10) continue;

      // Check each scenario
      for (const scenario of scenarios) {
        try {
          const spec = scenario.buildSpec(scenario.defaultValues, lookbackDays, symbol);
          const signal = checkSignalToday(prices, spec);

          if (signal) {
            results.push({
              scenarioName: scenario.name,
              symbol,
              signal,
            });
          }
        } catch {
          // Skip invalid scenario configurations
        }
      }
    }

    return NextResponse.json({
      signals: results,
      scannedSymbols: symbols.length,
      scannedScenarios: scenarios.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("signals scan error", error);
    return NextResponse.json({ error: "Signal scan failed." }, { status: 500 });
  }
}
