# Agent Log

> **IMMUTABLE LOG POLICY:** No agent may delete, overwrite, or modify existing entries in this file. Only a human operator may authorize deletion or modification of existing content.

> **INSERTION ORDER: NEWEST ENTRY AT TOP.** All agents MUST insert new entries immediately below this header (after the `---` separator). The log is in strict reverse chronological order — newest entry is always first. NEVER append to the bottom.

Persistent log of all agent work in this repository.
Each entry tracks: timestamp, area, files changed, functions/symbols used, database tables affected, and a link to detailed session notes.

---

## [2026-04-21 11:40] — Railway production deploy + auth retrospective log + prod smoke

**Area:** Trading/Ops, Trading/Auth, Trading/Infra, Trading/Verification
**Type:** docs (retroactive) + verification
**Commit documented:** `fe6bccc` (feat: add Railway production deploy and app auth, 2026-04-21 07:17 UTC+3)
**Prod URL:** https://trading-production-06fe.up.railway.app

### Why this retroactive entry
`fe6bccc` shipped the Railway production infrastructure but did not include an agent-log entry. The subsequent data-restore entry (`f9f343a` / PR #10) documents the VPS → Railway data move but not the underlying deploy. This entry closes that gap and records the end-to-end prod verification done today via Playwright.

### What `fe6bccc` introduced
- `Dockerfile` (multi-stage Next.js standalone) + `Dockerfile.worker` (tsx-runtime scheduler)
- `docker/init-db.sql` — bootstrap schema for Railway MySQL first-start
- `middleware.ts` — session-cookie auth gate; public paths: `/login`, `/api/auth/login|logout`, `/api/healthz`; everything else redirects to `/login?next=…`
- `src/app/login/*` + `src/app/api/auth/{login,logout,me}/route.ts` + `src/lib/auth/{constants,password,server,session}.ts` — admin-only login backed by `SESSION_SECRET`
- `src/lib/bootstrap.ts` + `src/lib/migrations.ts` — first-boot admin provisioning from `ADMIN_EMAIL` / `ADMIN_PASSWORD` env
- `src/app/api/healthz/route.ts` — `{ ok: true, service: "web" }`
- `scripts/surveillance-cron.ts` — updated to accept Railway-style `MYSQL*` envs in addition to `MYSQL_*`
- `docs/RAILWAY.md` — 3-service deploy plan (`web` + `worker` + `MySQL`)

### Railway topology (confirmed today)
| Service | Railway name | Latest deploy | Status |
|---|---|---|---|
| Web (Next.js) | `trading` | 2026-04-21T04:19Z | SUCCESS |
| Scheduler | `worker` | 2026-04-21T04:19Z | SUCCESS |
| Database | `MySQL` | 2026-02-04T15:07Z | SUCCESS |

Note: docs in `docs/RAILWAY.md` call the web service `web`, but the actual Railway service name is `trading`. Not worth renaming — just documenting the drift here.

### Verification (prod smoke via Playwright, 2026-04-21)
Added `scripts/prod-smoke.mjs` — logs in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` and walks the seven user-facing routes, capturing screenshots and console errors.

| Route | HTTP | Rendered heading | Console errs |
|---|---:|---|---:|
| `/api/healthz` | 200 | `{"ok":true,"service":"web"}` | — |
| `/` (dashboard) | 200 | "Mean reversion research, automation, and paper execution" | 1 ⚠ |
| `/reversal` | 200 | "Surveillance Command" — 491 tickers, $70.72 P&L, 46.5% WR | 0 |
| `/research` | 200 | "Strategy Research" | 0 |
| `/paper` | 200 | "Paper Trading Simulator" | 0 |
| `/markets` | 200 | "Markets" | 0 |
| `/strategies` | 200 | "Strategy Dashboard" | 0 |
| `/settings` | 200 | (sidebar-only layout) | 0 |

Matrix tab on `/reversal`: 1 table, 922 rows, "All 891 / Gainers 553 / Losers 338" — row counts match the post-restore target (`reversal_entries=891`) exactly. 2026-04-20 cohort renders 134 tickers. Full D1–D10 morning/midday/close column grid intact.

### Known issue surfaced by the smoke
`/` dashboard logs one console error: `Dashboard stats error: TypeError: Failed to fetch` (client-side fetch in a SSR-hydrated dashboard widget). Page still renders; not a blocker for this verification, but a follow-up candidate. Not introduced by `fe6bccc` — likely pre-existing behavior now visible because the dashboard is in a logged-in production context for the first time.

### Files Changed (this entry)
- `.claude/agent-log.md` — this entry
- `scripts/prod-smoke.mjs` — new; reusable Playwright smoke against any SMOKE_BASE

### Database Tables
- Read-only via the app — no schema or data changes in this pass.

---

## [2026-04-21 09:18] — Railway data restore from VPS (matrix recovery)

**Area:** Trading/Ops, Trading/Data, Trading/Docs
**Type:** data recovery + docs
**Branch:** `ops/railway-data-restore`
**Commit:** `f9f343a`
**PR:** [#10](https://github.com/filippmiller/trading/pull/10)
**Session notes:** [2026-04-21-091800-railway-data-restore.md](sessions/2026-04-21-091800-railway-data-restore.md)

### Files Changed
- `scripts/railway-restore-prelude.sql` — new, FK-safe TRUNCATE prelude for 8 VPS-owned tables before mysqldump load
- `.claude/deploy-instructions.md` — full restore playbook, two-DB topology, verification queries
- `CLAUDE.md` — session-start report updated to reflect Railway production deploy target
- `.claude/agent-log.md` — this entry
- `.claude/sessions/2026-04-21-091800-railway-data-restore.md` — detailed session notes

### Functions/Symbols Modified
- N/A — no application code touched. Ops-only change (SQL + docs).

### Database Tables Affected (Railway production MySQL)
Restored from VPS (TRUNCATE + INSERT preserving PKs for FK integrity):
- `reversal_entries` 134 → **891**
- `paper_signals` 63 → **3,023**
- `paper_position_prices` 0 → **18,283**
- `paper_trades` 0 → **3**
- `paper_orders` 0 → **7**
- `surveillance_logs` 9 → **69**
- `surveillance_failures` 0 → **192**
- `paper_strategies` 32 → **32** (synced `enabled` flags from VPS)

Preserved on Railway (not touched):
- `prices_daily` (9,374 rows, 1989-2026 seed history)
- `strategy_runs` / `trades` / `run_metrics` (5 / 65 / 5 research runs)
- `app_users` (admin), `app_settings`, `paper_accounts`

### Summary
Root cause: the 2026-04-20/21 Railway deploy bootstrapped the production DB empty and did not migrate the VPS-side accumulating dataset. User reported the "matrix of tickers with prices" had disappeared. Verified both DBs were reachable (VPS via SSH + local tunnel on 3319, Railway via public TCP proxy), row-counted every table on both sides, confirmed `paper_strategies` IDs matched 1:1 (no FK remap needed), confirmed VPS's 2026-04-20 symbol set was identical to Railway's (zero today-only Railway enrollments would be lost by overwrite). Executed a surgical restore: 8 VPS-owned tables TRUNCATEd + reloaded from `mysqldump --no-create-info`, 4 Railway-owned tables left alone. Post-restore row counts match plan exactly; FK integrity clean.

### Verification
- Row counts on Railway match VPS dump exactly for all 8 restored tables
- FK integrity clean: `paper_position_prices` → `paper_signals` (0 orphans), `surveillance_failures` → `reversal_entries` (0 orphans), `paper_signals.strategy_id` → `paper_strategies.id` (0 orphans)
- The 69 `paper_signals.reversal_entry_id` orphans on Railway post-restore are pre-existing on VPS (verified same count on source); that column has no actual FK constraint defined, only an index
- Matrix date range on Railway now spans 2026-03-10 → 2026-04-20 (29 trading days, 486 unique symbols, D1-D10 captures intact)

### Gotchas
- Docker Desktop for Windows has broken internal DNS for Railway proxy hostnames. Workaround in playbook: resolve host on laptop via `nslookup switchback.proxy.rlwy.net 8.8.8.8`, pass the IP to `docker run ... mysql -h <ip>`.
- Railway DB is called `railway` not `trading`. Use `mysqldump --no-create-info --tables <list>` (not `--databases`) to produce a DB-neutral dump.
- Worker service is stateless over DB content, so no worker restart was required after the restore.

---

## [2026-04-20 11:15] — Recovery, docs refresh, PR #8 merge, merged-state verification

**Area:** Trading/Ops, Trading/Docs, Trading/Git, Trading/Verification
**Type:** maintenance + merge + docs

### Files Changed
- `.claude/agent-log.md` — added this entry
- `.claude/deploy-instructions.md` — rewritten to reflect tunnel-based local operation and current verification workflow
- `docs/FEATURES.md` — rewritten from obsolete voice-simulator framing to current trading research platform
- `.claude/sessions/2026-04-20-111500.md` — new session record

### Functions/Symbols Modified
- N/A — no application code changed in this pass beyond merging the already-reviewed PR #8 branch into `master`

### Database Tables
- None

### Summary
Picked up from a crashed session after Grid Sweep had already been merged into remote `master`. Reconstructed state from the screenshot plus `.claude` session notes, restored the SSH DB tunnel, and verified merged `master` by hitting `/research` and `/api/research/grid`. Then rebased `fix/tab-audit-critical-cleanup` onto current `master`, force-pushed the rebased branch, created a clean integration worktree, and merged PR #8 into `master`.

Also refreshed the two stale docs that were materially out of date:
- deployment notes were still pinned to 2026-04-09 and did not mention the SSH tunnel or Grid Sweep verification path
- feature documentation still described the product as a voice strategy simulator instead of the current multi-page trading research + paper execution app

### Verification
- confirmed `origin/master` already contained Grid Sweep merge (`f6e3cd7`)
- restored tunnel on local `3319`
- verified `/research` returned `200`
- verified `/api/research/grid` returned valid JSON once DB connectivity was restored
- rebased PR #8 with one expected conflict in `.claude/agent-log.md` only
- post-merge build verification remains subject to Google Fonts reachability during `next build`

### Commits
- `f6e3cd7` — existing Grid Sweep merge on `master`
- `0fb0c20` — rebased `fix/tab-audit-critical-cleanup`
- integration `master` now includes PR #8 merge after this pass

### Session Notes
- `.claude/sessions/2026-04-20-111500.md`

## [2026-04-19 14:00] — Grid Sweep: multi-dimensional strategy search on /research

**Area:** Trading/Research, Trading/UI, Trading/API
**Type:** feat (strategy research primitive)

### Files Changed
- `src/lib/scenario-simulator.ts` — `ExitStrategy` gains `exitBar` + `breakevenAtPct`; `TradeParams` gains `entryDelayDays` + `entryBar`; `evaluateExitWalk` now walks all 3 bars/day (30 ticks over 10 days) with a `startDay` param for entry-delay support; new `runGridSweep` expands axis cross-product in-memory against a single DB load
- `src/app/api/research/grid/route.ts` — **new** POST endpoint with 10,000-combo hard cap
- `src/components/GridSweepSection.tsx` — **new** self-contained UI (5 presets, advanced axis editor, sortable top-25 results table)
- `src/app/research/page.tsx` — integrates `<GridSweepSection />` above the existing 1-D Parameter Sweep
- `scripts/analyze-delayed-entry.ts`, `analyze-momentum-carry.ts`, `analyze-strategy-grid.ts` — **new** CLI probes that surfaced the hypotheses the UI now automates

### Database Tables
- `reversal_entries` — read-only usage; selects all 30 bar columns (d1..d10 × morning/midday/close) instead of the previous 10 close columns

### Summary
Pre-existing `/research` page could run ONE scenario at a time, so finding the winning config across hold-days × exit-time × entry-delay × hard-stop × take-profit × trailing-stop × breakeven meant hours of manual scenario edits. The Grid Sweep primitive collapses that to one button click:

- User picks a preset (or edits axis values manually).
- Endpoint loads matching rows once, replays each combo in-memory.
- Returns top-25 configs sorted by the chosen metric.

Smoke numbers on 271-entry MOVERS gainers sample: 48-combo sweep runs in 1.4s. Top config — `hold=5d · exit=morning · trail=15%` — delivers **64% WR / +$5,687 / +21% avg per trade** at 5× leverage, vs the previous "hold 10 days close-exit" baseline of +$70 total.

Engineering choices:
- **In-memory replay over separate SQL queries** — one SELECT hydrates ~400 rows with all 30 bar columns (~100KB), each combo's simulation is pure arithmetic → ~30ms/combo regardless of DB state.
- **`startDay` param on `evaluateExitWalk`** — threads the entry-delay state through without duplicating the walk logic.
- **Hard 10k-combo cap** — prevents UI/server from combinatorial explosion (e.g. full 8-axis cross-product of 5 values each = 390k).
- **Breakeven arm as a first-class exit** — common real-world stop that wasn't expressible with hard_stop+trail alone.

### Verification
- `npx tsc --noEmit`: clean
- Backend smoke: `curl POST /api/research/grid` with 48 combos returns 200 in 1.4s
- UI smoke: Basic-hold-×-exit preset click → top-12 table renders with emerald highlight on winner
- Manual test of all 5 presets: each returns valid sorted output

### Commits
- (pending merge) — `feat/grid-sweep-strategy-search` branch, PR #9

### Open follow-ups (deliberately deferred)
- **Apply-to-form from grid row** — click a result row → populate main scenario form for drill-down with full trade list
- **Concentration filter** — cap max N occurrences of a single ticker (XNDU appeared 4× in top results, skewing stats)
- **ATR-based stops** — requires per-symbol volatility column
- **Regime filter** — requires SPY/VIX daily join (enable "skip trading when SPY red"-type filters)
- **Pair trades** (LONG top-5 + SHORT bottom-5) — structural second leg, not a simple axis
- **Vol-adjusted sizing** — needs historical vol per symbol

## [2026-04-19 07:00] — Full tab audit + 11 fixes (header lies, silent failures, stale KPIs, HTML nesting)

**Area:** Trading/UI (all 11 tabs), Trading/Cron (auto-close), Trading/DB (PnL backfill)
**Type:** critical-cleanup + data backfill

### Files Changed
- `src/components/AppShell.tsx` — live NYSE phase detection (Open/Pre/After/Closed); clock is mount-only to fix hydration mismatch; "Strategy Auto: 09:50 ET" → "Enroll: 16:05 ET"
- `src/components/TickerDownloader.tsx` — **new**, inline ticker-download affordance replacing 3 dead "Add one on the Dashboard first" references
- `src/components/ScenariosSection.tsx` — tri-state preview (`spec` / `error` / `notReady`) replacing misleading "Invalid parameters" default; `<CardDescription>` wrapping `<div>` fixed (was HTML-nesting hydration error); inline downloader integrated
- `src/app/page.tsx` — stale "Next sync window starts at 09:45 AM ET" → corrected "09:45 ET price-sync · 16:05 ET post-close MOVERS enrollment"
- `src/app/strategies/page.tsx` — `h1` "Strategy Scenarios" → "Strategy Dashboard" (was colliding with /scenarios); silent `catch {}` → visible error-state + retry
- `src/app/settings/page.tsx` — silent "Loading..." forever → try/catch + error+retry + proper loading UI
- `src/app/markets/page.tsx` — flat 60s refresh → market-phase-aware cadence (30s open, 90s pre/after, paused closed)
- `src/app/prices/page.tsx`, `src/app/voice/page.tsx` — inline `TickerDownloader` integration; `loadSymbols` promoted to returned-promise for downloader callback
- `src/lib/data.ts` — `loadPrices` mysql2 LIMIT prepared-statement bug (`ECONNREFUSED`-looking 500 on `/api/prices`) → `pool.query` with inlined int
- `src/lib/surveillance.ts` — 14-day auto-close now computes `final_pnl_usd`/`final_pnl_pct` in the same UPDATE via direction-adjusted CASE (was only flipping status, leaving PnL NULL forever)
- `scripts/backfill-completed-pnl.ts` — **new** one-time backfill for 400 COMPLETED entries with NULL PnL
- `docker/docker-compose.override.yml` — **new**, local-dev port remap (3320 → 3319) to match existing `.env.local`
- `package.json` — `@playwright/test` 1.58.1 → 1.59.1
- `.gitignore` — audit screenshots, `.claude/shots/`, `docker/.env`

### Database Tables
- `reversal_entries` — 400 COMPLETED rows backfilled with `final_pnl_usd`/`final_pnl_pct` via direction-adjusted close-to-entry on latest available d-close. Post-backfill: **186 wins / 213 losses / 1 scratch = 46.5% win rate, +$70.72 total PnL, avg +0.177% per trade**. Before: all 400 had `final_pnl_usd=NULL` → Overview and Reversal KPIs read $0 / 0% forever.

### Summary
Comprehensive critical audit across all 11 tabs (Overview, Markets, Mean Reversion, Strategy Dashboard, Strategy Scenarios, Strategy Research, Market Signals, Price Surveillance, Voice Intelligence, Simulation Runs, Paper Trading, System Settings). Initial visible symptoms were mostly "empty / broken" — root cause analysis revealed two underlying issues masquerading as many:

1. **SSH tunnel (3319→VPS 3320) had dropped** during the audit → every API endpoint started returning 500, every page's silent `catch {}` swallowed the error and rendered empty state ("$0", "0 strategies", "No entries"). Restoring the tunnel fixed the visible symptoms; adding loud error-state + retry pattern prevents regressions.

2. **User-facing trust lies** hardcoded in the shell — "Market Live" pulsing green on Sunday 01:00, "Strategy Auto: 09:50 ET" reflecting a schedule that was moved to 16:05 on 2026-04-18. Replaced with live market-phase detection and accurate cron schedule.

3. **Stale `final_pnl_usd=NULL` on 400 COMPLETED entries** — auto-close path only flipped status, never computed PnL. Both paths now fixed: one-off backfill script + forward-looking SQL CASE in `syncActiveSurveillance`.

4. **Minor HTML-validity issue** — `<CardDescription>` (renders as `<p>`) wrapping `<div>` nested-element children caused one persistent hydration warning; replaced with plain styled `<div>`.

### Verification
- All 11 tabs screenshotted pre/post-fix — visual confirmation for each
- Final cross-tab console sweep: **0 errors, 0 warnings, 0 hydration mismatches** across all 11 pages (previously 21+ errors total)
- `backfill-completed-pnl.ts` dry-run followed by apply: 400/400 rows updated, 0 skipped
- Overview KPI confirmed: "Win Rate 46.5%" (was 0.0%), "Strategy Win Rate 46.5%" (was 0.0%)
- `/api/prices?symbol=SPY&limit=5` now 200 (was 500 `Incorrect arguments to mysqld_stmt_execute`)
- Playwright 1.59.1 upgrade verified via one full navigation loop

### Deploy
Not deployed — local-dev only. Changes merged via PR after push.

### Open follow-ups (not in this PR)
- **TREND cohort pollution in matrix** — user spotted during commit that cohort sizes vary wildly (13/23/124/38 vs expected 20/day). Root cause: `enrollment_source='TREND'` adds streak-based rows alongside the strict top-10/top-10 `MOVERS`. Proposed next PR: matrix filter defaulting to MOVERS-only with opt-in "Show TREND" toggle; separate decision on whether TREND cron stays alive.
- `.claude/deploy-instructions.md` "Last Verified: 2026-04-09" — stale, should be refreshed.
- `docker/.env.example` has `MYSQL_ROOT_PASSWORD=changeme` while `.env.local` uses `trading123` — alignment when someone audits secrets.

### Commits
- (pending) — `fix/tab-audit-critical-cleanup` branch, PR to follow

---

## [2026-04-18 21:10] — Move MOVERS enrollment 09:45 AM → 16:05 ET (post-close)

**Area:** Trading/Cron, Trading/Data migration
**Type:** refactor (semantic shift) + data backfill

### Files Changed
- `scripts/surveillance-cron.ts` — jobEnrollMovers guard 09:45→16:05; runFullSync split into runMorningSync + runCloseSync; cron schedule updated; startup catchup no longer enrolls
- `scripts/backfill-movers-post-close.ts` — **new** one-time migration script

### Database Tables
- `reversal_entries` — 540 rows updated (entry_price → daily close, day_change_pct → close-to-close full day)
- `reversal_entries_backup_20260418` — **new** safety backup of 560 MOVERS rows pre-backfill

### Summary
После обсуждения с user обнаружено семантическое несоответствие: пользователь ожидал enrollment **post-close** (акции закрывшиеся сильно вверх/вниз за день), но код enrolls в 09:45 AM — это overnight gap + первые 15 мин. Часто такие утренние движения = продолжение вчерашнего news-driven move, не независимый сегодняшний сигнал.

**Два изменения в одном потоке:**

1. **Cron refactor**: enrollment moved to 16:05 ET, runFullSync split, startup catchup no longer enrolls. Deployed to VPS (container Up 17s, schedule log показывает новый taim). Первый реальный post-close enrollment — понедельник 2026-04-20 16:05 ET.

2. **Backfill existing data**: 540 MOVERS entries обновлены:
   - entry_price = daily close вместо 09:45 AM price
   - day_change_pct = full day close-to-close вместо overnight+15min
   - d1..d10 columns НЕ трогались (они уже правильные)
   - Safety backup в `reversal_entries_backup_20260418` (560 rows)
   - Restore query задокументирован в backup table

**Эффект на данные:**
- 18 entries где direction=SHORT но close went DOWN (gap-and-fade)
- 21 entry где direction=LONG но close went UP (gap-and-rally)
- Т.е. ~7% существующих entries имеют semantic mismatch — 9:45 сигнал оказался шумом
- Остальные 93% consistent с ожидаемым направлением

**Пример AAOI 2026-04-09:**
- Было: entry $132.70, day_change +12.8% (overnight gap + ранний spike)
- Стало: entry $133.30, day_change **+0.5%** (real full-day close-to-close)
- Т.е. акция открылась с +12% gap, но за день полностью вернулась ближе к flat. Оригинальный 9:45 сигнал это чистый шум.

### Verification
- Code: tsc clean, eslint clean, deployed to VPS
- Data: 540 rows updated, 0 misses, backup table verified (560 rows)
- Direction consistency: 93% entries consistent (521/560)

### Deploy
- Cron container rebuilt via GitHub raw pull (SCP failed due to VPS memory pressure — 12GB swap used)
- Startup log confirms new schedule: "09:45 — Morning price sync — no enrollment", "16:05 — ... + ENROLL today's post-close movers"

### Commits
- `85a7f6c` — refactor(cron): move MOVERS enrollment 09:45 AM → 16:05 ET (#7)

### Follow-up
- Re-run /research на обновлённых данных — пересчитать edge numbers (вероятно edges станут чётче без noise от 9:45 entries)
- Решить что делать с 39 direction-mismatch entries (можно добавить flag в UI /research для фильтра)

---

## [2026-04-18 01:15] — Strategy Research polish: Sharpe, histogram, presets, CSV, persistence

**Area:** Trading/Research, Trading/UI
**Type:** feat (autonomous v2 polish)

### Files Changed
- `src/lib/scenario-simulator.ts` — ScenarioSummary extended with profitFactor, sharpeRatio, medianPnlUsd, avgHoldDays, exitReasonCounts, pnlHistogram (12 buckets)
- `src/app/research/page.tsx` — 4 quick preset buttons, localStorage persistence, advanced metrics row, exit reason stacked bar, PnL histogram SVG, CSV export

### Summary
Autonomous polish pass per пользовательской инструкции «сделай сам всё что можешь». Six polish features shipped in one PR:

1. **Quick presets** — 4 кнопки из data-driven analysis (Baseline UP, Monster Rider, Dip Bounce, Gainer Fade контр-пример). Один клик → filters + trade params заполняются.
2. **Form persistence** — localStorage key `research:lastForm`. Refresh страницы не теряет форму.
3. **Reset to defaults** — кнопка сбрасывает в безопасные дефолты.
4. **Advanced metrics** — profit factor, Sharpe ratio (annualized по sqrt(252/avgHoldDays)), MaxDD, costs breakdown. Colour-coded thresholds.
5. **Exit reason breakdown** — горизонтальный stacked bar показывающий proportion TIME/HARD_STOP/TAKE_PROFIT/TRAIL_STOP/DATA_MISSING.
6. **PnL histogram** — pure SVG 12-bucket распределение P&L % по сделкам. Отрицательные бины красные, положительные зелёные.
7. **Export CSV** — download всех сделок в CSV с timestamp в filename.

All additive — `/api/research/run` shape обратно-совместимый (новые поля добавлены, существующие без изменений).

### Verification
- `npx tsc --noEmit`: clean
- `npx eslint`: clean
- `npm run build`: PASSES

### Commits
- `32126cf` — feat(research): polish — Sharpe, histogram, presets, CSV export, persistence (#6)

---

## [2026-04-18 00:45] — Strategy Research — интерактивный проигрыватель сценариев

**Area:** Trading/Research, Trading/UI, Trading/API, Trading/Schema
**Type:** feat (4-phase feature shipped in one PR)

### Files Changed
- `src/lib/scenario-simulator.ts` — **new** core simulator (runScenario with direction-aware exits, equity curve)
- `src/app/api/research/run/route.ts` — **new** POST run endpoint
- `src/app/api/research/scenarios/route.ts` — **new** save/list endpoints (upsert by name)
- `src/app/api/research/scenarios/[id]/route.ts` — **new** DELETE endpoint
- `src/app/api/research/sweep/route.ts` — **new** parameter sweep endpoint (8 dims)
- `src/app/research/page.tsx` — **new** UI page with form + table + SVG equity curve + sweep
- `docker/init-db.sql` + `src/lib/migrations.ts` — new `paper_scenarios` table
- `src/components/AppShell.tsx` — added "Strategy Research" nav entry
- `scripts/backtest-strategies.ts` — bundled live-pair collision fix (missed in PR #3 merge)
- `.claude/sessions/2026-04-17-data-driven-strategy-research.md` — **new** analysis log

### Database Tables
- `paper_scenarios` — **new** (id, name UNIQUE, description, filters_json, trade_json, costs_json, last_result_summary_json, created_at, updated_at). Created automatically on first API hit via ensureSchema.

### Summary
Built Strategy Research — интерактивный "what-if" playground на странице `/research`. Пользователь задаёт фильтры (cohort period, UP/DOWN, magnitude, streak, source), параметры сделки (investment, leverage, LONG/SHORT, exit strategy), издержки (commission, margin APY) и получает: таблицу симулированных сделок, сводку (win rate, ROI, best/worst, MaxDD), SVG equity curve график.

4 фазы всё в одном PR (пользователь сказал "гони до конца"):

1. **Phase 1** — core simulator + базовая форма с таблицей результатов
2. **Phase 2** — 4 типа exits (TIME, HARD_STOP, TAKE_PROFIT, TRAIL_STOP), direction-aware walk через d1..dN, leverage liquidation, SVG equity curve
3. **Phase 3** — сохранение/загрузка сценариев (upsert по name, chips с last-PnL индикатором)
4. **Phase 4** — parameter sweep: автоматический перебор одного параметра (holdDays, leverage, investmentUsd, day-change range, hard stop, take profit, trailing), таблица с 🏆 best highlighted

Переиспользует direction-aware `computePnL` из `strategy-engine.ts` (fixed в PR #3). Read-only — не пишет в live paper_signals / paper_accounts. Только в новую таблицу paper_scenarios для сохранения настроек.

### Context (зачем это сделано)
Предыдущие сессии нашли:
- SHORT стратегии стабильно убыточны (4/4 gap-stops day 1 live)
- Asymmetric market behavior: UP streaks продолжаются (75-90%), DOWN streaks отскакивают (82-86%)
- Friday 2026-04-10 симуляция: 10 UP movers × $100 × 5x = +$619 за 4 дня

Пользователь попросил инструмент чтобы исследовать эти гипотезы интерактивно без написания node-скриптов. `/research` — это именно он.

### Verification
- `npx tsc --noEmit`: clean
- `npx eslint`: clean
- `npm run build`: PASSES, все routes зарегистрированы:
  - `/research` (static page)
  - `/api/research/run`, `/api/research/scenarios`, `/api/research/scenarios/[id]`, `/api/research/sweep` (dynamic)
- paper_scenarios table будет создана автоматически при первом API hit (ensureSchema)

### Commits
- `3c65c2f` — feat: Strategy Research — интерактивный проигрыватель сценариев (#5)

### Как использовать
```bash
bash scripts/tunnel-db.sh   # в одном терминале
npm run dev                  # в другом
# → http://localhost:3000/research
```

### Session Notes
- `.claude/sessions/2026-04-17-data-driven-strategy-research.md` — strategy research data + insights

---

## [2026-04-17 23:55] — Internal Review + Adversarial Critic (5 follow-up fixes + dupe-key recovery)

**Area:** Trading/Cron, Trading/API, Trading/Schema, Trading/Lib
**Type:** bugfix (review-pass follow-up)

### Files Changed
- `docker/init-db.sql` — UNIQUE KEY UX_signal_strat_entry on paper_signals(strategy_id, reversal_entry_id)
- `scripts/migration-2026-04-17-unique-signal.sql` — **new** idempotent migration (APPLIED to prod)
- `src/lib/surveillance.ts` — ET-safe d-column iteration (same P0-4 fix as cron) + corrected MARKET_HOLIDAYS list + ET-explicit DATE_SUB
- `src/lib/strategy-engine.ts` — direction-aware PositionState, evaluateExit, computePnL
- `scripts/backtest-strategies.ts` — direction-aware inline exit loop + direction-aware maxPnlPct/minPnlPct watermarks
- `src/lib/migrations.ts` — memoized schemaReadyPromise to run ensureSchema() once per process
- `scripts/surveillance-cron.ts` — errno 1062 graceful recovery in both executor functions

### Database Tables
- `paper_signals` — **UX_signal_strat_entry** UNIQUE KEY added with idempotent migration (APPLIED LIVE, 0 duplicate collapses needed)

### Summary
Dispatched two independent review passes against the 19-fix PR #2:
1. **Reviewer** (code-reviewer subagent) — confirmed all P0 fixes correct-as-written except for one gap: the dup-check SELECT runs OUTSIDE the P0-2 transaction, so the constraint should be enforced at the DB level. Also flagged CONVERT_TZ dependency on mysql tz tables for future fresh containers.
2. **Critic** (bug-hunter subagent, adversarial) — found 21 NEW findings in files the first audit missed. Dominant classes:
   - **4× auth/trust boundary**: mutating API routes are unauthenticated (deferred — web app not publicly deployed yet)
   - **3× direction-aware math outside the cron**: strategy-engine + backtest were entirely LONG-only, every SHORT backtest silently inverted
   - **1× same TZ bug in HTTP path**: src/lib/surveillance.ts had identical P0-4 code the cron had
   - **1× state inconsistency**: paper_trades vs paper_signals split (deferred)
   - **1× ensureSchema per-request**: metadata lock contention risk

Shipped 4 correctness fixes as PR #3 + a follow-up dupe-key graceful-recovery fix as PR #4. Both squash-merged to master. The UNIQUE KEY migration was applied live to prod MySQL; the cron container was rebuilt and redeployed on VPS with the new errno 1062 handler. All other constraints (FK cascade on paper_position_prices from earlier, plus pre-existing UXs) verified still live via information_schema query.

Deferred (out of scope for live trading safety; web app not publicly deployed):
- Auth on mutating API routes (5 findings)
- Voice route rate-limits + LLM prompt-injection hardening
- /api/paper double-click race
- /api/reversal pagination
- Yahoo timeout helpers in src/lib (only /api/surveillance/sync would benefit)
- paper_trades/paper_signals equity union (UI display)

Prod-state changes this session:
- **UX_signal_strat_entry migration applied**: verified via `information_schema.STATISTICS`
- **Cron rebuilt and redeployed**: container came up clean in 11s, startup catchup completed, "Waiting for scheduled jobs..." reached
- **Monday's 09:50 ET tick now hardened**: any rare UNIQUE KEY race will rollback cash + skip candidate instead of aborting the whole tick

### Commits (merged to master)
- `1d407c8` — fix: second-pass review + adversarial-critic findings (4 fixes) (#3)
- `44a4a90` — fix(cron): graceful recovery from UNIQUE KEY race (errno 1062) (#4)

### Session Notes
- `.claude/sessions/2026-04-17-internal-review.md` — reviewer report (11 verdicts)
- `.claude/sessions/2026-04-17-critic-pass.md` — adversarial critic 21 findings

---

## [2026-04-17 23:30] — Opus 4.7 Fresh-Eye Audit: 20 findings, 19 shipped to prod

**Area:** Trading/Cron, Trading/API, Trading/Schema, Trading/Deploy
**Type:** bugfix (comprehensive audit + remediation) + deploy

### Files Changed
- `scripts/surveillance-cron.ts` — 14 distinct fixes across P0/P1/P2 (see below)
- `src/app/api/strategies/route.ts` — direction-aware `open_market_value` SQL
- `src/app/strategies/page.tsx` — consolidated duplicate `loadData`, added refreshKey pattern
- `docker/init-db.sql` — FK cascade on paper_position_prices → paper_signals
- `scripts/migration-2026-04-17-fk-cascade.sql` — **new** idempotent migration (APPLIED to prod)
- `scripts/smoke-test-p0.js`, `scripts/smoke-test-p0-456.js` — **new** prod-DB verification scripts

### Functions/Symbols Modified
- `jobMonitorPositions` — added `monitorRunning` guard + status-gated cash credit (P0-1)
- `jobExecuteStrategies`, `jobExecuteConfirmationStrategies` — transaction-wrapped cash-first signal insert + `executeStrategiesRunning` / `executeConfirmationRunning` guards (P0-2, P1-8 partial)
- `jobExecuteStrategies` — cohort_date filter widened to 7-day catch-up window (P0-3)
- d-column iteration loop — rewritten with ET-safe `addCalendarDaysET` / `isWeekendET` / `mysqlDateToETStr` helpers (P0-4)
- `forceCloseExpiredSignals` — **new**, runs after 14-day auto-close (P0-5)
- `/api/strategies` SQL — SHORT-aware multiplier on price-return calc (P0-6)
- `fetchWithTimeout` — **new** helper, wraps all Yahoo/Twelve Data calls (P1-1, P1-9)
- `jobPruneOldPrices` — **new**, 03:00 ET nightly retention (P1-4)
- Watermark `|| sentinel` → null-check (P1-5)
- TREND_UNIVERSE load — `process.exit(1)` on parse failure (P1-6)
- Universe path — `process.cwd()`-relative instead of `import.meta.url` (P1-7)
- Trend-scan guard — widened to 9:30-16:15 ET (was 16:05) to exclude partial-bar window (P1-2)
- Monitor batching — single config prefetch + multi-row price INSERT (P1-10)
- MARKET_HOLIDAYS — fixed Good Friday 2027 (was 2028's date), added Juneteenth 2026/2027, extended to 2028 (P2-2)
- SQL time-zone comparisons — `CURRENT_DATE`/`DATE(generated_at)` replaced with `todayET()` params + `CONVERT_TZ` (P1-3)

### Database Tables
- `paper_position_prices` — **FK_pos_price_signal** added with ON DELETE CASCADE (migration applied live)
- All reads/writes unchanged structurally; timestamp comparisons now ET-explicit via `CONVERT_TZ`

### Summary
Comprehensive fresh-eye audit of the live trading cron (deployed Thu 4/16) against the previous model's work. Bug-hunter subagent produced 20 findings across 6 P0 / 10 P1 / 4 P2. All 6 P0s and all 10 P1s implemented; 3 of 4 P2s implemented (P2-4 style-only, consciously deferred).

Shipped as PR #2 in 6 commits on `fix/p0-trading-cron-safety`, squash-merged to master as commit 498d253. Code deployed to VPS via scp + `docker compose build` of the surveillance-cron container. Container came up cleanly in 22s; startup catchup completed in ~38s with no errors; "Waiting for scheduled jobs..." reached.

Two notable side-discoveries during the audit:
1. The holiday list had **two data bugs** — 2027 Good Friday was 3 weeks wrong (Apr 16 instead of Mar 26, which is actually 2028's date) and both 2026 and 2027 were missing Juneteenth entirely. These would have silently affected trading-day detection on 3 real dates.
2. The P0-3 fix unlocked **164 TREND entries** previously invisible to TRADING strategies — the scanner had been running daily but its output was never consumed by the trading path (only by CONFIRMATION strategies). Monday's 09:50 ET tick will see these as fresh candidates for the first time, capped by per-strategy `max_new_per_day=3` / `max_concurrent=15`.

Also the P0-6 fix measurably corrected inflated equity on prod: 2 strategies showed $13.09 of phantom SHORT-gap-up "gains" that are now accurately accounted for.

Prod-state changes this session:
- **FK migration applied** via `scripts/migration-2026-04-17-fk-cascade.sql` (0 orphan rows cleaned, CASCADE now enforced).
- **Cron container rebuilt** with new code; verified via startup log (`Retention prune (>30d paper_position_prices, daily)` schedule line proves new code is running).
- **All smoke tests re-ran green** post-deploy: schema ok, transaction path ok, 264-entry cohort window, 84 open signals direction-split (79 LONG / 5 SHORT), 0 orphan signals, ET date arithmetic, SHORT-aware SQL all validated.

Files on VPS (post-deploy):
- `/opt/trading-surveillance/scripts/surveillance-cron.ts` (new)
- `/opt/trading-surveillance/scripts/trend-universe.json` (unchanged)
- `/opt/trading-surveillance/docker/Dockerfile.cron` (unchanged)
- `/opt/trading-surveillance/docker/docker-compose.surveillance.yml` (unchanged)
- `/opt/trading-surveillance/docker/init-db.sql` (new — FK cascade)

### Session Notes
→ `.claude/sessions/2026-04-17-opus47-audit.md` (full audit report with 20 findings)

### Commits (PR #2, squash-merged as 498d253)
- `9a30d12` — cascade bug fixes + confirmation engine + trend scanner (prior-session bundle)
- `51d074a` — P0-1 monitor guard, P0-2 transaction cash-first, P0-3 TREND visibility
- `6b62412` — P0-4 TZ d-column fix, P0-5 orphan force-close, P0-6 SHORT-aware SQL
- `bc91017` — P1-1/9 fetch timeouts, P1-4 price retention
- `6d4c20b` — P1-2 guard window, P1-5 sentinels, P1-6 loud fail, P1-10 batch, P2-2 holidays
- `01133ca` — P1-3 CONVERT_TZ, P1-7 cwd path, P2-1 FK cascade, P2-3 loadData consolidate

---

## [2026-04-17 06:27] — First Live Trading Day Results Monitoring

**Area:** Trading/Analysis, Trading/Monitoring
**Type:** docs (monitoring, no code changes)

### Files Changed
No files changed — live monitoring and results review.

### Functions/Symbols Modified
N/A

### Database Tables
- `paper_signals` — Read-only: queried trading results
- `reversal_entries` — Read-only: verified enrollment state

### Summary
First live trading day (Thursday 4/16) verified after pipeline fixes. Pre-market guard correctly blocked stale enrollment. 9:45 AM MOVERS enrollment fired cleanly (20 tickers). QLYS banked +$1,535.73 (trailing stop at 10x = +96%). Confirmation strategies lost -$111.68 — 4/4 SHORT positions (Gainer Fade) gap-stopped at market open due to overnight tech rally (+$49.69 worst on PSKY). SHORT exit logic proven working correctly. 5 positions still open. Net realized: +$1,424. Gap risk identified as key tuning concern for leveraged SHORT strategies.

### Session Notes
→ `.claude/sessions/2026-04-17-062713.md`

---

## [2026-04-16 11:26] — Trend Scanner + Confirmation Strategies + Cascade Bug Fixes

**Area:** Trading/Cron, Trading/Strategies, Trading/Analysis
**Type:** feature + bugfix (7 bugs across 3 review rounds)

### Files Changed
- `scripts/surveillance-cron.ts` — Added jobExecuteConfirmationStrategies, jobScanTrends, direction-aware jobMonitorPositions, pre-market guards, lastBar.date cohort logic, 8s fetch timeout
- `scripts/setup-confirmation-strategies.sql` — Created: 5 CONFIRMATION strategies ($5K each, $100/trade, 5x leverage)
- `scripts/setup-trend-strategies.sql` — Created: 3 TREND-based CONFIRMATION strategies
- `scripts/trend-universe.json` — Created: 517 liquid US symbols for trend scanner
- `scripts/smoke-test-confirmation.js` — Created: 83-check pipeline verification
- `scripts/smoke-test-trend.js` — Created: 75-check trend pipeline verification
- `scripts/cleanup-stale-2026-04-16.sql` — Created: cascade bug cleanup (refund cash, cancel signals, delete stale entries)
- `docker/Dockerfile.cron` — Added COPY for trend-universe.json
- `docker/init-db.sql` — Added direction column to paper_signals, enrollment_source column to reversal_entries
- `src/app/strategies/page.tsx` — Added "Confirmation only" scope filter

### Functions/Symbols Modified
- `jobExecuteConfirmationStrategies()` — new: d1/d2 confirmation-based entry engine
- `jobScanTrends()` — new: scans 517-symbol universe for 3+ consecutive day streaks
- `jobMonitorPositions()` — rewrote: direction-aware PnL, trailing stops, watermarks for SHORT
- `jobEnrollMovers()` — modified: added pre-market guard (skip before 9:45 AM ET), source-filtered idempotency
- `fetchDailyBars()` — modified: added AbortController with 8s timeout

### Database Tables
- `paper_signals` — Added direction column, backfilled 55 SHORT signals
- `reversal_entries` — Added enrollment_source column (MOVERS/TREND)
- `paper_strategies` + `paper_accounts` — 8 new strategies, cash refunded for cleanup

### Summary
Built confirmation strategy engine (waits for d1/d2 price confirmation before entry) with 5 initial strategies based on statistical analysis showing 90%+ win rates on "double confirmation" patterns. Expanded trading universe beyond Yahoo's top 20 movers by adding a trend scanner that detects 3+ day directional streaks in 517 liquid US stocks, with 3 trend-specific strategies. Two rounds of code review found 7 bugs (SHORT PnL inversion, missing direction column, cron race, no fetch timeout, source-blind idempotency, flat-day streak handling, market-hours guard). Third ultrathink self-review uncovered the most severe: a cascade bug where pre-market container startup enrolled 164 stale entries and placed 69 paper_signals, which would have silently blocked Thursday's entire MOVERS enrollment via idempotency. Fixed with cohort_date=lastBar.date logic + pre-market time guards + cleanup SQL. Pipeline verified ready for tomorrow's 9:45/16:15/16:30 ET triggers.

### Session Notes
→ `.claude/sessions/2026-04-16-112658.md`

---

## [2026-04-16 08:11] — Reversal Trading Statistical Analysis: Finding >70% Probability Edges

**Area:** Trading/Analysis, Trading/Cron
**Type:** docs (research & analysis)

### Files Changed
- `scripts/trend-analysis.js` — Created: 3-day streak reversal analysis
- `scripts/trend-analysis-d2.js` — Created: Day 2 direction change analysis
- `scripts/mega-analysis.js` — Created: 500-line comprehensive analysis testing 4,684 filter combinations

### Functions/Symbols Modified
- No production code modified — analysis scripts only

### Database Tables
- `reversal_entries` — Read-only: queried all 520 entries with d1-d10 price columns
- `surveillance_logs` — Read-only: verified cron execution history

### Summary
Verified production cron is healthy (all 5 daily jobs firing correctly on VPS). Then conducted a deep statistical analysis of reversal trading data across 520 entries (2026-03-10 to 2026-04-15). Tested 4,684 scenarios combining type, magnitude, day-1 pattern, day-2 pattern, entry timing, and exit day. Found **790 scenarios with ≥70% win rate**. The #1 discovery: "Double Confirmation Bounce" — when a top loser bounces on d1 AND d2, it continues at **88-100% win rate** through d3-d5 with avg returns of 6-12% and max drawdown of only -1%. The 8-12% drop magnitude bucket showed the strongest reversal signal (75.8% by d5). LONG (buying losers) vastly outperforms SHORT (fading gainers). Close entry beats morning entry by 3-5%.

### Session Notes
→ `.claude/sessions/2026-04-16-081145.md`

---

## [2026-04-10 08:00] — Strategy Dashboard, Auto-Trade Cron, Position Monitor, Sell Button Fix

**Area:** Trading/Strategy, Trading/Paper, Trading/Cron
**Type:** feature + bugfix

### Files Changed
- `src/app/api/strategies/route.ts` — **New** — GET endpoint, 2 aggregated queries, no ensureSchema
- `src/app/strategies/page.tsx` — **New** — Top 3 podium + 24-strategy ranking table + grouped view toggle
- `scripts/surveillance-cron.ts` — Added jobExecuteStrategies (9:50 AM auto-trade), jobMonitorPositions (every 15 min), updated schedule + startup
- `src/app/paper/page.tsx` — Fixed sell button disabled when Yahoo price unavailable
- `src/lib/paper.ts` — fetchLivePrices concurrency limit (batch 5), non-recursive getDefaultAccount, variable rename
- `src/lib/strategy-engine.ts` — Trailing stop watermark fix, computePnL zero guard

### Functions/Symbols Modified
- `jobExecuteStrategies()` — new in cron (matches entries against strategy configs, creates signals, deducts cash)
- `jobMonitorPositions()` — new in cron (fetches prices every 15 min, records history, checks exits, fills orders)
- `fetchLivePrices()` — modified (batch concurrency limit)
- `getDefaultAccount()` — modified (non-recursive)
- `evaluateExit()` — modified (Math.max trailing stop)
- `computePnL()` — modified (zero guard)

### Database Tables
- `paper_signals` — 69 live signals auto-created by jobExecuteStrategies on first run
- `paper_position_prices` — will be populated every 15 min during market hours

### Summary
Built the strategy comparison dashboard (Phase 4) showing all 24 strategies ranked by P&L with backtest data — Big Drop (10x) at #1 with +$4,855, Baseline 3D (10x) at #2 with +$2,901. Built the auto-trade cron job (Phase 5) that executes all enabled strategies at 9:50 AM ET — verified: 69 live signals created across 21 trading strategies on first run. Added 15-minute position monitor for live price tracking, stop loss triggers, and limit order fills. Fixed sell button being disabled when Yahoo price unavailable. Applied 5 code review fixes (concurrency, recursion, watermark, zero guard, shadowing). All verified on VPS: cron running, strategies executing, 60 active tickers across 3 cohorts.

### Session Notes
→ `.claude/sessions/2026-04-10-080000.md`

---

## [2026-04-10 05:00] — Code Review + Critic: 5 Fixes Applied, Clean Pass

**Area:** Trading/Strategy, Trading/Paper
**Type:** bugfix

### Files Changed
- `src/lib/paper.ts` — Concurrency limit on fetchLivePrices (batch of 5), non-recursive getDefaultAccount, renamed shadowed tradeRows variable
- `src/lib/strategy-engine.ts` — Trailing stop high watermark fix using Math.max, division-by-zero guard in computePnL
- `scripts/backtest-strategies.ts` — let→const lint fix

### Functions/Symbols Modified
- `fetchLivePrices()` — modified (concurrency limit: batches of 5)
- `getDefaultAccount()` — modified (non-recursive, throws on failure)
- `evaluateExit()` — modified (trailing stop uses Math.max for effective high)
- `computePnL()` — modified (entryPrice <= 0 guard)
- `fillOrder()` — modified (renamed shadowed tradeRows → openTradeRows)

### Database Tables
- N/A

### Summary
Ran /review on all session work, found and fixed 5 issues: unbounded parallel Yahoo fetches (now batched at 5), recursive getDefaultAccount without guard (now non-recursive with throw), trailing stop not considering current price as potential new high (now uses Math.max), division-by-zero in computePnL (now guards entryPrice <= 0), and variable shadowing in fillOrder SELL branch (renamed). Ran /critic after — clean pass, 0 new issues. All verified: TSC 0 errors, lint 0 issues on session files, Next.js build passes.

### Session Notes
→ `.claude/sessions/2026-04-10-050000.md`

---

## [2026-04-10 04:30] — Strategy Scenario Engine: 24 Parallel Strategies + Backtest Results

**Area:** Trading/Strategy, Trading/Paper
**Type:** feature

### Files Changed
- `src/lib/strategy-engine.ts` — **New** — Config-driven entry/exit evaluation, P&L computation, 8 strategy templates × 3 leverages
- `src/lib/migrations.ts` — Added paper_strategies, paper_signals, paper_position_prices tables
- `scripts/seed-strategies.ts` — **New** — Seeds 24 strategies with dedicated $100k accounts
- `scripts/backtest-strategies.ts` — **New** — Runs all strategies against 420 historical entries, outputs ranking table

### Functions/Symbols Modified
- `matchesEntry()`, `evaluateExit()`, `computePnL()` — new in strategy-engine.ts
- `STRATEGY_TEMPLATES`, `LEVERAGE_TIERS`, `generateAllStrategies()` — new
- Types: `EntryConfig`, `SizingConfig`, `ExitConfig`, `StrategyConfig`, `ReversalCandidate`, `PositionState`, `ExitDecision`

### Database Tables
- `paper_strategies` — Created + seeded with 24 entries (8 templates × 3 leverage tiers)
- `paper_signals` — Created, populated by backtest with BACKTEST_WIN/BACKTEST_LOSS records
- `paper_position_prices` — Created (for future high-frequency position tracking)

### Summary
Built the Strategy Scenario Engine — a config-driven framework for running 24 trading strategies in parallel. Each strategy has its own $100k account and JSON config defining entry criteria, position sizing, and exit rules. Ran backtest against 420 historical reversal entries (21 cohort days). Key finding: **only 2 strategies are profitable** — Baseline 3D (hold 3 days, +$284 at 1x, +$2,901 at 10x, 54.3% win rate) and Big Drop (≥10% drops, +$430 at 1x, +$4,855 at 10x, 50% win rate). ALL trailing stop strategies LOSE money on mean reversion because the price dips first before recovering. Simple time-based exit outperforms all complex exit rules.

### Session Notes
→ `.claude/sessions/2026-04-10-022000.md`

---

## [2026-04-10 02:20] — Full Session: Yahoo 60-Day Rewrite, 3 Data Provider Signups, Paper Trading Simulator, Idempotent Enrollment Fix

**Area:** Trading/Surveillance, Trading/Paper, Trading/Infrastructure, Trading/Data
**Type:** feature + bugfix + research

### Files Changed
- `docker/init-db.sql` — Added 5 web app tables (prices_daily, strategy_runs, trades, run_metrics, app_settings)
- `scripts/tunnel-db.sh` — **New** — SSH tunnel for local dev → VPS MySQL
- `src/lib/surveillance.ts` — Critical trading-day loop fix, VALID_COLUMNS, SYMBOL_RE, MARKET_HOLIDAYS, encodeURIComponent, isFinite, LIMIT 500
- `src/app/api/surveillance/sync/route.ts` — SYNC_SECRET auth, consecutive_days upsert, **idempotent enrollment check**
- `src/lib/migrations.ts` — UNIQUE KEY on surveillance_failures; **new paper_accounts, paper_orders, paper_equity_snapshots**; extended paper_trades with account_id + quantity
- `scripts/surveillance-cron.ts` — MARKET_HOLIDAYS, holiday skip, LIMIT 500, SQL DATE_SUB, **Twelve Data integration with circuit breaker, Yahoo 60-day rewrite with symbol-level caching, orphan cleanup, idempotent jobEnrollMovers**
- `scripts/deploy-surveillance.sh` — Removed hardcoded password, quoted $VPS
- `scripts/backfill-matrix.ts` — COALESCE to preserve live prices
- `docker/docker-compose.surveillance.yml` — TWELVEDATA_API_KEY env var, memory 256M→1G, CPU 0.5→1.0, NODE_OPTIONS heap
- `.env.local` — Added TWELVEDATA_API_KEY, FINNHUB_API_KEY, FMP_API_KEY
- `src/lib/paper.ts` — **New** — Paper trading library with order matching engine
- `src/app/api/paper/route.ts` — Rewrote GET to return account + trades + orders, runs matching engine
- `src/app/api/paper/order/route.ts` — **New** — POST place orders (BUY/SELL × MARKET/LIMIT/STOP), DELETE cancel
- `src/app/api/paper/account/route.ts` — **New** — GET account state, POST reset
- `src/app/paper/page.tsx` — Rewrote UI with account KPIs, buy form, pending orders, positions, history, reset
- `tsconfig.json` — Excluded scripts/surveillance-cron.ts from Next build (uses node-cron from separate package)

### Functions/Symbols Modified
- `fetchIntradayPrice()` in cron — **rewrote** as cache-based Yahoo 60-day primary with Twelve Data fallback
- `fetchYahoo60d()`, `fetchTwelveDataDay()`, `getSymbolBars()`, `lookupBar()`, `targetTimeFor()`, `Bar5m` type, `SymbolBarCache` type — new in cron
- `fetchLivePrice()`, `fetchLivePrices()`, `getDefaultAccount()`, `computeAccountEquity()`, `fillPendingOrders()`, `fillOrder()` — new in `src/lib/paper.ts`
- `syncActiveSurveillance()` — trading day loop fix, holiday skip, LIMIT 500, VALID_COLUMNS
- `jobEnrollMovers()` in cron — added idempotency check (COUNT before enroll)
- `autoEnrollTrenders()` in sync/route.ts — added idempotency check
- `fetchMoversFromYahoo()` — SYMBOL_RE validation, isFinite guards, typing
- `jobSyncPrices()` — per-sync cache map, Twelve Data circuit breaker, orphan cleanup, holiday skip
- `PaperTradingPage()` — rewrote

### Database Tables
- `paper_accounts`, `paper_orders`, `paper_equity_snapshots` — **Created** (new simulator schema)
- `paper_trades` — Extended with account_id + quantity
- `prices_daily`, `strategy_runs`, `trades`, `run_metrics`, `app_settings` — Created on VPS
- `reversal_entries` — Backfilled 466 → marked 380 COMPLETED → deleted 46 April 8 dupes → 40 ACTIVE remain
- `surveillance_failures` — Added UNIQUE KEY, cleaned orphans
- `surveillance_logs` — Orphan RUNNING cleanup query added

### Summary
Major multi-phase session. Unified VPS MySQL as single source of truth (cron + web app were on separate DBs). Ran 5-agent critic review and fixed 12 issues including a critical calendar-day vs trading-day loop bug. Signed up for 3 data providers via Playwright (Twelve Data works, Finnhub and FMP both gate historical intraday behind paid tiers). Discovered Yahoo's unadvertised `?interval=5m&range=60d` endpoint and rewrote fetchIntradayPrice with symbol-level caching (30× fewer API calls, 1G container memory). Built full paper trading simulator (accounts, orders, cash, matching engine) after verifying via Playwright that Alpaca and Tradier both block Canadians. Fixed enrollment idempotency bug that caused April 8 cohort to balloon to 66 tickers (each container restart fetched different Yahoo top 10). All verified: cron is running, filled 59/60 April 8 cohort d1 prices (98.3%, 1 gap is Yahoo data quirk), idempotency working ("SKIP: already enrolled" logged), paper trading buy/sell flow works end-to-end.

### Session Notes
→ `.claude/sessions/2026-04-10-022000.md`

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

## [2026-04-11 14:01] — Trading Verification, Markets Chart Upgrade, Site Polish

**Area:** Trading/Markets, Trading/Strategy, Trading/Paper, Trading/UI
**Type:** feature + bugfix + verification

### Files Changed
- `src/app/api/strategies/route.ts` — fixed strategy equity accounting using marked open-position values
- `scripts/surveillance-cron.ts` — fixed auto-trader cash overspend path
- `scripts/backtest-strategies.ts` — enforced overlapping-position concurrency in backtests
- `docker/init-db.sql` — aligned deploy schema with paper-trading and strategy runtime schema
- `src/app/api/markets/route.ts` — added multi-range chart API support (`1d`, `5d`, `1mo`, `6mo`, `1y`)
- `src/app/markets/page.tsx` — rebuilt ticker UI with Yahoo-like range selector and interactive SVG chart
- `src/app/page.tsx` — rewrote landing page around actual surveillance → strategy → paper-execution flow
- `src/app/strategies/page.tsx` — rebuilt strategy dashboard around corrected account metrics
- `src/app/paper/page.tsx` — standardized copy and fixed effect/lint issue
- `src/components/AppShell.tsx` — improved IA with `Markets`, `Strategy Dashboard`, and quick-jump search
- `src/app/globals.css` — added ambient background styling

### Summary
Audited the recent trading work from scratch under the assumption that it was flawed. Found four high-signal issues: strategy dashboard equity double-counted realized P&L, strategy auto-trade could overspend accounts, backtest concurrency was effectively disabled, and deploy schema lagged runtime expectations. Fixed those issues first, then improved the site’s information architecture and landing flow.

Built a real ad-free ticker interface on `/markets` to cover the gap the user called out: live stats for any symbol, quick watchlist workflow, and historical chart ranges similar to Yahoo. The new flow supports `1D / 5D / 1M / 6M / 1Y` using Yahoo chart data with range-specific intervals and an interactive SVG chart.

Verification completed on the code path changed in this session:
- `npx tsc --noEmit` — passed
- targeted `eslint` on touched files — passed
- `npm run build` — passed

### Commit
- `909db98` — fix trading accounting and add multi-range markets charts

### Session Notes
-> `.claude/sessions/2026-04-11-140100.md`

---
