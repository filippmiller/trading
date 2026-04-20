# Trading — Deployment And Verification Notes

## Current State

This repository is still operated primarily as a local-development stack against the VPS MySQL database exposed through an SSH tunnel.

| Field | Value |
|---|---|
| App host | Local Next.js dev/prod process |
| Database | VPS MySQL via local tunnel |
| Canonical branch | `master` |
| Public deployment | Not configured |

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

## Last Verified

- **Date:** 2026-04-20
- **Branch:** `master`
- **Merged state:** includes Grid Sweep (`PR #9`) and tab-audit cleanup (`PR #8`)
- **Runtime smoke:** `/research` and `/api/research/grid` verified with tunnel restored
- **Build:** passed on merged Grid Sweep master before PR #8 merge; post-merge build path may fail if Google Fonts are unreachable
