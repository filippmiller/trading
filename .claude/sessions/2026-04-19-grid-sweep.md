# 2026-04-19 — Grid Sweep: multi-dimensional strategy research

**Branch:** `feat/grid-sweep-strategy-search`
**PR:** https://github.com/filippmiller/trading/pull/9
**Base:** `master` (so this ships independent of PR #8 tab-audit)

## User intent

User is searching for an automated trading strategy. Not "pick one strategy and ship it" but "give me a research instrument that tests every hypothesis myself so I can find the edge." Walked through a brainstorm of 8 strategy-decision axes (universe, entry timing, direction, exit rules, filters, sizing, portfolio constraints, regime). User picked **Path A monolith** scope + told me to stop hallucinating 3-week estimates — max 1 hour of coding.

## Key pivot during session

Started with three ad-hoc TypeScript analysis scripts (`analyze-delayed-entry.ts`, `analyze-momentum-carry.ts`, `analyze-strategy-grid.ts`) answering specific questions the user asked:
1. "Does waiting 1-2 days improve SHORT PnL?" → marginal, doesn't rescue extended-rally SHORTs.
2. "What if we LONG the top gainers at close and sell next day?" → 70-76% WR on 50 trades, **+$1,465 on $5k deployed**. Surprise winner.
3. "Full grid on deduplicated 233-ticker universe" → **76% WR / +$3,126 on hold=5d trail=15%**.

User saw the third result, said "золотая жила", and asked for the research tool in the UI rather than more one-off scripts. Pivoted to building `/research` Grid Sweep.

## What shipped

### Simulator (src/lib/scenario-simulator.ts)
- Existing `evaluateExitWalk` only walked d{N}_close. Extended to walk all 30 bars (M/D/E × 10 days). Intraday stop triggers now fire correctly.
- Added `BarTime` type, `exitBar` on `ExitStrategy`, `entryDelayDays` + `entryBar` on `TradeParams`, `breakevenAtPct` breakeven arm.
- New `runGridSweep(request)`: single SQL load + in-memory axis cross-product. Returns top-N sorted.

### API (src/app/api/research/grid/route.ts)
- POST endpoint with a 10,000-combo hard cap.
- Input schema mirrors `GridSweepRequest` from simulator.

### UI (src/components/GridSweepSection.tsx)
- Self-contained component, dropped into `/research` above the existing 1-D Parameter Sweep.
- 5 presets: basic hold×exit, trailing search, SL×TP grid, entry-delay probe, deep search.
- "Edit axis values (advanced)" collapsible with comma-separated textareas per axis.
- Top-25 results table sortable by Total PnL / Win Rate / Sharpe / Profit Factor. Top row highlighted emerald.

## Verification

- `npx tsc --noEmit`: clean.
- Backend smoke: `curl POST /api/research/grid` — 48 combos × 271 rows → 1.4s response with expected top config.
- UI smoke: preset click → full pipeline works end-to-end, table renders.

## Process notes

- **User's "max 1 hour" frame was correct.** Total coding time ≈ 55 min including the three ad-hoc analyzers. The pre-existing `scenario-simulator.ts` already had 70% of the infrastructure — adding the missing axes + the grid function was additive.
- **Proactive telegraph worked.** When user picked "Path A monolith," I still ran the architectural check: the right ship was "shared infrastructure + immediately-visible UI win," not "three separate presets." Presets collapsed into one component.
- **SSH tunnel dropped twice during the session** (same pattern as prior sessions). Still no auto-reconnect. Worth a FIX task in a future session — something like `scripts/tunnel-db.sh` watchdog that ServerAliveInterval already hints at but doesn't enforce in current wrapper.
- **Didn't add `scripts/deploy-instructions.md` refresh** — still stale "Last Verified 2026-04-09". Untouched.

## Strategy findings surfaced (preserved here for reference)

From `analyze-strategy-grid.ts` run on 391 unique tickers (deduped, latest cohort per symbol):

| Universe | Best config | N | WR | Total $ | Avg % |
|---|---|---|---|---|---|
| **Gainers LONG** (momentum) | `≤5d hold · trail=15%` | 233 | 76% | +$3,126 | +13.4% |
| **Gainers LONG** | `≤5d hold · no trail` | 233 | 76% | +$3,102 | +13.3% |
| **Gainers LONG** | `hold=2d · midday exit` | 169 | 81% | +$1,997 | +11.8% |
| **Losers LONG** (bounce) | `≤5d hold · no trail` | 158 | 61% | +$996 | +6.3% |
| SHORT any extended rally | — | — | — | negative | negative |

Key insight: SHORTing extended momentum loses money at every delay tested (14-40% WR). LONGing extended declines works but is weaker than LONGing extreme gainers. System's current SHORT enrollment path is the main drag on total PnL.

## Open follow-ups

- Click-through from grid row → populate main scenario form
- Concentration filter (max N same ticker)
- ATR stops (needs volatility column)
- Regime filter (needs SPY/VIX join)
- Pair trades
- Vol-adjusted sizing

## Related PRs

- PR #8 (`fix/tab-audit-critical-cleanup`) — prior session, not yet merged, covers header lies + silent failures + PnL backfill. Independent of this PR.
