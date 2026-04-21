# Session 2026-04-21 09:18 — Railway data restore from VPS

**Type:** ops / data recovery
**Branch:** `ops/railway-data-restore`
**Commit:** `f9f343a`
**PR:** https://github.com/filippmiller/trading/pull/10
**Triggered by:** user-reported loss of the "matrix of tickers with prices" after the 2026-04-20/21 Railway deploy

---

## Problem

After the Railway production deploy landed (`fe6bccc feat: add Railway production deploy and app auth`), the Railway MySQL was bootstrapped **empty** aside from a large seeded `prices_daily` history (1989→2026). The accumulating VPS dataset — 891 `reversal_entries` rows dating back to 2026-03-10, 3,023 `paper_signals`, 18,283 `paper_position_prices` — was never migrated. From the user's POV: the matrix tab looked empty / newly-reset.

A codex/codex-session summary had already diagnosed this ("I did not import the prior VPS MySQL history into Railway"), but no restore had been executed.

## Root cause

Bootstrap-only migration. The Railway MySQL schema was created via `docker/init-db.sql` on first container start, and the admin + seed data was written, but the VPS-side historical tables were never dumped and loaded. The codex notes explicitly acknowledged this: *"Railway started from a clean state and then began enrolling fresh entries."*

## Verification done before action

Counted rows on both sides to understand the diff and rule out per-table surprises:

| Table | VPS | Railway (pre) |
|---|---:|---:|
| reversal_entries | 891 (2026-03-10 → 2026-04-20) | 134 (2026-04-20 only) |
| prices_daily | 22 (2026-03-18 → 2026-04-17) | **9,374 (1989 → 2026-02-04)** ← Railway has MORE |
| strategy_runs / trades / run_metrics | 0 / 0 / 0 | **5 / 65 / 5** ← Railway has the research runs |
| paper_signals | 3,023 | 63 |
| paper_position_prices | 18,283 | 0 |
| paper_trades / paper_orders | 3 / 7 | 0 / 0 |
| surveillance_logs / failures | 69 / 192 | 9 / 0 |
| paper_strategies | 32 | 32 (IDs + names match 1:1) |

Also symbol-set compared `reversal_entries WHERE cohort_date='2026-04-20'`: identical 134 symbols on both sides → zero unique-to-Railway tickers today → safe to overwrite.

## Decision

**Option A (restore-the-missing-8)** over Option B (full nuke). Restore VPS-owned tables only, keep Railway's authoritative `prices_daily` seed and research runs.

User confirmed.

## Execution

1. Dumped 8 tables data-only from VPS via `ssh root@89.167.42.128 "docker exec docker-mysql-1 mysqldump ..."` to `/tmp/vps-restore.sql` (~2 MB).
2. Prepended FK-safe TRUNCATE prelude (`scripts/railway-restore-prelude.sql`) to form `/tmp/railway-restore-final.sql`.
3. Could not use the Railway proxy hostname directly because Docker Desktop DNS on Windows failed to resolve `switchback.proxy.rlwy.net` from inside the mysql:8.0 container. Used the resolved IP `66.33.22.230` instead (Railway's TCP proxy is port-keyed, not hostname-keyed, so this works).
4. Executed restore via `docker run --rm -i mysql:8.0 mysql -h 66.33.22.230 -P 48486 -u root -p*** railway < /tmp/railway-restore-final.sql`. Both `prelude_done` and `restore_done` markers returned. No errors.

## Results

| Table | Before | After | Source |
|---|---:|---:|---|
| reversal_entries | 134 | **891** | VPS |
| paper_signals | 63 | **3,023** | VPS |
| paper_position_prices | 0 | **18,283** | VPS |
| paper_trades | 0 | **3** | VPS |
| paper_orders | 0 | **7** | VPS |
| surveillance_logs | 9 | **69** | VPS |
| surveillance_failures | 0 | **192** | VPS |
| paper_strategies | 32 | **32** | VPS (synced enabled flags) |
| prices_daily | 9,374 | 9,374 | Railway (kept) |
| strategy_runs / trades / run_metrics | 5 / 65 / 5 | 5 / 65 / 5 | Railway (kept) |
| app_users | 1 | 1 | Railway (kept admin) |

Matrix coverage: **29 trading days (2026-03-10 → 2026-04-20), 486 unique symbols, D1–D10 morning/midday/close captures intact.**

## FK integrity check

| Check | Result |
|---|---:|
| `paper_position_prices` → `paper_signals` | 0 orphans ✓ |
| `surveillance_failures` → `reversal_entries` | 0 orphans ✓ |
| `paper_signals.strategy_id` → `paper_strategies.id` | 0 orphans ✓ |
| `paper_signals.reversal_entry_id` → `reversal_entries.id` | **69 orphans — pre-existing on VPS** (verified by running same check against VPS source; no actual FK defined on this column, only an index) |

## Files changed in PR #10

- `scripts/railway-restore-prelude.sql` — new, reusable FK-safe TRUNCATE prelude
- `.claude/deploy-instructions.md` — full playbook (dump + proxy DNS workaround + restore + verification), two-DB topology explanation
- `CLAUDE.md` — session-start report updated for Railway deploy target

## Key learnings / gotchas

- **Docker Desktop for Windows has broken internal DNS for Railway proxy hostnames.** Workaround: resolve on host (`nslookup switchback.proxy.rlwy.net 8.8.8.8`) and pass IP directly to `-h`. Railway TCP proxy is port-based so IP works.
- **`paper_signals.reversal_entry_id` is NOT a real FK — just an index.** `docker/init-db.sql` defines `INDEX IX_signal_reversal (reversal_entry_id)` without a FOREIGN KEY clause, so integrity checks found 69 orphans on both VPS and Railway. Not a restore regression.
- **Railway DB is called `railway`, not `trading`.** Any restore script from VPS must target `railway` on the connection, not embed `USE trading;`. Using `mysqldump --no-create-info --tables <list>` instead of `--databases trading` gives a DB-neutral dump.
- **Identical `paper_strategies.id` values on both sides** removed the need for strategy_id FK remapping. Both sides seeded from the same `docker/init-db.sql` in the same order, so AUTO_INCREMENTs lined up.

## Next steps (not done this session)

- Eyeball `/reversal`, `/research`, `/paper` on the Railway prod URL to confirm the matrix renders
- Merge PR #10 after visual QA
- Worker was NOT restarted — it's stateless over DB content, next cron tick reads the restored data
