#!/usr/bin/env node
/**
 * Smoke test — Paper Trading W4 (slippage, commission, % sizing, whitelist,
 * fractional, borrow cost).
 *
 * Uses a dedicated `W4_SMOKE_TEST_DO_NOT_USE` account so it never touches
 * Default or any strategy account. Pins the risk config via the test hook
 * so the runtime values in `app_settings` don't get in the way.
 *
 * Assertions (>= 20 required, actual count logged at end):
 *   - Slippage model (MARKET vs LIMIT semantics, both sides).
 *   - Commission schedule (min floor + per-share).
 *   - Combined fill ledger (cash == initial − investment − slippage − comm).
 *   - Conservation invariant across open and close.
 *   - Symbol whitelist (accept known, reject unknown).
 *   - Fractional OFF — insufficient investment rejection.
 *   - Fractional ON — fractional quantity preserved.
 *   - Borrow cost accrual (7-day simulation via 7 calls).
 *
 * Runs against the local tunnel DB (port 3319). Seeds tradable_symbols with
 * test tickers so whitelist rejection testing doesn't depend on prod data.
 */

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

try {
  const envFile = fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* ok */ }

let paperFill;
let paperRisk;
async function loadModules() {
  paperFill = require("../src/lib/paper-fill");
  paperRisk = require("../src/lib/paper-risk");
}

const TEST_ACCOUNT_NAME = "W4_SMOKE_TEST_DO_NOT_USE";
const TEST_INITIAL_CASH = 100000;
const EPS = 1e-4;

const url = new URL(process.env.DATABASE_URL || "mysql://root:trading123@localhost:3319/trading");
const dbConfig = {
  host: url.hostname,
  port: Number(url.port) || 3306,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
  connectionLimit: 10,
  waitForConnections: true,
  timezone: "Z",
};
const pool = mysql.createPool(dbConfig);

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS ${msg}`); }
  else      { failed++; failures.push(msg); console.log(`  FAIL ${msg}`); }
}

async function ensureSchemaMinimal() {
  const required = [
    ["paper_trades", "commission_usd"],
    ["paper_trades", "slippage_usd"],
  ];
  for (const [table, col] of required) {
    const [rows] = await pool.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
      [table, col]
    );
    if (rows.length === 0) {
      throw new Error(`Schema check failed: ${table}.${col} missing. Apply scripts/migration-2026-04-21-paper-w4.sql.`);
    }
  }
  const [tbl] = await pool.execute(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tradable_symbols'"
  );
  if (tbl.length === 0) throw new Error("Schema check failed: tradable_symbols missing.");
}

async function seedTestSymbols() {
  // Test tickers: TEST_AAPL (real-ish), TEST_BRK (high-priced), TEST_MID ($333).
  // Use "z-prefix" so they don't clash with any production seed.
  const symbols = ["ZTEST_AAPL", "ZTEST_BRK", "ZTEST_MID", "ZTEST_BORROW", "ZTEST_SHORT"];
  for (const s of symbols) {
    await pool.execute(
      "INSERT INTO tradable_symbols (symbol, exchange, asset_class, active) VALUES (?, 'TEST', 'EQUITY', 1) ON DUPLICATE KEY UPDATE active = 1",
      [s]
    );
  }
}

async function cleanupTestSymbols() {
  await pool.execute("DELETE FROM tradable_symbols WHERE exchange = 'TEST'");
}

async function resetTestAccount() {
  const [rows] = await pool.execute(
    "SELECT id FROM paper_accounts WHERE name = ? LIMIT 1",
    [TEST_ACCOUNT_NAME]
  );
  let accountId;
  if (rows.length === 0) {
    const [r] = await pool.execute(
      "INSERT INTO paper_accounts (name, initial_cash, cash) VALUES (?, ?, ?)",
      [TEST_ACCOUNT_NAME, TEST_INITIAL_CASH, TEST_INITIAL_CASH]
    );
    accountId = r.insertId;
  } else {
    accountId = rows[0].id;
    await pool.execute("DELETE FROM paper_equity_snapshots WHERE account_id = ?", [accountId]);
    await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
    await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
    await pool.execute(
      "UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0, initial_cash = ? WHERE id = ?",
      [TEST_INITIAL_CASH, TEST_INITIAL_CASH, accountId]
    );
  }
  return accountId;
}

async function teardownTestAccount(accountId) {
  if (!accountId) return;
  try {
    await pool.execute("DELETE FROM paper_equity_snapshots WHERE account_id = ?", [accountId]);
    await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
    await pool.execute("UPDATE paper_trades SET strategy_id = NULL WHERE account_id = ?", [accountId]);
    await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
    await pool.execute("DELETE FROM paper_accounts WHERE id = ? AND name = ?", [accountId, TEST_ACCOUNT_NAME]);
  } catch (err) {
    console.error("teardown warning:", err.message);
  }
}

async function resetAcctState(accountId) {
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?",
    [TEST_INITIAL_CASH, accountId]);
}

async function insertOrder(accountId, symbol, side, position_side, orderType, fields = {}) {
  const {
    investment_usd = null, limit_price = null, stop_price = null,
    trade_id = null, close_quantity = null,
  } = fields;
  const [r] = await pool.execute(
    `INSERT INTO paper_orders (account_id, symbol, side, position_side, order_type, investment_usd,
       limit_price, stop_price, trade_id, close_quantity, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    [accountId, symbol, side, position_side, orderType, investment_usd, limit_price, stop_price, trade_id, close_quantity]
  );
  return r.insertId;
}

async function getAccount(id) {
  const [rows] = await pool.execute("SELECT cash, reserved_cash, reserved_short_margin, initial_cash FROM paper_accounts WHERE id = ?", [id]);
  return rows[0];
}

// ── Pure-function tests on paper-risk.ts itself ───────────────────────────
function testPureRiskFns() {
  console.log("\nPure: applySlippage + applyCommission + normalizeQuantity");
  const cfg = { slippageBps: 5, commissionPerShare: 0.005, commissionMinPerLeg: 1.0, allowFractionalShares: true, defaultBorrowRatePct: 2.5 };
  assert(Math.abs(paperRisk.applySlippage(100, "BUY", "MARKET", cfg) - 100.05) < EPS, "MARKET BUY slippage 5bps @$100 → $100.05");
  assert(Math.abs(paperRisk.applySlippage(100, "SELL", "MARKET", cfg) - 99.95) < EPS, "MARKET SELL slippage 5bps @$100 → $99.95");
  assert(paperRisk.applySlippage(100, "BUY", "LIMIT", cfg) === 100, "LIMIT BUY slippage = 0 (price unchanged)");
  assert(paperRisk.applySlippage(100, "SELL", "LIMIT", cfg) === 100, "LIMIT SELL slippage = 0");
  // Commission
  assert(paperRisk.applyCommission(10, 1000, cfg) === 1.0, "commission 10 shares → $1.00 min floor");
  assert(paperRisk.applyCommission(1000, 100000, cfg) === 5.0, "commission 1000 shares → $5.00 (0.005 × 1000)");
  // normalizeQuantity
  const frac = paperRisk.normalizeQuantity(0.3003, { ...cfg, allowFractionalShares: true });
  assert(Math.abs(frac.quantity - 0.3003) < EPS && frac.rejected === false, "fractional on → qty preserved (0.3003)");
  const whole = paperRisk.normalizeQuantity(0.3003, { ...cfg, allowFractionalShares: false });
  assert(whole.rejected === true, "fractional off + 0.3003 → rejected");
  const whole2 = paperRisk.normalizeQuantity(3.7, { ...cfg, allowFractionalShares: false });
  assert(whole2.rejected === false && whole2.quantity === 3, "fractional off + 3.7 → floor to 3");
}

// ── Test 1: MARKET BUY with slippage + commission ────────────────────────
async function test1_marketBuySlippageCommission(accountId) {
  console.log("\nTest 1: MARKET BUY $1000 @ $100 with 5bps slippage + $1 commission");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 5, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 2.5,
  });
  const orderId = await insertOrder(accountId, "ZTEST_AAPL", "BUY", "LONG", "MARKET", { investment_usd: 1000 });
  const fill = await paperFill.fillOrder(pool, orderId, 100);
  assert(fill.filled === true, `fill succeeded (got ${JSON.stringify(fill)})`);
  // quantity = investment / basePrice = 1000/100 = 10
  assert(Math.abs(fill.quantity - 10) < EPS, `quantity = 10 (got ${fill.quantity})`);
  // adjustedPrice = 100 * 1.0005 = 100.05
  assert(Math.abs(fill.fillPrice - 100.05) < EPS, `fillPrice = 100.05 (got ${fill.fillPrice})`);

  // DB state
  const [tradeRow] = await pool.execute("SELECT buy_price, quantity, investment_usd, slippage_usd, commission_usd FROM paper_trades WHERE id = ?", [fill.tradeId]);
  const t = tradeRow[0];
  assert(Math.abs(Number(t.buy_price) - 100.05) < EPS, `paper_trades.buy_price = 100.05 (got ${t.buy_price})`);
  // slippage_usd = qty * |adj - base| = 10 * 0.05 = 0.50
  assert(Math.abs(Number(t.slippage_usd) - 0.5) < EPS, `paper_trades.slippage_usd = 0.50 (got ${t.slippage_usd})`);
  // commission = max(1.0, 10*0.005) = 1.0
  assert(Math.abs(Number(t.commission_usd) - 1.0) < EPS, `paper_trades.commission_usd = 1.00 (got ${t.commission_usd})`);

  // Cash = initial - (investment + slippage + commission) = 100k - 1001.50
  const acct = await getAccount(accountId);
  const expectedCash = TEST_INITIAL_CASH - 1000 - 0.5 - 1.0;
  assert(Math.abs(Number(acct.cash) - expectedCash) < EPS, `cash = ${expectedCash.toFixed(4)} (got ${acct.cash})`);
}

// ── Test 2: Commission min-floor triggers ────────────────────────────────
async function test2_commissionMinFloor(accountId) {
  console.log("\nTest 2: Commission min-floor — 10 shares × $0.005 = $0.05 → floored to $1.00");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 0,
  });
  const orderId = await insertOrder(accountId, "ZTEST_AAPL", "BUY", "LONG", "MARKET", { investment_usd: 1000 });
  const fill = await paperFill.fillOrder(pool, orderId, 100);
  assert(fill.filled === true, `fill ok`);
  const [tradeRow] = await pool.execute("SELECT slippage_usd, commission_usd FROM paper_trades WHERE id = ?", [fill.tradeId]);
  assert(Number(tradeRow[0].slippage_usd) === 0, `slippage = 0 with bps=0`);
  assert(Math.abs(Number(tradeRow[0].commission_usd) - 1.0) < EPS, `commission floored at $1.00 (got ${tradeRow[0].commission_usd})`);
  const acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.cash) - (TEST_INITIAL_CASH - 1001)) < EPS, `cash = ${TEST_INITIAL_CASH - 1001} (got ${acct.cash})`);
}

// ── Test 3: Conservation invariant after open ────────────────────────────
async function test3_conservationOpen(accountId) {
  console.log("\nTest 3: Conservation — cash + positions_value + slippage_sum + commission_sum == initial (open)");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 5, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 0,
  });
  const orderId = await insertOrder(accountId, "ZTEST_AAPL", "BUY", "LONG", "MARKET", { investment_usd: 1000 });
  await paperFill.fillOrder(pool, orderId, 100);

  const acct = await getAccount(accountId);
  const [[tSum]] = await pool.execute(
    `SELECT COALESCE(SUM(slippage_usd),0) AS s, COALESCE(SUM(commission_usd),0) AS c,
            COALESCE(SUM(investment_usd),0) AS i
       FROM paper_trades WHERE account_id = ? AND status = 'OPEN'`, [accountId]);
  // positions_value marked @ nominal (investment) — slippage + commission
  // captured separately on the trade row.
  const lhs = Number(acct.cash) + Number(tSum.i) + Number(tSum.s) + Number(tSum.c);
  const rhs = TEST_INITIAL_CASH;
  console.log(`    cash=${acct.cash}  inv=${tSum.i}  slip=${tSum.s}  comm=${tSum.c}  lhs=${lhs} rhs=${rhs}`);
  assert(Math.abs(lhs - rhs) < EPS, `conservation: lhs=${lhs} rhs=${rhs} drift=${(lhs-rhs).toFixed(6)}`);
}

// ── Test 4: Full round-trip conservation (open + close) ──────────────────
async function test4_conservationRoundTrip(accountId) {
  console.log("\nTest 4: Round-trip conservation — open LONG then SELL, verify cash reflects both legs");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 5, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 0,
  });
  // Open $1000 @ $100 → qty 10, adj $100.05, slip $0.50, comm $1.00 → cash -$1001.50
  const orderBuy = await insertOrder(accountId, "ZTEST_AAPL", "BUY", "LONG", "MARKET", { investment_usd: 1000 });
  const buy = await paperFill.fillOrder(pool, orderBuy, 100);
  assert(buy.filled === true, `buy filled`);

  // Close at $110 → SELL MARKET, adj $109.945 (sell slippage -5bps), qty 10,
  // proceeds = 10 * 109.945 = 1099.45, commission = $1.00 → cash +1098.45
  // pnl = (109.945 - 100.05) * 10 - 1 = 98.95 - 1 = 97.95
  const orderSell = await insertOrder(accountId, "ZTEST_AAPL", "SELL", "LONG", "MARKET", { trade_id: buy.tradeId });
  const sell = await paperFill.fillOrder(pool, orderSell, 110);
  assert(sell.filled === true, `sell filled (got ${JSON.stringify(sell)})`);

  const acct = await getAccount(accountId);
  // cash_after = initial - 1001.50 + (10 * 109.945 - 1) = 100000 - 1001.5 + 1098.45 = 100096.95
  const adjClose = 110 * (1 - 5/10000);
  const expectedCash = TEST_INITIAL_CASH - 1001.5 + (10 * adjClose - 1);
  assert(Math.abs(Number(acct.cash) - expectedCash) < EPS,
    `cash after round-trip = ${expectedCash.toFixed(4)} (got ${acct.cash})`);

  const [[closed]] = await pool.execute("SELECT pnl_usd, slippage_usd, commission_usd FROM paper_trades WHERE id = ?", [buy.tradeId]);
  // W4 — pnl_usd is GROSS of commission/slippage. Commission and slippage
  // are tracked separately on paper_trades and subtracted at display time
  // (or by the conservation ledger). Gross = (adjClose - adjOpen) * qty.
  const expectedPnl = (adjClose - 100.05) * 10;
  assert(Math.abs(Number(closed.pnl_usd) - expectedPnl) < EPS, `realized pnl (gross) = ${expectedPnl.toFixed(4)} (got ${closed.pnl_usd})`);
  // Total slippage = open 0.50 + close (0.055 * 10 = 0.55)
  const expectedSlip = 0.5 + Math.abs(adjClose - 110) * 10;
  assert(Math.abs(Number(closed.slippage_usd) - expectedSlip) < EPS, `trade.slippage_usd accumulated = ${expectedSlip.toFixed(4)} (got ${closed.slippage_usd})`);
  // Total commission = open $1 + close $1
  assert(Math.abs(Number(closed.commission_usd) - 2.0) < EPS, `trade.commission_usd accumulated = 2.00 (got ${closed.commission_usd})`);
}

// ── Test 5: Symbol whitelist ─────────────────────────────────────────────
async function test5_symbolWhitelist() {
  console.log("\nTest 5: Symbol whitelist — isSymbolTradable");
  const ok = await paperRisk.isSymbolTradable("ZTEST_AAPL");
  assert(ok === true, `ZTEST_AAPL (seeded) is tradable`);
  const bad = await paperRisk.isSymbolTradable("NONSENSE123");
  assert(bad === false, `NONSENSE123 rejected`);
  // Real seed — AAPL is in the real CSV seed.
  const real = await paperRisk.isSymbolTradable("AAPL");
  assert(real === true, `AAPL (real seed) is tradable`);
}

// ── Test 6: Fractional off — insufficient investment ─────────────────────
async function test6_fractionalInsufficient(accountId) {
  console.log("\nTest 6: Fractional OFF + $100 @ $700k/share BRK.A → INSUFFICIENT_INVESTMENT");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: false, defaultBorrowRatePct: 0,
  });
  const orderId = await insertOrder(accountId, "ZTEST_BRK", "BUY", "LONG", "MARKET", { investment_usd: 100 });
  const fill = await paperFill.fillOrder(pool, orderId, 700000);
  assert(fill.filled === false, `fill rejected`);
  assert(fill.rejection === "INSUFFICIENT_INVESTMENT", `rejection = INSUFFICIENT_INVESTMENT (got ${fill.rejection})`);

  // Cash must not have moved.
  const acct = await getAccount(accountId);
  assert(Number(acct.cash) === TEST_INITIAL_CASH, `cash untouched (got ${acct.cash})`);

  // Order row is REJECTED with the right reason.
  const [[o]] = await pool.execute("SELECT status, rejection_reason FROM paper_orders WHERE id = ?", [orderId]);
  assert(o.status === "REJECTED", `order status REJECTED`);
  assert(o.rejection_reason === "INSUFFICIENT_INVESTMENT", `rejection_reason = INSUFFICIENT_INVESTMENT (got ${o.rejection_reason})`);
}

// ── Test 7: Fractional on — fractional quantity ──────────────────────────
async function test7_fractionalOn(accountId) {
  console.log("\nTest 7: Fractional ON + $100 @ $333 → qty ≈ 0.3003");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 0,
  });
  const orderId = await insertOrder(accountId, "ZTEST_MID", "BUY", "LONG", "MARKET", { investment_usd: 100 });
  const fill = await paperFill.fillOrder(pool, orderId, 333);
  assert(fill.filled === true, `fill ok`);
  // qty = 100/333 ≈ 0.3003003...
  assert(Math.abs(fill.quantity - (100 / 333)) < 1e-6, `qty = 100/333 ≈ 0.3003003 (got ${fill.quantity})`);
}

// ── Test 8: Borrow cost accrual ──────────────────────────────────────────
async function test8_borrowAccrual(accountId) {
  console.log("\nTest 8: Borrow cost — open SHORT $1000 @ $100, 2.5% annual, accrue 7 days");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 2.5,
  });
  // Open SHORT $1000 @ $100 → qty 10
  const orderId = await insertOrder(accountId, "ZTEST_SHORT", "SELL", "SHORT", "MARKET", { investment_usd: 1000 });
  const fill = await paperFill.fillOrder(pool, orderId, 100);
  assert(fill.filled === true, `SHORT open ok (got ${JSON.stringify(fill)})`);

  // Seed the trade row's borrow_daily_rate_pct = 2.5 (the fill path does NOT
  // auto-seed this yet; the smoke test sets it explicitly to exercise the
  // cron. Production will eventually set it at open time — noted as follow-up).
  await pool.execute("UPDATE paper_trades SET borrow_daily_rate_pct = 2.5 WHERE id = ?", [fill.tradeId]);

  const acctBefore = await getAccount(accountId);
  const { jobAccrueBorrowCost } = require("./surveillance-cron-borrow.cjs");
  // Call 7 times — simulates 7 weekdays of accrual.
  for (let i = 0; i < 7; i++) await jobAccrueBorrowCost(pool);
  const acctAfter = await getAccount(accountId);
  // Daily: qty * price * 2.5/100 / 365 = 10 * 100 * 0.025 / 365 ≈ 0.0684931
  // 7 days: ≈ 0.4794520
  const expectedDebit = 7 * (10 * 100 * 0.025 / 365);
  const delta = Number(acctBefore.cash) - Number(acctAfter.cash);
  assert(Math.abs(delta - expectedDebit) < 1e-4, `7-day borrow debit = ${expectedDebit.toFixed(6)} (got ${delta.toFixed(6)})`);
}

// ── Test 9: SHORT open ledger ───────────────────────────────────────────
async function test9_shortOpenLedger(accountId) {
  console.log("\nTest 9: SHORT open — slippage adverse (price down) + commission");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 5, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 0,
  });
  const orderId = await insertOrder(accountId, "ZTEST_SHORT", "SELL", "SHORT", "MARKET", { investment_usd: 1000 });
  const fill = await paperFill.fillOrder(pool, orderId, 100);
  assert(fill.filled === true, `SHORT open ok`);
  // SELL slippage: 100 * 0.9995 = 99.95. qty = 1000/100 = 10.
  assert(Math.abs(fill.fillPrice - 99.95) < EPS, `adj SHORT fillPrice = 99.95 (got ${fill.fillPrice})`);
  const [[t]] = await pool.execute("SELECT buy_price, slippage_usd, commission_usd FROM paper_trades WHERE id = ?", [fill.tradeId]);
  assert(Math.abs(Number(t.slippage_usd) - 0.5) < EPS, `slip = 0.50`);
  assert(Math.abs(Number(t.commission_usd) - 1.0) < EPS, `comm = 1.00`);

  // Cash flow: investment $1000 moved into short margin, extras $0.50 + $1.00 out of cash.
  const acct = await getAccount(accountId);
  const expectedCash = TEST_INITIAL_CASH - 1000 - 0.5 - 1.0;
  assert(Math.abs(Number(acct.cash) - expectedCash) < EPS, `cash = ${expectedCash} (got ${acct.cash})`);
  assert(Math.abs(Number(acct.reserved_short_margin) - 1000) < EPS, `short margin = 1000 (got ${acct.reserved_short_margin})`);
}

// ── Run ─────────────────────────────────────────────────────────────────
(async () => {
  let accountId;
  try {
    await loadModules();
    await ensureSchemaMinimal();
    await seedTestSymbols();
    accountId = await resetTestAccount();
    console.log(`Using test account id=${accountId} name='${TEST_ACCOUNT_NAME}' cash=$${TEST_INITIAL_CASH}`);

    testPureRiskFns();
    await test1_marketBuySlippageCommission(accountId);
    await test2_commissionMinFloor(accountId);
    await test3_conservationOpen(accountId);
    await test4_conservationRoundTrip(accountId);
    await test5_symbolWhitelist();
    await test6_fractionalInsufficient(accountId);
    await test7_fractionalOn(accountId);
    await test8_borrowAccrual(accountId);
    await test9_shortOpenLedger(accountId);

    console.log(`\n== SUMMARY: ${passed} passed, ${failed} failed ==`);
    if (failed > 0) {
      console.log("Failures:");
      for (const f of failures) console.log("  -", f);
    }
  } catch (err) {
    console.error("Fatal:", err);
    failed++;
  } finally {
    paperRisk?._setRiskConfigForTest?.(null);
    await teardownTestAccount(accountId);
    await cleanupTestSymbols();
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(failed === 0 ? 0 : 1);
  }
})();
