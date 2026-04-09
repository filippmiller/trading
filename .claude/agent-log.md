# Agent Log

> **IMMUTABLE LOG POLICY:** No agent may delete, overwrite, or modify existing entries in this file. Only a human operator may authorize deletion or modification of existing content.

> **INSERTION ORDER: NEWEST ENTRY AT TOP.** All agents MUST insert new entries immediately below this header (after the `---` separator). The log is in strict reverse chronological order — newest entry is always first. NEVER append to the bottom.

Persistent log of all agent work in this repository.
Each entry tracks: timestamp, area, files changed, functions/symbols used, database tables affected, and a link to detailed session notes.

---

## [2026-04-09 07:10] — Unify VPS MySQL, Critic Review, Yahoo 60-Day Rewrite, Data Provider Research

**Area:** Trading/Surveillance, Trading/Infrastructure, Trading/Data
**Type:** feature + bugfix + research

### Files Changed
- `docker/init-db.sql` — Added 5 web app tables (prices_daily, strategy_runs, trades, run_metrics, app_settings)
- `scripts/tunnel-db.sh` — New: SSH tunnel for local dev → VPS MySQL
- `src/lib/surveillance.ts` — Critical trading-day loop fix, VALID_COLUMNS, MARKET_HOLIDAYS, LIMIT 500
- `src/app/api/surveillance/sync/route.ts` — SYNC_SECRET auth, consecutive_days in upsert
- `src/lib/migrations.ts` — UNIQUE KEY on surveillance_failures(entry_id, field_name)
- `scripts/surveillance-cron.ts` — MARKET_HOLIDAYS, Twelve Data integration, Yahoo 60-day rewrite with symbol caching, circuit breaker, orphan cleanup
- `scripts/deploy-surveillance.sh` — Removed hardcoded password, quoted $VPS
- `scripts/backfill-matrix.ts` — COALESCE to preserve live prices
- `docker/docker-compose.surveillance.yml` — TWELVEDATA_API_KEY env var, memory 256M→1G, CPU 0.5→1.0, NODE_OPTIONS heap size
- `.env.local` — Added TWELVEDATA_API_KEY, FINNHUB_API_KEY, FMP_API_KEY

### Functions/Symbols Modified
- `syncActiveSurveillance()` — Trading day loop fix (critical bug)
- `fetchMoversFromYahoo()` — Symbol validation, typing
- `enhanceWithTrend()` — Division-by-zero guard
- `fetchIntradayPrice()` in cron — Complete rewrite: cache-based, Yahoo 60-day primary
- `fetchYahoo60d()` — New: single fetch per symbol, window-filtered
- `fetchTwelveDataDay()` — New: fallback with circuit breaker
- `getSymbolBars()` — New: per-symbol cache accessor
- `lookupBar()` — New: instant in-memory lookup
- `isTradingDay()` — Added holiday check
- `jobSyncPrices()` — Orphan cleanup, circuit breaker reset, cache per sync run

### Database Tables
- `prices_daily`, `strategy_runs`, `trades`, `run_metrics`, `app_settings` — Created on VPS MySQL
- `reversal_entries` — 466 entries backfilled (1 month, S&P 500), then 380 marked COMPLETED, 86 remain ACTIVE
- `surveillance_failures` — UNIQUE KEY added, cleared for COMPLETED entries
- `surveillance_logs` — Multiple sync runs, orphan cleanup added

### Summary
Started by investigating the surveillance cron built April 7-8. Discovered the VPS cron and local web app used separate MySQL databases. Unified them (VPS as single source of truth), created SSH tunnel script, backfilled 1 month of S&P 500 data directly into VPS. Ran 5-agent critic review, found and fixed 12 issues (critical trading-day loop bug, SQL injection defense, input validation, schema alignment, auth guard, market holidays, LIMIT 500, deploy hardening). Deployed and verified with Playwright showing 226 active tickers in matrix.

Researched alternative intraday data providers to replace Yahoo. Signed up for 3 services: Twelve Data, Finnhub, FMP. Discovered that **only Twelve Data includes historical 5-min bars in its free tier** — Finnhub and FMP both stripped this from free tiers in 2024-2025. Integrated Twelve Data as fallback, but hit 800/day quota after one sync attempt (massive backlog from backfilled midday cells).

Then discovered Yahoo's unadvertised `?interval=5m&range=60d` endpoint returns **60 trading days of 5-min bars in a single call** (4,681 bars for AAPL). Rewrote fetchIntradayPrice with symbol-level caching: 1 Yahoo call per unique symbol per sync, then instant in-memory lookups for all d1-d10 cells. Added memory optimization (filter to target time windows only), bumped container memory 256M→1G with NODE_OPTIONS heap, and added a Twelve Data circuit breaker. Verified: sync completes in 4:25 for 86 active entries.

Also researched paper trading APIs. Earlier research falsely claimed Alpaca paper-only worked from Canada; verified directly by visiting signup form and confirmed **Canada is blocked at the country dropdown** (list includes Comoros, Congo, China, Cyprus, Chile, Colombia, Ecuador — but NOT Canada). The app already has paper trading built-in via `paper_trades` table and `/api/paper/route.ts` — decided to extend that rather than chase external APIs.

### Data Provider Research (documented here for future reference)

**Tested and confirmed working for historical 5-min bars on free tier:**

| Provider | Historical Intraday | Limit | Notes |
|----------|:-------------------:|:-----:|-------|
| **Yahoo Finance** (unofficial) | **60 trading days** | Rate-limited (no hard cap) | Best free source. Single call returns all 60 days. Use `?interval=5m&range=60d`. |
| **Twelve Data** | 1+ month | 800 credits/day | Second best. 1 credit per symbol per call. Resets at UTC midnight. Grow plan $66/mo = unlimited. |

**Tested and confirmed DOES NOT work for historical intraday on free tier (2026):**

| Provider | Signed Up? | Historical Intraday Free? | What IS Free |
|----------|:---:|:---:|---|
| **Finnhub** | Yes (key: `d7bmg59r01qo9pqu6pcgd7bmg59r01qo9pqu6pd0`) | No — `/stock/candle` returns `"You don't have access to this resource"` | Real-time quote only, 60 calls/min |
| **FMP** | Yes (key: `WPaPEeBQd8mMXe8d7rjnDzupF9wGWY61`) | No — `/stable/historical-chart/5min` returns "Restricted Endpoint" | Real-time quote + EOD daily, 250 calls/day |
| **Alpha Vantage** | No | No — `TIME_SERIES_INTRADAY` with `month=` is premium-only | 25 calls/day daily-only |
| **Polygon.io** | No | No — EOD aggregates only on Stocks Basic free | Confirmed by staff forum post |
| **EODHD** | No | No — EOD only free, intraday at $29.99/mo | — |
| **Marketstack** | No | No — sub-15min intervals require Professional $99/mo | — |
| **Tiingo** | No | IEX intraday with 2000-bar rolling window (~7 days) | Not useful for >1 week history |

**Paper trading APIs (Canada accessible, with or without KYC):**

| Service | Paper Trading | Canada OK | Signup Friction |
|---------|:---:|:---:|---|
| **Alpaca Paper-Only** | Yes, full API | **NO — Canada blocked at signup dropdown** (confirmed 2026-04-09) | N/A |
| **Tradier Sandbox** | Yes, 15-min delayed | Yes (dev sandbox) | Email only |
| **IBKR Paper** | Yes (US securities only from Canada) | Yes | Full KYC + fund live account first |
| **Moomoo OpenAPI** | Yes | Yes (Moomoo CA entity) | Mobile app + account |
| **TradeStation SIM** | Yes | Maybe via International | Full account |
| **Questrade API** | Practice account exists but API order execution blocked for retail | Yes | — |
| **Wealthsimple** | No official API | — | — |
| **Twelve Data / Finnhub / FMP / Yahoo** | **NO — all data-only providers, no order execution** | — | — |

**Key insight**: None of the data providers (Twelve Data, Finnhub, FMP, Yahoo) offer paper trading APIs. Paper trading requires a broker API. Alpaca was the obvious choice but Canada is blocked. The app already has built-in paper trading via `paper_trades` table and `/api/paper/route.ts` — extending that is the right path forward.

### Commits
- `4e230f1` — fix(surveillance): unify VPS MySQL as single source of truth
- `aff6c91` — fix: resolve 12 issues from 5-agent critic review
- `3a28222` — fix: resolve remaining review issues
- `2547526` — feat(cron): integrate Twelve Data as primary intraday source
- `3208de3` — feat(cron): Yahoo 60-day range as primary with symbol-level caching

### Session Notes
-> `.claude/sessions/2026-04-09-071000.md`

---

## [2026-04-07 17:21] — Full Pipeline: Yahoo Fallback, Matrix Tab, 3-Month Backfill, Strategy Analysis, Paper Trading

**Area:** Trading/Surveillance, Trading/Matrix, Trading/Analysis, Trading/PaperTrading
**Type:** feature

### Files Changed
- `src/lib/data.ts` — Yahoo Finance fallback in fetchDailyBars()
- `src/app/api/surveillance/sync/route.ts` — ensureSchema, removed streak filter, 10+10 enrollment
- `src/lib/reversal.ts` — Extended ReversalEntry d1-d3 → d1-d10 (30 fields)
- `src/app/api/reversal/route.ts` — API returns d4-d10 via loop
- `src/app/reversal/page.tsx` — Matrix tab: legend, dates, tooltips, prices+%, full-width, sorting by magnitude
- `scripts/backfill-matrix.ts` — New: S&P 500 backfill with configurable range (1mo/3mo)
- `src/app/api/paper/route.ts` — New: paper trading API with live Yahoo prices
- `src/app/paper/page.tsx` — New: paper trading UI with live P&L and sell button
- `src/components/AppShell.tsx` — Added Paper Trading to sidebar nav

### Functions/Symbols Modified
- `fetchDailyBars()` — modified (Yahoo fallback)
- `autoEnrollTrenders()` — modified (no filter, top 10 each)
- `ReversalEntry` — modified (d4-d10 added)
- `SurveillanceMatrix()` — rewritten (dates, legend, prices, sorting)
- `MatrixCell()` — rewritten (price + % + tooltip)
- `addBusinessDays()` — new
- `PaperTradingPage()` — new
- Paper API `GET()`/`POST()` — new

### Database Tables
- `reversal_entries` — 1,200 entries backfilled (3 months, 60 trading days, S&P 500)
- `paper_trades` — new table, 5 initial trades (AXTI, PAYP, FIGS, SEDG, SOC)

### Summary
Major session covering the full surveillance pipeline. Fixed Stooq blocking with Yahoo fallback. Built Matrix tab showing 10-day price follow-up for top daily movers with actual dollar prices, % change, dates, and tooltips. Backfilled 3 months of S&P 500 data (1,200 entries, 21,800 price points). Ran comprehensive strategy analysis — found one consistently profitable strategy: BUY >7% losers, hold 3 days (62% win rate, +1.9% avg return over 224 trades). Built paper trading page with live prices and sell button; recorded 5 initial trades. Extensive discussion with user about mean reversion vs momentum, martingale risks, and consecutive down-day distributions.

### Session Notes
-> `.claude/sessions/2026-04-07-172149.md`

---

## [2026-04-07 10:16] — Fix Surveillance Worker: Yahoo Finance Fallback for Stooq Block

**Area:** Trading/Surveillance, Trading/Data
**Type:** bugfix

### Files Changed
- `src/lib/data.ts` — Added Yahoo Finance chart API fallback in `fetchDailyBars()` when Stooq fails/blocks
- `src/app/api/surveillance/sync/route.ts` — Added missing `ensureSchema()` call

### Functions/Symbols Modified
- `fetchDailyBars()` — modified (Stooq-first with Yahoo fallback)
- `GET()` in sync route — modified (added ensureSchema)

### Database Tables
- `reversal_entries` — 2 new entries enrolled (PAYP, SEDG)
- `surveillance_logs` — 2 SUCCESS entries logged
- `prices_daily` — 20 AAPL rows from data refresh verification

### Summary
Verified the surveillance sync worker end-to-end. Discovered Stooq API blocks automated requests, silently breaking the trend analysis pipeline — movers were fetched from Yahoo but `enhanceWithTrend` failed on every Stooq call, leaving `consecutiveDays` undefined, and the `>= 2` filter removed all candidates. Added Yahoo Finance chart API as fallback in `fetchDailyBars()`. Also fixed missing `ensureSchema()` in the sync route. After fix: 10 gainers + 10 losers with trend data, 2 entries auto-enrolled.

### Session Notes
-> `.claude/sessions/2026-04-07-101608.md`

---

## [2026-04-02 07:40] — Critic Review: 15 Bug Fixes Across Trading Platform

**Area:** Trading/Core, Trading/Reversal, Trading/API
**Type:** bugfix

### Files Changed
- `src/lib/reversal.ts` — Fixed division-by-zero guard, improved daysHeld calculation to track actual exit measurement
- `src/lib/backtest.ts` — Fixed SAR flip cursor overwrite bug, removed dead code in resolveStopTake, exported calculateMAs and isSignalAllowedByRegime
- `src/lib/signals.ts` — Deduplicated calculateMAs and isSignalAllowedByRegime (now imported from backtest.ts)
- `src/lib/data.ts` — Parameterized LIMIT query, added CSV row validation (skip NaN/zero-close rows)
- `src/lib/migrations.ts` — Fixed SQL injection risk in ensureColumn (table/column whitelist), fixed TOCTOU race condition
- `src/app/api/reversal/movers/route.ts` — Added "most active" stocks fetch, switched to Promise.allSettled for partial failure resilience
- `src/app/api/reversal/route.ts` — Added input validation: date format, direction allowlist, positive price check
- `src/app/api/reversal/[id]/route.ts` — Added status allowlist validation, negative price guard, removed unused MeasurementField import
- `src/app/reversal/page.tsx` — Fixed 3 ESLint unescaped entity errors, removed unused MEASUREMENT_LABELS import
- `src/components/BacktestCritique.tsx` — Fixed ESLint unescaped entity error
- `src/app/signals/page.tsx` — Fixed ESLint unescaped entity error
- `src/components/StrategyChat.tsx` — Fixed ESLint unescaped entity error

### Functions/Symbols Modified
- `calculateEntryPnL()` — modified (division-by-zero guard, daysHeld fix)
- `calculateMAs()` — exported from backtest.ts, removed duplicate from signals.ts
- `isSignalAllowedByRegime()` — exported from backtest.ts, removed duplicate from signals.ts
- `resolveStopTake()` — modified (removed dead code branch, added comment)
- `runBacktest()` — modified (SAR flip cursor fix)
- `ensureColumn()` — modified (whitelist validation, TOCTOU race fix)
- `parseCsv()` — modified (row validation)
- `loadPrices()` — modified (parameterized LIMIT)
- `fetchMovers()` — modified (accepts "most_actives" type)
- `GET /api/reversal/movers` — modified (3rd category, Promise.allSettled)

### Database Tables
- N/A (no schema changes, fixes were in application logic)

### Summary
Ran a comprehensive 5-agent parallel critic review on the trading platform. Found 43 issues (3 critical, 16 high, 14 medium, 10 low). Fixed 15 of the most impactful: division-by-zero in P&L calc, SAR flip cursor overwrite causing re-processed bars, SQL injection risk in ensureColumn, missing "most active" stocks category, CSV parser accepting malformed data, and 14 ESLint build-blocking errors. Identified 3 structural gaps that need design decisions: fully manual data collection (no automated price fetcher), entry price captured at click-time instead of market close, and regime filter logic inverted for fade strategies.

### Session Notes
-> `.claude/sessions/2026-04-02-074017.md`

---
