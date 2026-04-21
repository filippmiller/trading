import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.SMOKE_BASE || "https://trading-production-06fe.up.railway.app";
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const OUT = process.env.SMOKE_OUT || "audit/prod-smoke";

if (!EMAIL || !PASSWORD) {
  console.error("SMOKE_EMAIL and SMOKE_PASSWORD env vars required");
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

const PAGES = [
  "/",
  "/reversal",
  "/research",
  "/paper",
  "/markets",
  "/strategies",
  "/settings",
];

const results = [];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const consoleMsgs = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") {
    consoleMsgs.push({ type: m.type(), text: m.text(), url: page.url() });
  }
});
page.on("pageerror", (e) => {
  consoleMsgs.push({ type: "pageerror", text: e.message, url: page.url() });
});

try {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"], input[name="email"]', EMAIL);
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 }),
    page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Войти")'),
  ]);
  console.log(`LOGIN OK -> ${page.url()}`);
} catch (e) {
  console.error("LOGIN FAILED", e.message);
  const shot = join(OUT, "login-failure.png");
  await page.screenshot({ path: shot, fullPage: true });
  console.error(`Screenshot: ${shot}`);
  await browser.close();
  process.exit(1);
}

for (const path of PAGES) {
  const before = consoleMsgs.length;
  const url = `${BASE}${path}`;
  let status = 0;
  let finalUrl = "";
  const t0 = Date.now();
  try {
    const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    status = resp?.status() || 0;
    finalUrl = page.url();
    await page.waitForTimeout(1500);
    const shot = join(OUT, `${path === "/" ? "root" : path.slice(1)}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const title = await page.title();
    const h1 = await page.locator("h1").first().textContent().catch(() => null);
    const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 200);
    const errs = consoleMsgs.slice(before);
    results.push({ path, status, finalUrl, title, h1, bodyStart: bodyText, ms: Date.now() - t0, errors: errs });
    console.log(`${path}  status=${status}  final=${finalUrl}  h1=${(h1 || "").trim().slice(0, 60)}  errs=${errs.length}`);
  } catch (e) {
    results.push({ path, status, finalUrl, error: e.message, ms: Date.now() - t0 });
    console.error(`${path}  FAIL  ${e.message}`);
  }
}

writeFileSync(join(OUT, "report.json"), JSON.stringify({ base: BASE, results, consoleMsgs }, null, 2));
console.log(`\nReport written to ${OUT}/report.json`);

await browser.close();

const hardFails = results.filter((r) => r.error || (r.status && r.status >= 500));
if (hardFails.length) {
  console.error(`\n${hardFails.length} hard failure(s)`);
  process.exit(1);
}
process.exit(0);
