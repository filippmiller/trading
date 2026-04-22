# 2026-04-19 — Tab audit critical pass (11 fixes + MOVERS PnL backfill)

**Branch:** `fix/tab-audit-critical-cleanup`
**PR:** https://github.com/filippmiller/trading/pull/8
**Commit:** `19a6f38`

## Outcome

25 tasks closed across an aggressive multi-hour audit+fix session. All 11 tabs (Overview, Markets, Mean Reversion, Strategy Dashboard, Strategy Scenarios, Strategy Research, Market Signals, Price Surveillance, Voice Intelligence, Simulation Runs, Paper Trading, System Settings) now render correctly without console errors or hydration mismatches.

## Key findings (root-cause framing, not symptom list)

**1. A dropped SSH tunnel (3319 → VPS 3320) was the invisible root cause of most "broken" pages.** Every page had `catch {}` on its data fetch → silent failure → rendered empty state ("0 strategies", "No entries", "$0 P&L"). Users couldn't tell the difference between "system genuinely empty" and "DB unreachable." Fix: add loud error+retry state to silent-failure sites + documented the tunnel restart pattern.

**2. `AppShell` contained hardcoded trust-lies.** "Market Live" with pulsing green shown 24/7, including Sundays. "Strategy Auto: 09:50 ET" — the schedule was moved to 16:05 ET on 2026-04-18 but the header never updated. Now header computes live NYSE phase and shows the correct cron label.

**3. 400 COMPLETED reversal_entries had `final_pnl_usd=NULL`.** The 14-day auto-close path in `syncActiveSurveillance` only flipped `status`, never computed PnL. The Overview and Reversal KPIs read "$0 / 0% Win Rate" forever — another false-empty trust bug. One-off backfill filled them; forward-looking SQL CASE in the UPDATE prevents regression. Real stats: **46.5% WR / +$70.72 / 186W 213L 1S / avg +0.177%**.

## Files changed

- `src/components/AppShell.tsx` — live NYSE phase detection
- `src/components/TickerDownloader.tsx` — **new** reusable empty-state downloader
- `src/components/ScenariosSection.tsx` — tri-state preview, nested-div fix, inline downloader
- `src/app/page.tsx` — stale cron schedule string
- `src/app/strategies/page.tsx` — error+retry, h1 rename
- `src/app/settings/page.tsx` — error+retry
- `src/app/markets/page.tsx` — market-phase-aware refresh
- `src/app/prices/page.tsx`, `src/app/voice/page.tsx` — inline downloader
- `src/lib/data.ts` — mysql2 LIMIT prepared-statement bug
- `src/lib/surveillance.ts` — auto-close now computes final_pnl
- `scripts/backfill-completed-pnl.ts` — **new** backfill migration
- `docker/docker-compose.override.yml` — **new** local-dev port remap
- `.claude/agent-log.md` — session entry
- `.gitignore` — audit screenshots

## Process notes

- The audit itself burned too much time on failed screenshot automation (chrome CLI Windows-path bugs, bash `$route` escape issues, Playwright browser profile collisions) before realising `Playwright MCP` worked fine once the browser lock cleared. Lesson: when a tool fails repeatedly with a specific setup, stop iterating on workarounds and re-check whether the underlying blocker is external.
- User caught two fake-trust issues I missed in my first pass ("Market Live" on Sunday, ticker-count discrepancy in matrix). Worth keeping a "critical pass" checklist that includes: **does this UI tell the user anything that could be falsified?** Dot indicators, refresh labels, KPI values, nav badges all fall into this category.
- `new Date().toLocaleTimeString()` at render time in a client component is ALWAYS a hydration mismatch waiting to happen — should be a project-wide lint rule.

## Open follow-ups

- **TREND cohort pollution in matrix** — cohort sizes swing from 13 to 124/day because `enrollment_source='TREND'` adds streak-based rows alongside the strict top-10/top-10 MOVERS. Next PR needs a matrix filter defaulting to MOVERS-only.
- **`.claude/deploy-instructions.md`** last verified 2026-04-09 — stale.
- **`docker/.env.example`** password `changeme` vs `.env.local` password `trading123` — alignment inconsistency.

## Verification

- `curl /api/reversal` → 28 cohorts / 757 entries
- `curl /api/strategies` → 32 strategies, $2.4M aggregate equity, +$15,832 realized
- `curl /api/prices?symbol=SPY&limit=5` → 200 with 5 rows (was 500)
- Cross-tab Playwright navigation loop: **0 errors / 0 warnings** across all 11 pages
- Overview KPIs: Win Rate 46.5%, Strategy Win Rate 46.5% (were both 0.0%)
- Header phase indicator: "Market Closed" on Sunday 02:30 ET (correct)
