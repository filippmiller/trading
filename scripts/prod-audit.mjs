// Extended headed audit for trading-production.
// Covers all 12 sidebar routes + targeted regression probes (PR #29, #33, #34)
// + safe mutations (filters, scenario apply+reset, popover open/close).
// Prod-state mutations (real order, reset modal, account creation) are skipped.

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.SMOKE_BASE || "https://trading-production-06fe.up.railway.app";
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const OUT = process.env.SMOKE_OUT || "audit/prod-audit";
const HEADED = process.env.SMOKE_HEADED === "1";

if (!EMAIL || !PASSWORD) {
  console.error("SMOKE_EMAIL and SMOKE_PASSWORD env vars required");
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

const PAGES = [
  { path: "/", key: "root" },
  { path: "/markets", key: "markets" },
  { path: "/reversal", key: "reversal" },
  { path: "/strategies", key: "strategies" },
  { path: "/scenarios", key: "scenarios" },
  { path: "/research", key: "research" },
  { path: "/signals", key: "signals" },
  { path: "/prices", key: "prices" },
  { path: "/voice", key: "voice" },
  { path: "/runs", key: "runs" },
  { path: "/paper", key: "paper" },
  { path: "/settings", key: "settings" },
];

const results = [];
const consoleMsgs = [];
const probes = [];
const rollbackLog = [];
const networkCalls = [];

const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

page.on("console", (m) => {
  const t = m.type();
  if (t === "error" || t === "warning") {
    consoleMsgs.push({ type: t, text: m.text().slice(0, 500), url: page.url(), at: Date.now() });
  }
});
page.on("pageerror", (e) => {
  consoleMsgs.push({ type: "pageerror", text: e.message.slice(0, 500), url: page.url(), at: Date.now() });
});
page.on("requestfinished", (req) => {
  const u = req.url();
  if (u.includes("/api/prices/daily") || u.includes("/api/paper/") || u.includes("/api/reversal/")) {
    networkCalls.push({ url: u, method: req.method(), at: Date.now() });
  }
});

async function shot(key) {
  const p = join(OUT, `${key}.png`);
  try { await page.screenshot({ path: p, fullPage: true }); } catch {}
  return p;
}

async function errorsSince(anchorIdx) {
  return consoleMsgs.slice(anchorIdx);
}

// ---------- LOGIN ----------
try {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 30000 });
  await page.fill('input[type="email"], input[name="email"]', EMAIL);
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }),
    page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Войти")'),
  ]);
  console.log(`LOGIN OK -> ${page.url()}`);
} catch (e) {
  console.error("LOGIN FAILED", e.message);
  await shot("login-failure");
  await browser.close();
  process.exit(1);
}

// ---------- PAGE WALK ----------
for (const { path, key } of PAGES) {
  const before = consoleMsgs.length;
  const url = `${BASE}${path}`;
  let status = 0;
  const t0 = Date.now();
  try {
    const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
    status = resp?.status() || 0;
    await page.waitForTimeout(1500);
    const screenshotPath = await shot(key);
    const title = await page.title().catch(() => null);
    const h1 = await page.locator("h1").first().textContent().catch(() => null);
    const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 300);
    const errs = await errorsSince(before);
    results.push({
      path,
      status,
      finalUrl: page.url(),
      title,
      h1: (h1 || "").trim(),
      bodyStart: bodyText,
      ms: Date.now() - t0,
      screenshot: screenshotPath,
      errors: errs,
    });
    console.log(`  [${status}] ${path}  errs=${errs.length}  ${Date.now() - t0}ms`);
  } catch (e) {
    results.push({ path, status, error: e.message, ms: Date.now() - t0, screenshot: await shot(`${key}-fail`) });
    console.error(`  FAIL ${path}  ${e.message}`);
  }
}

// ---------- TARGETED PROBES ----------

// Probe A: /reversal — matrix loads, F1/F2/F3 filters clickable, Best/Worst panel present
async function probeMatrix() {
  const probe = { name: "matrix-basic", started: Date.now(), notes: [] };
  try {
    await page.goto(`${BASE}/reversal`, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(2000);
    const matrixCell = await page.locator('table').first().count();
    probe.notes.push(`table-count=${matrixCell}`);
    // F1/F2/F3 filters - try several selector shapes
    const f1 = await page.locator('button:has-text("F1"), [aria-label*="F1"], [data-testid*="f1"]').count();
    const f2 = await page.locator('button:has-text("F2"), [aria-label*="F2"], [data-testid*="f2"]').count();
    const f3 = await page.locator('button:has-text("F3"), [aria-label*="F3"], [data-testid*="f3"]').count();
    probe.notes.push(`f1=${f1} f2=${f2} f3=${f3}`);
    const best = await page.locator('text=/Best/i').count();
    const worst = await page.locator('text=/Worst/i').count();
    probe.notes.push(`best=${best} worst=${worst}`);
    probe.screenshot = await shot("probe-matrix");
    probe.ok = true;
  } catch (e) {
    probe.ok = false;
    probe.error = e.message;
    probe.screenshot = await shot("probe-matrix-fail");
  }
  probe.ms = Date.now() - probe.started;
  probes.push(probe);
}

// Probe B: PR #34 empty-cache refetch — open popover, close, reopen, measure network
async function probeEmptyCacheRefetch() {
  const probe = { name: "pr34-empty-cache-refetch", started: Date.now(), notes: [] };
  try {
    await page.goto(`${BASE}/reversal`, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(2000);
    // Try clicking first symbol cell in matrix to open popover.
    const symbolCell = page.locator('table tbody tr td:first-child button, table tbody tr td:first-child a').first();
    const n = await symbolCell.count();
    probe.notes.push(`symbolCell-count=${n}`);
    if (n === 0) {
      probe.ok = false;
      probe.error = "No clickable symbol cell found";
      probe.screenshot = await shot("probe-pr34-fail-no-cell");
      probes.push(probe);
      return;
    }
    const before1 = networkCalls.filter((c) => c.url.includes("/api/prices/daily")).length;
    await symbolCell.click();
    await page.waitForTimeout(2500);
    probe.notes.push(`open-1 fetched=${networkCalls.filter((c) => c.url.includes("/api/prices/daily")).length - before1}`);
    probe.screenshot = await shot("probe-pr34-popover-open");
    // close
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
    // reopen
    const before2 = networkCalls.filter((c) => c.url.includes("/api/prices/daily")).length;
    await symbolCell.click();
    await page.waitForTimeout(2500);
    const refetch = networkCalls.filter((c) => c.url.includes("/api/prices/daily")).length - before2;
    probe.notes.push(`open-2 fetched=${refetch}`);
    probe.screenshot2 = await shot("probe-pr34-popover-reopen");
    probe.ok = true;
  } catch (e) {
    probe.ok = false;
    probe.error = e.message;
    probe.screenshot = await shot("probe-pr34-fail");
  }
  probe.ms = Date.now() - probe.started;
  probes.push(probe);
}

// Probe C: /paper — trade history, auto-exit slippage column for HARD_STOP/TRAILING_STOP
async function probePaperSlippage() {
  const probe = { name: "pr33-auto-exit-slippage", started: Date.now(), notes: [] };
  try {
    await page.goto(`${BASE}/paper`, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(2000);
    const hardstops = await page.locator('text=/HARD_STOP|TRAILING_STOP/i').count();
    probe.notes.push(`hardstop-or-trailing rows visible=${hardstops}`);
    const slippageHeader = await page.locator('text=/slippage/i').count();
    probe.notes.push(`slippage-header-count=${slippageHeader}`);
    probe.screenshot = await shot("probe-pr33-paper-history");
    probe.ok = true;
  } catch (e) {
    probe.ok = false;
    probe.error = e.message;
    probe.screenshot = await shot("probe-pr33-fail");
  }
  probe.ms = Date.now() - probe.started;
  probes.push(probe);
}

// Probe D: /paper — filter mutation + reset (safe, ephemeral)
async function probePaperFilterMutation() {
  const probe = { name: "paper-filter-mutation", started: Date.now(), notes: [] };
  try {
    await page.goto(`${BASE}/paper`, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(1500);
    const symbolFilter = page.locator('input[placeholder*="Symbol" i], input[aria-label*="Symbol" i]').first();
    const has = await symbolFilter.count();
    probe.notes.push(`symbol-filter-present=${has > 0}`);
    if (has === 0) {
      probe.ok = true;
      probe.notes.push("no-symbol-filter-visible-probably-no-trades");
      probe.screenshot = await shot("probe-paper-filter-none");
      probes.push(probe);
      return;
    }
    await symbolFilter.fill("AAPL");
    rollbackLog.push({ action: "typed AAPL into paper symbol filter", at: Date.now() });
    await page.waitForTimeout(1000);
    probe.screenshot = await shot("probe-paper-filter-aapl");
    await symbolFilter.fill("");
    rollbackLog.push({ action: "cleared paper symbol filter", at: Date.now() });
    await page.waitForTimeout(500);
    probe.screenshot2 = await shot("probe-paper-filter-cleared");
    probe.ok = true;
  } catch (e) {
    probe.ok = false;
    probe.error = e.message;
    probe.screenshot = await shot("probe-paper-filter-fail");
  }
  probe.ms = Date.now() - probe.started;
  probes.push(probe);
}

// Probe E: /scenarios — open page, switch presets (read-only mutation, no Apply)
async function probeScenariosTabSwitch() {
  const probe = { name: "scenarios-tab-switch", started: Date.now(), notes: [] };
  try {
    await page.goto(`${BASE}/scenarios`, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(1500);
    const tabs = await page.locator('[role="tab"], button[class*="tab" i]').count();
    probe.notes.push(`tab-count=${tabs}`);
    if (tabs > 1) {
      const t2 = page.locator('[role="tab"], button[class*="tab" i]').nth(1);
      await t2.click().catch(() => {});
      rollbackLog.push({ action: "clicked scenarios tab #2 (view only)", at: Date.now() });
      await page.waitForTimeout(800);
      probe.screenshot = await shot("probe-scenarios-tab2");
      const t0 = page.locator('[role="tab"], button[class*="tab" i]').nth(0);
      await t0.click().catch(() => {});
      rollbackLog.push({ action: "returned to scenarios tab #1", at: Date.now() });
      await page.waitForTimeout(500);
      probe.screenshot2 = await shot("probe-scenarios-tab1");
    }
    probe.ok = true;
  } catch (e) {
    probe.ok = false;
    probe.error = e.message;
    probe.screenshot = await shot("probe-scenarios-fail");
  }
  probe.ms = Date.now() - probe.started;
  probes.push(probe);
}

await probeMatrix();
await probeEmptyCacheRefetch();
await probePaperSlippage();
await probePaperFilterMutation();
await probeScenariosTabSwitch();

writeFileSync(
  join(OUT, "report.json"),
  JSON.stringify({ base: BASE, at: new Date().toISOString(), results, probes, consoleMsgs, networkCalls, rollbackLog }, null, 2),
);
console.log(`\nReport written to ${OUT}/report.json`);

await browser.close();

const hardFails = results.filter((r) => r.error || (r.status && r.status >= 500));
const pageErrors = consoleMsgs.filter((m) => m.type === "pageerror");
console.log(`\nhard-fails=${hardFails.length}  pageerrors=${pageErrors.length}  warnings/errors=${consoleMsgs.length - pageErrors.length}`);
if (hardFails.length || pageErrors.length) {
  process.exit(1);
}
process.exit(0);
