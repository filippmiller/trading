# Agent Log

> **IMMUTABLE LOG POLICY:** No agent may delete, overwrite, or modify existing entries in this file. Only a human operator may authorize deletion or modification of existing content.

> **INSERTION ORDER: NEWEST ENTRY AT TOP.** All agents MUST insert new entries immediately below this header (after the `---` separator). The log is in strict reverse chronological order — newest entry is always first. NEVER append to the bottom.

Persistent log of all agent work in this repository.
Each entry tracks: timestamp, area, files changed, functions/symbols used, database tables affected, and a link to detailed session notes.

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
