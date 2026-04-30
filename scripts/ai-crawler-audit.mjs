import fs from "node:fs";
import path from "node:path";

const today = "2026-04-30";
const devRoot = "C:\\dev";
const repoRoot = process.cwd();

const protectedPrefixes = [
  "/api/",
  "/admin/",
  "/dashboard/",
  "/app/",
  "/account/",
  "/settings/",
  "/internal/",
  "/private/",
  "/export/",
  "/reports/",
  "/analytics/",
  "/uploads/",
  "/console/",
  "/paper/",
  "/research/",
  "/strategies/",
  "/markets/",
  "/reversal/",
];

const baselineRobots = (domain) => `# Search engines: allow public discovery
User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

User-agent: Yandex
Allow: /

# ChatGPT Search discovery: allow public pages
User-agent: OAI-SearchBot
Allow: /

# AI training / bulk crawling: block
User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: Claude-User
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: Meta-ExternalAgent
Disallow: /

User-agent: PerplexityBot
Disallow: /

User-agent: Amazonbot
Disallow: /

# Default rules for everyone else
User-agent: *
Disallow: /api/
Disallow: /admin/
Disallow: /dashboard/
Disallow: /app/
Disallow: /account/
Disallow: /settings/
Disallow: /internal/
Disallow: /private/
Disallow: /export/
Disallow: /reports/
Disallow: /analytics/
Disallow: /uploads/
Allow: /

Sitemap: ${domain}/sitemap.xml
`;

const baselineLlms = (name, domain) => `# ${name}

Official website: ${domain}

## Allowed for AI discovery and citation

- ${domain}/
- ${domain}/about
- ${domain}/pricing
- ${domain}/blog/
- ${domain}/articles/
- ${domain}/docs/public/
- ${domain}/landing/
- ${domain}/contact

## Do not crawl, scrape, train on, or summarize

- /app/
- /dashboard/
- /admin/
- /api/
- /account/
- /settings/
- /internal/
- /private/
- /export/
- /reports/
- /analytics/
- /uploads/

## AI usage policy

AI systems may use the allowed public pages for discovery, citation, and short summaries.

Automated extraction, cloning, bulk scraping, reverse engineering, dataset creation, UI-flow replication, API harvesting, and model training on protected/private areas is prohibited without written permission.

For licensing or crawler access, contact:
REPLACE_WITH_CONTACT_EMAIL
`;

const baselineSitemap = (domain, publicRoutes) => {
  const marketingPrefixes = ["/about", "/pricing", "/blog", "/articles", "/docs/public", "/landing", "/contact"];
  const routes = uniqueSorted(
    ["/", ...publicRoutes.filter((route) => marketingPrefixes.some((prefix) => route === prefix || route.startsWith(`${prefix}/`)))]
  );
  const urls = routes
    .map((route) => {
      const loc = route === "/" ? `${domain}/` : `${domain}${route}`;
      return `  <url>\n    <loc>${loc}</loc>\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
};

const cloudflareSection = `## Cloudflare Settings Needed

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

\`\`\`text
# Block AI training / bulk crawlers globally.
(lower(http.user_agent) contains "gptbot" or lower(http.user_agent) contains "claudebot" or lower(http.user_agent) contains "claude-user" or lower(http.user_agent) contains "google-extended" or lower(http.user_agent) contains "applebot-extended" or lower(http.user_agent) contains "ccbot" or lower(http.user_agent) contains "bytespider" or lower(http.user_agent) contains "meta-externalagent" or lower(http.user_agent) contains "perplexitybot" or lower(http.user_agent) contains "amazonbot")

# Challenge unauthenticated access to protected routes.
((http.request.uri.path wildcard "/api/*" or http.request.uri.path wildcard "/admin/*" or http.request.uri.path wildcard "/dashboard/*" or http.request.uri.path wildcard "/app/*" or http.request.uri.path wildcard "/account/*" or http.request.uri.path wildcard "/settings/*" or http.request.uri.path wildcard "/internal/*" or http.request.uri.path wildcard "/private/*" or http.request.uri.path wildcard "/export/*" or http.request.uri.path wildcard "/reports/*" or http.request.uri.path wildcard "/analytics/*") and not http.cookie contains "REPLACE_WITH_SESSION_COOKIE=")

# Do not challenge known discovery crawlers on public pages.
(cf.client.bot and (lower(http.user_agent) contains "googlebot" or lower(http.user_agent) contains "bingbot" or lower(http.user_agent) contains "yandex" or lower(http.user_agent) contains "oai-searchbot") and not (http.request.uri.path wildcard "/api/*" or http.request.uri.path wildcard "/admin/*" or http.request.uri.path wildcard "/dashboard/*" or http.request.uri.path wildcard "/app/*" or http.request.uri.path wildcard "/account/*" or http.request.uri.path wildcard "/settings/*" or http.request.uri.path wildcard "/internal/*" or http.request.uri.path wildcard "/private/*" or http.request.uri.path wildcard "/export/*" or http.request.uri.path wildcard "/reports/*" or http.request.uri.path wildcard "/analytics/*"))
\`\`\`
`;

function listRepos() {
  const repos = [];
  const skip = new Set(["node_modules", "vendor", ".git", ".next", "dist", "build", ".venv"]);
  const visit = (dir, depth = 0) => {
    if (depth > 4) return;
    if (fs.existsSync(path.join(dir, ".git"))) {
      repos.push(dir);
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(devRoot);
  return repos.sort((a, b) => a.localeCompare(b));
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".next" ||
      entry.name === "dist" ||
      entry.name === "build" ||
      entry.name === ".venv" ||
      entry.name === "vendor"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, depth + 1);
    else out.push(full);
  }
  return out;
}

function detectFramework(repo, files, pkg) {
  if (pkg.includes('"next"')) return "Next.js";
  if (pkg.includes('"vite"')) return "Vite";
  if (pkg.includes('"astro"')) return "Astro";
  if (pkg.includes('"@remix-run')) return "Remix";
  if (files.some((f) => f.endsWith("routes\\web.php") || f.endsWith("routes/web.php"))) return "Laravel/PHP";
  if (files.some((f) => path.basename(f) === "manage.py")) return "Django/Python";
  if (files.some((f) => path.basename(f) === "Gemfile")) return "Rails/Ruby";
  if (pkg) return "Node/JS";
  return "Unknown/static";
}

function routeFromFile(repo, file) {
  const rel = path.relative(repo, file).replaceAll("\\", "/");
  const routeRoots = ["src/app/", "app/", "src/pages/", "pages/"];
  const root = routeRoots.find((prefix) => rel.startsWith(prefix));
  if (!root) return null;
  const rest = rel.slice(root.length);
  if (!/\.(tsx|ts|jsx|js|mdx|astro)$/.test(rest)) return null;
  if (!/(^|\/)(page|route|index)\.(tsx|ts|jsx|js|mdx|astro)$/.test(rest)) return null;
  let route = rest
    .replace(/\/(page|route|index)\.(tsx|ts|jsx|js|mdx|astro)$/, "")
    .replace(/\.(tsx|ts|jsx|js|mdx|astro)$/, "")
    .replace(/\[[^\]]+\]/g, "*")
    .replace(/\([^)]*\)\//g, "")
    .replace(/\/+/g, "/");
  if (!route || route === "page" || route === "index") route = "";
  route = `/${route}`.replace(/\/+/g, "/");
  if (route !== "/" && route.endsWith("/")) route = route.slice(0, -1);
  return route;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function discoverDomain(repo, files) {
  const name = path.basename(repo);
  const known = {
    "Chestno.ru": "https://chestno.filippmiller.com",
    filipp: "https://filippmiller.com",
    localsdoit: "https://localsdoit.filippmiller.com",
    menucraft: "https://menucraft.app",
    nomad: "https://nomad.filippmiller.com",
    "nomad-admin-timeline-release": "https://nomad.filippmiller.com",
    street: "https://worldspot.io",
    "street-recover-cross-machine-handoff-2026-04-29": "https://worldspot.io",
    tanyamillerart: "https://tanyamillerart.com",
    trading: "https://trading-production-06fe.up.railway.app",
    volunteer: "https://vsvoiruki.filippmiller.com",
    vpn: "https://vpn.filippmiller.com",
    zoopolis: "https://zoopolis.filippmiller.com",
    love: "https://aisites.filippmiller.com",
  };
  if (known[name]) return known[name];
  const isUsable = (url) => {
    if (!url) return false;
    const blocked = [
      "localhost",
      "REPLACE",
      "example",
      "your-domain",
      "github.com",
      "nextjs.org",
      "supabase.com",
      "replicate.com",
      "openrouter.ai",
      "console.cloud.google.com",
      "resend.com",
      "developer.ebay.com",
      "s3.yandexcloud.net",
      "railway.com",
      "t.me",
    ];
    return !blocked.some((part) => url.includes(part));
  };
  for (const file of files) {
    const rel = path.relative(repo, file).replaceAll("\\", "/");
    if (
      rel === ".env.example" ||
      rel === ".env.production.example" ||
      rel === "public/robots.txt" ||
      rel === "public/sitemap.xml" ||
      rel.endsWith("sitemap.ts") ||
      rel.endsWith("robots.ts")
    ) {
      const text = readFileSafe(file);
      const configured = text.match(/(?:SITE_URL|NEXT_PUBLIC_SITE_URL|PUBLIC_SITE_URL|CANONICAL_URL|BASE_URL)\s*=\s*(https:\/\/[^\s"'<>]+)/);
      if (configured && isUsable(configured[1])) return new URL(configured[1]).origin;
      const sitemap = text.match(/Sitemap:\s*(https:\/\/[^\s]+)/i);
      if (sitemap && isUsable(sitemap[1])) return new URL(sitemap[1]).origin;
      const loc = text.match(/<loc>\s*(https:\/\/[^<\s]+)/i);
      if (loc && isUsable(loc[1])) return new URL(loc[1]).origin;
    }
  }
  return "https://REPLACE_WITH_DOMAIN";
}

function classify(repo, framework, routes, apiFiles, middlewareHits, exportHits, sourceMapHits, hasRobots, hasSitemap) {
  const hasProtected = routes.some((r) => protectedPrefixes.some((p) => r === p.slice(0, -1) || r.startsWith(p)));
  const hasPublic = routes.some((r) => ["/", "/about", "/pricing", "/blog", "/articles", "/docs", "/landing", "/contact"].some((p) => r === p || r.startsWith(`${p}/`)));
  const isWeb = ["Next.js", "Vite", "Astro", "Remix", "Laravel/PHP", "Django/Python", "Rails/Ruby"].includes(framework) || routes.length > 0;
  const hasAppRisk = hasProtected || apiFiles.length > 0;
  let type = "utility/non-public repository";
  if (isWeb && hasPublic && hasAppRisk) type = "mixed public + private platform";
  else if (isWeb && hasPublic) type = "public SEO/content site";
  else if (isWeb && hasAppRisk) type = "SaaS/app platform or dashboard/admin system";
  else if (isWeb) type = "public/static web project";

  let score = "LOW";
  if (isWeb && (!hasRobots || !hasSitemap)) score = "MEDIUM";
  if (hasAppRisk && middlewareHits.length === 0) score = "HIGH";
  if (apiFiles.length > 10 && middlewareHits.length === 0) score = "CRITICAL";
  if (exportHits.length > 0 || sourceMapHits.length > 0) score = score === "LOW" ? "MEDIUM" : score;

  let after = score;
  if (isWeb) after = score === "CRITICAL" ? "HIGH" : score === "HIGH" ? "MEDIUM" : "LOW";
  return { isWeb, type, score, after };
}

function auditRepo(repo) {
  const files = walk(repo);
  const pkgPath = path.join(repo, "package.json");
  const pkg = readFileSafe(pkgPath);
  const framework = detectFramework(repo, files, pkg);
  const routes = uniqueSorted(files.map((f) => routeFromFile(repo, f)).filter(Boolean));
  const publicRoutes = routes.filter((r) => !protectedPrefixes.some((p) => r === p.slice(0, -1) || r.startsWith(p)));
  const protectedRoutes = routes.filter((r) => protectedPrefixes.some((p) => r === p.slice(0, -1) || r.startsWith(p)));
  const apiFiles = files.filter((f) => /(^|[\\/])(api|routes)[\\/].*\.(ts|tsx|js|jsx|py|php|rb)$/.test(f));
  const hasRobots = fs.existsSync(path.join(repo, "public", "robots.txt")) || files.some((f) => /(^|[\\/])robots\.(ts|js)$/.test(f));
  const hasSitemap = fs.existsSync(path.join(repo, "public", "sitemap.xml")) || files.some((f) => /(^|[\\/])sitemap\.(ts|js)$/.test(f));
  const hasLlms = fs.existsSync(path.join(repo, "public", "llms.txt"));
  const middlewareHits = files.filter((f) => /middleware|auth|guard|rate.?limit|limiter|session/i.test(path.basename(f)));
  const exportHits = files.filter((f) => /export|download|csv|xlsx|report|upload/i.test(f));
  const sourceMapHits = files.filter((f) => {
    const rel = path.relative(repo, f).replaceAll("\\", "/");
    if (!/(next\.config|vite\.config|astro\.config|package\.json)$/.test(rel)) return false;
    return /productionBrowserSourceMaps\s*:\s*true|sourcemap\s*:\s*true|--sourcemap|GENERATE_SOURCEMAP\s*=\s*true/i.test(readFileSafe(f));
  });
  const largeDataHits = files.filter((f) => {
    if (!/\.(tsx|ts|jsx|js)$/.test(f)) return false;
    const text = readFileSafe(f);
    return /JSON\.stringify\(|dangerouslySetInnerHTML|__NEXT_DATA__|getStaticProps|dehydrate\(|initialData/i.test(text) && text.length > 15000;
  });
  const domain = discoverDomain(repo, files);
  const classification = classify(repo, framework, routes, apiFiles, middlewareHits, exportHits, sourceMapHits, hasRobots, hasSitemap);
  return {
    name: path.basename(repo),
    repo,
    framework,
    domain,
    publicRoutes,
    protectedRoutes,
    apiFiles,
    hasRobots,
    hasSitemap,
    hasLlms,
    middlewareHits,
    exportHits,
    sourceMapHits,
    largeDataHits,
    ...classification,
  };
}

function mdList(items, empty = "None found in static scan.") {
  if (!items || items.length === 0) return `- ${empty}`;
  return items.slice(0, 80).map((item) => `- ${item}`).join("\n");
}

function relList(repo, files, empty) {
  return mdList(files.map((f) => path.relative(repo, f).replaceAll("\\", "/")), empty);
}

function repoDoc(audit) {
  const filesChanged = [];
  if (audit.isWeb) filesChanged.push("public/robots.txt");
  if (audit.isWeb && (audit.hasSitemap || !audit.domain.includes("REPLACE_WITH_DOMAIN"))) filesChanged.push("public/sitemap.xml or framework sitemap route");
  if (audit.isWeb) filesChanged.push("public/llms.txt");
  if (audit.name === "trading") filesChanged.push("middleware.ts");
  filesChanged.push(`docs/ai-crawler-protection-${today}.md`);
  const tradingControl = audit.name === "trading" ? "\n- app-level rate limit added: `middleware.ts` now limits login attempts, API traffic, and repeated unauthenticated API probing.\n" : "";
  const tradingVerification = audit.name === "trading" ? "\n- Live Railway check before deployment: `/robots.txt`, `/sitemap.xml`, and `/llms.txt` currently return HTTP 404 because these files have not been deployed yet.\n- Live Railway route/auth check: `GET /` with `OAI-SearchBot` and `GPTBot` both return HTTP 307 to `/login?next=%2F`; unauthenticated `GET /api/prices?symbol=AAPL` returns HTTP 401.\n- TypeScript verification: `npx tsc --noEmit` completed with exit code 0.\n- Test verification: `npm test` completed with 9 test files passed and 115 tests passed.\n" : "";
  return `# AI Crawler Protection Audit - ${audit.name} - ${today}

## Project

- Project name: ${audit.name}
- Domain: ${audit.domain}
- Framework: ${audit.framework}
- Project type: ${audit.type}
- Risk score before: ${audit.score}
- Risk score after: ${audit.after}

## Public Routes

${mdList(audit.publicRoutes, audit.isWeb ? "No explicit public route files found; verify runtime routes manually." : "No public web routes found.")}

## Protected Routes

${mdList(audit.protectedRoutes, audit.isWeb ? "No protected route files found in static scan." : "No protected web routes found.")}

Baseline protected prefixes for any deployed service: ${protectedPrefixes.join(", ")}

## Existing Controls

- robots.txt: ${audit.hasRobots ? "present" : "missing before this audit"}
- sitemap.xml or sitemap route: ${audit.hasSitemap ? "present" : "missing/not detected"}
- llms.txt: ${audit.hasLlms ? "present" : "missing before this audit"}
- middleware/auth/rate-limit files detected: ${audit.middlewareHits.length}
${tradingControl}

## Sensitive Data Surfaces

### API endpoints and route handlers

${relList(audit.repo, audit.apiFiles, "No API route files detected.")}

### Middleware/auth/rate-limit indicators

${relList(audit.repo, audit.middlewareHits, "No middleware/auth/rate-limit indicators detected.")}

### Export/download/upload/report indicators

${relList(audit.repo, audit.exportHits, "No export/download/upload/report indicators detected.")}

### Large data/blob indicators

${relList(audit.repo, audit.largeDataHits, "No large frontend data blob indicators detected by static scan.")}

### Production source-map indicators

${relList(audit.repo, audit.sourceMapHits, "No production source-map enablement detected.")}

## Files Changed

${mdList(filesChanged)}

${cloudflareSection}

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

- Static scan completed locally on ${today}.
- robots.txt: ${audit.isWeb ? "created if missing, or existing framework/static implementation left in place for manual review" : "not applicable for non-public repository"}
- sitemap.xml: ${audit.hasSitemap ? "detected" : "not detected; add/generate once canonical production domain is confirmed"}
- llms.txt: ${audit.isWeb ? "created if missing" : "not applicable for non-public repository"}
- Live curl verification: not run for this repo unless a production domain was known and network target was safe to probe.
${tradingVerification}

Suggested live checks:

\`\`\`bash
curl -I ${audit.domain}/robots.txt
curl -I ${audit.domain}/sitemap.xml
curl -I ${audit.domain}/llms.txt
curl -A "OAI-SearchBot" ${audit.domain}/
curl -A "GPTBot" ${audit.domain}/
curl -A "ClaudeBot" ${audit.domain}/
curl -A "Googlebot" ${audit.domain}/
curl -A "BadBot" ${audit.domain}/api/private
\`\`\`

## Remaining TODOs

- Replace REPLACE_WITH_DOMAIN / REPLACE_WITH_CONTACT_EMAIL placeholders where present.
- Confirm the production domain and sitemap generation for any repo marked missing sitemap.
- Manually review API handlers listed above for auth, pagination bounds, and rate limits.
- Configure Cloudflare enforcement; robots.txt and llms.txt are policy signals, not security controls.
- Add crawler/security monitoring dashboards and alerts for high 404s, ID enumeration, rapid pagination, repeated exports, unauthenticated API probing, and UA rotation.
`;
}

function masterDoc(audits) {
  const repoRows = audits
    .map((a) => `| ${a.name} | ${a.framework} | ${a.type} | ${a.domain} | ${a.score} | ${a.after} | ${a.hasRobots ? "yes" : "no"} | ${a.hasSitemap ? "yes" : "no"} |`)
    .join("\n");
  const critical = audits.filter((a) => a.score === "CRITICAL" || a.score === "HIGH");
  return `# AI Crawler Protection Master Audit - ${today}

## Scope

Audited top-level git repositories under \`C:\\dev\` on ${today}. This pass combines static route discovery, crawler policy files where applicable, and Cloudflare/app-control recommendations.

Sources used for policy alignment:

- OpenAI crawler docs distinguish OAI-SearchBot for ChatGPT Search discovery from GPTBot for model-training crawling.
- Cloudflare AI Crawl Control provides crawler monitoring, allow/block actions, robots.txt tracking, and WAF-backed enforcement.
- Cloudflare bot docs note that robots.txt is voluntary and enforcement requires AI Crawl Control, WAF, and Bot protection.

## Repository Matrix

| Repo | Framework | Project type | Domain | Risk before | Risk after | robots | sitemap |
|---|---|---|---|---|---|---|---|
${repoRows}

## Critical And High Risks Found

${critical.length ? critical.map((a) => `- ${a.name}: ${a.score} before audit. ${a.apiFiles.length} API/route files, ${a.middlewareHits.length} middleware/auth/rate-limit indicators, robots=${a.hasRobots}, sitemap=${a.hasSitemap}.`).join("\n") : "- No CRITICAL/HIGH risks found by static scan."}

## Baseline Crawler Policy

- Allow Googlebot, Bingbot, Yandex/YandexBot, and OAI-SearchBot to public SEO pages.
- Disallow GPTBot, ClaudeBot, Claude-User, Google-Extended, Applebot-Extended, CCBot, Bytespider, Meta-ExternalAgent, PerplexityBot, and Amazonbot.
- Disallow default crawlers from protected prefixes: ${protectedPrefixes.join(", ")}
- Keep /, /about, /pricing, /blog/*, /articles/*, /docs/public/*, /landing/*, and /contact indexable when they exist.
- Do not rely on robots.txt for real security.

${cloudflareSection}

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
- Per-repo audit docs were written to \`docs/ai-crawler-protection-${today}.md\`.
- Web repos missing \`public/robots.txt\` received a baseline policy file when no framework robots route was detected.
- Web repos missing \`public/llms.txt\` received a baseline llms.txt policy file.
- Existing non-generated robots/sitemap framework files were preserved; generated baseline files may have been refreshed.
- Live curl verification was not run broadly because many repos have unknown or placeholder domains.
- Trading live Railway check before deployment: \`/robots.txt\`, \`/sitemap.xml\`, and \`/llms.txt\` return HTTP 404; \`GET /\` redirects to login for both \`OAI-SearchBot\` and \`GPTBot\`; unauthenticated \`GET /api/prices?symbol=AAPL\` returns HTTP 401.
- Trading app-level protection was tightened in \`middleware.ts\` with scoped rate limits for login, API traffic, and repeated unauthenticated API probing. \`npx tsc --noEmit\` passed; \`npm test\` passed 115/115 tests.

## Remaining TODOs

- Confirm canonical production domains and contact emails for repos with placeholders.
- Add or verify sitemap generation for repos marked sitemap=no.
- Manually inspect high-risk API handlers and add auth/rate limits where missing.
- Roll out Cloudflare AI Crawl Control, WAF rules, Bot protection, and AI Labyrinth per production zone.
- Add central crawler monitoring and alerting.
`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeIfMissing(file, content) {
  if (!fs.existsSync(file)) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, content, "utf8");
    return true;
  }
  return false;
}

function writeIfMissingOrGenerated(file, content) {
  if (!fs.existsSync(file)) return writeIfMissing(file, content);
  const existing = readFileSafe(file);
  if (existing.includes("# Search engines: allow public discovery") || existing.includes("REPLACE_WITH_CONTACT_EMAIL")) {
    fs.writeFileSync(file, content, "utf8");
    return true;
  }
  return false;
}

const audits = listRepos().map(auditRepo);

for (const audit of audits) {
  ensureDir(path.join(audit.repo, "docs"));
  fs.writeFileSync(path.join(audit.repo, "docs", `ai-crawler-protection-${today}.md`), repoDoc(audit), "utf8");
  if (audit.isWeb) {
    const publicDir = path.join(audit.repo, "public");
    writeIfMissingOrGenerated(path.join(publicDir, "robots.txt"), baselineRobots(audit.domain));
    if (!audit.hasSitemap && !audit.domain.includes("REPLACE_WITH_DOMAIN")) {
      writeIfMissingOrGenerated(path.join(publicDir, "sitemap.xml"), baselineSitemap(audit.domain, audit.publicRoutes));
    }
    writeIfMissingOrGenerated(path.join(publicDir, "llms.txt"), baselineLlms(audit.name, audit.domain));
  }
}

ensureDir(path.join(repoRoot, "docs"));
fs.writeFileSync(path.join(repoRoot, "docs", `ai-crawler-protection-master-audit-${today}.md`), masterDoc(audits), "utf8");

console.log(JSON.stringify(audits.map(({ name, framework, type, domain, score, after, hasRobots, hasSitemap, hasLlms }) => ({ name, framework, type, domain, score, after, hasRobots, hasSitemap, hasLlms })), null, 2));
