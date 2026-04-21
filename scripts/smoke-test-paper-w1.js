#!/usr/bin/env node
/**
 * Smoke test — Paper Trading W1 money correctness.
 *
 * Uses a dedicated test account so it NEVER touches the 'Default' account
 * or any strategy account. Creates (or reuses) a `paper_accounts` row named
 * `W1_SMOKE_TEST_DO_NOT_USE`, wipes its trades/orders, and exercises:
 *
 *   1. Concurrent MARKET BUYs against limited cash — only the right number fill.
 *   2. Concurrent SELLs against the same trade_id — only one fills.
 *   3. Invalid fillPrice (0 / NaN / -1) — rejected cleanly.
 *   4. LIMIT BUY reservation path — reserve, release, verify cash restored.
 *   5. Invariant: cash + reserved_cash + positions_value ≈ equity at end,
 *      with equity expressed as initial_cash + SUM(pnl_usd for CLOSED trades)
 *      — a real conservation check, not a tautology.
 *
 * Exit 0 = all pass. Exit 1 = any assertion fails.
 *
 * Runs against the local tunnel DB (port 3319). Make sure the tunnel is up:
 *   ssh -f -N -L 3319:127.0.0.1:3320 root@89.167.42.128
 *
 * The test does NOT call the Next.js API — it invokes the fill engine
 * directly against the DB so it can stress-concurrency without spinning
 * up a web server.
 */

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

// Load .env.local into process.env without pulling in dotenv.
try {
  const envFile = fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* .env.local missing is OK if env is set externally */ }

// Dynamically import the TS module via tsx. If invoked via `node` we
// fall back to a runtime `require` that tsx/ts-node typically provides.
let paperFill;
async function loadPaperFill() {
  try {
    paperFill = require("../src/lib/paper-fill");
  } catch (err) {
    console.error("Failed to load src/lib/paper-fill.ts — run via `npx tsx` or after `npm run build`.");
    throw err;
  }
}

const TEST_ACCOUNT_NAME = "W1_SMOKE_TEST_DO_NOT_USE";
const TEST_INITIAL_CASH = 100000;

// DECIMAL(18,6) precision — anything under 1e-6 is sub-scale.
const PRECISION_EPS = 1e-6;

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

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS ${msg}`); }
  else      { failed++; console.log(`  FAIL ${msg}`); }
}

async function ensureSchemaMinimal() {
  // Make sure the W1 columns exist even if `ensureSchema` was never called
  // via the API in this environment (e.g. brand-new dev DB).
  try {
    await pool.execute("ALTER TABLE paper_accounts ADD COLUMN reserved_cash DECIMAL(18,6) NOT NULL DEFAULT 0");
  } catch (e) { if (e.errno !== 1060) throw e; }
  try {
    await pool.execute("ALTER TABLE paper_orders ADD COLUMN reserved_amount DECIMAL(18,6) NOT NULL DEFAULT 0");
  } catch (e) { if (e.errno !== 1060) throw e; }
}

async function resetTestAccount() {
  // Reset the dedicated smoke-test account. Never touches Default.
  const [rows] = await pool.execute(
    "SELECT id FROM paper_accounts WHERE name = ? LIMIT 1",
    [TEST_ACCOUNT_NAME]
  );
  let accountId;
  if (rows.length === 0) {
    const [result] = await pool.execute(
      "INSERT INTO paper_accounts (name, initial_cash, cash) VALUES (?, ?, ?)",
      [TEST_ACCOUNT_NAME, TEST_INITIAL_CASH, TEST_INITIAL_CASH]
    );
    accountId = result.insertId;
  } else {
    accountId = rows[0].id;
    await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
    await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
    await pool.execute(
      "UPDATE paper_accounts SET cash = ?, reserved_cash = 0, initial_cash = ? WHERE id = ?",
      [TEST_INITIAL_CASH, TEST_INITIAL_CASH, accountId]
    );
  }
  return accountId;
}

async function teardownTestAccount(accountId) {
  // S5 — idempotent teardown so repeat runs don't accumulate state.
  // DELETEs first (FK-dependent), then the account row itself.
  if (!accountId) return;
  try {
    await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
    await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
    await pool.execute("DELETE FROM paper_accounts WHERE id = ? AND name = ?", [accountId, TEST_ACCOUNT_NAME]);
  } catch (err) {
    console.error("teardown warning:", err.message);
  }
}

async function insertOrder(accountId, symbol, side, orderType, investmentUsd) {
  const [result] = await pool.execute(
    `INSERT INTO paper_orders
       (account_id, symbol, side, order_type, investment_usd, status)
     VALUES (?, ?, ?, ?, ?, 'PENDING')`,
    [accountId, symbol, side, orderType, investmentUsd]
  );
  return result.insertId;
}

async function getAccount(accountId) {
  const [rows] = await pool.execute(
    "SELECT cash, reserved_cash FROM paper_accounts WHERE id = ?",
    [accountId]
  );
  return { cash: Number(rows[0].cash), reserved_cash: Number(rows[0].reserved_cash) };
}

async function getTrades(accountId) {
  const [rows] = await pool.execute(
    "SELECT id, symbol, buy_price, sell_price, investment_usd, quantity, pnl_usd, status FROM paper_trades WHERE account_id = ?",
    [accountId]
  );
  return rows;
}

async function test1_concurrentMarketBuys(accountId) {
  console.log("\nTest 1: 20 concurrent MARKET BUYs of $10k on $100k cash — expect exactly 10 fill, 10 reject");
  // 20 orders of $10k each against $100k cash — only 10 should succeed.
  const orderIds = [];
  for (let i = 0; i < 20; i++) {
    const id = await insertOrder(accountId, "AAPL", "BUY", "MARKET", 10000);
    orderIds.push(id);
  }
  const fillPrice = 100; // fake but finite & positive

  // S1 — Barrier pattern. Without it, the pre-first-await block of each
  // async arrow serializes when the map() body has no `await` on entry.
  // With an explicit gate, all N workers reach their first DB call at the
  // same moment, which is what we're actually trying to stress-test.
  let release;
  const gate = new Promise(r => { release = r; });
  const workers = orderIds.map(id => (async () => {
    await gate;
    return paperFill.fillOrder(pool, id, fillPrice);
  })());
  release();
  const results = await Promise.all(workers);

  const filled = results.filter(r => r.filled).length;
  const rejected = results.filter(r => !r.filled).length;
  assert(filled === 10, `exactly 10 orders filled (got ${filled})`);
  assert(rejected === 10, `exactly 10 orders rejected (got ${rejected})`);
  const acct = await getAccount(accountId);
  assert(acct.cash === 0, `cash === 0 after all fills (got ${acct.cash})`);
  assert(acct.reserved_cash === 0, `reserved_cash === 0 (got ${acct.reserved_cash})`);
  assert(acct.cash >= 0, `cash never negative`);
  const trades = await getTrades(accountId);
  assert(trades.length === 10, `exactly 10 trades created (got ${trades.length})`);
  // All trades OPEN.
  assert(trades.every(t => t.status === "OPEN"), `all trades OPEN`);
}

async function test2_concurrentSells(accountId) {
  console.log("\nTest 2: 5 parallel SELL orders against the same trade_id — expect exactly 1 fill");
  // Pick one open trade and hammer it with 5 SELL orders.
  const trades = await getTrades(accountId);
  const target = trades.find(t => t.status === "OPEN");
  if (!target) { failed++; console.log("  FAIL: no open trade to sell against"); return; }
  const orderIds = [];
  for (let i = 0; i < 5; i++) {
    const [result] = await pool.execute(
      `INSERT INTO paper_orders
         (account_id, symbol, side, order_type, trade_id, status)
       VALUES (?, ?, 'SELL', 'MARKET', ?, 'PENDING')`,
      [accountId, target.symbol, target.id]
    );
    orderIds.push(result.insertId);
  }

  // Barrier pattern for the concurrent SELLs as well.
  let release;
  const gate = new Promise(r => { release = r; });
  const workers = orderIds.map(id => (async () => {
    await gate;
    return paperFill.fillOrder(pool, id, 105);
  })());
  release();
  const results = await Promise.all(workers);

  const filled = results.filter(r => r.filled).length;
  const rejected = results.filter(r => !r.filled).length;
  assert(filled === 1, `exactly 1 SELL filled (got ${filled})`);
  assert(rejected === 4, `exactly 4 SELLs rejected (got ${rejected})`);
  const [tradeRow] = await pool.execute("SELECT status FROM paper_trades WHERE id = ?", [target.id]);
  assert(tradeRow[0].status === "CLOSED", `target trade now CLOSED (got ${tradeRow[0].status})`);
}

async function test3_invalidFillPrice(accountId) {
  console.log("\nTest 3: invalid fillPrice (0, NaN, negative, Infinity) — expect clean rejection, no trade side effects");
  const before = await getAccount(accountId);
  const tradesBefore = await getTrades(accountId);
  const orderId = await insertOrder(accountId, "TSLA", "BUY", "MARKET", 500);
  for (const bad of [0, NaN, -1, Infinity, -Infinity]) {
    const r = await paperFill.fillOrder(pool, orderId, bad);
    assert(!r.filled && r.rejection === "INVALID_PRICE", `fillOrder(${bad}) => INVALID_PRICE`);
  }
  // INVALID_PRICE is a soft reject that commits the txn without writing any
  // REJECTED state, so the order STAYS PENDING. Clean it up so the invariant
  // at end isn't skewed.
  await pool.execute("UPDATE paper_orders SET status='CANCELLED' WHERE id=?", [orderId]);
  const after = await getAccount(accountId);
  const tradesAfter = await getTrades(accountId);
  assert(after.cash === before.cash, `cash unchanged after bad-price attempts (${before.cash} → ${after.cash})`);
  assert(tradesAfter.length === tradesBefore.length, `no new trades created (${tradesBefore.length} → ${tradesAfter.length})`);
}

async function test4_reservationPath(accountId) {
  console.log("\nTest 4: cash reservation for LIMIT BUY — reserve, release on cancel");
  const before = await getAccount(accountId);
  const [insRes] = await pool.execute(
    `INSERT INTO paper_orders (account_id, symbol, side, order_type, investment_usd, limit_price, status)
     VALUES (?, 'GOOGL', 'BUY', 'LIMIT', ?, ?, 'PENDING')`,
    [accountId, 1000, 50]
  );
  const orderId = insRes.insertId;
  const reserved = await paperFill.reserveCashForOrder(pool, orderId, accountId, 1000);
  const mid = await getAccount(accountId);
  assert(reserved === true || before.cash < 1000, `reservation attempt ran (got ${reserved})`);
  if (reserved) {
    assert(Math.abs(mid.cash - (before.cash - 1000)) < PRECISION_EPS, `cash debited by 1000 (${before.cash} → ${mid.cash})`);
    assert(Math.abs(mid.reserved_cash - (before.reserved_cash + 1000)) < PRECISION_EPS, `reserved_cash credited by 1000`);
    // Now release.
    await paperFill.releaseReservationForOrder(pool, orderId);
    const after = await getAccount(accountId);
    assert(Math.abs(after.cash - before.cash) < PRECISION_EPS, `cash restored after release (${after.cash} vs ${before.cash})`);
    assert(Math.abs(after.reserved_cash - before.reserved_cash) < PRECISION_EPS, `reserved_cash restored after release`);
  }

  // S4 — the LIMIT order is still PENDING (with reserved_amount=0 after
  // release). Cancel it explicitly and assert final order state so the
  // account's order table is clean before the invariant check.
  await pool.execute("UPDATE paper_orders SET status='CANCELLED' WHERE id=? AND status='PENDING'", [orderId]);
  const [finalOrder] = await pool.execute(
    "SELECT status, reserved_amount FROM paper_orders WHERE id=?",
    [orderId]
  );
  assert(finalOrder[0].status === "CANCELLED", `limit order cancelled (got ${finalOrder[0].status})`);
  assert(Number(finalOrder[0].reserved_amount) === 0, `limit order reserved_amount cleared (got ${finalOrder[0].reserved_amount})`);
}

async function test5_invariant(accountId) {
  console.log("\nTest 5: invariant — re-query DB state, compare to independent expected value");
  // S2 — no tautology. Query the account from the DB after every prior
  // operation, compute expected conservation value from a DIFFERENT source
  // (initial_cash + SUM(pnl) for closed trades + SUM(investment) for open
  // positions already parked in positions_value), and compare.
  const [acctRows] = await pool.execute(
    "SELECT cash, reserved_cash, initial_cash FROM paper_accounts WHERE id = ?",
    [accountId]
  );
  const acct = {
    cash: Number(acctRows[0].cash),
    reserved_cash: Number(acctRows[0].reserved_cash),
    initial_cash: Number(acctRows[0].initial_cash),
  };

  const [openTrades] = await pool.execute(
    "SELECT quantity, buy_price, investment_usd FROM paper_trades WHERE account_id = ? AND status = 'OPEN'",
    [accountId]
  );
  // At buy price the investment and (quantity * buy_price) match exactly
  // (minus DECIMAL rounding). Use investment_usd as the authoritative
  // value captured at fill time — avoids FP drift on quantity * buy_price.
  const openInvestment = openTrades.reduce((s, t) => s + Number(t.investment_usd), 0);
  const markedValue = openTrades.reduce((s, t) => s + Number(t.quantity) * Number(t.buy_price), 0);

  const [closedRows] = await pool.execute(
    "SELECT COALESCE(SUM(pnl_usd),0) AS sum_pnl FROM paper_trades WHERE account_id = ? AND status='CLOSED'",
    [accountId]
  );
  const realized = Number(closedRows[0].sum_pnl);

  // Independent expected: every dollar of initial_cash is either
  //   (a) still sitting in cash,
  //   (b) held in reserved_cash pending a PENDING LIMIT/STOP BUY,
  //   (c) invested in an OPEN position (investment_usd), or
  //   (d) realized as +pnl on a CLOSED position and credited back to cash.
  //
  // So: cash + reserved_cash + openInvestment == initial_cash + realized.
  const lhs = acct.cash + acct.reserved_cash + openInvestment;
  const rhs = acct.initial_cash + realized;

  console.log(`    cash=${acct.cash.toFixed(6)}  reserved=${acct.reserved_cash.toFixed(6)}  open_investment=${openInvestment.toFixed(6)}  marked_value=${markedValue.toFixed(6)}`);
  console.log(`    initial=${acct.initial_cash.toFixed(6)}  realized_pnl=${realized.toFixed(6)}`);
  console.log(`    lhs (cash+reserved+open_invest)=${lhs.toFixed(6)}  rhs (initial+realized)=${rhs.toFixed(6)}  drift=${(lhs - rhs).toFixed(9)}`);

  // S3 — DECIMAL(18,6) precision. Tolerance 1e-6.
  assert(Math.abs(lhs - rhs) < PRECISION_EPS, `conservation: cash+reserved+open_invest == initial+realized (drift < ${PRECISION_EPS})`);
  assert(acct.cash >= 0, `cash non-negative (got ${acct.cash})`);
  assert(acct.reserved_cash >= 0, `reserved_cash non-negative (got ${acct.reserved_cash})`);
  // Sanity: positions marked at entry price = investment_usd.
  assert(Math.abs(markedValue - openInvestment) < PRECISION_EPS, `positions marked@entry == investment_usd (drift < ${PRECISION_EPS})`);
}

(async () => {
  let accountId;
  try {
    await loadPaperFill();
    await ensureSchemaMinimal();
    accountId = await resetTestAccount();
    console.log(`Using test account id=${accountId} name='${TEST_ACCOUNT_NAME}' cash=$${TEST_INITIAL_CASH}`);

    await test1_concurrentMarketBuys(accountId);
    await test2_concurrentSells(accountId);
    await test3_invalidFillPrice(accountId);
    await test4_reservationPath(accountId);
    await test5_invariant(accountId);

    console.log(`\n== SUMMARY: ${passed} passed, ${failed} failed ==`);
  } catch (err) {
    console.error("Fatal:", err);
    failed++;
  } finally {
    // S5 — idempotent teardown. Always attempt even if tests crashed so the
    // next run starts from a clean slate.
    await teardownTestAccount(accountId);
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(failed === 0 ? 0 : 1);
  }
})();
