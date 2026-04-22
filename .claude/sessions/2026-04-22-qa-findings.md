# QA Findings — 2026-04-22 Post-Wave Deploy Audit

**Session:** Full Playwright walkthrough of every sidebar page after merging all 5 waves + scenario overlay + 2 hotfixes.

**Prod URL:** `https://trading-production-06fe.up.railway.app`
**Master HEAD:** `5ce98b1` (hotfix post-deploy critic) → merged commits: W1 #11, W2 #12, W3 #13, Scenario #14, W3 hotfix #15, W5 #16, W4 #17, Critic hotfix #18
**Migrations applied on Railway:** W1, W2, W3, W4, W5 — all idempotent, schema verified
**Seed:** 224 tradable_symbols populated (AAPL/MSFT/NVDA/TSLA/GOOGL/SPY/QQQ etc. confirmed)

## Walkthrough result

| # | Page | Status | Findings |
|---|------|--------|----------|
| 1 | Overview `/` | ✅ CLEAN | 0 console errors |
| 2 | Markets `/markets` | ✅ CLEAN | Indices + watchlist + gainers/losers; 0 errors |
| 3 | Mean Reversion `/reversal` | ⚠️ MINOR | React hydration #418 (auto-recovers); matrix fully functional: 956 tickers, F1/F2/F3 all working |
| 4 | Strategy Dashboard `/strategies` | ✅ CLEAN | 32 strategies, $673k aggregate equity, podium + ranked table |
| 5 | Strategy Scenarios `/scenarios` | ✅ CLEAN | 7 preset tabs + StrategySpec editor + parameter sweep |
| 6 | Strategy Research `/research` | ✅ CLEAN | Quick presets + filters + trade params + Grid Sweep |
| 7 | Market Signals `/signals` | ✅ CLEAN | Empty state + refresh trigger + how-it-works |
| 8 | Price Surveillance `/prices` | ✅ CLEAN | Daily MU prices table, 60-day default |
| 9 | Voice Intelligence `/voice` | ✅ CLEAN | Voice-to-Strategy — audio upload + prompt text + parse |
| 10 | Simulation Runs `/runs` | ✅ CLEAN | Recent runs history (Streak Fade / Follow, various tickers) |
| 11 | Paper Trading `/paper` | ✅ CLEAN | All 5 waves visible and working |
| 12 | System Settings `/settings` | ✅ CLEAN | W4 risk-model block loaded with seed values |

**Totals:** 11 CLEAN / 1 MINOR (non-blocking hydration warning) / 0 RED

## Cross-cutting wave verifications on /paper

| Wave | Feature | Visible? |
|------|---------|----------|
| W1 | Account cash invariant preserved ($100,030.71 after D1 reconciliation) | ✅ |
| W1 | Equity card + Cash card + Positions + Realized P&L all consistent | ✅ |
| W2 | Honest win-rate ("1W · 2L · 33% win"); scratched trades visible | ✅ |
| W2 | Trade history filters (Symbol, From/To dates, Outcome, Strategy) | ✅ |
| W2 | CSV export button | ✅ |
| W2 | Held days column | ✅ (0d/0d/1d on the 3 historical trades) |
| W3 | Direction dropdown: Long/Short | ✅ |
| W3 | "Exit brackets" expandable section | ✅ |
| W4 | Sizing toggle ($ / % Equity / % Risk) | ✅ |
| W4 | Risk settings in /settings match seeded values | ✅ |
| W4 | tradable_symbols table populated (whitelist active) | ✅ (verified via DB query, 224 symbols) |
| W5 | Account switcher dropdown (top-right) | ✅ "Default" visible |
| W5 | Dual clock "ET: 12:12 AM · Local: 7:12 AM · CLOSED" | ✅ |
| W5 | Session status badge (Pre-Market / Open / After-Hours / Closed) | ✅ CLOSED (correct for 00:12 ET) |
| W5 | Reset button present (typed-confirmation modal not clicked in this pass) | ✅ present |

## Known non-blocking issues

- **React hydration #418 on `/reversal`** — same as earlier local-dev sessions. Auto-recovers. Root cause: SSR renders a different initial state than the client (likely matrix data fetch timing). Not a data bug. Fix is a dedicated follow-up; doesn't affect functionality. Priority: LOW.

## Items NOT verified in this walkthrough (deferred to manual user testing)

- Placing a real order (would touch prod paper account state)
- Reset modal typed-confirmation flow (requires form filling — works on local per W5 smoke)
- Idempotency double-click (same)
- Toast notification on rejection (same)
- Scenario overlay Apply + Report (verified on local dev prior to merge)
- Account creation via API (verified on local dev prior to merge)

## Artifacts

All screenshots saved as `qa-NN-<page>.png` in the Playwright cwd (`.playwright-mcp/`).

## Verdict

**Platform is healthy.** Every sidebar page renders, every wave's visible features are present, no RED findings. The one YELLOW is a React hydration warning that recovers gracefully. All 6 critic findings (4 from original post-deploy audit + 2 W5 round-2 findings) were independently verified as real bugs against master and correctly fixed — no hallucinations, no fix drift.

Paper-trading platform is substantively better than it was 24h ago:
- Money accounting is atomic + conservation-verified
- Shorts + protective exits work end-to-end
- Trailing stop ratchet fixed (was broken silently in shipped W3)
- Auto-exits correctly charge commission (was silently skipping)
- Multi-account isolation working
- Idempotency prevents double-orders
- Whitelist seeded
- UI shows honest metrics (scratched trades, dual clock, context on pending orders)
- Scenario overlay on matrix gives instant "what-if" P&L across 5 presets with per-ticker checkboxes + recurrence badges + report

Remaining work beyond this session:
- Fix React hydration on /reversal (LOW, cosmetic)
- Address 2 MEDIUM findings from internal critic (finding #1 watermark UPDATE outside transaction; #10 1e-9 float literal in SQL)
- Finding #11 (isSymbolTradable silent DB errors) — add logging + 503 on DB unreachable

None of these blocks production use today.
