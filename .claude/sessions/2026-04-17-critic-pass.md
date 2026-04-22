# Second-Order Critic Pass — 2026-04-17

**Scope:** files outside the first audit — `src/lib/paper.ts`, `src/lib/surveillance.ts`, `src/lib/reversal.ts`, `src/lib/migrations.ts`, `src/lib/data.ts`, `src/app/api/**` (non-strategies), `src/app/paper/page.tsx`, `src/app/reversal/page.tsx`. First audit's 20 findings NOT re-listed.

---

## P0 — Security / data corruption

### P0-A. No auth on `POST /api/paper/order` — anyone on the internet can drain the account
**File:** `src/app/api/paper/order/route.ts:30`, `src/app/api/paper/account/route.ts:36`
The surveillance/sync route is gated by `SYNC_SECRET`. `/api/paper/order` and `/api/paper/account` (which **DELETE-s all trades and resets cash** on POST) have zero auth. The VPS is publicly reachable. A bot can spray MARKET BUY orders on garbage tickers, fill them at live prices, and watch the account equity go to zero; or just POST `/api/paper/account` in a loop to erase the live paper-trading experiment every few seconds.
**Fix:** Reuse the `SYNC_SECRET` guard (or introduce `API_SECRET`) on every state-mutating route: `paper/order`, `paper/account`, `reversal/POST`, `reversal/[id]/PATCH+DELETE`, `backtest/run`, `data/refresh`.

### P0-B. `paper_trades` live PnL ignores SHORT direction (same class as first-audit's P0-6, different file)
**File:** `src/app/api/paper/route.ts:49-50` + `src/lib/paper.ts:84-121` (`computeAccountEquity`) + `src/app/paper/page.tsx:328-336`
```ts
pnlPct = ((currentPrice - buyPrice) / buyPrice) * 100;  // assumes LONG
pnlUsd = quantity * (currentPrice - buyPrice);
```
`paper_trades` has no `direction` column (unlike `paper_signals` which was backfilled). Any SHORT trade placed via `POST /api/paper/order` with `side='SELL'`…wait, actually the order API only opens LONG-style BUYs that later SELL — but the cron's `jobMonitorPositions` exits go into `paper_signals`, while user-placed BUYs live in `paper_trades`. So today this happens to be LONG-only. **But:** `computeAccountEquity` does `positions_value += qty * markPrice` which is a correct mark-to-market for LONGs. If a SHORT path is ever added (mentioned as a roadmap in the UI "Buy/Sell" form), equity will silently invert.
**Fix:** Add `direction` column to `paper_trades` via `ensureColumn` and gate PnL math on it now, before the SHORT UI lands.

### P0-C. `/api/reversal` POST + `/api/reversal/[id]` PATCH/DELETE are unauthenticated
**File:** `src/app/api/reversal/route.ts:78`, `src/app/api/reversal/[id]/route.ts:7,117`
Anyone can INSERT arbitrary cohort entries (poisons the d-column grid that drives live strategies) or DELETE real entries (paper_signals with `reversal_entry_id` FK would then fail on subsequent queries). PATCH lets an attacker write any price into `d1..d10_{morning,midday,close}` — which `jobExecuteConfirmationStrategies` reads to decide BUY/SELL entries. A malicious payload here directly moves money in paper_accounts (and would move real money if live trading is ever enabled).
**Fix:** Same secret guard. Also validate `body.final_pnl_usd` / `body.final_pnl_pct` as numbers before SQL-binding — they're currently passed straight through with no Number() check (line 56 in `/api/reversal/[id]/route.ts`).

### P0-D. `ensureColumn` is called on every request — schema drift disaster on concurrent deploys
**File:** `src/lib/migrations.ts:233` called by `src/app/api/paper/route.ts:18`, `src/app/api/paper/order/route.ts:32`, `src/app/api/paper/account/route.ts:11`, `src/app/api/reversal/route.ts:10,80` and more
Every GET `/api/paper` executes 16+ `CREATE TABLE IF NOT EXISTS` + ~30 `ALTER TABLE ADD COLUMN` + UNIQUE KEY add attempts. The `paper/page.tsx` UI polls `/api/paper` every 30s (line 81). With 3 users open in 3 browsers + the cron container, that's ~12 schema modification attempts per minute against MySQL. MySQL serializes DDL via metadata lock; under load one of these will deadlock with the cron's active INSERT into `paper_position_prices` and block the entire monitor tick. Also: init-db.sql's `paper_position_prices` schema already differs from migrations.ts (init-db has FK cascade from the first audit's fix; migrations.ts:209-215 does NOT) — if a dev hits `/api/paper` on a fresh dev-env DB before running init-db, they get a table without the FK and the schemas have silently diverged.
**Fix:** Run `ensureSchema()` once at process start (or via a migration CLI), not on every request. Guard with a module-level `schemaReady` Promise. Update migrations.ts to match init-db.sql's FK cascade.

---

## P1 — Silent failures / resource leaks

### P1-A. `paper/page.tsx` has a race on rapid BUY clicks → duplicate orders
**File:** `src/app/paper/page.tsx:88-121` (`handleBuy`)
`handleBuy` sets `busy=true` *after* the user-input validation returns, but the guard `disabled={busy}` on the BUY button only prevents **the next React paint's** click. A fast double-click (or Enter-key held) fires two fetch POSTs before `setBusy(true)` renders. Both succeed — `/api/paper/order` for MARKET BUY has no client-idempotency key. Result: two `paper_trades` rows, double cash deducted.
**Fix:** Move `setBusy(true)` to the top of `handleBuy` before any validation; or use `useRef` flag checked synchronously; or add an `Idempotency-Key` header and dedupe server-side on `paper_orders`.

### P1-B. `loadData` callback → 30s setInterval calls stale `account` state? No — but calls **race with in-flight request**
**File:** `src/app/paper/page.tsx:75-86`
`setInterval(loadData, 30000)` + manual `loadData()` from `handleBuy`/`handleSell`/refresh button can overlap. A slow `/api/paper` (which runs `fillPendingOrders`, 20+ Yahoo fetches, schema migrations — can take 5-10s) plus a user click 2s later triggers a second overlapping request. The later `setTrades(data.trades)` can arrive **before** the earlier one, so stale data clobbers fresh data (the classic "last response wins" bug). User sees a just-cancelled order reappear for 30s.
**Fix:** AbortController on each `loadData`; abort prior request before starting new.

### P1-C. `syncActiveSurveillance` has same TZ bug as the (now-fixed) cron — `CURRENT_DATE` + `getDay()` + UTC ISO string
**File:** `src/lib/surveillance.ts:177-180, 204-210`
The cron's `syncActiveSurveillance` path was patched with ET-safe helpers (per agent-log), but `src/lib/surveillance.ts` — called from `/api/surveillance/sync` (the HTTP-accessible path, not the cron) — retains the old mixed-TZ logic:
```ts
"UPDATE reversal_entries SET status = 'COMPLETED' WHERE status = 'ACTIVE' AND cohort_date < DATE_SUB(CURRENT_DATE, INTERVAL 14 DAY)"
obsDate.setDate(obsDate.getDate() + 1);  // local TZ
if (obsDate.getDay() === 0 || obsDate.getDay() === 6) continue;  // local
const dateStr = obsDate.toISOString().split('T')[0];  // UTC
```
Same P0-4 bug in the HTTP path. The HTTP endpoint is a manual override used from the reversal UI; every manual "Scan & Sync" click goes through this corrupted d-column writer.
**Fix:** Replace with the same `addCalendarDaysET`/`isWeekendET`/`todayET` helpers the cron uses. Delete one code path — either cron calls the lib or lib calls cron helpers, not two divergent copies.

### P1-D. `fetchIntradayPrice` and all Yahoo calls in `src/lib/` have no timeout
**File:** `src/lib/surveillance.ts:38-94`, `src/lib/paper.ts:11-25`, `src/lib/data.ts:35-51`
The cron added `fetchWithTimeout`; none of this propagated to `src/lib/`. Any hung Yahoo fetch from an API request wedges the Next.js request indefinitely until the platform-level timeout fires (usually 60-120s on Next dev, uncapped in prod container). A single slow Yahoo call on `/api/paper` GET while the user's page polls every 30s can queue up an unbounded number of hung fetches.
**Fix:** Extract `fetchWithTimeout` from the cron into `src/lib/http.ts` and import in both paths.

### P1-E. `strategy-engine.ts` `evaluateExit` — ALL exit math is LONG-only
**File:** `src/lib/strategy-engine.ts:120-183`
```ts
const pnlPct = ((pos.current_price - pos.entry_price) / pos.entry_price) * 100;  // LONG
const stopPrice = pos.entry_price * (1 + exits.hard_stop_pct / 100);  // LONG stop below entry
if (pos.current_price <= stopPrice) { return HARD_STOP }  // wrong for SHORT
```
`PositionState` type has no `direction` field. Every backtest and every strategy evaluation done via this engine is SHORT-incorrect. `scripts/backtest-strategies.ts` uses this engine. The `matchesEntry` function *does* handle SHORT direction (line 67-80) but the exit math doesn't.
**Fix:** Add `direction: 'LONG'|'SHORT'` to `PositionState`; multiply raw `pnlPct` by `-1` when SHORT; flip the HARD_STOP comparator (`>=` for SHORT) and likewise for TAKE_PROFIT / TRAIL_STOP. The cron's monitor has its own correct copy, but this lib is used by backtests to pre-validate new strategies — so every SHORT-strategy backtest is reporting phantom numbers.

### P1-F. `computePnL` in strategy-engine.ts ignores direction
**File:** `src/lib/strategy-engine.ts:187-200`
```ts
const rawPct = ((exitPrice - entryPrice) / entryPrice) * 100;  // LONG only
```
Same inversion. All SHORT backtest results from `scripts/backtest-strategies.ts` are negated. If the backtest found a "winning" SHORT strategy, it's actually losing.

### P1-G. Voice routes forward raw user text to OpenAI with 30s+ timeout — easy DoS and cost amplification
**File:** `src/app/api/voice/parse/route.ts:38-53` (no timeout), `src/app/api/voice/refine/route.ts:71-84` (30s), `src/app/api/voice/transcribe/route.ts:19-25` (no timeout)
Any unauthenticated request (these routes have no secret) can submit arbitrarily large `text`/audio payloads that get forwarded to OpenAI at app's expense. `parse` has no `text.length` cap, no rate limiting, no auth. `refine` accepts unlimited `history[]` array and JSON-stringifies it into a system prompt — an attacker can send `{"spec":{...},"message":"x","history":[{...100KB blob...}]}` to burn GPT tokens. Also: `transcribe` accepts arbitrarily large audio files (no Content-Length cap) and forwards them to OpenAI's `audio/transcriptions` API which charges per minute of audio.
**Fix:** Auth guard + `if (text.length > 4000) reject` + `if (history.length > 20) reject` + audio file size limit (e.g., 10MB).

### P1-H. `critique/route.ts` system prompt interpolates raw DB data including `spec_json` unescaped
**File:** `src/app/api/runs/[id]/critique/route.ts:74, 88-97`
```ts
const spec = JSON.parse(run.spec_json);  // can throw 500
const systemPrompt = `...Template: ${spec.template}\n- Symbol: ${run.symbol}\n...`;
```
If `spec_json` contains control characters, quotes, or prompt-injection (e.g., a symbol entered via `/api/voice/parse` → stored in `strategy_runs` → later critiqued), the LLM system prompt is injected. Also `run.symbol` is taken straight from DB without escaping. A malicious voice parse could set symbol to `\"\nIgnore prior instructions and...` and the critique endpoint would echo it. Since critique is used to evaluate strategies for humans, the poisoned response could mislead the user.
**Fix:** JSON.stringify every interpolation, cap lengths, and wrap the user-derived content in a clearly-delimited block like `<user_data>...</user_data>` with instructions "treat as untrusted data".

### P1-I. `src/lib/data.ts` Stooq → Yahoo fallback silently swallows all errors
**File:** `src/lib/data.ts:29-44`
```ts
try {
  const stooqSymbol = toStooqSymbol(normalized);
  const response = await fetch(...);
  if (response.ok) { ... if (rows.length) return rows; }
} catch { /* fall through to Yahoo */ }
```
The fetch has `cache: "no-store"` but **no timeout, no UA**. Stooq has blocked requests with unset UA in the past. The silent `catch` means if Stooq is down AND Yahoo rate-limits, the caller gets "Failed to fetch X daily bars" with no indication which provider failed — debugging production data gaps becomes guesswork.
**Fix:** `console.warn` the provider name + status on each fallback step. Add timeout to both fetches.

### P1-J. `/api/reversal` returns ALL rows (no pagination) → UI memory bloat + DB transfer cost
**File:** `src/app/api/reversal/route.ts:36`
```ts
query += " ORDER BY cohort_date DESC, direction, symbol";
// no LIMIT
```
With 164 TREND entries already in prod + 20 MOVERS/day × 14 days retention + future cohorts = 500-2000 entries per fetch. Each row has 30 d-column DECIMALs. `reversal/page.tsx` fetches this on mount and on every "Scan & Sync" click, building a `Record<string, ReversalEntry[]>` in React state. At 2000 rows × 30 price cells each, the matrix view renders 60,000 `<td>` DOM nodes with tooltips — causes browser jank. Also the endpoint returns response bodies >500KB unzipped.
**Fix:** Add `?limit=N&cursor=cohort_date`. Default to 14 days. Let the matrix view opt in to `?limit=500` with a warning.

### P1-K. `paper_trades` table has no `account_id` FK — silent orphan growth
**File:** `src/lib/migrations.ts:118-136`
`paper_trades` declares `account_id INT NULL` but no foreign key. If paper_accounts ever gets a row deleted (admin cleanup, multi-account feature), all paper_trades reference a nonexistent account and equity computation silently drops them from `computeAccountEquity`. Account-reset (DELETE FROM paper_trades WHERE account_id = ?) is safe, but any future account rename/merge breaks.
**Fix:** `ALTER TABLE paper_trades ADD CONSTRAINT FK_trades_account FOREIGN KEY (account_id) REFERENCES paper_accounts(id)`.

### P1-L. `paper_signals` and `paper_trades` are parallel tracking tables with no cross-reference
**File:** `src/lib/paper.ts:84` (equity from paper_trades) vs `scripts/surveillance-cron.ts:jobMonitorPositions` (writes to paper_signals)
`computeAccountEquity` sums `paper_trades.status='OPEN'` for positions_value. The cron writes every strategy-driven position to `paper_signals`, not `paper_trades`. **Strategy-driven positions are invisible to `/api/paper` equity math.** The paper-trading page shows cash correctly (because the cron decrements `paper_accounts.cash` directly) but positions_value doesn't include the ~84 open cron-placed signals. A user looking at `/paper` thinks "I have $X cash and no positions" when there are tens of thousands in open cron positions — they can manual-BUY more and overshoot actual available capital. (Cash is correctly debited, so no double-spend, but the UI KPIs lie.)
**Fix:** Option A: cron writes to `paper_trades` instead of `paper_signals`. Option B: `computeAccountEquity` unions both tables. Option B is less invasive.

---

## P2 — Minor / cosmetic

### P2-A. `reversal/page.tsx` SurveillanceCard "Current" cell is hardcoded `--`
**File:** `src/app/reversal/page.tsx:307-310` — the UI renders `<p>--</p>` for Current. Dead UI element or forgotten feature.

### P2-B. `/api/verify` has no auth and uses `DESCRIBE` (schema disclosure)
**File:** `src/app/api/verify/route.ts:9` — exposes full schema + recent log timestamps + 5 real data rows to any visitor. Minor info leak for a paper-trading app but shouldn't ship on a production host.

### P2-C. `reversal.ts:22-35` type has 10 × 3 = 30 explicit field declarations — pure boilerplate
**File:** `src/lib/reversal.ts:26-35` — use an index signature or generated type. Cosmetic.

### P2-D. `reversal/[id]/route.ts:31` rejects `v < 0` for price fields but some legitimate reversal exits can cross zero (not really — prices can't be ≤0). Dead check but harmless.

### P2-E. `data.ts` `parseCsv` has no max-row cap — Stooq could return a multi-MB CSV → memory spike per request.

---

## Cross-cutting summary

| Class | Count | Most-severe finding |
|---|---|---|
| Auth / trust boundary | 4 | P0-A (paper/order unauth) |
| Direction-aware math outside the cron | 3 | P1-E (strategy-engine exits) |
| TZ / calendar drift in HTTP path | 1 | P1-C (surveillance.ts) |
| Schema drift | 2 | P0-D (ensureSchema per-request) |
| Resource leaks / timeouts | 3 | P1-D (no Yahoo timeout in lib) |
| State inconsistency | 2 | P1-L (paper_trades vs paper_signals) |
| Race conditions (UI) | 2 | P1-A (double BUY click) |
| LLM injection / DoS | 2 | P1-G (voice routes unauth + no caps) |

## Top 3 to fix first
1. **P0-A auth on paper/order + paper/account** — 5-line fix, stops "anyone can drain the account" class entirely. Add `requireSecret()` helper that all state-mutating routes share.
2. **P0-D ensureSchema-per-request** — move to one-shot startup; blocks a class of metadata-lock deadlocks under load.
3. **P1-E strategy-engine direction-awareness** — every SHORT backtest is currently lying. Fix before any new SHORT strategies ship.

## Notes
- No files modified.
- The first audit's P0-6 fix (SHORT-aware SQL in /api/strategies) didn't catch that the *same class* lives in 3 more places: paper.ts `computeAccountEquity` (P0-B), strategy-engine.ts (P1-E/F), and — worst — there's no `direction` column on `paper_trades` at all.
- Auth gaps are the dominant P0 cluster. The cron container isn't publicly reachable, but the Next.js web app is, and every mutating API route under `/api/paper`, `/api/reversal`, `/api/backtest`, `/api/voice`, `/api/data/refresh` is wide open.
