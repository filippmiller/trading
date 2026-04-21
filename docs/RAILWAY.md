# Railway Production Plan

This repo is now prepared for a 3-service Railway deployment:

1. `web` — Next.js app
2. `worker` — long-lived market scheduler
3. `mysql` — Railway MySQL

## Why this shape

- The web app is a standard Next.js deployment.
- The scheduler in `scripts/surveillance-cron.ts` is a long-lived `node-cron` process and should run as a dedicated worker service.
- Railway Cron is not precise enough for the market-timed jobs in this app.

## Required services

### 1. MySQL

Create a Railway MySQL service.

The app can consume either:

- `MYSQLHOST` / `MYSQLPORT` / `MYSQLUSER` / `MYSQLPASSWORD` / `MYSQLDATABASE`
- or `DATABASE_URL`

The web app already supports Railway-style `MYSQL*` envs.
The worker now supports both `MYSQL_*` and `MYSQL*`.

### 2. Web

Source:

- repo root
- Dockerfile: `Dockerfile`

Recommended service settings:

- Healthcheck path: `/api/healthz`
- Restart policy: `ON_FAILURE`

Required env vars:

- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `OPENAI_API_KEY` if voice features remain enabled

Recommended reference vars from MySQL:

- `MYSQLHOST=${{MySQL.MYSQLHOST}}`
- `MYSQLPORT=${{MySQL.MYSQLPORT}}`
- `MYSQLUSER=${{MySQL.MYSQLUSER}}`
- `MYSQLPASSWORD=${{MySQL.MYSQLPASSWORD}}`
- `MYSQLDATABASE=${{MySQL.MYSQLDATABASE}}`

Auth notes:

- The app is private by default.
- `ADMIN_EMAIL` + `ADMIN_PASSWORD` are authoritative on boot.
- Rotating `ADMIN_PASSWORD` and redeploying resets the bootstrap admin password.

### 3. Worker

Source:

- same repo
- Dockerfile path: `Dockerfile.worker`

Required env vars:

- same MySQL reference vars as `web`
- `TZ=America/New_York`
- `RATE_LIMIT_MS=500`
- `PRICE_RETENTION_DAYS=30`
- `TWELVEDATA_API_KEY` if you still want that fallback path

Recommended service settings:

- no public domain
- restart policy: `ALWAYS`

## Railway CLI flow

CLI auth is required first:

```bash
railway login
```

Or for CI/project-scoped deploys, use a project token:

```bash
RAILWAY_TOKEN=... railway up
```

Official docs:

- CLI deploys: https://docs.railway.com/cli/deploying
- Dockerfiles: https://docs.railway.com/deploy/dockerfiles
- Variables: https://docs.railway.com/variables
- MySQL: https://docs.railway.com/databases/mysql

## Suggested bootstrap sequence

1. Create an empty Railway project.
2. Add MySQL.
3. Create empty service `web`.
4. Create empty service `worker`.
5. Link the repo locally:

```bash
railway link
```

6. Deploy the web service from this repo:

```bash
railway up --service web
```

7. In `worker`, set:

- `RAILWAY_DOCKERFILE_PATH=Dockerfile.worker`

8. Deploy the worker service:

```bash
railway up --service worker
```

9. Add a public domain only to `web`.
10. Verify:

- `/api/healthz` returns `200`
- `/` redirects to `/login`
- login works with `ADMIN_EMAIL` / `ADMIN_PASSWORD`
- worker logs show the scheduler startup banner

## Current limitations

- Full account management UI is not built yet.
- The bootstrap admin is env-driven; this is intentional for first production cut.
- The build can fail in offline environments because `next/font/google` fetches Google Fonts during build.
