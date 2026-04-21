# Trading — Deployment And Verification Notes

## Current State

Production runs on Railway. Local development still uses the VPS MySQL via SSH tunnel (historical accumulating dataset).

| Field | Value |
|---|---|
| Production app | Railway project `TRADING` — services: `web`, `worker`, `MySQL` |
| Production URL | `trading-production-06fe.up.railway.app` |
| Production DB | Railway MySQL (private: `mysql.railway.internal:3306`, public proxy: `switchback.proxy.rlwy.net:48486`) |
| Local dev DB | VPS MySQL via SSH tunnel (`localhost:3319` → `89.167.42.128:3320` inside `docker-mysql-1`) |
| Canonical branch | `master` |

### Why two databases?

The VPS MySQL has been accumulating enrollment + signal data since March 2026 and is the historical source of truth for the matrix (`reversal_entries`) and paper-trading tables. The Railway MySQL is the live production DB that the Railway worker writes to going forward. On 2026-04-21 the historical VPS data was one-shot restored into Railway; see the "Data recovery / restore" section below.

## Local Development

### 1. Restore the DB tunnel

From the repo root:

```bash
ssh -N -L 3319:127.0.0.1:3320 root@89.167.42.128
```

Alternative:

```bash
bash scripts/tunnel-db.sh
```

Expected result:
- local port `3319` is listening
- `.env.local` points the app at `localhost:3319`

### 2. Install dependencies

```bash
npm install
```

### 3. Run the app

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Verification Checklist

### Build

```bash
npm run build
```

Expected:
- Next.js build completes
- `/research`
- `/api/research/grid`
- `/strategies`
- `/settings`
- `/markets`

Notes:
- `next/font` pulls Google Fonts during build. If `fonts.googleapis.com` is unreachable, the build can fail even when app code is fine.
- Next may warn about multiple lockfiles because `C:\dev\package-lock.json` exists above this repo.

### Runtime smoke

With the tunnel up and dev server running:

1. Visit `/research`
2. Run a small Grid Sweep preset
3. Visit `/strategies`
4. Visit `/settings`
5. Visit `/markets`
6. Visit `/paper`

Expected:
- no silent infinite-loading states
- `/research` loads and grid requests return data
- market page responds with live quote/chart data if upstream fetches are healthy
- strategy/settings pages show visible errors instead of swallowing failures if the DB/tunnel is down

### API smoke

Minimal grid test:

```bash
curl -X POST http://localhost:3000/api/research/grid ^
  -H "Content-Type: application/json" ^
  -d "{\"filters\":{\"direction\":\"UP\"},\"trade\":{\"investmentUsd\":100,\"leverage\":1,\"tradeDirection\":\"LONG\",\"holdDays\":{\"values\":[1,2]},\"exitBar\":{\"values\":[\"close\"]},\"trailingStopPct\":{\"values\":[null,15]}},\"costs\":{\"commissionRoundTrip\":0,\"marginApyPct\":0},\"topN\":5,\"sortBy\":\"totalPnl\"}"
```

Expected:
- HTTP `200`
- JSON payload with `totalCombinations`, `rows`, and `sampleSize`

## Known Operational Gotchas

- **DB tunnel is fragile.** `ECONNREFUSED` from app routes usually means local port `3319` is no longer forwarded.
- **Google Fonts can break offline builds.** Failures against `fonts.googleapis.com` are environmental, not necessarily code regressions.
- **Multiple lockfile warning is cosmetic.** It does not block local dev.
- **Public deployment is still blocked by auth and DB exposure choices.** Cloudflare/Vercel were discussed, but no production deployment path is currently configured.

## Data recovery / restore

### Background

When Railway was bootstrapped on 2026-04-20/21, the production DB was created **empty** (aside from a seeded `prices_daily` history and paper_strategies rows). It did NOT inherit the accumulating VPS dataset. On 2026-04-21 the VPS historical data was one-shot restored into Railway using the playbook below.

### Source of truth for historical data

VPS MySQL on `89.167.42.128`, container `docker-mysql-1` (`mysql:8.0`), database `trading`, credentials `root / trading123` (only reachable via SSH).

### Railway target

- Database name: `railway` (not `trading`)
- Public proxy host: `switchback.proxy.rlwy.net` (IP `66.33.22.230`) port `48486`
- Credentials: see `railway variables --service MySQL --kv`

### Playbook (one-shot restore from VPS to Railway)

Tables VPS owns (restore overwrites Railway): `reversal_entries`, `paper_signals`, `paper_position_prices`, `paper_trades`, `paper_orders`, `surveillance_logs`, `surveillance_failures`, `paper_strategies`.

Tables Railway owns (do NOT overwrite): `prices_daily` (9k+ seeded history back to 1989), `strategy_runs`, `trades`, `run_metrics`, `app_users` (bootstrap admin), `app_settings`.

```bash
# 1. Dump VPS (data-only, scoped tables)
ssh root@89.167.42.128 "docker exec docker-mysql-1 mysqldump -uroot -ptrading123 \
  --single-transaction --skip-lock-tables --no-tablespaces --skip-triggers \
  --complete-insert --hex-blob --no-create-info --skip-add-drop-table --set-gtid-purged=OFF \
  --databases trading \
  --tables reversal_entries paper_signals paper_position_prices paper_trades \
           paper_orders surveillance_logs surveillance_failures paper_strategies" \
  > /tmp/vps-restore.sql

# 2. Build restore file (TRUNCATEs + dump)
cat scripts/railway-restore-prelude.sql /tmp/vps-restore.sql > /tmp/railway-restore-final.sql

# 3. Resolve Railway public proxy IP (Docker Desktop DNS can fail on hostname)
nslookup switchback.proxy.rlwy.net 8.8.8.8   # => 66.33.22.230 (IP may change; re-resolve on use)

# 4. Apply against Railway
docker run --rm -i mysql:8.0 mysql \
  -h <railway-proxy-ip> -P 48486 \
  -u root -p<MYSQL_ROOT_PASSWORD> \
  railway < /tmp/railway-restore-final.sql
```

### Verification queries

```sql
-- Row-count parity (run against Railway, compare to VPS dump)
SELECT 'reversal_entries' t, COUNT(*) n FROM reversal_entries
UNION ALL SELECT 'paper_signals', COUNT(*) FROM paper_signals
UNION ALL SELECT 'paper_position_prices', COUNT(*) FROM paper_position_prices
UNION ALL SELECT 'paper_trades', COUNT(*) FROM paper_trades
UNION ALL SELECT 'paper_orders', COUNT(*) FROM paper_orders
UNION ALL SELECT 'surveillance_logs', COUNT(*) FROM surveillance_logs
UNION ALL SELECT 'surveillance_failures', COUNT(*) FROM surveillance_failures
UNION ALL SELECT 'paper_strategies', COUNT(*) FROM paper_strategies;

-- FK integrity (all should return 0 except orphaned_signal_reversal_refs,
-- which is a pre-existing data quality issue with no FK constraint defined)
SELECT 'orphaned_position_prices',
  (SELECT COUNT(*) FROM paper_position_prices pp
   LEFT JOIN paper_signals s ON pp.signal_id = s.id WHERE s.id IS NULL);
SELECT 'orphaned_surveillance_failures',
  (SELECT COUNT(*) FROM surveillance_failures sf
   LEFT JOIN reversal_entries re ON sf.entry_id = re.id WHERE re.id IS NULL);
```

### Last restore verified

- **Date:** 2026-04-21
- **VPS → Railway row transfer:** 891 reversal_entries, 3,023 paper_signals, 18,283 paper_position_prices, 3 paper_trades, 7 paper_orders, 69 surveillance_logs, 192 surveillance_failures, 32 paper_strategies
- **FK integrity:** orphaned_position_prices=0, orphaned_surveillance_failures=0, orphaned_signal_strategy_refs=0 (paper_signals.reversal_entry_id has 69 orphans, pre-existing on VPS — not caused by restore)

## Last Verified

- **Date:** 2026-04-21
- **Branch:** `master`
- **Merged state:** includes Grid Sweep (`PR #9`), tab-audit cleanup (`PR #8`), Railway deploy + auth (commit `fe6bccc`), VPS→Railway data restore
- **Build:** passed on merged Grid Sweep master before PR #8 merge; post-merge build path may fail if Google Fonts are unreachable
