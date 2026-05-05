# Market Data Archive v1

## Purpose

Market Data Archive v1 separates durable market data collection from the existing `reversal_entries` event matrix. The goal is to preserve both stable universes such as S&P 500/NASDAQ and high-volatility MOVERS so research can compare behavior by segment instead of mixing all tickers into one sample.

## Current Scope

- Working provider: `yahoo_stooq`
  - Uses the existing Stooq daily CSV fetch with Yahoo fallback.
  - Suitable for research bootstrap, not a long-term intraday source of truth.
- Provider hooks:
  - `POLYGON_API_KEY`
  - `ALPACA_API_KEY`
  - `ALPACA_SECRET_KEY`
  - `ALPACA_DATA_FEED`
  - `FMP_API_KEY`
  - `TWELVE_DATA_API_KEY`
- New archive tables:
  - `market_universe`
  - `market_bars`
  - `market_data_runs`
  - `market_streak_signals`

## Scripts

### Sync Universe

```bash
npx tsx scripts/sync-market-universe.ts
```

Seeds:

- `NASDAQ` or `CUSTOM` rows from `tradable_symbols`
- `MOVERS` rows from distinct `reversal_entries` symbols with `enrollment_source='MOVERS'`
- optional `SP500` rows from `scripts/market-universe-sp500-seed.csv` when present

Expected output:

```text
[market-universe] upserted N rows across M symbols
```

### Sync Daily Bars

```bash
npx tsx scripts/sync-market-bars.ts --source=MOVERS --limit=25
```

Writes daily OHLCV rows into `market_bars` using `provider='yahoo_stooq'` and `timeframe='1d'`.

## Research Helpers

Pure helpers live in `src/lib/market-data/research.ts`:

- `detectPriceStreak`
- `detectRepeatedTopListCandidates`
- `computeTradePnlPct`
- `computePnlPath`
- `firstReversalLabel`

These helpers distinguish two separate hypotheses:

- Price streak: a ticker closed up/down for consecutive trading closes.
- Repeated top list: a ticker appeared in our own top gainers/top losers list on consecutive cohort dates.

## Operational Notes

- This v1 does not enable live trading.
- Hourly collection for all NASDAQ symbols is intentionally not started until a paid intraday provider is selected.
- `market_bars` can store `1h`, `5m`, and `1m`, but the active bootstrap script only writes `1d`.
- `reversal_entries` remains unchanged and continues powering the existing matrix and paper strategy flow.

## Verification

Recommended local checks:

```bash
npx tsc --noEmit
npm test -- src/lib/market-data/research.test.ts
npx tsx scripts/sync-market-universe.ts
npx tsx scripts/sync-market-bars.ts --source=MOVERS --limit=3
```
