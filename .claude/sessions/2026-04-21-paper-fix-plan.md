# Paper Trading Fix Plan — 2026-04-21

Fix all 27 findings from the Paper Trading critique + 4 net-new bugs found by codex during smoke test. Batched into 5 waves. Each wave = one sub-agent turn, reviewed by codex CLI as independent critic, merged only after critique is clean.

## Wave overview

| Wave | Branch | Scope | Findings |
|------|--------|-------|----------|
| W1 | `fix/paper-w1-money-correctness` | Atomic cash, cash reservation, unify fill engines, market-hours, staleness, fillPrice validation, account-scoped trade_id | 1, 2, 3, 4, 6, 7 + codex a–d |
| W2 | `fix/paper-w2-data-integrity` | Equity snapshots, win-rate, strategy FK, paper_trades↔paper_signals reconciliation, STOP UI, LIMIT OHLC fills, trade history filters | 5, 8, 11, 12, 13, 14, 24 |
| W3 | `fix/paper-w3-shorts-exits` | SHORT side, stop-loss / take-profit / trailing / time exit, partial close, order modify | 9, 10, 15 |
| W4 | `fix/paper-w4-risk-model` | Slippage, commission, % position sizing, symbol whitelist, fractional share mode | 16, 17, 18, 19, 20 |
| W5 | `fix/paper-w5-ux-guardrails` | Reset gate, idempotency, rejection surfacing, pending-context, time sync, multi-account | 21, 22, 23, 25, 26, 27 |

## Codex critic workflow (every wave)

After the sub-agent pushes its PR:

```bash
codex exec --skip-git-repo-check "$(cat <<'EOF'
Review PR diff at https://github.com/filippmiller/trading/pull/<N>.
Focus: correctness, concurrency, data integrity, migration safety.
List ONLY critical/high-severity issues. Skip style nits.
Max 10 bullets. Each with file:line ref. Be terse.
EOF
)"
```

Extract codex's findings (slice between `^codex$` and `^tokens used$`). If critical issues found → fixup sub-agent with codex output as input → re-critique. If clean → merge + smoke-test on Railway → proceed to next wave.

---

## W1 — Money correctness (EXECUTING)

### Goal

Make the paper-trading fill engine transactionally correct. After W1: no cash overdraft, no double-fills, no NaN quantities, no cross-account position leaks, limit orders reserve cash, market orders reject outside RTH, every displayed price has a staleness timestamp.

### Findings covered

| # | Summary | Location |
|---|---------|----------|
| 1 | Cash SELECT → check → UPDATE has no transaction/row lock | `src/lib/paper.ts:172-218` |
| 2 | LIMIT/STOP orders don't reserve cash | `src/app/api/paper/order/route.ts:96-112` |
| 3 | Two fill engines: UI lib + cron duplicate | `src/lib/paper.ts:166-270` vs `scripts/surveillance-cron.ts:1232-1278` |
| 4 | Cash KPI inconsistent with realized P&L | precision/ordering bug; root-cause needed |
| 6 | No market-hours gate on MARKET orders | `src/lib/paper.ts:11-25`, fetchLivePrice |
| 7 | Stale price fallback silently uses buy_price | `src/lib/paper.ts:106-121` computeAccountEquity |
| codex-a | `UPDATE paper_orders SET status='FILLED'` missing `AND status='PENDING'` | `src/lib/paper.ts:215, 265` |
| codex-b | `UPDATE paper_trades SET status='CLOSED'` missing `AND status='OPEN'` | `src/lib/paper.ts:257` |
| codex-c | fillPrice not validated > 0 & finite → NaN quantity risk | `src/lib/paper.ts:192, 252` |
| codex-d | SELL trusts order.trade_id without account/symbol binding | `src/lib/paper.ts:221` |

### Required implementation

1. **Refactor `fillOrder` into a transactional unit.** Wrap the entire BUY and SELL paths in `pool.getConnection()` → `conn.beginTransaction()` → … → `conn.commit()` / `conn.rollback()`. Use `FOR UPDATE` on order + account + trade SELECTs.

2. **Atomic cash move pattern.** Replace `SELECT cash` → compare → `UPDATE cash - ?` with:
   ```sql
   UPDATE paper_accounts
      SET cash = cash - ?
    WHERE id = ?
      AND cash >= ?
   ```
   Check `affectedRows === 1`; else rollback with 'INSUFFICIENT_CASH' rejection.

3. **Status-guarded status transitions.**
   - `UPDATE paper_orders SET status='FILLED' ... WHERE id=? AND status='PENDING'`
   - `UPDATE paper_trades SET status='CLOSED' ... WHERE id=? AND status='OPEN'`
   Check `affectedRows`; if 0 → rollback + log.

4. **Cash reservation for PENDING BUY.** On `POST /api/paper/order` for LIMIT/STOP BUY, atomically debit `paper_accounts.cash` into a new `paper_accounts.reserved_cash` column (schema migration). On fill, release reservation + do the actual debit. On cancel/reject, release reservation back to cash.

   New schema migration:
   ```sql
   ALTER TABLE paper_accounts ADD COLUMN reserved_cash DECIMAL(18,4) NOT NULL DEFAULT 0;
   ```
   Add to `src/lib/migrations.ts` ensureSchema flow.

5. **Unify fill engines.** Extract `src/lib/paper-fill.ts` with a single `fillOrder(orderId, fillPrice, conn)` function. Call from:
   - `src/lib/paper.ts:fillPendingOrders` (UI path)
   - `scripts/surveillance-cron.ts:1232-1278` (cron path)
   Delete the duplicate in surveillance-cron.ts; it calls the shared module.

6. **Account-scoped SELL.** When resolving `order.trade_id`, require:
   ```sql
   SELECT * FROM paper_trades
    WHERE id=? AND account_id=? AND symbol=? AND status='OPEN'
   FOR UPDATE
   ```
   Reject with 'TRADE_MISMATCH' if 0 rows.

7. **fillPrice validation.** Reject fill if `!(Number.isFinite(fillPrice) && fillPrice > 0)`. Apply in both `fillOrder` and at the boundary in `fetchLivePrice` (return null on non-finite / ≤ 0).

8. **Market-hours + staleness.** Extend `fetchLivePrice` return type:
   ```ts
   type LivePrice = { price: number; asOf: Date; isLive: boolean; regularMarketTime: number };
   ```
   Compute `isLive = (now - regularMarketTime) < 60_000 && isRTH(now)`. Helper `isRTH(d: Date)` checks weekday + 09:30-16:00 ET.
   - MARKET orders reject with 'MARKET_CLOSED' if `!isLive`.
   - LIMIT/STOP orders pend regardless (they wait for trigger).
   - `/api/paper` response includes `asOf` per position mark.

9. **Root-cause the cash/realized-P&L inconsistency (#4).** Query the live Railway DB:
   ```sql
   SELECT cash, initial_cash FROM paper_accounts WHERE name='Default';
   SELECT id, symbol, buy_price, sell_price, pnl_usd, investment_usd, quantity, status FROM paper_trades WHERE account_id=<id> ORDER BY id;
   ```
   Reconcile. Expected: `cash = initial_cash + SUM(pnl_usd for CLOSED)`. If mismatched, identify whether (a) precision loss, (b) missing cash update for one of the 3 trades, or (c) an incomplete reset. Document finding + add reconciliation SQL to plan file. Then fix: ensure the new transactional fill path maintains this invariant, and add a `paper_accounts.reconcile()` SQL view or script that can be run ad-hoc.

10. **Lightweight smoke test.** Create `scripts/smoke-test-paper-w1.js` that:
    - Resets the Default account (test account only — NOT on live data; use a fresh Default copy if possible or guard with env flag)
    - Fires 20 concurrent MARKET BUYs for $10k each against $100k cash — asserts exactly 10 fill, 10 reject with 'INSUFFICIENT_CASH'
    - Fires 5 parallel SELLs against the same trade_id — asserts exactly 1 fill
    - Passes `fillPrice=0` / `fillPrice=NaN` through internal fillOrder — asserts rollback + 'INVALID_PRICE'
    - Verifies `paper_accounts.cash + reserved_cash + positions_value = equity` invariant at end.

### Acceptance criteria

- [ ] All 10 sub-tasks above completed
- [ ] `npm run build` passes locally
- [ ] Smoke test `node scripts/smoke-test-paper-w1.js` passes against local tunnel DB
- [ ] Migration runs cleanly (verified via `railway run` against production — **DO NOT APPLY TO PROD YET**, just syntax-check with `EXPLAIN` or dry-run in a local copy)
- [ ] PR opened on GitHub with diff ready for codex critique
- [ ] Root cause of #4 documented in PR body
- [ ] No regressions in `surveillance-cron.ts` — cron's existing order fills still work via the shared module

### Files expected to change

- `src/lib/paper.ts` (major refactor)
- `src/lib/paper-fill.ts` (NEW — shared fill module)
- `src/app/api/paper/order/route.ts` (reservation on submit, cancel refund)
- `src/app/api/paper/account/route.ts` (reset clears reserved_cash too)
- `src/app/api/paper/route.ts` (include reserved_cash + asOf in response)
- `src/app/paper/page.tsx` (display "Reserved" + stale indicator)
- `src/lib/migrations.ts` (add reserved_cash column)
- `scripts/surveillance-cron.ts` (delete duplicate fillOrder, call shared module)
- `scripts/smoke-test-paper-w1.js` (NEW)
- One migration file `scripts/migration-2026-04-21-paper-w1.sql`

### Out of scope for W1

- LIMIT OHLC correctness (moved to W2)
- Slippage/commission (W4)
- Short selling (W3)
- UI polish (W5)
- Multi-user auth (W5)

---

## W2 — Data integrity (EXECUTING)

### Goal

On top of W1's correct foundation, make the paper-trading DASHBOARD stop lying. Equity snapshots must actually be written (table exists, nothing writes to it). Win-rate must exclude scratched trades. Strategy attribution must be real (FK not string). The split between `paper_trades` and `paper_signals` must be explicit with a reconciliation view. STOP orders must be reachable from the UI. LIMIT fills should honor the intraday range (best-effort) so limit orders don't silently miss a price that pierced them between polls. Trade history must be filterable and exportable.

### Findings covered (original critique numbering)

| # | Summary | Location |
|---|---------|----------|
| 5 | LIMIT orders don't model intraday OHLC; miss fills between polls | `src/lib/paper.ts:fillPendingOrders` |
| 12 | `paper_equity_snapshots` table exists but nothing writes to it | `src/lib/paper-fill.ts` (fill path) + new hourly cron |
| 13 | `paper_trades` vs `paper_signals` are disconnected cash streams | view / reconciliation script |
| 14 | Win-rate counts scratched trades; uses `pnl_usd > 0` | `src/app/api/paper/route.ts:100-101` |
| 15 | `Strategy` column stores `"MARKET BUY"` not a real FK | `src/lib/paper-fill.ts`, `paper_trades` schema |
| 24 | No date/symbol/outcome filter; no CSV export | `src/app/paper/page.tsx` trade history section |
| STOP-UI | Backend supports STOP orders but UI exposes only MARKET/LIMIT | `src/app/paper/page.tsx:240-248` |

### Required implementation

1. **Write equity snapshots.** Add `recordEquitySnapshot(accountId)` utility. Call from:
   - `src/lib/paper-fill.ts:fillOrder` on any successful fill OR soft-reject that changed cash
   - `src/lib/paper.ts:fillPendingOrders` at end of each batch (so idle time still gets hourly-ish data)
   - A new hourly cron hook in `scripts/surveillance-cron.ts` that takes a snapshot for every non-dormant account once per hour during RTH
   Schema already has `paper_equity_snapshots(account_id, captured_at, cash, reserved_cash, positions_value, equity, realized_pnl)` — verify columns match what we need, add any missing.

2. **Fix win-rate math.** In `src/app/api/paper/route.ts`:
   - Exclude `pnl_usd = 0` (scratched) from both numerator and denominator
   - Add `profit_factor = SUM(pnl where pnl>0) / ABS(SUM(pnl where pnl<0))` (return `Infinity` JSON-safe sentinel if denominator is 0)
   - Add `scratched_count` so UI can show `23 wins · 17 losses · 3 scratched`
   - Update `src/app/paper/page.tsx` KPI card accordingly

3. **Strategy attribution as FK.** 
   - Schema: add `paper_trades.strategy_id INT NULL REFERENCES paper_strategies(id)` (keep existing `strategy` string for backward-compat display, but it becomes a denormalized label).
   - Migration: backfill NULL for all existing rows. Do NOT attempt to reverse-parse the old `"MARKET BUY"` strings — leave them as historical labels.
   - Fill path: when `fillOrder` is called from the cron with a known strategy_id (passed from `surveillance-cron.ts`), persist it. Manual UI trades get `strategy_id = NULL` + `strategy = 'MANUAL BUY' / 'MANUAL SELL'`.
   - UI: trade history shows `strategy || '(manual)'`, clickable to open strategy-dashboard filtered to that id.

4. **Reconcile `paper_trades` vs `paper_signals`.**
   - Create `scripts/reconcile-paper-accounts.sql` — the manual home promised by W1's M1 fix.
   - Create a DB VIEW `v_paper_account_activity` that UNIONs both tables into a single `(account_id, event_type, symbol, amount_usd, at_timestamp)` shape for audit/dashboard purposes.
   - Document that `paper_trades` is owned by the UI + manual testing, `paper_signals` is owned by the strategy engine. Both mutate `paper_accounts.cash`. The reconciliation invariant per account: `cash + reserved_cash + SUM(open investment from trades + signals) = initial_cash + SUM(closed PnL from trades + signals)`.
   - Add `scripts/smoke-test-paper-w2.js` that asserts the invariant across BOTH tables for Default account + a handful of strategy accounts.

5. **STOP UI.** Add "Stop" to the order-type dropdown in `src/app/paper/page.tsx`. When Stop is selected, enable the Stop-price input (the existing Limit-price field becomes a Stop-price field conditionally). Wire the POST body correctly.

6. **LIMIT OHLC best-effort fill.** In `fillPendingOrders` (UI path) AND the cron path:
   - For each pending LIMIT order, fetch the intraday 5-min bars since `orders.created_at` (Yahoo chart endpoint supports `interval=5m&range=1d`).
   - Determine if the limit price was pierced within the window. If yes, fill at the limit price (for BUY limit, the fill price is MIN(current, limit) honored via limit; for SELL, MAX). Record `fill_rationale: 'OHLC_TOUCH'` in order notes.
   - Keep the existing spot-price check as fallback (`fill_rationale: 'SPOT'`) for orders placed in the current poll cycle.
   - Scope-guard: if Yahoo doesn't return bars for the symbol, fall back silently to spot check and log the miss. Do NOT fail the entire `fillPendingOrders` batch on one bad symbol.

7. **Trade history filters + CSV export.** In `src/app/paper/page.tsx`:
   - Collapse the existing trade history into a component with local-state filters: symbol substring, date range, outcome (win/loss/scratched), strategy dropdown.
   - Add "Export CSV" button — client-side, no new API endpoint needed. Columns: `id, symbol, strategy, side, buy_date, buy_price, quantity, investment_usd, sell_date, sell_price, pnl_usd, pnl_pct, held_days, status`.
   - Add a "Held days" computed column in the UI.

### Acceptance criteria

- [ ] Migration `scripts/migration-2026-04-21-paper-w2.sql` — adds `strategy_id` FK, any missing equity_snapshots columns. Idempotent.
- [ ] `paper_equity_snapshots` has at least N rows for Default after smoke test (where N = 3: one per fill in the smoke test batch)
- [ ] Win-rate card shows separated counts (wins / losses / scratched) and `profit_factor`
- [ ] Trade history shows real strategy names for cron-generated trades once a strategy-engine run happens; `(manual)` for manual ones
- [ ] STOP order reaches FILLED when triggered by smoke test
- [ ] LIMIT orders fill when intraday OHLC touches limit price, even if spot is back above (for BUY) at check time — verify with a synthetic test using a past day's bars
- [ ] Trade history filter inputs work; CSV export downloads valid CSV
- [ ] `npm run build` passes
- [ ] `node scripts/smoke-test-paper-w2.js` passes against local tunnel DB — exercises all 6 features (snapshot writes, win-rate math, strategy_id persistence, reconciliation invariant, STOP fill, LIMIT OHLC fill)
- [ ] PR opened on GitHub
- [ ] Follow-up codex critic round via parallel per-file single-file reviews (lesson from W1: never feed codex a multi-file prompt)

### Files expected to change
- `src/lib/paper-fill.ts` — recordEquitySnapshot calls, strategy_id in INSERT
- `src/lib/paper.ts` — OHLC fetch, passes bars to fill logic
- `src/app/api/paper/route.ts` — win-rate math, scratched count, profit factor
- `src/app/paper/page.tsx` — STOP UI, filters, CSV export, new KPI display
- `src/lib/migrations.ts` — strategy_id FK, ensure snapshots columns
- `scripts/surveillance-cron.ts` — hourly snapshot hook, strategy_id passed through
- `scripts/migration-2026-04-21-paper-w2.sql` (NEW) — additive only
- `scripts/reconcile-paper-accounts.sql` (NEW) — audit queries, no mutations
- `scripts/smoke-test-paper-w2.js` (NEW)

### Out of scope for W2

- Short selling (W3)
- Protective exits on manual trades (W3)
- Slippage/commission (W4)
- Whitelist/fractional (W4)
- Multi-account (W5)
- Full `paper_signals → paper_trades` migration (deferred indefinitely unless invariant drift returns)

---

## W3 — Shorts + protective exits + partial close (EXECUTING)

### Goal

Close the "not a real paper simulator" gap. After W3 you can paper-trade SHORT signals (half the strategy catalog), every manual position has stop-loss / take-profit / trailing / time-exit protection (currently only `paper_signals` do), positions can be partially scaled out, and pending LIMIT orders can be modified without cancel-and-replace.

### Findings covered

| # | Summary | Location |
|---|---------|----------|
| 9 | No short selling — schema is BUY-first, SELL only closes | `paper_trades` schema, `src/lib/paper-fill.ts` |
| 10 | No protective exits on manual positions | strategy configs have `trailing_stop_pct` etc; `paper_trades` has none |
| 15 | Partial close not supported | `src/app/paper/page.tsx` SELL button |
| U4 | Pending LIMIT orders are view-only (cancel only, no modify) | `src/app/paper/page.tsx` pending orders list |

### Required implementation

1. **Schema — add side + exit bracket columns to `paper_trades`.**
   - `side ENUM('LONG','SHORT') NOT NULL DEFAULT 'LONG'` — existing rows become LONG (backward compat)
   - `stop_loss_price DECIMAL(18,6) NULL` — absolute price; engine closes if breached
   - `take_profit_price DECIMAL(18,6) NULL` — absolute price
   - `trailing_stop_pct DECIMAL(10,4) NULL` — e.g., 3.0000 = 3%
   - `trailing_activates_at_profit_pct DECIMAL(10,4) NULL` — activate trailing once this profit reached
   - `trailing_stop_price DECIMAL(18,6) NULL` — current ratcheted stop price (engine maintains)
   - `trailing_active TINYINT(1) NOT NULL DEFAULT 0` — 0 until profit threshold hit
   - `time_exit_date DATE NULL` — engine closes at or after this date
   - `max_pnl_pct DECIMAL(10,4) NULL` — watermark (for trailing + analytics)
   - `min_pnl_pct DECIMAL(10,4) NULL` — watermark
   - `borrow_daily_rate_pct DECIMAL(10,6) NOT NULL DEFAULT 0` — placeholder, real modeling in W4
   - `closed_quantity DECIMAL(18,6) NOT NULL DEFAULT 0` — for partial close tracking; `remaining_quantity = quantity - closed_quantity`
   
   Mirror the semantics of `paper_signals` which already uses these concepts. Look at `scripts/surveillance-cron.ts` around the monitor loop for the exit-price evaluation pattern. Do NOT copy-paste the cron's logic into paper-fill.ts — extract it into a shared module `src/lib/paper-exits.ts` that BOTH paper_trades and paper_signals can use (delete the duplicate in surveillance-cron.ts).

2. **Fill engine — SHORT side.** In `src/lib/paper-fill.ts`:
   - SHORT_OPEN (equivalent of "SELL short" opening): debits cash into a MARGIN hold (new `paper_accounts.reserved_short_margin` column OR reuse `reserved_cash` with a marker — pick the cleaner one). Quantity = investment / fillPrice. Position is OPEN with `side='SHORT'`.
   - BUY_TO_COVER (closing a SHORT): pays `remaining_quantity * fillPrice` to close out. Returns the margin to cash. P&L = `(entry_price - fillPrice) * remaining_quantity`.
   - Fill path must correctly handle both LONG and SHORT in all existing code paths (reservation, release, market-hours gate, OHLC limit fill). Smoke test MUST include both sides.
   - Borrow cost: NO actual accrual yet — just persist `borrow_daily_rate_pct = 0` on SHORT opens. W4 will model it.

3. **Exit engine — shared `src/lib/paper-exits.ts`.** Extract from `scripts/surveillance-cron.ts` the logic that evaluates each open position against:
   - Hard stop: if breached, close at current price, reason='HARD_STOP'
   - Take profit: if hit, close at current price (or take-profit price for LIMIT-like exits), reason='TAKE_PROFIT'
   - Trailing stop: if `trailing_active=1` and current price breaches `trailing_stop_price`, close, reason='TRAILING_STOP'. If not yet active but profit ≥ `trailing_activates_at_profit_pct`, activate and set `trailing_stop_price`. Maintain `max_pnl_pct`/`min_pnl_pct` watermarks.
   - Time exit: if current date ≥ `time_exit_date`, close at current price, reason='TIME_EXIT'
   
   The shared module exposes `evaluateExits(positionRow, currentPrice, now): ExitDecision | null` and `applyExitDecision(conn, positionRow, decision): Promise<void>`. Both `paper_trades` and `paper_signals` adapters call it.
   
   A new cron hook `monitorPaperTrades()` in `scripts/surveillance-cron.ts` runs every 15 min during RTH, loads open `paper_trades`, fetches live prices, evaluates exits, closes positions that trigger. Delete or gut the duplicate logic that monitored `paper_signals` and call the shared module instead.

4. **Partial close** — API + engine + UI.
   - Add `POST /api/paper/order` accepts `close_quantity?: number` for SELL orders. If omitted, close full remaining_quantity.
   - Engine: updates `paper_trades.closed_quantity += close_quantity`. If `closed_quantity >= quantity`, marks CLOSED. Otherwise stays OPEN with reduced remaining. `pnl_usd` is accumulated (sum of all partials). Cash credited per-partial.
   - UI: replace the single "SELL" button on open positions with "Close 25% / 50% / All / Custom" dropdown/buttons.
   - Smoke test must include a position opened at qty=10, closed in 3 partials (3, 3, 4) with P&L reconciliation assertion.

5. **Order modify** — API + UI.
   - Add `PATCH /api/paper/order?id=<id>` accepting `{ limit_price?: number, stop_price?: number, investment_usd?: number }`. Only allowed on PENDING orders. If `investment_usd` changes, re-reserve the delta atomically (like reserveCashForOrder but for a diff).
   - UI: the pending order card gets an "Edit" button that opens a small inline form for limit price (+ amount).

6. **UI surfacing for exit brackets on manual opens.**
   - BUY form gets optional fields: Stop-loss % (or $), Take-profit %, Trailing %, Time-exit days.
   - Auto-compute `stop_loss_price` etc. from the limit/spot fill price at order placement (or compute at fill time — pick one, document).
   - Display the bracket on open-position cards: small chips showing "SL $95.00 · TP $110.00 · Trail 3%".

### Migration safety

- All new columns nullable or have sensible defaults (LONG for `side`, 0 for `closed_quantity`, etc.). Existing rows must work unchanged.
- FK/index considerations: index `paper_trades(status, time_exit_date)` for the exit scanner.
- Migration gated via INFORMATION_SCHEMA for idempotency (same pattern as W2).
- Manual reconcile file (`scripts/reconcile-paper-accounts.sql`) updated to include sanity checks on `closed_quantity <= quantity`, `side IN ('LONG','SHORT')`.

### Acceptance criteria

- [ ] `scripts/migration-2026-04-21-paper-w3.sql` — all new columns + index, idempotent
- [ ] `src/lib/paper-exits.ts` extracted, both `paper_trades` and `paper_signals` paths call it
- [ ] `src/lib/paper-fill.ts` handles LONG + SHORT opens/closes, including reservation semantics
- [ ] New cron hook `monitorPaperTrades` runs every 15 min during RTH; duplicate signal-monitor logic consolidated
- [ ] Partial close API + UI + engine correctness
- [ ] Order modify PATCH endpoint + UI
- [ ] BUY form exposes exit bracket options
- [ ] Open-position card displays bracket
- [ ] `npm run build` passes
- [ ] `node scripts/smoke-test-paper-w3.js` — asserts:
  - SHORT open → margin reserved; cover → cash credited + margin returned; P&L sign correct
  - LONG with stop_loss triggers close at stop price; cash balance correct after
  - Trailing stop activates at threshold + ratchets as price advances
  - Time-exit closes at deadline
  - Partial close (qty=10 → 3+3+4) reconciles P&L to sum
  - Modify PATCH updates limit_price atomically with reservation delta
  - LONG behavior unchanged (regression guard) — all W1/W2 smoke cases still pass if re-run
- [ ] PR opened, codex per-file reviews run in parallel

### Files expected to change

- `src/lib/paper-fill.ts` — SHORT paths, bracket capture on open
- `src/lib/paper-exits.ts` (NEW) — shared exit evaluator
- `src/lib/paper.ts` — any SHORT-related adjustments in fillPendingOrders
- `src/app/api/paper/order/route.ts` — partial close, PATCH endpoint, bracket fields
- `src/app/api/paper/route.ts` — expose bracket + side in response shape
- `src/app/paper/page.tsx` — BUY form brackets, partial close, modify, short display
- `src/lib/migrations.ts` — new columns via ensureSchema
- `scripts/surveillance-cron.ts` — gut signal-monitor, add monitorPaperTrades, both use shared exits
- `scripts/migration-2026-04-21-paper-w3.sql` (NEW)
- `scripts/smoke-test-paper-w3.js` (NEW)
- `scripts/reconcile-paper-accounts.sql` — sanity checks for new columns

### Out of scope for W3

- Actual borrow cost accrual (W4 — just persist `borrow_daily_rate_pct=0` for now)
- Commission (W4)
- Slippage (W4)
- Position sizing as % of equity (W4)
- Symbol whitelist (W4)
- Multi-account (W5)

---

## W4 — Risk model (EXECUTING parallel)

### Goal
Make P&L honest. Today's engine fills at exact mid with zero spread, zero commission, zero borrow cost — inflating reported returns vs any real broker. W4 wires economic realism.

### Findings covered
- #16 Zero slippage on market orders
- #17 Zero commission
- #18 No position sizing by risk (only fixed $)
- #19 Symbol regex too permissive (accepts crypto, nonsense)
- #20 High-priced tickers silently fractionalize
- W3 follow-up: borrow_daily_rate_pct persisted but never debited

### Required implementation

1. **Slippage model.** New `src/lib/paper-risk.ts` module. Function `applySlippage(fillPrice, side, amount, cfg): number`. Default cfg: `5bps` adverse (market orders). For LIMIT, apply 0 by default (you got the limit or better; model assumes you didn't pay to cross spread — unless order_type forces touch). Hook into `fillOrderCore` in `paper-fill.ts` before the trade row is written. Slippage cfg lives in `app_settings` table (per W2 pattern) with defaults seeded.

2. **Commission.** In `paper-risk.ts`: `applyCommission(tradeSizeUsd, shares, cfg): number`. Default cfg: `$0.005/share` with `$1.00 min` per leg (mirrors Alpaca). Stored in `app_settings`. Commission DEBITS cash at fill time (in the same transaction — preserve lock order). Recorded on `paper_trades.commission_usd` (new column).

3. **% position sizing.** Extend buy form in `src/app/paper/page.tsx` with a toggle: `$ Fixed` | `% of equity` | `% risk on stop`. For `% of equity`: `investment = equity * pct / 100`. For `% risk on stop`: requires stop_loss_price from W3; `investment = (equity * risk_pct / 100) / stop_distance_pct`. Compute client-side, send resulting `investment_usd` to API.

4. **Symbol whitelist.** New table `tradable_symbols(symbol VARCHAR(16) PRIMARY KEY, exchange, asset_class, active BOOLEAN)`. Seed from a CSV of NASDAQ + NYSE listings (find a public one; simplest — pull from `ftp://ftp.nasdaqtrader.com/symboldirectory/nasdaqlisted.txt` + `otherlisted.txt`). On order submit, validate symbol ∈ `tradable_symbols WHERE active=1 AND asset_class='EQUITY'`. Reject with `SYMBOL_NOT_TRADABLE`. Also add a script `scripts/sync-tradable-symbols.ts` to refresh the list nightly.

5. **Fractional vs whole-share mode.** Add `app_settings.allow_fractional_shares BOOLEAN DEFAULT true`. When false, `fillOrderCore` rounds `quantity` to integer (floor); if result is 0 shares, reject with `INSUFFICIENT_INVESTMENT`. UI shows a warning: "At current price, $100 = 0 shares of BRK.A ($700k). Increase to $710k min or enable fractional."

6. **Borrow cost accrual.** Nightly cron job in `surveillance-cron.ts`: for every `OPEN SHORT` with `borrow_daily_rate_pct > 0`, debit `position_value_usd * rate/365`. Record on `paper_accounts.cash` (NOT reserved_short_margin). Log in `surveillance_logs`. Run at 17:00 ET daily (post-close). Skip weekends. Default `borrow_daily_rate_pct = 2.5` (2.5% annualized — typical for liquid large-caps; set in the UI when opening short).

### Schema additions (migration `2026-04-21-paper-w4.sql`)
- `paper_trades.commission_usd DECIMAL(18,6) NOT NULL DEFAULT 0`
- `paper_trades.slippage_usd DECIMAL(18,6) NOT NULL DEFAULT 0`
- `tradable_symbols` new table
- `app_settings` rows for slippage_bps, commission_per_share, commission_min, allow_fractional_shares, default_borrow_rate_pct

### Acceptance criteria
- `node scripts/smoke-test-paper-w4.js` passes with assertions: $100 market BUY @ $100 with 5bps slippage fills at $100.05, commission $1 (min floor), so position cost $101, tracked. SHORT held for 7 days at 2.5% annualized debits `position_value * 0.025 * 7/365 ≈ 0.048%` of investment per week. Invalid symbol "NONSENSE" rejected with SYMBOL_NOT_TRADABLE.
- `npm run build` passes
- Migration idempotent via INFORMATION_SCHEMA gates
- Existing smoke tests (W1/W2/W3) still pass — they may need expected-value updates since slippage/commission now subtract from P&L; update ONLY tests, never the formula
- PR opened, codex per-file critic pass

### Files expected to change
- `src/lib/paper-risk.ts` (NEW)
- `src/lib/paper-fill.ts` (hook slippage + commission into fill path)
- `src/app/api/paper/order/route.ts` (validate against whitelist)
- `src/app/paper/page.tsx` (sizing toggle, whitelist feedback, fractional warning)
- `src/app/api/paper/settings/route.ts` (NEW — CRUD for risk settings; simple key-value read/write)
- `src/app/settings/page.tsx` (new section for risk settings)
- `src/lib/migrations.ts`
- `scripts/surveillance-cron.ts` (borrow cost accrual job)
- `scripts/sync-tradable-symbols.ts` (NEW)
- `scripts/migration-2026-04-21-paper-w4.sql` (NEW)
- `scripts/smoke-test-paper-w4.js` (NEW)

### Out of scope for W4
- Live market data (other than Yahoo for quote, already wired)
- FX / non-USD
- Option chains / derivatives

---

## W5 — UX guardrails + multi-account (EXECUTING parallel)

### Goal
Sharp edges sanded down. Today: reset wipes everything on a single browser `confirm()`; rapid double-clicks create duplicate orders; rejections disappear silently; pending-order cards don't show distance from current price; the UI shows browser local time while trading is ET. After W5: these all fixed + you can create/switch between multiple named paper accounts.

### Findings covered
- #21 Reset is one-click footgun
- #22 Rapid double-click places two orders
- #23 Rejection reasons hidden
- #25 Pending limits show raw prices with no context
- #26 "Last updated" is browser-local, market time mismatch  
- #27 Single shared "Default" account

### Required implementation

1. **Reset gate.** Replace `window.confirm()` with a modal that requires the user to type literally `RESET <account-name>` to enable the Reset button. Before reset fires, auto-export an archive: trigger CSV download of closed trades + equity snapshots + account state. File: `reset-archive-<account-name>-<timestamp>.csv`. Only after the download starts does the actual DELETE run.

2. **Idempotency.** 
   - Client: generate a `clientRequestId` UUID on every Buy/Sell form submit. Disable the submit button **before** the fetch starts (not on response). Re-enable only on response.
   - Server: add `paper_orders.client_request_id VARCHAR(64) UNIQUE NULL`. On `POST /api/paper/order`, if the body has `client_request_id` and a row with that id already exists, return the existing row instead of inserting a duplicate. 
   - Idempotency window: `client_request_id` is unique for 24 hours; older ones can be reused (client generates fresh ones per form submit anyway).

3. **Rejection toast system.** Install a lightweight toast library or hand-roll (e.g., `sonner` is small). On any API response with `error`, show a toast in the bottom-right with the full rejection reason. Tap to dismiss, auto-dismiss after 6 seconds. Rejection reasons are already in the API responses (from W1 SOFT_REJECT / HARD_REJECT codes). Surface ALL of them including the full technical code (`ORDER_NOT_PENDING_FILLED` etc.) — user wants to see what broke.

4. **Pending order context.** On each pending order card in `src/app/paper/page.tsx`, compute client-side the `% distance from live price` using the last known spot price for that symbol. Display: `LIMIT $300.00 (−24.8% from live $399.27)`. Color the distance: green if within 2% of live (likely to fill soon), grey if between 2-10%, red if > 10% (unlikely). Auto-refresh every 30s (already exists).

5. **Time display.** Top of every page, show `ET: <time> · Local: <time>` using `Intl.DateTimeFormat`. Compute ET via `timeZone: 'America/New_York'`. Highlight the current trading session state: Pre-Market / Open / After-Hours / Closed (based on weekday + time). Already partially shown in the existing header; extend to also display local.

6. **Multi-account.** 
   - Users can create multiple named paper accounts. Schema already has `paper_accounts.name`; user selects via dropdown.
   - Add "Create account" flow: name + initial cash. Default ($100k Default) stays as-is.
   - Account switcher in the `/paper` page top bar. Persists selection in localStorage.
   - API endpoints accept optional `?account_id=<n>` or read from session. For MVP: account selection is client-side only (localStorage key); server reads from query param. No auth-per-user required yet.
   - Scope: paper_orders + paper_trades are already keyed by `account_id`; just need the UI to expose the selection.

### Schema additions (migration `2026-04-21-paper-w5.sql`)
- `paper_orders.client_request_id VARCHAR(64) NULL UNIQUE`
- Index on `(client_request_id)` for fast dedup lookup

### Acceptance criteria
- `node scripts/smoke-test-paper-w5.js` passes: idempotency dedup via client_request_id works (two POSTs with same id = one order); reset modal blocks without typed confirmation; pending order card shows distance-from-live; multi-account switcher creates + swaps accounts without data leaking between them.
- `npm run build` passes
- Manual Playwright: click Buy twice rapidly → exactly 1 order. Click Reset → modal appears → type wrong → button stays disabled → type correctly → CSV downloads + DELETE fires. Switch accounts → trade history changes.
- Migration idempotent
- Existing W1-W4 smokes still pass
- PR opened, codex per-file critic pass

### Files expected to change
- `src/app/paper/page.tsx` (reset modal, idempotency hook, rejection toasts, pending context, account switcher, time display)
- `src/app/api/paper/order/route.ts` (accept + dedup on client_request_id)
- `src/app/api/paper/account/route.ts` (support ?account_id=)
- `src/app/api/paper/accounts/route.ts` (NEW — list + create)
- `src/app/api/paper/route.ts` (support ?account_id=)
- `src/components/Toast.tsx` (NEW) — or install sonner
- `src/components/ResetConfirmModal.tsx` (NEW)
- `src/components/AccountSwitcher.tsx` (NEW)
- `src/lib/migrations.ts`
- `scripts/migration-2026-04-21-paper-w5.sql` (NEW)
- `scripts/smoke-test-paper-w5.js` (NEW)

### Out of scope for W5
- True auth-per-user (W5 scope is multi-account, single user; true multi-user auth is a future wave)
- Mobile-responsive redesign
- Dark mode

---

## Progress log (continued)

| Date | Wave | Status | Notes |
|------|------|--------|-------|
| 2026-04-21 | W3 | MERGED | PR #13 squash-merged `45e32d0`. 74/74 + 24/24 smoke. Codex found 4: PF1 correctly rejected mathematically (current formula correct), PF2/C1/C2 fixed round-2. Migration applied to Railway prod: 12 new cols on paper_trades + 3×reserved_short_margin. Existing rows backfilled `side='LONG'`. |
| 2026-04-21 | Scenario v1+v2 | MERGED | PR #14 `908e694`. 99/99 tests. 5 presets, F1 cohort filter, F2 ticker filter, F3 recurrence badges, F4 price-in-cells. F1 default-checked bug caught via Playwright, fixed via useEffect seed. |
| 2026-04-21 | W3-hotfix | IN PROGRESS | Codex post-merge review found 3 bugs in shipped W3 code: (1) paper-exits.ts:358 pnl_pct slice-based vs pnl_usd total mismatch after partial-close + auto-exit — data corruption. (2) DELETE /api/paper/order non-atomic refund + status flip — race. (3) PATCH /api/paper/order partial-success on adjustReservation + patchPendingOrderPrices split. Plus matrix-scenarios asOfKey day-only compare. Hotfix blocks W4. |
| 2026-04-21 | W4 | QUEUED | Full brief written. Waits for W3-hotfix to land so paper-fill.ts base is clean. |
| 2026-04-21 | W5 | QUEUED | Full brief written. Can run parallel with W4 once hotfix lands. |

---

## Progress log

| Date | Wave | Status | Notes |
|------|------|--------|-------|
| 2026-04-21 | Plan | DRAFTED | W1 brief written in full |
| 2026-04-21 | W1 | MERGED | PR #11 squash-merged at commit `ad15255`. Migration applied to Railway prod (both columns present). Smoke 28/28 passing. Codex found 5 critical + 2 high + 3 medium in review, all addressed in round-2 fixup. |
| 2026-04-21 | W1 post-merge | DONE | D1 reconciled (Default cash drift $30.71 → 0). D2 cancelled legacy orphan MSFT PENDING order with no reservation backing. |
| 2026-04-21 | W2 | MERGED | PR #12 squash-merged at commit `5c89b27`. 31/31 smoke tests. Codex (4 of 5 parallel single-file reviews returned; OHLC review hung — self-audited instead) found 6 issues: snapshot error-swallow, cron strategy_id not wired, win_rate_pct silent meaning change, view sign bug, SET NULL claim mismatch, FK dep not gated. All 6 fixed in round-2 + 5 OHLC safety properties A–E documented/fixed. Migration applied to Railway prod cleanly. `v_paper_account_activity` view verified with net_flow = $30.71 matching realized P&L. |
| 2026-04-21 | W3 | IN PROGRESS | Full brief written. Sub-agent spawning. Biggest wave: shorts, protective exits, partial close, order modify, shared exit engine. |
