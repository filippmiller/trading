# AI Crawler Protection Master Audit - 2026-04-30

## Scope

Audited top-level git repositories under `C:\dev` on 2026-04-30. This pass combines static route discovery, crawler policy files where applicable, and Cloudflare/app-control recommendations.

Sources used for policy alignment:

- OpenAI crawler docs distinguish OAI-SearchBot for ChatGPT Search discovery from GPTBot for model-training crawling.
- Cloudflare AI Crawl Control provides crawler monitoring, allow/block actions, robots.txt tracking, and WAF-backed enforcement.
- Cloudflare bot docs note that robots.txt is voluntary and enforcement requires AI Crawl Control, WAF, and Bot protection.

## Repository Matrix

| Repo | Framework | Project type | Domain | Risk before | Risk after | robots | sitemap |
|---|---|---|---|---|---|---|---|
| AIlingva | Node/JS | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| aitookmyjob | Node/JS | utility/non-public repository | https://aitookmyjob.filippmiller.com | MEDIUM | MEDIUM | yes | no |
| carry | Next.js | mixed public + private platform | https://REPLACE_WITH_DOMAIN | MEDIUM | LOW | yes | no |
| Chestno.ru | Unknown/static | utility/non-public repository | https://chestno.filippmiller.com | MEDIUM | MEDIUM | yes | yes |
| claude-code-orchestrator-kit | Node/JS | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| clihost | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | LOW | LOW | no | no |
| custodian | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| deploy | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | LOW | LOW | no | no |
| derevnya | Node/JS | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| domcom | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| ebay-connector-app | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| clear-mind-app | Unknown/static | SaaS/app platform or dashboard/admin system | https://REPLACE_WITH_DOMAIN | MEDIUM | LOW | yes | no |
| echocity | Next.js | mixed public + private platform | https://REPLACE_WITH_DOMAIN | MEDIUM | LOW | yes | no |
| email | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | LOW | LOW | no | no |
| filipp | Unknown/static | utility/non-public repository | https://filippmiller.com | LOW | LOW | no | no |
| fulfillment | Next.js | mixed public + private platform | https://REPLACE_WITH_DOMAIN | MEDIUM | LOW | yes | no |
| gene-tree | Next.js | mixed public + private platform | https://REPLACE_WITH_DOMAIN | MEDIUM | LOW | yes | yes |
| gene-tree | Unknown/static | public SEO/content site | https://REPLACE_WITH_DOMAIN | MEDIUM | LOW | yes | no |
| hetzner | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | LOW | LOW | no | no |
| mcp_agent_mail | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| kavork | Rails/Ruby | public/static web project | https://REPLACE_WITH_DOMAIN | MEDIUM | LOW | yes | no |
| kavork-v2 | Django/Python | public/static web project | https://REPLACE_WITH_DOMAIN | MEDIUM | LOW | yes | no |
| kirillmiller | Node/JS | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| konsiyerzh | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| kuznetsov | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | LOW | LOW | no | no |
| localsdoit | Next.js | mixed public + private platform | https://localsdoit.filippmiller.com | MEDIUM | LOW | yes | yes |
| love | Node/JS | utility/non-public repository | https://aisites.filippmiller.com | MEDIUM | MEDIUM | no | no |
| love-land-gsu | Node/JS | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| match | Next.js | mixed public + private platform | https://soulmatch.eu | MEDIUM | LOW | yes | yes |
| menucraft | Node/JS | utility/non-public repository | https://menucraft.app | MEDIUM | MEDIUM | yes | yes |
| needmybox | Node/JS | utility/non-public repository | https://REPLACE_WITH_DOMAIN | LOW | LOW | no | no |
| NewEbayApp | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| nomad | Next.js | mixed public + private platform | https://nomad.filippmiller.com | MEDIUM | LOW | yes | yes |
| nomad-admin-timeline-release | Next.js | mixed public + private platform | https://nomad.filippmiller.com | MEDIUM | LOW | yes | yes |
| OCR | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | HIGH | HIGH | no | no |
| orchestra_new | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | LOW | LOW | no | no |
| paintings | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | yes | yes |
| pawn | Node/JS | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | yes |
| reddit-clone-ref | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| referral | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| sniper | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | HIGH | HIGH | no | no |
| street | Astro | mixed public + private platform | https://worldspot.io | MEDIUM | LOW | yes | yes |
| street-recover-cross-machine-handoff-2026-04-29 | Astro | mixed public + private platform | https://worldspot.io | MEDIUM | LOW | yes | yes |
| tanyamillerart | Vite | SaaS/app platform or dashboard/admin system | https://tanyamillerart.com | MEDIUM | LOW | yes | yes |
| telegrambot | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | LOW | LOW | no | no |
| teplo | Next.js | SaaS/app platform or dashboard/admin system | https://REPLACE_WITH_DOMAIN | MEDIUM | LOW | yes | yes |
| teploENG | Next.js | SaaS/app platform or dashboard/admin system | https://REPLACE_WITH_DOMAIN | MEDIUM | LOW | yes | yes |
| tickets | Unknown/static | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| trading | Next.js | mixed public + private platform | https://trading-production-06fe.up.railway.app | MEDIUM | LOW | yes | yes |
| translation | Next.js | mixed public + private platform | https://REPLACE_WITH_DOMAIN | MEDIUM | LOW | yes | no |
| volunteer | Next.js | SaaS/app platform or dashboard/admin system | https://vsvoiruki.filippmiller.com | MEDIUM | LOW | yes | yes |
| vpn | Unknown/static | utility/non-public repository | https://vpn.filippmiller.com | LOW | LOW | no | no |
| workpulse | Node/JS | utility/non-public repository | https://REPLACE_WITH_DOMAIN | MEDIUM | MEDIUM | no | no |
| your_plants | Unknown/static | mixed public + private platform | https://REPLACE_WITH_DOMAIN | MEDIUM | LOW | yes | no |
| zoopolis | Node/JS | utility/non-public repository | https://zoopolis.filippmiller.com | MEDIUM | MEDIUM | yes | yes |

## Critical And High Risks Found

- OCR: HIGH before audit. 2 API/route files, 0 middleware/auth/rate-limit indicators, robots=false, sitemap=false.
- sniper: HIGH before audit. 1 API/route files, 0 middleware/auth/rate-limit indicators, robots=false, sitemap=false.

## Baseline Crawler Policy

- Allow Googlebot, Bingbot, Yandex/YandexBot, and OAI-SearchBot to public SEO pages.
- Disallow GPTBot, ClaudeBot, Claude-User, Google-Extended, Applebot-Extended, CCBot, Bytespider, Meta-ExternalAgent, PerplexityBot, and Amazonbot.
- Disallow default crawlers from protected prefixes: /api/, /admin/, /dashboard/, /app/, /account/, /settings/, /internal/, /private/, /export/, /reports/, /analytics/, /uploads/, /console/, /paper/, /research/, /strategies/, /markets/, /reversal/
- Keep /, /about, /pricing, /blog/*, /articles/*, /docs/public/*, /landing/*, and /contact indexable when they exist.
- Do not rely on robots.txt for real security.

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


## App-Level Architecture Requirements

- Route guards must protect dashboard, admin, app, account, settings, report, analytics, private, and internal areas.
- API auth must be server-side and enforced for private, admin, export, write, pricing, and bulk data endpoints.
- Public APIs must return minimal data with max limits and bounded pagination.
- Search/detail/export endpoints need rate limits and logs.
- Frontend must not embed full datasets, private records, pricing engines, environment secrets, or database-shaped JSON.
- Production source maps should remain disabled unless a protected error-reporting workflow requires them.
- Terms of Service should prohibit automated scraping, cloning, UI-flow replication, reverse engineering, dataset creation, API harvesting, and model training on protected/private areas.

## Verification Summary

- Static scan and policy generation completed locally.
- Per-repo audit docs were written to `docs/ai-crawler-protection-2026-04-30.md`.
- Web repos missing `public/robots.txt` received a baseline policy file when no framework robots route was detected.
- Web repos missing `public/llms.txt` received a baseline llms.txt policy file.
- Existing non-generated robots/sitemap framework files were preserved; generated baseline files may have been refreshed.
- Live curl verification was not run broadly because many repos have unknown or placeholder domains.
- Trading live Railway check before deployment: `/robots.txt`, `/sitemap.xml`, and `/llms.txt` return HTTP 404; `GET /` redirects to login for both `OAI-SearchBot` and `GPTBot`; unauthenticated `GET /api/prices?symbol=AAPL` returns HTTP 401.
- Trading app-level protection was tightened in `middleware.ts` with scoped rate limits for login, API traffic, and repeated unauthenticated API probing. `npx tsc --noEmit` passed; `npm test` passed 115/115 tests.

## Remaining TODOs

- Confirm canonical production domains and contact emails for repos with placeholders.
- Add or verify sitemap generation for repos marked sitemap=no.
- Manually inspect high-risk API handlers and add auth/rate limits where missing.
- Roll out Cloudflare AI Crawl Control, WAF rules, Bot protection, and AI Labyrinth per production zone.
- Add central crawler monitoring and alerting.
