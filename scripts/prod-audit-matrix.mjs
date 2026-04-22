// Second-pass matrix-specific probes: visit /reversal?view=matrix,
// confirm table renders, click a symbol cell to open popover, verify re-open
// triggers fresh prices_daily fetch (PR #34 empty-cache regression).

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.SMOKE_BASE || "https://trading-production-06fe.up.railway.app";
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const OUT = process.env.SMOKE_OUT || "audit/prod-audit-matrix";

if (!EMAIL || !PASSWORD) { console.error("creds required"); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const consoleMsgs = [];
const networkCalls = [];
const log = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 400), url: page.url() });
});
page.on("pageerror", (e) => consoleMsgs.push({ type: "pageerror", text: e.message.slice(0, 400), url: page.url() }));
page.on("requestfinished", (req) => {
  const u = req.url();
  if (u.includes("/api/")) networkCalls.push({ url: u, method: req.method(), at: Date.now() });
});

async function shot(name) { const p = join(OUT, `${name}.png`); try { await page.screenshot({ path: p, fullPage: false }); } catch {} return p; }

// LOGIN
await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 30000 });
await page.fill('input[type="email"], input[name="email"]', EMAIL);
await page.fill('input[type="password"], input[name="password"]', PASSWORD);
await Promise.all([
  page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }),
  page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")'),
]);
log.push("login-ok");

// PROBE: matrix view
await page.goto(`${BASE}/reversal?view=matrix`, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3000);
const tableCount = await page.locator("table").count();
log.push(`table-count=${tableCount}`);
const rowCount = await page.locator("table tbody tr").count();
log.push(`row-count=${rowCount}`);
await shot("matrix-view-full");

// Matrix tbody contains cohort-header rows (no button) interleaved with
// ticker rows (button = ticker symbol). Target any ticker button.
const allButtons = page.locator('table tbody button');
const btnCount = await allButtons.count();
log.push(`tbody-button-count=${btnCount}`);
const firstBtnText = btnCount > 0 ? (await allButtons.first().textContent().catch(() => "")) : "";
log.push(`first-button-text="${(firstBtnText || "").slice(0, 30).trim()}"`);
const symLocator = btnCount > 0 ? allButtons.first() : null;

let priceCallsBefore = 0, priceCallsAfterOpen1 = 0, priceCallsAfterOpen2 = 0;

if (symLocator) {
  priceCallsBefore = networkCalls.filter(c => c.url.includes("/api/prices?")).length;
  await symLocator.click({ timeout: 5000 }).catch((e) => log.push(`click-1-err=${e.message}`));
  await page.waitForTimeout(3000);
  priceCallsAfterOpen1 = networkCalls.filter(c => c.url.includes("/api/prices?")).length;
  log.push(`popover-open-1 prices-fetched=${priceCallsAfterOpen1 - priceCallsBefore}`);
  await shot("matrix-popover-open-1");

  // close popover
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(800);
  // click body area to ensure closed
  await page.mouse.click(10, 10).catch(() => {});
  await page.waitForTimeout(500);

  // reopen
  await symLocator.click({ timeout: 5000 }).catch((e) => log.push(`click-2-err=${e.message}`));
  await page.waitForTimeout(3000);
  priceCallsAfterOpen2 = networkCalls.filter(c => c.url.includes("/api/prices?")).length;
  log.push(`popover-open-2 prices-fetched=${priceCallsAfterOpen2 - priceCallsAfterOpen1}`);
  await shot("matrix-popover-open-2");
}

writeFileSync(join(OUT, "report.json"), JSON.stringify({ base: BASE, log, consoleMsgs, networkCalls }, null, 2));
console.log("LOG:\n" + log.join("\n"));
console.log(`\nprices-fetched open-1=${priceCallsAfterOpen1 - priceCallsBefore}  open-2=${priceCallsAfterOpen2 - priceCallsAfterOpen1}`);
console.log(`console-errors=${consoleMsgs.filter(m => m.type === "error" || m.type === "pageerror").length}`);

await browser.close();
process.exit(0);
