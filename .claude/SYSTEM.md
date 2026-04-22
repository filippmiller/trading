# Trading System — Manual for Future Agents

**Last updated:** 2026-04-22 · **Status:** production on Railway · **Master HEAD sample:** `52722e3`

Read this BEFORE making code changes. It captures the stuff that's not obvious from `git log` or `CLAUDE.md`.

---

## 1. Topology in one diagram

```
┌────────────────────────┐     ┌──────────────────────────┐
│  Railway web (Next.js) │     │  Railway worker          │
│  /api/*  /paper  etc.  │←───→│  surveillance-cron.ts    │
│  ensureSchema on boot  │     │  (node-cron, Yahoo fetch)│
└───────────┬────────────┘     └────────────┬─────────────┘
            │                                │
            ▼                                ▼
         ┌──────────────────────────────────────────┐
         │   Railway MySQL (same DB both services)  │
         │   Public proxy: switchback.proxy.rlwy.net│
         └──────────────────────────────────────────┘
              │
              │  (historical SoT for recovery)
              ▼
         ┌─────────────────────────────────────────┐
         │  VPS MySQL  89.167.42.128:3320          │
         │  (accumulating archive, March 2026+)    │
         └─────────────────────────────────────────┘
```

Two runtime environments. Local dev uses `.env.local` + SSH tunnel to the VPS MySQL on `localhost:3319`. Prod uses Railway's managed MySQL.

---

## 2. Key tables (relationships that actually matter)

| Table | Populated by | Consumed by | Notes |
|---|---|---|---|
| `reversal_entries` | `surveillance-cron.ts` (MOVERS job daily + TREND scan) | `/api/reversal` → `/reversal` matrix UI | **956 rows and growing**. Each = one (cohort_date, symbol) enrollment. Direction is LONG=was-loser, SHORT=was-gainer (mean-reversion bet) |
| `tradable_symbols` | CSV seed (`scripts/tradable-symbols-seed.csv`, 232 rows) + **lazy-insert** from each enrollment | `isSymbolTradable` / `filterTradableSymbols` (paper-order gates) | `exchange='LAZY_SYNC'` marks lazy-added rows; `'NASDAQ'`/`'NYSE'` = curated seed |
| `prices_daily` | `refreshSymbolData` on every enrollment + backfill scripts | `/api/prices`, stop-eval cron, deviation band (PR #41) | UNIQUE (symbol, date) |
| `paper_accounts` | `getDefaultAccount` on first API call | All paper-trading code | Multi-account: id=1 is Default; strategies create their own |
| `paper_orders` | `/api/paper/order` (single) + `/api/paper/batch-order` (N, manual-fill) | `fillOrder` → paper_trades | `is_manual_fill=1` flags batch-fills (PR #40); `client_request_id` is idempotency key |
| `paper_trades` | `fillOrderCore` on fill | `/paper` UI + `jobMonitorPaperTrades` (stop-eval) | Has absolute `stop_loss_price` / `take_profit_price` / `trailing_stop_pct`; bracket pcts from the order are converted on fill |
| `paper_position_prices` | `jobMonitorPaperTrades` (15-min RTH ticks) | `/paper` mark-to-market | Prune via `jobPruneOldPrices` |
| `paper_equity_snapshots` | Inside `fillOrder` transaction + hourly equity cron | `/paper` equity curve | Atomic-with-fill so curves never miss a trade |
| `app_settings` | `/api/paper/settings` PATCH + seed in `ensureSchema` | `loadRiskConfig` (30s cache) | Risk knobs all prefixed `risk.*` |

---

## 3. Two enrollment paths (both in `surveillance-cron.ts`)

### MOVERS (daily, 16:05 ET close)
`fetchMoversFromYahoo` hits Yahoo's `day_gainers` / `day_losers` predefined screeners → top 25 each (capped to 10G+10L for enrolment). For every enrolled symbol: `refreshSymbolData` backfills prices_daily, `ensureTradableSymbol` adds it to the whitelist (provenance=LAZY_SYNC).

### TREND (16:15 ET)
Separate scan for multi-day streaks (3+ consecutive up/down days). Same enrollment semantics — goes into `reversal_entries` with `enrollment_source='TREND'`, same lazy whitelist insert.

**Both paths converge into `reversal_entries`.** The `/reversal` matrix UI reads them all; the F2 checkbox selection feeds the batch-order modal.

---

## 4. Order lifecycle (the path most code changes will touch)

```
  user clicks BUY in /paper OR Submit in BatchTradeModal
                    │
                    ▼
         ┌─────────────────────────────┐
         │ /api/paper/order            │  /api/paper/batch-order
         │ — RTH-gated                 │  — deliberately bypasses
         │ — live-price via Yahoo      │    RTH + live-price
         │ — is_manual_fill=0          │  — is_manual_fill=1
         │                             │  — deviation band (±20%)
         │                             │  — 1..50 orders, partial OK
         └──────────────┬──────────────┘
                        │ INSERT paper_orders (PENDING)
                        ▼
              fillOrder(pool, orderId, fillPrice, opts)
                        │ single DB transaction:
                        │   UPDATE paper_orders → FILLED
                        │   INSERT paper_trades (bracket pcts → absolute $)
                        │   UPDATE paper_accounts.cash
                        │   recordEquitySnapshotInTx
                        ▼
              (later, every 15 min during RTH)
                        │
                        ▼
              jobMonitorPaperTrades
                        │ scan OPEN trades w/ brackets
                        │ fetch Yahoo live prices
                        │ evaluateExitDecision → applyExitDecisionToTrade
                        │   uses PR #33 slippage parity for auto-closes
                        ▼
              paper_trades status=CLOSED
```

**Key invariants:**
1. Fill + snapshot + cash move = one transaction. If anything in that chain fails, all roll back.
2. `client_request_id` (UNIQUE with `account_id`) is the idempotency primitive. 1062 catch + pre-check both use `LEFT JOIN paper_trades` to pull real quantity on replay (PR #41 fix).
3. `is_manual_fill` is provenance, NOT policy. Analytics filters on it; engine doesn't care.

---

## 5. API endpoints cheat sheet

| Method + path | Auth | Purpose | Gotchas |
|---|---|---|---|
| `POST /api/paper/order` | Session cookie | Single order | RTH-gated, live-price fetch. Returns 409 `MARKET_CLOSED` outside hours |
| `POST /api/paper/batch-order` | Session cookie | N orders (1..50) at caller prices | Bypasses RTH/live-price. Applies whitelist + deviation band up-front (one IN-query + one JOIN-query). Per-row result. Order-dependent cash state — sequential |
| `POST /api/paper/account` | Session cookie | Reset account (atomic DELETE+UPDATE) | Account-scoped, other accounts untouched. Body optional: `{initial_cash: N}` |
| `GET/PATCH /api/paper/settings` | Session cookie | Risk knobs | Zod bounds tightened in PR #36. PATCH is transactional across all keys |
| `GET /api/healthz` | public | `{ok:true,service:"web"}` | Use this for Railway deploy sanity |
| `GET /api/prices?symbol=X&limit=N` | Session cookie | prices_daily history | Response shape: `{items: [{date, open, high, low, close}]}` |
| `GET /api/reversal` | Session cookie | Matrix data (cohorts) | Feeds /reversal UI; expensive-ish |

---

## 6. Deploy semantics (Railway)

- Any push to master auto-deploys both `web` and `worker` services
- Healthz goes 200 on OLD code during build, then briefly **500 / connection-closed** as the new container swaps in (you'll see `ERR_CONNECTION_CLOSED` for ~10s), then 200 again on NEW code
- `ensureSchema()` runs on the first API request after container boot — this is when `ensureColumn` migrations + one-shot data backfills fire. **It's cached via `schemaReadyPromise` — runs ONCE per container lifetime**, not per-request
- If a migration fails, `schemaReadyPromise` is nulled so the next request retries; but silent-swallowed failures (wrapped in try/catch for best-effort data fixes) do NOT retry until next boot

**Post-deploy verification recipe:**
```
curl /api/healthz   → 200
login + POST /api/paper/batch-order with a known-good payload → 200 + filled
Then call POST /api/paper/account to reset state
```

---

## 7. Gotchas that burned previous sessions

1. **`/api/paper/order` MARKET orders require RTH.** Outside market hours they 409 with `MARKET_CLOSED`. If you need "fill at an arbitrary price" use the batch endpoint or a LIMIT order.
2. **`paper_orders.quantity` is NULL on batch-path fills.** They size by `investment_usd`. Real fill qty lives on `paper_trades.quantity`. Idempotent replay SELECTs MUST `LEFT JOIN paper_trades` (PR #41 fixed the 1062-catch branch that missed this).
3. **`paper_orders.notes='BATCH'` is NOT the provenance signal.** `fillOrderCore` copies order.notes → trade.notes on fill, but `paper_orders.notes` itself survives unchanged. However, the canonical provenance flag is `paper_orders.is_manual_fill=1`. Read that, not notes.
4. **Yahoo Movers returns real US equities, but not always ones in our curated whitelist.** `ensureTradableSymbol` lazy-adds any enrolled symbol so the matrix→paper batch flow doesn't reject them. Don't remove this or paper-trading breaks for ~77% of matrix rows.
5. **`isSymbolTradable` throws `WhitelistLookupError` on DB failures** — distinguishes "symbol not in whitelist" (400) from "DB down" (503). Callers must handle both.
6. **Deviation band fails OPEN when last-close is unknown.** Missing `prices_daily` row means no sanity check → fill proceeds. Weigh the trade-off before changing this: stricter closed-fail breaks fresh-symbol flow.
7. **Agent-log append-only.** Immutable-policy in the file header. Don't rewrite prior entries even if they were wrong; add an errata entry.
8. **Reset is account-scoped.** `POST /api/paper/account?account_id=N` wipes only that account. Default is id=1. Other accounts (Strategy: Baseline etc.) have their own state.
9. **GitHub CLI TLS flakes on this Windows box.** `gh pr merge` / `gh pr comment` sometimes hang on `net/http: TLS handshake timeout`. Fallback: `curl -X PUT -H "Authorization: Bearer $(gh auth token)" ...` with `until ...; do sleep 4; done` polling.
10. **Playwright chromium DNS flakes on this Windows box.** Symptom: `net::ERR_NAME_NOT_RESOLVED` on first `page.goto(BASE)` even though curl works. Usually fixed by retry.

---

## 8. Risk config (`app_settings` keys)

All keys prefixed `risk.`:

| Key | Default | Zod bound | Notes |
|---|---|---|---|
| `risk.slippage_bps` | 5 | 0..200 | MARKET slippage in bps. Applied on BUY up, SELL down |
| `risk.commission_per_share` | 0.005 | 0..0.5 | Mirrors Alpaca retail. PR #36 tightened from `.max(10)` |
| `risk.commission_min_per_leg` | 1.0 | 0..10 | Min commission per open or close leg |
| `risk.allow_fractional_shares` | true | bool | Off → qty floor()'d to int |
| `risk.default_borrow_rate_pct` | 2.5 | 0..100 | Annualized SHORT borrow cost |

Cached 30s via `loadRiskConfig`. PATCH bust via `invalidateRiskConfigCache()`.

---

## 9. Test suite

- Location: `src/**/*.test.ts`, run with `npm test` (vitest)
- Current count: 104 tests (as of PR #41)
- No integration tests with live DB. Mocks where needed. Pure-function helpers are preferred (e.g. `checkFillPriceDeviation`, `computeExitFillPrice`) because they unit-test without DB
- Always run before PR: `npx tsc --noEmit; echo "tsc_exit=$?"` must equal 0. `tail` of output is not trustworthy — exit code is

---

## 10. Agent-log convention

`.claude/agent-log.md` is append-only with newest-at-top. Every PR gets an entry. Session notes live in `.claude/sessions/YYYY-MM-DD-HHMMSS.md`.

Format of one entry:
```
## [YYYY-MM-DD HH:MM] — <short title>
**Area:** …
**Type:** feature | fix | hotfix | chore | docs
**Branch:** fix/…

### Why
<1 paragraph>

### What
<bullet list of the real changes>

### Verification
```
npx tsc --noEmit → tsc_exit=0
npm test        → N/N passed
```

### Files Changed
<per-file: 1 line>

---
```

Errata for prior entries are NEW entries, not edits.

---

## 11. Current tech stack (2026-04-22)

- **Next.js** 16.2.3 (App Router)
- **React** 19.2.3
- **mysql2/promise** 3.16.3 — pool per-service
- **Zod** for API schema validation (exported from routes so tests can pin bounds)
- **node-cron** 4.2.1 (worker only)
- **vitest** for tests
- **@playwright/test** for E2E smoke (headed on Windows is reliable; DNS flakes → retry)
- **lucide-react** icons
- **Tailwind** utility classes (no config changes needed for most UI work)

---

## 12. When in doubt

Read these three things, in order:
1. `CLAUDE.md` (session-start protocol)
2. This file (`.claude/SYSTEM.md`) — system model
3. `.claude/agent-log.md` top 3-5 entries — recent context

If a change touches money or stop-evaluation logic, also read:
- `src/lib/paper-fill.ts` fillOrderCore
- `src/lib/paper-exits.ts` evaluateExitDecision + applyExitDecisionToTrade
- `scripts/surveillance-cron.ts` jobMonitorPaperTrades

If a change touches the matrix or whitelist:
- `src/app/reversal/page.tsx`
- `src/lib/paper-risk.ts` — isSymbolTradable + filterTradableSymbols + ensureTradableSymbol

If a change is a new route:
- Copy the Zod+exported-schema+route pattern from `src/app/api/paper/batch-order/route.ts`
- Export the schema so tests pin the bounds

That's enough to be productive without re-deriving yesterday's decisions.
