# Trading Handoff — 2026-04-30

## Current Production State

- App: Railway project `TRADING`, environment `production`.
- Services: `trading` (Next.js web), `worker` (surveillance cron), `MySQL` (Railway MySQL).
- Public URL: https://trading-production-06fe.up.railway.app
- Canonical git branch: `master`.
- Repository remote: https://github.com/filippmiller/trading.git
- Production deploy trigger: push to `master` auto-deploys `trading` and `worker` on Railway.
- Production DB: Railway MySQL. Historical recovery source of truth remains VPS MySQL on `89.167.42.128:3320` via SSH/docker, documented in `.claude/deploy-instructions.md`.

## Verification Snapshot

Checked on 2026-04-30 from `C:\dev\trading`.

- Production health: `GET /api/healthz` returned HTTP 200 with `{ ok: true, service: "web" }`.
- Railway web service: `trading`, latest listed deployment before this handoff was SUCCESS on 2026-04-26 08:04:56 +03:00.
- Railway worker service: `worker`, latest listed deployment before this handoff was SUCCESS on 2026-04-26 10:36:19 +03:00.
- Worker logs show continued data activity through 2026-04-30: monitor ticks, price recordings, trend scans, close syncs, confirmation-strategy execution, borrow accrual, and retention.
- Local validation before integration: `npx tsc --noEmit` passed, `npm test` passed 114/114, `npm run build` passed.

## Install On A New Machine

1. Clone and enter the repo:

```bash
git clone https://github.com/filippmiller/trading.git
cd trading
```

2. Install Node dependencies:

```bash
npm install
```

3. Create `.env.local` from `.env.example` and fill real values from the operator's secret store or Railway variables. Do not copy secrets into committed docs.

4. Start the local DB tunnel to the VPS accumulating MySQL:

```bash
ssh -N -L 3319:127.0.0.1:3320 root@89.167.42.128
```

Alternative:

```bash
bash scripts/tunnel-db.sh
```

5. Run local dev:

```bash
npm run dev
```

6. Open http://localhost:3000 and sign in with the configured admin account.

## Required Local Checks

Run before pushing:

```bash
npx tsc --noEmit
npm test
npm run build
```

Useful production checks:

```bash
curl -i https://trading-production-06fe.up.railway.app/api/healthz
railway status
railway deployment list --service trading --environment production
railway deployment list --service worker --environment production
railway logs --service worker --environment production --lines 120
```

## Operational Notes

- Local dev uses `.env.local` plus the VPS MySQL tunnel on `localhost:3319`.
- Production uses Railway private MySQL from both services.
- The worker is responsible for surveillance/data fetching: MOVERS, TREND scan, active-entry price sync, paper position monitoring, confirmation strategies, borrow accrual, and retention.
- `GET /api/healthz` is public and is the fastest web deploy sanity check.
- Auth-protected runtime smoke should use a browser login or scripted session cookie before calling paper/research endpoints.
- `next/font` may fail builds if Google Fonts are unreachable; treat that as an environment/network issue unless code changed font config.
- Railway CLI service names are `trading`, `worker`, and `MySQL`, not `web`.

## Files Future Agents Should Read First

- `AGENTS.md`
- `.claude/deploy-instructions.md`
- `.claude/SYSTEM.md`
- Top entries of `.claude/agent-log.md`
- This handoff: `.claude/handoffs/2026-04-30-verification-handoff.md`

## Do Not Commit

- `.env.local`
- `docker/.env`
- local security-audit files containing literal secrets
- unrelated wake/desktop automation scripts unless the user explicitly asks for them
