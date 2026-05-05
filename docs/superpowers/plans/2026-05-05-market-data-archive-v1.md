# Market Data Archive v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first durable archive layer for SP500/NASDAQ/MOVERS research without breaking the existing Yahoo MOVERS/TREND worker.

**Architecture:** Add provider interfaces and a Yahoo/Stooq-backed default adapter, then persist universe rows and OHLCV bars in new market archive tables. Keep research reports as scripts for now, but move repeated-list and price-streak logic into testable helpers so reports stop being one-off shell artifacts.

**Tech Stack:** Next.js/TypeScript, mysql2, existing `ensureSchema()` migration style, Vitest, Node `tsx` scripts.

---

### Task 1: Beads And Planning

**Files:**
- Created beads epic `trading-agx`
- Create: `docs/superpowers/plans/2026-05-05-market-data-archive-v1.md`

- [x] **Step 1: Create beads**

Created:
- `trading-agx` Market Data Archive v1
- `trading-agx.1` provider abstraction
- `trading-agx.2` schema migrations
- `trading-agx.3` universe/bar sync scripts
- `trading-agx.4` research reports
- `trading-agx.5` tests/docs

### Task 2: Market Data Provider Core

**Files:**
- Create: `src/lib/market-data/types.ts`
- Create: `src/lib/market-data/providers/errors.ts`
- Create: `src/lib/market-data/providers/yahoo-stooq.ts`
- Create: `src/lib/market-data/providers/stubs.ts`
- Create: `src/lib/market-data/index.ts`
- Modify: `.env.example`

- [ ] **Step 1: Define provider-neutral types**
- [ ] **Step 2: Wrap existing Stooq/Yahoo daily-bar fetcher**
- [ ] **Step 3: Add configured-but-not-failing provider stubs for Polygon, Alpaca, FMP, TwelveData**
- [ ] **Step 4: Export providers from one index**
- [ ] **Step 5: Add env placeholders**

### Task 3: Market Archive Schema

**Files:**
- Modify: `src/lib/migrations.ts`

- [ ] **Step 1: Add `market_universe` table**
- [ ] **Step 2: Add `market_bars` table**
- [ ] **Step 3: Add `market_data_runs` table**
- [ ] **Step 4: Add `market_streak_signals` table**
- [ ] **Step 5: Keep migration idempotent via `CREATE TABLE IF NOT EXISTS` and indexes in table DDL**

### Task 4: Testable Research Helpers And Scripts

**Files:**
- Create: `src/lib/market-data/research.ts`
- Create: `src/lib/market-data/research.test.ts`
- Create: `scripts/sync-market-universe.ts`
- Create: `scripts/sync-market-bars.ts`
- Modify: `scripts/analyze-repeated-top-list-tickers.ts`

- [ ] **Step 1: Extract repeated top-list detection into pure helper**
- [ ] **Step 2: Extract price-streak detection into pure helper**
- [ ] **Step 3: Add PnL/path helpers with long/short direction**
- [ ] **Step 4: Add universe sync script for SP500/NASDAQ seed sources and MOVERS-derived symbols**
- [ ] **Step 5: Add bar sync script using default provider**
- [ ] **Step 6: Keep existing reports working and update wording away from “signals” where it means tickers/candidates**

### Task 5: Documentation And Verification

**Files:**
- Create: `docs/market-data-archive-v1.md`
- Modify: `.claude/agent-log.md`

- [ ] **Step 1: Document schema, scripts, provider env vars, and limits**
- [ ] **Step 2: Add agent-log entry newest-at-top**
- [ ] **Step 3: Run `npx tsc --noEmit`**
- [ ] **Step 4: Run focused tests**
- [ ] **Step 5: Report honest verification status**

---

**Self-review:** This v1 intentionally excludes live trading and avoids a UI redesign. Hourly capture as a long-running worker job is deferred until the archive tables and sync scripts are verified locally.
