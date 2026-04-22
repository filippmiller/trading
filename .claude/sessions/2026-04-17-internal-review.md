# Internal Code Review — 19-Fix Sweep
**Reviewer:** claude-sonnet-4-6  
**Date:** 2026-04-17  
**Scope:** fixes shipped in PR #2 (squash-merged 498d253)

---

## Q1: P0-2 Transaction — race window on dup-check outside tx

**File:** `scripts/surveillance-cron.ts:872-876` (jobExecuteStrategies), `:1394-1398` (jobExecuteConfirmationStrategies)  
**Confidence:** HIGH — real race window exists

The dup-check SELECT runs outside the transaction. Two concurrent invocations (startup-catchup at 09:44:58 + scheduled 09:50 tick) can both pass the SELECT before either INSERT commits. Both then open separate transactions and both succeed, because the INSERT has no UNIQUE constraint on `(strategy_id, reversal_entry_id)` to throw a duplicate-key error.

**The transaction fix is correct-as-written for the cash-first ordering problem it was solving.** But it does not close the dup-check race. The only safe fix is to add a UNIQUE KEY:

```sql
ALTER TABLE paper_signals
  ADD UNIQUE KEY UX_signal_strat_entry (strategy_id, reversal_entry_id);
```

Then let the INSERT inside the tx throw on conflict (catch, skip, no rollback needed because cash was not yet deducted). The SELECT dup-check can remain as an optimization to avoid wasting a transaction round-trip, but the UNIQUE KEY is the correctness guarantee.

**Risk window on Monday:** Both `jobExecuteStrategies` calls fire at startup (09:44-ish) and at 09:50. The `executeStrategiesRunning` guard correctly prevents overlap within a single function — but startup fires the function, and 09:50 fires it again once the startup finishes. If startup's `jobExecuteStrategies` completes before 09:50, both passes will independently evaluate the 7-day entry window and the dup-check will catch it. Only if startup's run is still in-flight at 09:50 does the guard block the second invocation. So in practice the race is unlikely on Monday but structurally unguarded.

---

## Q2: P0-1 Guard — does `monitorRunning` protect against the specific overlap?

**File:** `scripts/surveillance-cron.ts:947-956`  
**Confidence:** HIGH — guard is correct for the stated threat

`node-cron` fires its callback every 15 minutes regardless of whether the previous invocation is still running. `monitorRunning` is a module-level boolean that persists across tick callbacks in the same Node.js process. When the 15-min tick fires and the previous `jobMonitorPositions` is still in progress (awaiting Yahoo or MySQL), `monitorRunning === true`, the new callback returns immediately, and no second invocation runs concurrently.

The guard is exactly right for this threat model: single-process, single-event-loop, overlapping cron ticks. It does NOT protect against two separate container instances (but you run one container), and it does NOT protect against a process restart mid-run (but that is addressed by the exit-status-gated cash credit below).

The status-gated exit UPDATE (`WHERE id = ? AND status = 'EXECUTED' AND exit_at IS NULL`) plus the `affectedRows === 0` early-exit at lines 1145-1148 correctly handles the idempotency requirement. If the process restarts between the UPDATE and the cash credit, the next run will try to exit the same signal, get `affectedRows = 0` (status already changed), and skip the cash credit. **This is correct.**

---

## Q3: P0-3 Widen — disabled-then-re-enabled strategy sees 7 days of backlog

**File:** `scripts/surveillance-cron.ts:792-798`  
**Confidence:** MEDIUM — real scenario, capped but not zero risk

Yes, this is a genuine consequence of the 7-day window. A strategy disabled on Monday and re-enabled on Friday will see up to 7 days of entries in its first run. The per-strategy caps (`max_new_per_day=3`, `max_concurrent=15`) limit the damage: at most 3 signals fire on re-enable, not 7 days × entries.

However, `max_new_per_day` counts signals with `DATE(CONVERT_TZ(generated_at, ...)) = today`. All 3 signals inserted on re-enable get today's generated_at, so the count is correctly enforced. A strategy with `max_new_per_day=3` and `max_concurrent=15` will fire exactly 3 signals regardless of how many entries are in the window.

**The cap is sufficient for current config.** The risk only escalates if someone creates a strategy with `max_new_per_day=20` and `max_concurrent=50`. Worth adding a comment in the code noting this behavior is intentional and bounded by the caps, so future config changes are made with awareness.

---

## Q4: P0-4 ICU data — Alpine `Intl.DateTimeFormat` on Node 22

**File:** `scripts/surveillance-cron.ts:363`, `392`, `399`  
**Confidence:** MEDIUM

`Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })` requires IANA timezone data, which on Alpine-based Node images depends on the ICU build. Node 22 official Docker images (`node:22-alpine`) ship with `full-icu` by default since Node 13. The risk is:

1. If Dockerfile.cron uses a non-official slim image or custom base with `--with-intl=small-icu`, timezone names beyond a small subset may not resolve, causing the formatter to throw or produce empty strings.

2. The actual Alpine image used is determined by `docker/Dockerfile.cron`. Let me note: you should verify the base image line — if it is `node:22-alpine` from Docker Hub, full ICU is included and this is a non-issue. If it is a custom or slimmed image, this is a latent P0.

**The `en-CA` locale itself is fine** — it is in full-icu. The only risk is the `America/New_York` timezone name, which is in the IANA database included in Node's full-icu. On the current prod container (which you verified runs the new code), the startup catchup validated ET date arithmetic, so this is empirically working. Risk is LOW on current prod, MEDIUM on a hypothetical fresh deploy with a nonstandard base image.

---

## Q5: P0-5 Force-close — stale price from weeks ago as exit price

**File:** `scripts/surveillance-cron.ts:417-429`  
**Confidence:** MEDIUM — design gap, not an introduced bug

The concern is valid. If `paper_position_prices` has a price from 10 days ago (symbol delisted, monitor stopped fetching), `forceCloseExpiredSignals` uses that as exit_price. With 10x leverage, a 10-day-stale price that diverged 5% produces a 50% fictional PnL on the force-close.

**However:** The original P0-5 audit finding was "signals stuck EXECUTED forever." The force-close fixes the permanent cash-lock. The stale-price PnL is a secondary inaccuracy, not a new bug introduced by the fix. Before P0-5, these signals stayed open permanently — worse.

**What was introduced:** The fallback to `entry_price` when no position prices exist is correct (flat P&L). The staleness risk only applies when prices exist but are old.

**Suggested bound:** add a staleness check — if `last_price` came from a `fetched_at` more than N days ago, fall back to `entry_price` instead. This is not a regression introduced by the fix, but it is a known limitation worth tracking.

---

## Q6: P0-6 SQL — `GREATEST(..., -1)` floor for 100%+ SHORT losses

**File:** `src/app/api/strategies/route.ts:35-52`  
**Confidence:** LOW — works correctly

The formula for open_market_value:

```sql
GREATEST(
  0,
  investment_usd + (
    investment_usd * GREATEST(
      (raw_return * direction_multiplier) * leverage,
      -1
    )
  )
)
```

The inner `GREATEST(..., -1)` caps the leveraged return at -100% (total loss of principal). For a SHORT position that went 100%+ against (price doubled), `raw_return = +1.0`, direction multiplier = -1, so leveraged return = `-1.0 * leverage`. At leverage=5 that is -5.0. `GREATEST(-5.0, -1)` = -1. Then `investment + investment * (-1) = 0`. The outer `GREATEST(0, 0) = 0`. Correct — position value floors at zero, not negative.

A SHORT cannot lose more than the investment (the broker margin call fires at ~-80 to -100% depending on leverage). The -100% floor is the correct economic model. **This is correct-as-written.**

---

## Q7: P1-1 `fetchWithTimeout` — "network error" vs "HTTP error" conflation

**File:** `scripts/surveillance-cron.ts:69-85` and callers  
**Confidence:** LOW — no behavioral regression

Before: `fetchMoversFromYahoo` called `fetch()` directly and would throw on network error, plus check `res.ok` and throw on non-2xx.

After: `fetchWithTimeout` returns `null` for both network errors and non-2xx responses. `fetchMoversFromYahoo` checks `if (!res) throw new Error(...)` — so it still throws, propagating into `Promise.allSettled`. The throw is caught in the `allSettled` rejection path, same as before.

No caller previously distinguished between "HTTP 400" and "network timeout" in a way that required different handling. All error paths either logged and continued, or threw. The null-consolidation does not change observable behavior.

`fetchTwelveDataDay` correctly keeps inline AbortController to inspect `res.status === 429` before the ok-check. **This is correct-as-written.**

---

## Q8: P1-3 `CONVERT_TZ` — fresh MySQL container without tz tables

**File:** `scripts/surveillance-cron.ts:827`, `:1317`  
**Confidence:** MEDIUM — real operational risk on fresh deploys

`CONVERT_TZ(ts, '+00:00', 'America/New_York')` returns NULL if the MySQL timezone tables are not populated. `mysql:8.0` does NOT populate them by default — `tzdata` must be installed and `mysql_tzinfo_to_sql` must be run, OR the image must include them.

Your smoke tests verified this works on current prod, so the existing container has tz tables. But a fresh container from `docker/init-db.sql` alone will NOT have them. The query `DATE(CONVERT_TZ(generated_at, '+00:00', 'America/New_York')) = ?` will silently return zero rows (CONVERT_TZ returns NULL, DATE(NULL) = NULL, NULL = '2026-04-17' = false). Effect: `todayNew` always reads as 0, so `max_new_per_day` is never enforced — strategies fire uncapped.

**This is a genuine gap in the fresh-deploy story.** The `docker/init-db.sql` or `Dockerfile` for the MySQL container should include tz table population. Current prod is safe; future rebuilds are not.

---

## Q9: P1-10 Batching — placeholder count limit

**File:** `scripts/surveillance-cron.ts:1009-1012`  
**Confidence:** LOW — not a practical issue

`mysql2` uses the MySQL prepared-statement protocol. The `execute()` method sends an array of bind parameters. MySQL's protocol limit on parameter count is 65,535. Your strategy IDs (`stratIdsArr`) are bounded by the number of distinct strategies referenced by open signals. Even at 1,000 strategies (far beyond current scale), the IN clause is well within the limit.

The actual performance risk is the query planner doing a full-index scan for large IN lists, but at the strategy count you're running (O(10)), this is irrelevant. **Correct-as-written.**

---

## Q10: P2-1 Migration — TABLE doesn't exist on fresh container

**File:** `scripts/migration-2026-04-17-fk-cascade.sql:22-24`  
**Confidence:** HIGH — real failure mode on fresh container, but not a prod risk

Step 1 deletes orphan rows:
```sql
DELETE pp FROM paper_position_prices pp
LEFT JOIN paper_signals ps ON ps.id = pp.signal_id
WHERE ps.id IS NULL;
```

If `paper_position_prices` or `paper_signals` does not exist yet (fresh container before `init-db.sql` has run), this DELETE will fail with "Table doesn't exist." The migration would abort before the FK probe in Step 2.

**This is not a prod risk** — the migration is explicitly designed for applying to an existing prod database, which already has both tables. The comment at the top says exactly this. On a fresh container, `init-db.sql` creates the tables WITH the FK already defined, so the migration is never needed.

The risk is if someone runs the migration on a partially-initialized container. Low probability, but the migration could add an existence guard:
```sql
-- Only run if table exists
SET @tbl_exists := (SELECT COUNT(*) FROM information_schema.TABLES 
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'paper_position_prices');
```

Not a blocking issue given the migration's documented scope.

---

## Q11: P2-3 `refreshKey` — timer reset on click + spam vulnerability

**File:** `src/app/strategies/page.tsx:44`, `66-71`, `73`  
**Confidence:** LOW — minor UX issue, no data corruption

When `refresh()` increments `refreshKey`, the useEffect dependency changes, React tears down the old effect (sets `cancelled = true`, clears the old `setInterval`), and mounts a new effect (immediate `loadData()` call + fresh 60s interval). So yes, clicking refresh resets the 60s poll timer to zero from the click moment.

**User expectation:** ambiguous. Resetting the timer is arguably correct — if you just manually refreshed, you don't want another auto-refresh 3 seconds later. The Safari/Chrome "pull to refresh" pattern resets polling too.

**Spam vulnerability:** Rapid-clicking refresh triggers one fetch per click (each effect mount calls `loadData()` immediately), but the `cancelled = true` teardown from each new key means the in-flight request from the previous mount is abandoned (it checks `if (cancelled) return` before setState). Only the latest fetch's state updates land. No infinite churn, no memory leak — just wasted network requests proportional to click rate. At human click speeds (5-10 clicks/second max), this is negligible.

**Verdict:** Correct-as-written. The only improvement would be a debounce on the refresh button, which is cosmetic.

---

## Summary Table

| # | Finding | Verdict | Severity |
|---|---------|---------|----------|
| Q1 | Dup-check outside tx — race window | **BUG: missing UNIQUE KEY** | P0 (low probability Monday) |
| Q2 | monitorRunning guard | Correct-as-written | — |
| Q3 | 7-day backlog on re-enable | Works, capped by max_new_per_day | Design note |
| Q4 | Alpine ICU for Intl.DateTimeFormat | Empirically working; medium risk on non-official base | Operational note |
| Q5 | Stale last_price in force-close | Known limitation, not a regression | Design note |
| Q6 | GREATEST(-1) floor for SHORT | Correct-as-written | — |
| Q7 | fetchWithTimeout null-conflation | Correct-as-written | — |
| Q8 | CONVERT_TZ on fresh MySQL | **GAP: fresh containers have no tz tables** | P1 (affects future deploys) |
| Q9 | IN() placeholder limit | Not a practical issue | — |
| Q10 | Migration on no-table container | Not a prod risk; scope is clear | Documentation note |
| Q11 | refreshKey timer reset + spam | Correct-as-written | — |

---

## Two Issues Requiring Action Before Monday Open

### Issue 1 (P0, low probability): Missing UNIQUE KEY on paper_signals

The transaction fix is correct. The dup-check race is structurally still open. On Monday the startup catchup fires `jobExecuteStrategies`, then the 09:50 tick fires it again. If the first run completes before 09:50, the dup-check SELECT will catch duplicates. If it overlaps, `executeStrategiesRunning` blocks the second. So Monday's specific scenario is low-risk, but the UNIQUE KEY is the correct long-term fix and there is no downside to adding it now.

```sql
ALTER TABLE paper_signals
  ADD UNIQUE KEY UX_signal_strat_entry (strategy_id, reversal_entry_id);
```

### Issue 2 (P1, affects future deploys): CONVERT_TZ requires tz tables

Not a Monday risk (current prod has tz tables). A future `docker compose down && up` from scratch would break `max_new_per_day` enforcement silently. Add to `docker/init-db.sql` or the MySQL Dockerfile:

```sql
-- After tables created, or in a separate init step:
-- Requires tzdata in the MySQL container and running mysql_tzinfo_to_sql
```

Alternatively, replace `CONVERT_TZ(generated_at, '+00:00', 'America/New_York')` with an offset calculation using a known fixed offset (e.g., subtract `INTERVAL 4 HOUR` in summer, `5` in winter — imprecise but DST is not a concern here since the cron only runs in ET context). The cleanest fix is to pass `todayET()` as a parameter and compare to `DATE(generated_at)` in UTC, accepting the ~20:00-23:59 ET boundary drift — which P1-3 already analyzed as safe for current job schedule.
