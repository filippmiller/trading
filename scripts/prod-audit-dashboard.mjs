// Stay-put probe for `/` Dashboard stats fetch.
// Goal: distinguish real bug (/api/runs or /api/reversal producing
// a client-visible failure for a logged-in user) from test artifact
// (in-flight fetch aborted by prior audit script navigating away).
//
// Method: log in, land on `/`, sit for 10s, watch for both fetches to
// complete AND for any console error from the Dashboard useEffect.

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.SMOKE_BASE || "https://trading-production-06fe.up.railway.app";
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const OUT = process.env.SMOKE_OUT || "audit/prod-audit-dashboard";
const STAY_MS = Number(process.env.STAY_MS || 10000);

if (!EMAIL || !PASSWORD) { console.error("creds required"); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const consoleMsgs = [];
const networkCalls = [];
const networkFailed = [];
const log = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") {
    consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 500), at: Date.now(), url: page.url() });
  }
});
page.on("pageerror", (e) => consoleMsgs.push({ type: "pageerror", text: e.message.slice(0, 500), at: Date.now(), url: page.url() }));

page.on("request", (req) => {
  const u = req.url();
  if (u.endsWith("/api/reversal") || u.endsWith("/api/runs")) {
    networkCalls.push({ phase: "request", url: u, at: Date.now() });
  }
});
page.on("requestfinished", async (req) => {
  const u = req.url();
  if (u.endsWith("/api/reversal") || u.endsWith("/api/runs")) {
    const resp = await req.response().catch(() => null);
    networkCalls.push({ phase: "finished", url: u, at: Date.now(), status: resp ? resp.status() : null });
  }
});
page.on("requestfailed", (req) => {
  const u = req.url();
  if (u.endsWith("/api/reversal") || u.endsWith("/api/runs")) {
    networkFailed.push({ url: u, at: Date.now(), failure: req.failure()?.errorText });
  }
});

const t0 = Date.now();

// LOGIN — lands on `/` automatically.
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.fill('input[type="email"], input[name="email"]', EMAIL);
await page.fill('input[type="password"], input[name="password"]', PASSWORD);
await Promise.all([
  page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }),
  page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")'),
]);
log.push(`login-ok at +${Date.now() - t0}ms url=${page.url()}`);

// Stay on current page (should be `/`) and wait.
log.push(`staying-put on ${page.url()} for ${STAY_MS}ms`);
await page.waitForTimeout(STAY_MS);

const shot = join(OUT, "dashboard-after-stay.png");
await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

// Summary
const reqFired = networkCalls.filter((n) => n.phase === "request").map((n) => n.url);
const reqDone = networkCalls.filter((n) => n.phase === "finished");
const doneReversal = reqDone.find((n) => n.url.endsWith("/api/reversal"));
const doneRuns = reqDone.find((n) => n.url.endsWith("/api/runs"));
const dashboardErrs = consoleMsgs.filter((m) => m.text.includes("Dashboard stats error"));

log.push(`requests-fired=${reqFired.length}`);
log.push(`reversal-done=${doneReversal ? doneReversal.status : "NO"}`);
log.push(`runs-done=${doneRuns ? doneRuns.status : "NO"}`);
log.push(`network-failed=${networkFailed.length}`);
log.push(`dashboard-stats-errors=${dashboardErrs.length}`);
log.push(`total-console-errors=${consoleMsgs.filter((m) => m.type === "error" || m.type === "pageerror").length}`);

writeFileSync(join(OUT, "report.json"), JSON.stringify({ base: BASE, stayMs: STAY_MS, log, consoleMsgs, networkCalls, networkFailed }, null, 2));

console.log(log.join("\n"));
if (dashboardErrs.length > 0) console.log("\n!! Dashboard stats error still fires when we stay put — REAL BUG");
else if (doneReversal?.status === 200 && doneRuns?.status === 200) console.log("\n== Both fetches completed cleanly — confirms Finding #1 was a test artifact");
else console.log("\n?? Mixed signal — review report.json");

await browser.close();
process.exit(0);
