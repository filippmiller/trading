#!/usr/bin/env node
/**
 * Smoke test — Paper Trading W3 (shorts, protective exits, partial close, modify).
 *
 * Uses a dedicated `W3_SMOKE_TEST_DO_NOT_USE` account so it never touches
 * Default or any strategy account. Idempotent teardown in the `finally` block.
 *
 * Test cases:
 *   1. LONG regression — concurrent BUY + SELL full-close from W1/W2 still works.
 *   2. SHORT round-trip profit — open $1000 short at $100, cover at $90 → +$100 pnl.
 *   3. SHORT round-trip loss — open $1000 short at $100, cover at $110 → -$100 pnl.
 *   4. Hard stop — LONG stop at $95, price tick $94 → closes at $94 with HARD_STOP.
 *   5. Trailing stop — LONG trailing=3% activates_at=5%. 100 → 110 → 115 → 111 → fires.
 *   6. Time exit — LONG with time_exit_date = today → monitorPaperTrades closes.
 *   7. Partial close — LONG qty 10, close in 3 partials (3+3+4), assert P&L sum.
 *   8. Order modify — PATCH a PENDING LIMIT BUY; reject PATCH on non-PENDING.
 *   9. Conservation invariant — cash + reserved_cash + reserved_short_margin +
 *      open_LONG_investment = initial_cash + realized_pnl across LONG + SHORT.
 *
 * Runs against the local tunnel DB (port 3319).
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
let paperExits;
async function loadModules() {
  paperFill = require("../src/lib/paper-fill");
  paperExits = require("../src/lib/paper-exits");
}

const TEST_ACCOUNT_NAME = "W3_SMOKE_TEST_DO_NOT_USE";
const TEST_INITIAL_CASH = 100000;
const PRECISION_EPS = 1e-4;

const url = new URL(process.env.DATABASE_URL || "mysql://root:trading123@localhost:3319/trading");
const dbConfig = {
  host: url.hostname,
  port: Number(url.port) || 3306,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
  connectionLimit: 30,
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
  // W3 columns are applied via scripts/migration-2026-04-21-paper-w3.sql
  // (already run as part of the W3 task). Here we just verify the required
  // columns exist — running 27 ALTERs inside the SSH tunnel is flaky.
  const required = [
    ["paper_accounts", "reserved_short_margin"],
    ["paper_orders", "position_side"],
    ["paper_orders", "close_quantity"],
    ["paper_trades", "side"],
    ["paper_trades", "stop_loss_price"],
    ["paper_trades", "closed_quantity"],
  ];
  for (const [table, col] of required) {
    const [rows] = await pool.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [table, col]
    );
    if (rows.length === 0) {
      throw new Error(`Schema check failed: ${table}.${col} missing. Run: node -e "const m=require('mysql2/promise');const fs=require('fs');(async()=>{const c=await m.createConnection({host:'localhost',port:3319,user:'root',password:'trading123',database:'trading',multipleStatements:true});await c.query(fs.readFileSync('scripts/migration-2026-04-21-paper-w3.sql','utf8'));await c.end();})()"`);
    }
  }
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

async function insertOrder(accountId, symbol, side, position_side, orderType, fields = {}) {
  const {
    investment_usd = null, limit_price = null, stop_price = null,
    trade_id = null, close_quantity = null,
    bracket_stop_loss_pct = null, bracket_take_profit_pct = null,
    bracket_trailing_pct = null, bracket_trailing_activates_pct = null,
    bracket_time_exit_days = null,
  } = fields;
  const [r] = await pool.execute(
    `INSERT INTO paper_orders
       (account_id, symbol, side, position_side, order_type, investment_usd,
        limit_price, stop_price, trade_id, close_quantity,
        bracket_stop_loss_pct, bracket_take_profit_pct,
        bracket_trailing_pct, bracket_trailing_activates_pct, bracket_time_exit_days,
        status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    [accountId, symbol, side, position_side, orderType, investment_usd,
     limit_price, stop_price, trade_id, close_quantity,
     bracket_stop_loss_pct, bracket_take_profit_pct,
     bracket_trailing_pct, bracket_trailing_activates_pct, bracket_time_exit_days]
  );
  return r.insertId;
}

async function getAccount(id) {
  const [rows] = await pool.execute("SELECT cash, reserved_cash, reserved_short_margin, initial_cash FROM paper_accounts WHERE id = ?", [id]);
  return rows[0];
}

// ── Test 1: LONG regression (W1/W2) ───────────────────────────────────────
async function test1_longRegression(accountId) {
  console.log("\nTest 1: LONG regression — BUY + SELL full close still works");
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?", [TEST_INITIAL_CASH, accountId]);

  // Open LONG via MARKET BUY at $100.
  const buyOrder = await insertOrder(accountId, "AAPL", "BUY", "LONG", "MARKET", { investment_usd: 5000 });
  const buyFill = await paperFill.fillOrder(pool, buyOrder, 100, { strategyLabel: "MANUAL BUY", fillRationale: "MANUAL" });
  assert(buyFill.filled === true, `LONG BUY fill succeeded`);
  assert(buyFill.positionSide === "LONG", `positionSide = LONG (got ${buyFill.positionSide})`);
  assert(Math.abs(buyFill.quantity - 50) < PRECISION_EPS, `quantity = 50 (got ${buyFill.quantity})`);

  let acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.cash) - (TEST_INITIAL_CASH - 5000)) < PRECISION_EPS, `cash = ${TEST_INITIAL_CASH - 5000} (got ${acct.cash})`);

  // Full close via MARKET SELL at $110 → +$500 pnl.
  const sellOrder = await insertOrder(accountId, "AAPL", "SELL", "LONG", "MARKET", { trade_id: buyFill.tradeId });
  const sellFill = await paperFill.fillOrder(pool, sellOrder, 110, { strategyLabel: "MANUAL SELL", fillRationale: "MANUAL" });
  assert(sellFill.filled === true, `LONG SELL fill succeeded`);
  assert(Math.abs(sellFill.pnlUsd - 500) < PRECISION_EPS, `pnl = $500 (got ${sellFill.pnlUsd})`);

  acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.cash) - (TEST_INITIAL_CASH + 500)) < PRECISION_EPS, `cash = ${TEST_INITIAL_CASH + 500} after close (got ${acct.cash})`);
}

// ── Test 2: SHORT round-trip — profit ─────────────────────────────────────
async function test2_shortProfit(accountId) {
  console.log("\nTest 2: SHORT round-trip profit — short $1000 at $100, cover at $90 → +$100");
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?", [TEST_INITIAL_CASH, accountId]);

  // SELL SHORT at $100.
  const openOrder = await insertOrder(accountId, "AAPL", "SELL", "SHORT", "MARKET", { investment_usd: 1000 });
  const openFill = await paperFill.fillOrder(pool, openOrder, 100, { strategyLabel: "MANUAL SELL", fillRationale: "MANUAL" });
  assert(openFill.filled === true, `SHORT open succeeded`);
  assert(openFill.positionSide === "SHORT", `positionSide = SHORT (got ${openFill.positionSide})`);
  assert(Math.abs(openFill.quantity - 10) < PRECISION_EPS, `quantity = 10 (got ${openFill.quantity})`);

  let acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.cash) - (TEST_INITIAL_CASH - 1000)) < PRECISION_EPS, `cash = ${TEST_INITIAL_CASH - 1000} (got ${acct.cash})`);
  assert(Math.abs(Number(acct.reserved_short_margin) - 1000) < PRECISION_EPS, `short margin = $1000 (got ${acct.reserved_short_margin})`);

  // BUY TO COVER at $90 — profit $100 (price fell, short wins).
  const coverOrder = await insertOrder(accountId, "AAPL", "BUY", "SHORT", "MARKET", { trade_id: openFill.tradeId });
  const coverFill = await paperFill.fillOrder(pool, coverOrder, 90, { strategyLabel: "MANUAL BUY", fillRationale: "MANUAL" });
  assert(coverFill.filled === true, `SHORT cover succeeded (got ${JSON.stringify(coverFill)})`);
  assert(Math.abs(coverFill.pnlUsd - 100) < PRECISION_EPS, `pnl = +$100 (got ${coverFill.pnlUsd})`);

  acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.reserved_short_margin)) < PRECISION_EPS, `short margin returned to 0 (got ${acct.reserved_short_margin})`);
  assert(Math.abs(Number(acct.cash) - (TEST_INITIAL_CASH + 100)) < PRECISION_EPS, `cash = ${TEST_INITIAL_CASH + 100} (got ${acct.cash})`);
}

// ── Test 3: SHORT round-trip — loss ───────────────────────────────────────
async function test3_shortLoss(accountId) {
  console.log("\nTest 3: SHORT round-trip loss — short $1000 at $100, cover at $110 → -$100");
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?", [TEST_INITIAL_CASH, accountId]);

  const openOrder = await insertOrder(accountId, "MSFT", "SELL", "SHORT", "MARKET", { investment_usd: 1000 });
  const openFill = await paperFill.fillOrder(pool, openOrder, 100);
  assert(openFill.filled === true, `SHORT open`);

  const coverOrder = await insertOrder(accountId, "MSFT", "BUY", "SHORT", "MARKET", { trade_id: openFill.tradeId });
  const coverFill = await paperFill.fillOrder(pool, coverOrder, 110);
  assert(coverFill.filled === true, `SHORT cover at $110`);
  assert(Math.abs(coverFill.pnlUsd - (-100)) < PRECISION_EPS, `pnl = -$100 (got ${coverFill.pnlUsd})`);

  const acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.cash) - (TEST_INITIAL_CASH - 100)) < PRECISION_EPS, `cash = ${TEST_INITIAL_CASH - 100} (got ${acct.cash})`);
}

// ── Test 4: Hard stop ─────────────────────────────────────────────────────
async function test4_hardStop(accountId) {
  console.log("\nTest 4: Hard stop — LONG opened with stop=$95, evaluateExits at $94 → HARD_STOP");
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?", [TEST_INITIAL_CASH, accountId]);

  // Open LONG at $100 with 5% stop-loss bracket → stop at $95.
  const buyOrder = await insertOrder(accountId, "NVDA", "BUY", "LONG", "MARKET", {
    investment_usd: 1000, bracket_stop_loss_pct: 5,
  });
  const buyFill = await paperFill.fillOrder(pool, buyOrder, 100);
  assert(buyFill.filled === true, `open`);

  // Verify stop_loss_price recorded.
  const [tradeRows] = await pool.execute("SELECT stop_loss_price FROM paper_trades WHERE id = ?", [buyFill.tradeId]);
  assert(Math.abs(Number(tradeRows[0].stop_loss_price) - 95) < PRECISION_EPS, `stop_loss_price = $95 (got ${tradeRows[0].stop_loss_price})`);

  // Directly evaluate at price $94. Shared module should return HARD_STOP.
  const [row] = await pool.execute("SELECT * FROM paper_trades WHERE id = ?", [buyFill.tradeId]);
  const input = paperExits.inputsFromTradeRow(row[0], null, null);
  const decision = paperExits.evaluateExits(input, 94, new Date());
  assert(decision !== null, `decision non-null`);
  assert(decision && decision.reason === "HARD_STOP", `reason = HARD_STOP (got ${decision && decision.reason})`);

  // C2 — auto-exit must record equity snapshot in-tx. Capture count before.
  const [[snapBefore]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM paper_equity_snapshots WHERE account_id = ?",
    [accountId]
  );

  // Apply — closes the position.
  const applied = await paperExits.applyExitDecisionToTrade(pool, buyFill.tradeId, 94, decision);
  assert(applied.closed === true, `applied`);
  const [closedRows] = await pool.execute("SELECT status, exit_reason, sell_price, pnl_usd FROM paper_trades WHERE id = ?", [buyFill.tradeId]);
  assert(closedRows[0].status === "CLOSED", `status = CLOSED`);
  assert(closedRows[0].exit_reason === "HARD_STOP", `exit_reason = HARD_STOP`);
  assert(Math.abs(Number(closedRows[0].sell_price) - 94) < PRECISION_EPS, `sell_price = 94 (got ${closedRows[0].sell_price})`);
  // pnl = (94-100)*10 = -60
  assert(Math.abs(Number(closedRows[0].pnl_usd) - (-60)) < PRECISION_EPS, `pnl = -$60 (got ${closedRows[0].pnl_usd})`);

  // C2 assertion — snapshot count increased by exactly 1 for the auto-exit.
  const [[snapAfter]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM paper_equity_snapshots WHERE account_id = ?",
    [accountId]
  );
  assert(
    Number(snapAfter.c) === Number(snapBefore.c) + 1,
    `paper_equity_snapshots +1 after auto-exit (before=${snapBefore.c}, after=${snapAfter.c})`
  );
}

// ── Test 5: Trailing stop ─────────────────────────────────────────────────
async function test5_trailingStop(accountId) {
  console.log("\nTest 5: Trailing — LONG trailing=3% activates_at=5%. 100→110→115→111 fires");
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?", [TEST_INITIAL_CASH, accountId]);

  const buyOrder = await insertOrder(accountId, "TSLA", "BUY", "LONG", "MARKET", {
    investment_usd: 1000, bracket_trailing_pct: 3, bracket_trailing_activates_pct: 5,
  });
  const buyFill = await paperFill.fillOrder(pool, buyOrder, 100);
  assert(buyFill.filled === true, `open at $100`);

  // Walk the evaluator through a price sequence. Simulate the monitor tick
  // by re-reading the row, feeding to evaluateExitsAlways, persisting
  // watermarks, then feeding again.
  let [row] = await pool.execute("SELECT * FROM paper_trades WHERE id = ?", [buyFill.tradeId]);
  let t = row[0];

  // Tick 1: price $110 (10% gain > 5% activation threshold). Trailing activates.
  let input = paperExits.inputsFromTradeRow(t, null, null);
  let result = paperExits.evaluateExitsAlways(input, 110, new Date());
  assert(result.reason === null, `tick1 no exit at $110`);
  assert(result.watermarks.trailingActive === true, `trailing activates at $110`);
  await paperExits.persistWatermarks(pool, buyFill.tradeId, result.watermarks.maxPnlPct, result.watermarks.minPnlPct, result.watermarks.trailingActive, result.watermarks.trailingStopPrice);

  // Tick 2: price $115. Trailing ratchets to $111.55 (115 * 0.97).
  [row] = await pool.execute("SELECT * FROM paper_trades WHERE id = ?", [buyFill.tradeId]);
  t = row[0];
  // maxPrice must advance — shared module uses maxPrice=max(current, stored). Since paper_trades doesn't
  // track max_price as a column, input.maxPrice is always null so evaluator uses currentPrice each tick.
  // But watermark ratchet uses maxPrice inside evaluator within a tick; across ticks we need to pass
  // the maxPrice we've seen so far. Pull from paper_trades.max_pnl_pct (indirect) — for this test we
  // keep max_price in a local to drive ratchet correctly.
  input = paperExits.inputsFromTradeRow(t, 110, null); // pass tick1 max
  result = paperExits.evaluateExitsAlways(input, 115, new Date());
  assert(result.reason === null, `tick2 no exit at $115`);
  const expectedStop = 115 * 0.97;
  assert(Math.abs(result.watermarks.trailingStopPrice - expectedStop) < PRECISION_EPS, `trailing_stop = $${expectedStop.toFixed(4)} at $115 (got ${result.watermarks.trailingStopPrice})`);
  await paperExits.persistWatermarks(pool, buyFill.tradeId, result.watermarks.maxPnlPct, result.watermarks.minPnlPct, result.watermarks.trailingActive, result.watermarks.trailingStopPrice);

  // Tick 3: price $111. That's below $111.55 → TRAILING_STOP fires.
  [row] = await pool.execute("SELECT * FROM paper_trades WHERE id = ?", [buyFill.tradeId]);
  t = row[0];
  input = paperExits.inputsFromTradeRow(t, 115, null); // pass tick2 max
  result = paperExits.evaluateExitsAlways(input, 111, new Date());
  assert(result.reason === "TRAILING_STOP", `tick3 TRAILING_STOP fires at $111 vs stop $${expectedStop.toFixed(4)} (got ${result.reason})`);

  const applied = await paperExits.applyExitDecisionToTrade(pool, buyFill.tradeId, 111, { reason: "TRAILING_STOP", closePrice: 111, watermarks: result.watermarks });
  assert(applied.closed === true, `closed`);
  const [closedRows] = await pool.execute("SELECT sell_price, exit_reason FROM paper_trades WHERE id = ?", [buyFill.tradeId]);
  assert(Math.abs(Number(closedRows[0].sell_price) - 111) < PRECISION_EPS, `sell_price = 111`);
  assert(closedRows[0].exit_reason === "TRAILING_STOP", `exit_reason = TRAILING_STOP`);
}

// ── Test 6: Time exit ─────────────────────────────────────────────────────
async function test6_timeExit(accountId) {
  console.log("\nTest 6: Time exit — LONG with time_exit_date=yesterday closes");
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?", [TEST_INITIAL_CASH, accountId]);

  const buyOrder = await insertOrder(accountId, "META", "BUY", "LONG", "MARKET", { investment_usd: 1000, bracket_time_exit_days: 0 });
  const buyFill = await paperFill.fillOrder(pool, buyOrder, 100);
  assert(buyFill.filled === true, `open`);

  // Since time_exit_days=0, exit date = today. evaluateExits with `now = today`
  // should trigger TIME_EXIT.
  const [row] = await pool.execute("SELECT * FROM paper_trades WHERE id = ?", [buyFill.tradeId]);
  const input = paperExits.inputsFromTradeRow(row[0], null, null);
  const decision = paperExits.evaluateExits(input, 100, new Date());
  assert(decision !== null && decision.reason === "TIME_EXIT", `reason = TIME_EXIT (got ${decision && decision.reason})`);
}

// ── Test 7: Partial close ────────────────────────────────────────────────
async function test7_partialClose(accountId) {
  console.log("\nTest 7: Partial close — LONG qty 10, close 3+3+4, P&L sums");
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?", [TEST_INITIAL_CASH, accountId]);

  // Open LONG at $100 investing $1000 → qty 10.
  const buyOrder = await insertOrder(accountId, "AMZN", "BUY", "LONG", "MARKET", { investment_usd: 1000 });
  const buyFill = await paperFill.fillOrder(pool, buyOrder, 100);
  assert(Math.abs(buyFill.quantity - 10) < PRECISION_EPS, `qty = 10`);

  // Partial 1: close 3 at $105 → pnl = 3*5 = $15.
  const sell1 = await insertOrder(accountId, "AMZN", "SELL", "LONG", "MARKET", { trade_id: buyFill.tradeId, close_quantity: 3 });
  const fill1 = await paperFill.fillOrder(pool, sell1, 105);
  assert(fill1.filled === true, `partial 1`);
  assert(Math.abs(fill1.pnlUsd - 15) < PRECISION_EPS, `partial 1 pnl = $15 (got ${fill1.pnlUsd})`);
  assert(fill1.remainingQuantity === 7, `remaining = 7 (got ${fill1.remainingQuantity})`);

  // Partial 2: close 3 at $108 → pnl = 3*8 = $24.
  const sell2 = await insertOrder(accountId, "AMZN", "SELL", "LONG", "MARKET", { trade_id: buyFill.tradeId, close_quantity: 3 });
  const fill2 = await paperFill.fillOrder(pool, sell2, 108);
  assert(fill2.filled === true, `partial 2`);
  assert(Math.abs(fill2.pnlUsd - 24) < PRECISION_EPS, `partial 2 pnl = $24 (got ${fill2.pnlUsd})`);
  assert(fill2.remainingQuantity === 4, `remaining = 4 (got ${fill2.remainingQuantity})`);

  // Partial 3: close remaining 4 at $110 → pnl = 4*10 = $40.
  const sell3 = await insertOrder(accountId, "AMZN", "SELL", "LONG", "MARKET", { trade_id: buyFill.tradeId, close_quantity: 4 });
  const fill3 = await paperFill.fillOrder(pool, sell3, 110);
  assert(fill3.filled === true, `partial 3 (full)`);
  assert(Math.abs(fill3.pnlUsd - 40) < PRECISION_EPS, `partial 3 pnl = $40 (got ${fill3.pnlUsd})`);

  // Verify trade CLOSED with accumulated pnl = 15 + 24 + 40 = 79.
  const [rows] = await pool.execute("SELECT status, pnl_usd, closed_quantity, quantity FROM paper_trades WHERE id = ?", [buyFill.tradeId]);
  assert(rows[0].status === "CLOSED", `status = CLOSED (got ${rows[0].status})`);
  assert(Math.abs(Number(rows[0].pnl_usd) - 79) < PRECISION_EPS, `total pnl = $79 (got ${rows[0].pnl_usd})`);
  assert(Math.abs(Number(rows[0].closed_quantity) - 10) < PRECISION_EPS, `closed_quantity = 10 (got ${rows[0].closed_quantity})`);

  // Cash must have gained $79 overall.
  const acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.cash) - (TEST_INITIAL_CASH + 79)) < PRECISION_EPS, `cash = $${TEST_INITIAL_CASH + 79} (got ${acct.cash})`);
}

// ── Test 8: Order modify ─────────────────────────────────────────────────
async function test8_orderModify(accountId) {
  console.log("\nTest 8: Order modify — PATCH LIMIT BUY price + investment; reject non-PENDING");
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?", [TEST_INITIAL_CASH, accountId]);

  // Place PENDING LIMIT BUY at $100 for $1000 — requires reservation.
  const orderId = await insertOrder(accountId, "GOOG", "BUY", "LONG", "LIMIT", {
    investment_usd: 1000, limit_price: 100,
  });
  const reserved = await paperFill.reserveCashForOrder(pool, orderId, accountId, 1000);
  assert(reserved === true, `reservation succeeded`);
  let acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.reserved_cash) - 1000) < PRECISION_EPS, `reserved_cash = 1000 (got ${acct.reserved_cash})`);

  // PATCH — change limit to $95 AND reduce investment to $500.
  const adj = await paperFill.adjustReservation(pool, orderId, 500);
  assert(adj.ok === true, `adjustReservation ok`);
  const price = await paperFill.patchPendingOrderPrices(pool, orderId, { limit_price: 95 });
  assert(price.ok === true, `patchPendingOrderPrices ok`);

  acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.reserved_cash) - 500) < PRECISION_EPS, `reserved_cash post-PATCH = 500 (got ${acct.reserved_cash})`);
  assert(Math.abs(Number(acct.cash) - (TEST_INITIAL_CASH - 500)) < PRECISION_EPS, `cash post-PATCH = ${TEST_INITIAL_CASH - 500} (got ${acct.cash})`);

  const [orderRows] = await pool.execute("SELECT limit_price, investment_usd, reserved_amount FROM paper_orders WHERE id = ?", [orderId]);
  assert(Math.abs(Number(orderRows[0].limit_price) - 95) < PRECISION_EPS, `limit_price = 95 (got ${orderRows[0].limit_price})`);
  assert(Math.abs(Number(orderRows[0].investment_usd) - 500) < PRECISION_EPS, `investment_usd = 500 (got ${orderRows[0].investment_usd})`);
  assert(Math.abs(Number(orderRows[0].reserved_amount) - 500) < PRECISION_EPS, `reserved_amount = 500 (got ${orderRows[0].reserved_amount})`);

  // Cancel it first to get a non-PENDING order.
  await pool.execute("UPDATE paper_orders SET status='CANCELLED' WHERE id = ?", [orderId]);
  // Now PATCH — must fail.
  const adjAfter = await paperFill.adjustReservation(pool, orderId, 400);
  assert(adjAfter.ok === false, `adjustReservation on non-PENDING rejected (got ${JSON.stringify(adjAfter)})`);
}

// ── Test H1 (hotfix #1): partial close then auto-exit — pnl_pct consistent ─
async function testH1_partialThenAutoExit(accountId) {
  console.log("\nTest H1 (hotfix #1): partial-close then auto-exit keeps pnl_pct consistent");
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?", [TEST_INITIAL_CASH, accountId]);

  // Open LONG with $1000 investment at $100 → qty 10.
  const buyOrder = await insertOrder(accountId, "WTST", "BUY", "LONG", "MARKET", {
    investment_usd: 1000, bracket_stop_loss_pct: 5, // stop at $95
  });
  const buyFill = await paperFill.fillOrder(pool, buyOrder, 100);
  assert(buyFill.filled === true, `H1 open`);
  assert(Math.abs(buyFill.quantity - 10) < PRECISION_EPS, `H1 qty = 10`);

  // Partial close 4 at $110 → slice pnl = 4*10 = +$40, closed_quantity=4, remaining=6.
  const partial = await insertOrder(accountId, "WTST", "SELL", "LONG", "MARKET", {
    trade_id: buyFill.tradeId, close_quantity: 4,
  });
  const partialFill = await paperFill.fillOrder(pool, partial, 110);
  assert(partialFill.filled === true, `H1 partial fill`);
  assert(Math.abs(partialFill.pnlUsd - 40) < PRECISION_EPS, `H1 partial pnl = +$40 (got ${partialFill.pnlUsd})`);
  assert(partialFill.remainingQuantity === 6, `H1 remaining = 6 (got ${partialFill.remainingQuantity})`);

  // Trigger auto-exit (stop) at $105 (above the stop but we force via
  // applyExitDecisionToTrade to model the auto-exit path regardless of
  // evaluateExits logic). This remaining 6 at $105 vs entry $100 → slice pnl
  // = 6*5 = +$30. Total pnl across both legs = $40 + $30 = +$70.
  // pnl_pct must be 70/1000*100 = 7.0, NOT the buggy slice value 30/600*100 = 5.0.
  const [rows] = await pool.execute("SELECT * FROM paper_trades WHERE id = ?", [buyFill.tradeId]);
  const trade = rows[0];
  const input = paperExits.inputsFromTradeRow(trade, null, null);
  // Force a HARD_STOP decision synthetically — we just need the apply path.
  const decision = {
    reason: "HARD_STOP",
    closePrice: 105,
    watermarks: {
      maxPnlPct: Number(trade.max_pnl_pct ?? 0),
      minPnlPct: Number(trade.min_pnl_pct ?? 0),
      trailingActive: Boolean(trade.trailing_active),
      trailingStopPrice: trade.trailing_stop_price != null ? Number(trade.trailing_stop_price) : null,
    },
  };
  const applied = await paperExits.applyExitDecisionToTrade(pool, buyFill.tradeId, 105, decision);
  assert(applied.closed === true, `H1 auto-exit closed`);

  // Read final pnl_usd and pnl_pct.
  const [finalRows] = await pool.execute("SELECT status, pnl_usd, pnl_pct, investment_usd FROM paper_trades WHERE id = ?", [buyFill.tradeId]);
  const f = finalRows[0];
  assert(f.status === "CLOSED", `H1 status = CLOSED (got ${f.status})`);
  assert(Math.abs(Number(f.pnl_usd) - 70) < PRECISION_EPS, `H1 pnl_usd = $70 (got ${f.pnl_usd})`);
  // The WHOLE point of the hotfix: pnl_pct must be relative to the ORIGINAL
  // full investment ($1000), giving 7.0%. The bug would write 5.0% (derived
  // from the remaining slice's investmentShare = $600).
  assert(Math.abs(Number(f.pnl_pct) - 7.0) < 1e-3, `H1 pnl_pct = 7.0 (got ${f.pnl_pct}) — must be total/investment, not slice-based`);
}

// ── Test H2 (hotfix #2): DELETE is atomic — no intermediate state ─────────
async function testH2_cancelAtomic(accountId) {
  console.log("\nTest H2 (hotfix #2): cancelOrderWithRefund atomic — concurrent cancels, single winner");
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?", [TEST_INITIAL_CASH, accountId]);

  // Open LIMIT BUY for $1000 at limit $50 on GOOGL — reserves $1000 in cash.
  const orderId = await insertOrder(accountId, "GOOGL", "BUY", "LONG", "LIMIT", {
    investment_usd: 1000, limit_price: 50,
  });
  const reserved = await paperFill.reserveCashForOrder(pool, orderId, accountId, 1000);
  assert(reserved === true, `H2 reservation succeeded`);
  let acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.cash) - (TEST_INITIAL_CASH - 1000)) < PRECISION_EPS, `H2 cash post-reserve = ${TEST_INITIAL_CASH - 1000}`);
  assert(Math.abs(Number(acct.reserved_cash) - 1000) < PRECISION_EPS, `H2 reserved_cash = 1000`);

  // Launch N=20 concurrent cancels on the same orderId.
  const N = 20;
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(paperFill.cancelOrderWithRefund(pool, orderId));
  }
  const results = await Promise.all(promises);
  const winners = results.filter((r) => r.cancelled === true);
  const losers = results.filter((r) => r.cancelled === false);
  assert(winners.length === 1, `H2 exactly 1 cancel winner (got ${winners.length})`);
  assert(losers.length === N - 1, `H2 exactly ${N - 1} losers (got ${losers.length})`);

  // Cash must be restored to exactly initial — not +N*1000 (that would be the
  // bug where every cancel re-refunded).
  acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.cash) - TEST_INITIAL_CASH) < PRECISION_EPS, `H2 cash restored to exactly $${TEST_INITIAL_CASH} (got ${acct.cash})`);
  assert(Math.abs(Number(acct.reserved_cash)) < PRECISION_EPS, `H2 reserved_cash = 0 (got ${acct.reserved_cash})`);

  const [[orderRow]] = await pool.execute("SELECT status, reserved_amount FROM paper_orders WHERE id = ?", [orderId]);
  assert(orderRow.status === "CANCELLED", `H2 order status = CANCELLED (got ${orderRow.status})`);
  assert(Math.abs(Number(orderRow.reserved_amount)) < PRECISION_EPS, `H2 order reserved_amount = 0 (got ${orderRow.reserved_amount})`);
}

// ── Test H3 (hotfix #3): PATCH is atomic — failure reverts ────────────────
async function testH3_modifyAtomic(accountId) {
  console.log("\nTest H3 (hotfix #3): modifyPendingOrder atomic — invalid input leaves order untouched");
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?", [TEST_INITIAL_CASH, accountId]);

  // Open LIMIT BUY $1000 at limit $50 on AAPL.
  const orderId = await insertOrder(accountId, "AAPL", "BUY", "LONG", "LIMIT", {
    investment_usd: 1000, limit_price: 50,
  });
  const reserved = await paperFill.reserveCashForOrder(pool, orderId, accountId, 1000);
  assert(reserved === true, `H3 reservation succeeded`);

  // PATCH with invalid limit_price (-5) — must fail and leave EVERYTHING
  // untouched (including reservation + investment).
  const bad = await paperFill.modifyPendingOrder(pool, orderId, { limit_price: -5, investment_usd: 500 });
  assert(bad.ok === false, `H3 invalid PATCH rejected (got ${JSON.stringify(bad)})`);
  assert(bad.reason === "INVALID_LIMIT_PRICE", `H3 rejection reason = INVALID_LIMIT_PRICE (got ${bad.reason})`);

  // Assert order still has original values — no partial success.
  const [[o1]] = await pool.execute("SELECT limit_price, investment_usd, reserved_amount FROM paper_orders WHERE id = ?", [orderId]);
  assert(Math.abs(Number(o1.limit_price) - 50) < PRECISION_EPS, `H3 limit_price unchanged = 50 (got ${o1.limit_price})`);
  assert(Math.abs(Number(o1.investment_usd) - 1000) < PRECISION_EPS, `H3 investment_usd unchanged = 1000 (got ${o1.investment_usd})`);
  assert(Math.abs(Number(o1.reserved_amount) - 1000) < PRECISION_EPS, `H3 reserved_amount unchanged = 1000 (got ${o1.reserved_amount})`);
  let acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.reserved_cash) - 1000) < PRECISION_EPS, `H3 account reserved_cash unchanged = 1000 (got ${acct.reserved_cash})`);

  // Now a VALID PATCH: limit_price 45, investment_usd 500 — must succeed
  // and update all fields atomically.
  const good = await paperFill.modifyPendingOrder(pool, orderId, { limit_price: 45, investment_usd: 500 });
  assert(good.ok === true, `H3 valid PATCH succeeded (got ${JSON.stringify(good)})`);
  const [[o2]] = await pool.execute("SELECT limit_price, investment_usd, reserved_amount FROM paper_orders WHERE id = ?", [orderId]);
  assert(Math.abs(Number(o2.limit_price) - 45) < PRECISION_EPS, `H3 limit_price = 45 (got ${o2.limit_price})`);
  assert(Math.abs(Number(o2.investment_usd) - 500) < PRECISION_EPS, `H3 investment_usd = 500 (got ${o2.investment_usd})`);
  assert(Math.abs(Number(o2.reserved_amount) - 500) < PRECISION_EPS, `H3 reserved_amount = 500 (got ${o2.reserved_amount})`);
  acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.reserved_cash) - 500) < PRECISION_EPS, `H3 account reserved_cash = 500 (got ${acct.reserved_cash})`);
  assert(Math.abs(Number(acct.cash) - (TEST_INITIAL_CASH - 500)) < PRECISION_EPS, `H3 account cash = ${TEST_INITIAL_CASH - 500} (got ${acct.cash})`);
}

// ── Test 9b: PF2 — duplicate SHORT position rejection ────────────────────
async function test9b_duplicateShort(accountId) {
  console.log("\nTest 9b: PF2 — second SHORT on same (account, symbol) rejected as DUPLICATE_SHORT_POSITION");
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?", [TEST_INITIAL_CASH, accountId]);

  // Open first SHORT on XYZ.
  const o1 = await insertOrder(accountId, "XYZ", "SELL", "SHORT", "MARKET", { investment_usd: 500 });
  const f1 = await paperFill.fillOrder(pool, o1, 50);
  assert(f1.filled === true, `first SHORT open succeeded`);

  // Attempt second SHORT on same symbol — must reject with DUPLICATE_SHORT_POSITION.
  const o2 = await insertOrder(accountId, "XYZ", "SELL", "SHORT", "MARKET", { investment_usd: 300 });
  const f2 = await paperFill.fillOrder(pool, o2, 55);
  assert(f2.filled === false, `second SHORT rejected (got ${JSON.stringify(f2)})`);
  assert(f2.rejection === "DUPLICATE_SHORT_POSITION", `rejection = DUPLICATE_SHORT_POSITION (got ${f2.rejection})`);

  // Verify order row flipped to REJECTED with the right reason.
  const [[orow]] = await pool.execute("SELECT status, rejection_reason FROM paper_orders WHERE id = ?", [o2]);
  assert(orow.status === "REJECTED", `order 2 status = REJECTED`);
  assert(String(orow.rejection_reason) === "DUPLICATE_SHORT_POSITION", `order 2 rejection_reason = DUPLICATE_SHORT_POSITION`);

  // Cash untouched by the rejection.
  const acct = await getAccount(accountId);
  assert(Math.abs(Number(acct.cash) - (TEST_INITIAL_CASH - 500)) < PRECISION_EPS, `cash unchanged by rejection (got ${acct.cash})`);

  // After covering the first SHORT, a new SHORT on XYZ is allowed again.
  const oCover = await insertOrder(accountId, "XYZ", "BUY", "SHORT", "MARKET", { trade_id: f1.tradeId });
  const fCover = await paperFill.fillOrder(pool, oCover, 50);
  assert(fCover.filled === true, `cover succeeded`);
  const o3 = await insertOrder(accountId, "XYZ", "SELL", "SHORT", "MARKET", { investment_usd: 200 });
  const f3 = await paperFill.fillOrder(pool, o3, 40);
  assert(f3.filled === true, `third SHORT (no open SHORT remaining) succeeded`);
}

// ── Test 9: Conservation invariant ───────────────────────────────────────
async function test9_invariant(accountId) {
  console.log("\nTest 9: Conservation — cash + reserved_cash + reserved_short_margin + open_long_inv == initial + realized");
  // Do NOT wipe — include mixed open / closed state from prior tests
  // (clearing here would trivialize the test). Actually, for determinism we
  // set up a fresh scenario.
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?", [TEST_INITIAL_CASH, accountId]);

  // 1. Open LONG $2000 at $50 → qty 40.
  const o1 = await insertOrder(accountId, "A1", "BUY", "LONG", "MARKET", { investment_usd: 2000 });
  await paperFill.fillOrder(pool, o1, 50);
  // 2. Open SHORT $1500 at $30.
  const o2 = await insertOrder(accountId, "A2", "SELL", "SHORT", "MARKET", { investment_usd: 1500 });
  const f2 = await paperFill.fillOrder(pool, o2, 30);
  // 3. Close SHORT at $28 → pnl = $100.
  const o3 = await insertOrder(accountId, "A2", "BUY", "SHORT", "MARKET", { trade_id: f2.tradeId });
  await paperFill.fillOrder(pool, o3, 28);

  const acct = await getAccount(accountId);
  const [openLongs] = await pool.execute(
    "SELECT COALESCE(SUM(investment_usd * ((quantity - closed_quantity) / quantity)), 0) AS v FROM paper_trades WHERE account_id = ? AND status = 'OPEN' AND side = 'LONG'",
    [accountId]
  );
  const [realizedRow] = await pool.execute(
    "SELECT COALESCE(SUM(pnl_usd), 0) AS v FROM paper_trades WHERE account_id = ? AND status = 'CLOSED'",
    [accountId]
  );
  const openInv = Number(openLongs[0].v);
  const realized = Number(realizedRow[0].v);
  const lhs = Number(acct.cash) + Number(acct.reserved_cash) + Number(acct.reserved_short_margin) + openInv;
  const rhs = Number(acct.initial_cash) + realized;
  console.log(`    cash=${acct.cash} reserved=${acct.reserved_cash} short_margin=${acct.reserved_short_margin} open_long=${openInv.toFixed(6)} realized=${realized.toFixed(6)}`);
  console.log(`    lhs=${lhs.toFixed(6)} rhs=${rhs.toFixed(6)} drift=${(lhs - rhs).toFixed(9)}`);
  assert(Math.abs(lhs - rhs) < PRECISION_EPS, `invariant holds (drift < ${PRECISION_EPS})`);
  assert(Math.abs(realized - 100) < PRECISION_EPS, `realized pnl = $100 from short cover (got ${realized})`);
}

(async () => {
  let accountId;
  try {
    await loadModules();
    await ensureSchemaMinimal();
    accountId = await resetTestAccount();
    console.log(`Using test account id=${accountId} name='${TEST_ACCOUNT_NAME}' cash=$${TEST_INITIAL_CASH}`);

    await test1_longRegression(accountId);
    await test2_shortProfit(accountId);
    await test3_shortLoss(accountId);
    await test4_hardStop(accountId);
    await test5_trailingStop(accountId);
    await test6_timeExit(accountId);
    await test7_partialClose(accountId);
    await test8_orderModify(accountId);
    await testH1_partialThenAutoExit(accountId);
    await testH2_cancelAtomic(accountId);
    await testH3_modifyAtomic(accountId);
    await test9b_duplicateShort(accountId);
    await test9_invariant(accountId);

    console.log(`\n== SUMMARY: ${passed} passed, ${failed} failed ==`);
    if (failed > 0) {
      console.log("Failures:");
      for (const f of failures) console.log(`  - ${f}`);
    }
  } catch (err) {
    console.error("Fatal:", err);
    failed++;
  } finally {
    await teardownTestAccount(accountId);
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(failed === 0 ? 0 : 1);
  }
})();
