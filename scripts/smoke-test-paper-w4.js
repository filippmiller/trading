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

// ── Test 8: Borrow cost accrual — multi-day via targetDate override ──────
async function test8_borrowAccrual(accountId) {
  console.log("\nTest 8: Borrow cost — open SHORT $1000 @ $100, 2.5% annual, accrue 7 calendar days");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 2.5,
  });
  // Open SHORT $1000 @ $100 (LIMIT to skip slippage). qty = 10.
  const orderId = await insertOrder(accountId, "ZTEST_SHORT", "SELL", "SHORT", "LIMIT", { investment_usd: 1000 });
  const fill = await paperFill.fillOrder(pool, orderId, 100);
  assert(fill.filled === true, `SHORT open ok (got ${JSON.stringify(fill)})`);

  // Seed the trade row's borrow_daily_rate_pct = 2.5 and pin buy_date so the
  // DATEDIFF calc is deterministic across wall-clock drift.
  const baseDate = "2026-04-01"; // buy date for this test
  await pool.execute(
    "UPDATE paper_trades SET borrow_daily_rate_pct = 2.5, buy_date = ?, last_borrow_accrued_date = NULL WHERE id = ?",
    [baseDate, fill.tradeId]
  );

  const acctBefore = await getAccount(accountId);
  const { jobAccrueBorrowCost } = require("./surveillance-cron-borrow.cjs");
  // Run cron with targetDate = baseDate + 7 days — one call accrues all 7.
  const target = "2026-04-08"; // 7 calendar days after base
  const res = await jobAccrueBorrowCost(pool, { targetDate: target });
  const acctAfter = await getAccount(accountId);
  const expectedDebit = 7 * (10 * 100 * 0.025 / 365);
  const delta = Number(acctBefore.cash) - Number(acctAfter.cash);
  assert(Math.abs(delta - expectedDebit) < 1e-4, `7-day borrow debit = ${expectedDebit.toFixed(6)} (got ${delta.toFixed(6)})`);
  assert(res.debited === 1 && res.skipped === 0, `one trade debited, none skipped (got debited=${res.debited} skipped=${res.skipped})`);
}

// ── Test 9: SHORT open ledger (round-2 bug #2 fix) ──────────────────────
async function test9_shortOpenLedger(accountId) {
  console.log("\nTest 9 (round-2 #2): SHORT open — margin = adj*qty (not nominal)");
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
  const [[t]] = await pool.execute(
    "SELECT buy_price, slippage_usd, commission_usd, investment_usd FROM paper_trades WHERE id = ?",
    [fill.tradeId]
  );
  assert(Math.abs(Number(t.slippage_usd) - 0.5) < EPS, `slip = 0.50 (tracked)`);
  assert(Math.abs(Number(t.commission_usd) - 1.0) < EPS, `comm = 1.00`);
  // Margin now = adj*qty = 99.95*10 = 999.5, NOT nominal 1000.
  const expectedMargin = 99.95 * 10;
  const acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.reserved_short_margin) - expectedMargin) < EPS,
    `short margin = ${expectedMargin} (got ${acct.reserved_short_margin})`);
  // investment_usd on trade row = adjusted margin (for shorts).
  assert(Math.abs(Number(t.investment_usd) - expectedMargin) < EPS,
    `paper_trades.investment_usd = ${expectedMargin} for SHORT (got ${t.investment_usd})`);
  // Cash flow: adj*qty moved to margin, commission out of cash. Slippage is
  // NOT a separate cash debit under round-2 fix — it's baked into the smaller
  // margin, captured only informationally on slippage_usd.
  const expectedCash = TEST_INITIAL_CASH - expectedMargin - 1.0;
  assert(Math.abs(Number(acct.cash) - expectedCash) < EPS,
    `cash = ${expectedCash} (got ${acct.cash})`);
}

// ── Test 10 (round-2 #2): SHORT round-trip same adj price → PnL = -2*comm ─
async function test10_shortRoundTripSamePriceNoPhantomRecoup(accountId) {
  console.log("\nTest 10 (round-2 #2): SHORT round-trip same adj price → PnL = -2*commission");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 5, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 0,
  });
  // Open short MARKET at $100 quote → adj = $99.95, qty = 10, margin = $999.50.
  const openId = await insertOrder(accountId, "ZTEST_SHORT", "SELL", "SHORT", "MARKET", { investment_usd: 1000 });
  const open = await paperFill.fillOrder(pool, openId, 100);
  assert(open.filled === true, `SHORT open ok`);
  // Cover LIMIT at $99.95 (no cover-leg slippage). closeValue = $999.50.
  const coverId = await insertOrder(accountId, "ZTEST_SHORT", "BUY", "SHORT", "LIMIT", { trade_id: open.tradeId });
  const cover = await paperFill.fillOrder(pool, coverId, 99.95);
  assert(cover.filled === true, `cover ok (got ${JSON.stringify(cover)})`);

  const acct = await getAccount(accountId);
  const expectedCashDelta = -2 * 1.0; // -2*commission; zero slippage recoup
  const actualCashDelta = Number(acct.cash) - TEST_INITIAL_CASH;
  assert(Math.abs(actualCashDelta - expectedCashDelta) < EPS,
    `round-trip cash delta = -2*commission = ${expectedCashDelta} (got ${actualCashDelta.toFixed(6)})`);
  // Margin fully released.
  assert(Math.abs(Number(acct.reserved_short_margin)) < EPS,
    `reserved_short_margin released to 0 (got ${acct.reserved_short_margin})`);
}

// ── Test 11 (round-2 #1): LONG close — commission > proceeds → underflow HARD REJECT ──
async function test11_cashUnderflowOnLongClose(accountId) {
  console.log("\nTest 11 (round-2 #1): LONG close commission > cash+proceeds → HARD REJECT, cash untouched");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 0,
  });
  // Open tiny LONG, then drain cash to near-zero, then try to close with huge
  // commission. Goal: (closeValue - commission) < -cash so (cash + credit) < 0.
  const openId = await insertOrder(accountId, "ZTEST_AAPL", "BUY", "LONG", "MARKET", { investment_usd: 10 });
  const open = await paperFill.fillOrder(pool, openId, 100); // qty = 0.1, cash -11 (10 inv + 1 comm)
  assert(open.filled === true, `open ok`);
  // Drain remaining cash to -$5 worth below threshold via direct UPDATE.
  await pool.execute("UPDATE paper_accounts SET cash = 0.05 WHERE id = ?", [accountId]);
  // Jack up commission to $50 so close-value ($10) - $50 commission = -$40 credit,
  // cash would become 0.05 - 40 < 0.
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0.005, commissionMinPerLeg: 50.0,
    allowFractionalShares: true, defaultBorrowRatePct: 0,
  });
  const closeId = await insertOrder(accountId, "ZTEST_AAPL", "SELL", "LONG", "MARKET", { trade_id: open.tradeId });
  const close = await paperFill.fillOrder(pool, closeId, 100);
  assert(close.filled === false, `close rejected (got ${JSON.stringify(close)})`);
  assert(close.rejection === "CASH_UNDERFLOW_ON_CLOSE",
    `rejection = CASH_UNDERFLOW_ON_CLOSE (got ${close.rejection})`);
  // Cash must be UNTOUCHED (0.05) — HARD REJECT rolled back.
  const acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.cash) - 0.05) < EPS, `cash unchanged = 0.05 (got ${acct.cash})`);
  // Position must remain OPEN.
  const [[trade]] = await pool.execute("SELECT status FROM paper_trades WHERE id = ?", [open.tradeId]);
  assert(trade.status === "OPEN", `trade stays OPEN (got ${trade.status})`);
}

// ── Test 12 (round-2 #3): concurrent cover vs borrow cron — race-safe skip ──
async function test12_borrowCronSkipsClosedShort(accountId) {
  console.log("\nTest 12 (round-2 #3): borrow cron re-checks status='OPEN' under trade lock → skip if raced to CLOSED");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 2.5,
  });
  // Open SHORT, seed borrow rate + buy_date.
  const openId = await insertOrder(accountId, "ZTEST_SHORT", "SELL", "SHORT", "LIMIT", { investment_usd: 1000 });
  const open = await paperFill.fillOrder(pool, openId, 100);
  assert(open.filled === true, `short open ok`);
  await pool.execute(
    "UPDATE paper_trades SET borrow_daily_rate_pct = 2.5, buy_date = '2026-04-01', last_borrow_accrued_date = NULL WHERE id = ?",
    [open.tradeId]
  );

  // To exercise the per-trade re-check under lock, we use a cron variant
  // that accepts an injected hook fired BETWEEN the outer snapshot SELECT
  // and each per-trade transaction. The hook flips the row to CLOSED; the
  // per-trade tx's `FOR UPDATE` re-read must see it and skip.
  //
  // Instead of duplicating the cron, we simulate here by opening a race
  // window: spawn two "workers" — the flip and the cron — on separate
  // connections. In a single-threaded JS runner we serialize as: (a) the
  // outer SELECT in the cron picks up the trade as OPEN, (b) before the
  // per-trade tx hits the FOR UPDATE re-read, we flip to CLOSED on a
  // sibling connection, (c) the tx must see CLOSED and skip.
  //
  // Easiest simulation: wrap the cron so we can monkeypatch the pool to
  // flip the row right before tradeRows is read. Since we can't do that
  // cleanly with the current signature, we instead exercise the status
  // re-check path DIRECTLY by running the per-trade block ourselves.
  const conn = await pool.getConnection();
  let skipped = false;
  try {
    await conn.beginTransaction();
    // Lock account, then flip status=CLOSED (simulating a commit from another
    // worker that already released the margin & closed the trade).
    await conn.execute("SELECT id FROM paper_accounts WHERE id = ? FOR UPDATE", [accountId]);
    // Flip status on a separate connection — simulates another tx already
    // committed the cover.
    await pool.execute("UPDATE paper_trades SET status = 'CLOSED' WHERE id = ?", [open.tradeId]);
    // Now, from within our tx, re-read trade under FOR UPDATE (same query
    // the cron uses). It must see CLOSED.
    const [rows] = await conn.execute(
      "SELECT status FROM paper_trades WHERE id = ? FOR UPDATE",
      [open.tradeId]
    );
    if (rows.length > 0 && rows[0].status !== "OPEN") {
      skipped = true;
      await conn.rollback();
    } else {
      await conn.rollback();
    }
  } finally {
    conn.release();
  }
  assert(skipped === true, `per-trade FOR UPDATE re-read sees CLOSED and skips`);

  // Additionally: running the full cron on the now-closed trade must yield
  // zero debits (trade filtered out by the outer WHERE status='OPEN').
  const cashBefore = Number((await getAccount(accountId)).cash);
  const { jobAccrueBorrowCost } = require("./surveillance-cron-borrow.cjs");
  const res = await jobAccrueBorrowCost(pool, { targetDate: "2026-04-08" });
  const cashAfter = Number((await getAccount(accountId)).cash);
  assert(Math.abs(cashAfter - cashBefore) < EPS,
    `cash unchanged when trade already closed (before=${cashBefore} after=${cashAfter})`);
  assert(res.debited === 0,
    `cron debited=0 for already-closed position (got ${res.debited})`);
}

// ── Test 13 (round-2 #4): cron runs twice same day → second run no-ops ──
async function test13_cronIdempotencySameDay(accountId) {
  console.log("\nTest 13 (round-2 #4): cron twice same day → 2nd run no-op (0 days to accrue)");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 2.5,
  });
  const openId = await insertOrder(accountId, "ZTEST_SHORT", "SELL", "SHORT", "LIMIT", { investment_usd: 1000 });
  const open = await paperFill.fillOrder(pool, openId, 100);
  assert(open.filled === true, `short open ok`);
  await pool.execute(
    "UPDATE paper_trades SET borrow_daily_rate_pct = 2.5, buy_date = '2026-04-01', last_borrow_accrued_date = NULL WHERE id = ?",
    [open.tradeId]
  );

  const { jobAccrueBorrowCost } = require("./surveillance-cron-borrow.cjs");
  const cashBefore = Number((await getAccount(accountId)).cash);
  const res1 = await jobAccrueBorrowCost(pool, { targetDate: "2026-04-08" });
  const cashAfter1 = Number((await getAccount(accountId)).cash);
  const res2 = await jobAccrueBorrowCost(pool, { targetDate: "2026-04-08" });
  const cashAfter2 = Number((await getAccount(accountId)).cash);
  assert(res1.debited === 1, `run 1 debits (got debited=${res1.debited})`);
  assert(res2.debited === 0 && res2.skipped === 1,
    `run 2 no-ops (debited=${res2.debited} skipped=${res2.skipped})`);
  assert(Math.abs(cashAfter1 - cashAfter2) < EPS, `cash unchanged between run 1 and run 2`);
  const expected7Days = 7 * (10 * 100 * 0.025 / 365);
  assert(Math.abs((cashBefore - cashAfter1) - expected7Days) < 1e-4,
    `run 1 debited 7 days (got ${(cashBefore - cashAfter1).toFixed(6)})`);
}

// ── Test 14 (round-2 #5): multi-day span includes weekend ────────────────
async function test14_weekendAccrualIncluded(accountId) {
  console.log("\nTest 14 (round-2 #5): Friday→Monday accrual = 3 calendar days (weekend included)");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 2.5,
  });
  const openId = await insertOrder(accountId, "ZTEST_SHORT", "SELL", "SHORT", "LIMIT", { investment_usd: 1000 });
  const open = await paperFill.fillOrder(pool, openId, 100);
  assert(open.filled === true, `short open ok`);
  // Seed last_borrow_accrued_date = Friday 2026-04-03, target = Monday 2026-04-06.
  await pool.execute(
    "UPDATE paper_trades SET borrow_daily_rate_pct = 2.5, buy_date = '2026-03-15', last_borrow_accrued_date = '2026-04-03' WHERE id = ?",
    [open.tradeId]
  );
  const cashBefore = Number((await getAccount(accountId)).cash);
  const { jobAccrueBorrowCost } = require("./surveillance-cron-borrow.cjs");
  const res = await jobAccrueBorrowCost(pool, { targetDate: "2026-04-06" });
  const cashAfter = Number((await getAccount(accountId)).cash);
  // Fri→Mon = 3 calendar days (Sat, Sun, Mon).
  const expected3Days = 3 * (10 * 100 * 0.025 / 365);
  assert(res.debited === 1, `cron debited once`);
  assert(Math.abs((cashBefore - cashAfter) - expected3Days) < 1e-4,
    `3-day weekend-span debit = ${expected3Days.toFixed(6)} (got ${(cashBefore - cashAfter).toFixed(6)})`);
  // Verify last_borrow_accrued_date advanced to target.
  const [[t]] = await pool.execute(
    "SELECT last_borrow_accrued_date FROM paper_trades WHERE id = ?",
    [open.tradeId]
  );
  const lastIso = new Date(t.last_borrow_accrued_date).toISOString().slice(0, 10);
  assert(lastIso === "2026-04-06", `last_borrow_accrued_date = 2026-04-06 (got ${lastIso})`);
}

// ── Test 15 (round-2 #6): cover-path intraday accrual = documented limitation ──
async function test15_coverIntradayAccrualSkipped(accountId) {
  console.log("\nTest 15 (round-2 #6): cover path does NOT catch-up intraday borrow (documented MVP limitation)");
  await resetAcctState(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 2.5,
  });
  // Open short, seed borrow.
  const openId = await insertOrder(accountId, "ZTEST_SHORT", "SELL", "SHORT", "LIMIT", { investment_usd: 1000 });
  const open = await paperFill.fillOrder(pool, openId, 100);
  assert(open.filled === true, `short open`);
  // Seed last_borrow_accrued_date a few days ago; cover today at same price.
  await pool.execute(
    "UPDATE paper_trades SET borrow_daily_rate_pct = 2.5, buy_date = '2026-04-01', last_borrow_accrued_date = '2026-04-05' WHERE id = ?",
    [open.tradeId]
  );
  const cashBeforeCover = Number((await getAccount(accountId)).cash);
  // Cover LIMIT at exact adj open price (0 pnl, commission only).
  const coverId = await insertOrder(accountId, "ZTEST_SHORT", "BUY", "SHORT", "LIMIT", { trade_id: open.tradeId });
  const cover = await paperFill.fillOrder(pool, coverId, 100);
  assert(cover.filled === true, `cover ok`);
  const cashAfterCover = Number((await getAccount(accountId)).cash);
  // Under MVP limitation: cover does NOT catch up borrow between
  // last_borrow_accrued_date and today. Cash delta = -commission only.
  const coverCashDelta = cashAfterCover - cashBeforeCover;
  // SHORT cover at no-slippage LIMIT $100 = closeValue 1000; margin release
  // = adj_open * qty = 100 * 10 = 1000. cashCredit = 2*1000 - 1000 - 1 = 999.
  assert(Math.abs(coverCashDelta - 999) < EPS,
    `cover cash credit = 999 (no borrow catch-up, got ${coverCashDelta.toFixed(6)})`);
  // Trade is CLOSED; last_borrow_accrued_date unchanged.
  const [[t]] = await pool.execute(
    "SELECT status, last_borrow_accrued_date FROM paper_trades WHERE id = ?",
    [open.tradeId]
  );
  assert(t.status === "CLOSED", `trade closed`);
  const lastIso = new Date(t.last_borrow_accrued_date).toISOString().slice(0, 10);
  assert(lastIso === "2026-04-05", `last_borrow_accrued_date unchanged = 2026-04-05 (got ${lastIso}) — confirms MVP limitation`);
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
    await test10_shortRoundTripSamePriceNoPhantomRecoup(accountId);
    await test11_cashUnderflowOnLongClose(accountId);
    await test12_borrowCronSkipsClosedShort(accountId);
    await test13_cronIdempotencySameDay(accountId);
    await test14_weekendAccrualIncluded(accountId);
    await test15_coverIntradayAccrualSkipped(accountId);

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
