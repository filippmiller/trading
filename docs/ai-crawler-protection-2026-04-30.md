# AI Crawler Protection Audit - trading - 2026-04-30

## Project

- Project name: trading
- Domain: https://trading-production-06fe.up.railway.app
- Framework: Next.js
- Project type: mixed public + private platform
- Risk score before: MEDIUM
- Risk score after: LOW

## Public Routes

- /
- /login
- /prices
- /runs
- /runs/*
- /scenarios
- /signals
- /voice

## Protected Routes

- /api/auth/login
- /api/auth/logout
- /api/auth/me
- /api/backtest/run
- /api/backtest/sweep
- /api/data/refresh
- /api/data/status
- /api/healthz
- /api/markets
- /api/paper
- /api/paper/account
- /api/paper/accounts
- /api/paper/batch-order
- /api/paper/order
- /api/paper/quote
- /api/paper/settings
- /api/prices
- /api/research/grid
- /api/research/run
- /api/research/scenarios
- /api/research/scenarios/*
- /api/research/sweep
- /api/reversal
- /api/reversal/*
- /api/reversal/movers
- /api/reversal/settings
- /api/runs
- /api/runs/*
- /api/runs/*/critique
- /api/settings
- /api/signals
- /api/strategies
- /api/strategies/promote
- /api/surveillance/sync
- /api/symbols
- /api/verify
- /api/voice/parse
- /api/voice/refine
- /api/voice/transcribe
- /markets
- /paper
- /research
- /reversal
- /settings
- /strategies

Baseline protected prefixes for any deployed service: /api/, /admin/, /dashboard/, /app/, /account/, /settings/, /internal/, /private/, /export/, /reports/, /analytics/, /uploads/, /console/, /paper/, /research/, /strategies/, /markets/, /reversal/

## Existing Controls

- robots.txt: present
- sitemap.xml or sitemap route: present
- llms.txt: present
- middleware/auth/rate-limit files detected: 2

- app-level rate limit added: `middleware.ts` now limits login attempts, API traffic, and repeated unauthenticated API probing.


## Sensitive Data Surfaces

### API endpoints and route handlers

- src/app/api/auth/login/route.ts
- src/app/api/auth/logout/route.ts
- src/app/api/auth/me/route.ts
- src/app/api/backtest/run/route.ts
- src/app/api/backtest/sweep/route.ts
- src/app/api/data/refresh/route.ts
- src/app/api/data/status/route.ts
- src/app/api/healthz/route.ts
- src/app/api/markets/route.ts
- src/app/api/paper/account/route.ts
- src/app/api/paper/accounts/route.ts
- src/app/api/paper/batch-order/route.ts
- src/app/api/paper/batch-order/schema.test.ts
- src/app/api/paper/order/route.ts
- src/app/api/paper/quote/route.ts
- src/app/api/paper/route.ts
- src/app/api/paper/settings/route.ts
- src/app/api/paper/settings/schema.test.ts
- src/app/api/prices/route.ts
- src/app/api/research/grid/route.ts
- src/app/api/research/run/route.ts
- src/app/api/research/scenarios/route.ts
- src/app/api/research/scenarios/[id]/route.ts
- src/app/api/research/sweep/route.ts
- src/app/api/reversal/movers/route.ts
- src/app/api/reversal/route.ts
- src/app/api/reversal/settings/route.ts
- src/app/api/reversal/[id]/route.ts
- src/app/api/runs/route.ts
- src/app/api/runs/[id]/critique/route.ts
- src/app/api/runs/[id]/route.ts
- src/app/api/settings/route.ts
- src/app/api/signals/route.ts
- src/app/api/strategies/promote/route.ts
- src/app/api/strategies/route.ts
- src/app/api/surveillance/sync/route.ts
- src/app/api/symbols/route.ts
- src/app/api/verify/route.ts
- src/app/api/voice/parse/route.ts
- src/app/api/voice/refine/route.ts
- src/app/api/voice/transcribe/route.ts

### Middleware/auth/rate-limit indicators

- middleware.ts
- src/lib/auth/session.ts

### Export/download/upload/report indicators

- audit/cleanup-test/report.json
- audit/e2e-batch/report.json
- audit/e2e-batch-direct/report.json
- audit/prod-audit/report.json
- audit/prod-audit-dashboard/report.json
- audit/prod-audit-matrix/report.json
- scripts/tradable-symbols-seed.csv
- src/components/TickerDownloader.tsx

### Large data/blob indicators

- scripts/smoke-test-paper-critic-hotfix.js
- scripts/smoke-test-paper-w2.js
- scripts/smoke-test-paper-w3.js
- scripts/smoke-test-paper-w4.js
- scripts/smoke-test-paper-w5.js
- scripts/surveillance-cron.ts
- src/app/markets/page.tsx
- src/app/paper/page.tsx
- src/app/research/page.tsx
- src/components/GridSweepSection.tsx
- src/components/paper/BatchTradeModal.tsx
- src/lib/migrations.ts
- src/lib/surveillance.ts

### Production source-map indicators

- No production source-map enablement detected.

## Files Changed

- public/robots.txt
- public/sitemap.xml or framework sitemap route
- public/llms.txt
- middleware.ts
- docs/ai-crawler-protection-2026-04-30.md

## Cloudflare Settings Needed

- Put the domain behind the Cloudflare orange-cloud proxy.
- Enable WAF and Bot protection/Bot Management where available.
- Enable AI Crawl Control and review the Crawlers, Metrics, and Robots.txt tabs.
- Allow verified Googlebot, Bingbot, YandexBot, and OAI-SearchBot on public SEO pages.
- Block GPTBot, ClaudeBot, CCBot, Bytespider, Meta-ExternalAgent, PerplexityBot, Amazonbot, Applebot-Extended, and Google-Extended.
- Enable AI Labyrinth for suspicious crawler behavior and robots.txt violators where appropriate.
- Add WAF custom rules:
  - Managed Challenge or block requests to protected route prefixes when unauthenticated.
  - Rate-limit /search, /api/search, /export, /download, and detail/listing endpoints.
  - Challenge unknown high-rate bots, sequential ID enumeration, and headless browser fingerprints.
- Monitor IP, user-agent, ASN, country, path, rate, status, auth state, referrer, public/private route class, and bot-like behavior.

Suggested WAF expression templates:

```text
# Block AI training / bulk crawlers globally.
(lower(http.user_agent) contains "gptbot" or lower(http.user_agent) contains "claudebot" or lower(http.user_agent) contains "claude-user" or lower(http.user_agent) contains "google-extended" or lower(http.user_agent) contains "applebot-extended" or lower(http.user_agent) contains "ccbot" or lower(http.user_agent) contains "bytespider" or lower(http.user_agent) contains "meta-externalagent" or lower(http.user_agent) contains "perplexitybot" or lower(http.user_agent) contains "amazonbot")

# Challenge unauthenticated access to protected routes.
((http.request.uri.path wildcard "/api/*" or http.request.uri.path wildcard "/admin/*" or http.request.uri.path wildcard "/dashboard/*" or http.request.uri.path wildcard "/app/*" or http.request.uri.path wildcard "/account/*" or http.request.uri.path wildcard "/settings/*" or http.request.uri.path wildcard "/internal/*" or http.request.uri.path wildcard "/private/*" or http.request.uri.path wildcard "/export/*" or http.request.uri.path wildcard "/reports/*" or http.request.uri.path wildcard "/analytics/*") and not http.cookie contains "REPLACE_WITH_SESSION_COOKIE=")

# Do not challenge known discovery crawlers on public pages.
(cf.client.bot and (lower(http.user_agent) contains "googlebot" or lower(http.user_agent) contains "bingbot" or lower(http.user_agent) contains "yandex" or lower(http.user_agent) contains "oai-searchbot") and not (http.request.uri.path wildcard "/api/*" or http.request.uri.path wildcard "/admin/*" or http.request.uri.path wildcard "/dashboard/*" or http.request.uri.path wildcard "/app/*" or http.request.uri.path wildcard "/account/*" or http.request.uri.path wildcard "/settings/*" or http.request.uri.path wildcard "/internal/*" or http.request.uri.path wildcard "/private/*" or http.request.uri.path wildcard "/export/*" or http.request.uri.path wildcard "/reports/*" or http.request.uri.path wildcard "/analytics/*"))
```


## Route-Level Protection Requirements

- /admin/* must require admin authentication.
- /dashboard/*, /app/*, /account/*, /settings/*, /reports/*, and /analytics/* must require authenticated users.
- /api/private/*, /api/admin/*, /api/export/*, and write APIs must require server-side auth.
- Listing/search APIs must enforce max limits, bounded pagination, and rate limits.
- Export/download endpoints must require auth, rate limits, audit logging, and business justification.
- Do not expose private database-shaped JSON, internal route maps, pricing engines, or full datasets in frontend HTML.
- Disable production browser source maps unless explicitly needed and access-controlled.

## Terms Clause To Add Or Verify

Automated scraping, crawling, extraction, reverse engineering, dataset creation, AI training, replication of UI flows, replication of business logic, and cloning of this platform are prohibited without prior written permission.

Search engine indexing of public marketing pages is permitted. Access to private, authenticated, API, dashboard, admin, export, and analytics areas by automated systems is prohibited.

## Verification Results

- Static scan completed locally on 2026-04-30.
- robots.txt: created if missing, or existing framework/static implementation left in place for manual review
- sitemap.xml: detected
- llms.txt: created if missing
- Live curl verification: not run for this repo unless a production domain was known and network target was safe to probe.

- Live Railway check before deployment: `/robots.txt`, `/sitemap.xml`, and `/llms.txt` currently return HTTP 404 because these files have not been deployed yet.
- Live Railway route/auth check: `GET /` with `OAI-SearchBot` and `GPTBot` both return HTTP 307 to `/login?next=%2F`; unauthenticated `GET /api/prices?symbol=AAPL` returns HTTP 401.
- TypeScript verification: `npx tsc --noEmit` completed with exit code 0.
- Test verification: `npm test` completed with 9 test files passed and 115 tests passed.


Suggested live checks:

```bash
curl -I https://trading-production-06fe.up.railway.app/robots.txt
curl -I https://trading-production-06fe.up.railway.app/sitemap.xml
curl -I https://trading-production-06fe.up.railway.app/llms.txt
curl -A "OAI-SearchBot" https://trading-production-06fe.up.railway.app/
curl -A "GPTBot" https://trading-production-06fe.up.railway.app/
curl -A "ClaudeBot" https://trading-production-06fe.up.railway.app/
curl -A "Googlebot" https://trading-production-06fe.up.railway.app/
curl -A "BadBot" https://trading-production-06fe.up.railway.app/api/private
```

## Remaining TODOs

- Replace REPLACE_WITH_DOMAIN / REPLACE_WITH_CONTACT_EMAIL placeholders where present.
- Confirm the production domain and sitemap generation for any repo marked missing sitemap.
- Manually review API handlers listed above for auth, pagination bounds, and rate limits.
- Configure Cloudflare enforcement; robots.txt and llms.txt are policy signals, not security controls.
- Add crawler/security monitoring dashboards and alerts for high 404s, ID enumeration, rapid pagination, repeated exports, unauthenticated API probing, and UA rotation.
