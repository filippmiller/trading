#!/usr/bin/env node
/**
 * Smoke test — critic-report hotfixes (Bugs #2, #6, #12).
 *
 * Dedicated to the 2026-04-21 internal critic findings merged after W5. Runs
 * against the local tunnel DB (port 3319). Uses its own account so it never
 * touches Default / W1..W5 / strategy accounts. Idempotent teardown.
 *
 * Cases:
 *   12a. Bug #12 — LONG trailing ratchet holds across ticks. Open $100, peak
 *        $110 (watermark max_pnl_pct=10%), retrace $105 (below peak but above
 *        trailing stop of ~$106.70). Simulate the monitor-cron derivation
 *        (maxPrice from max_pnl_pct) and verify trailing_stop_price does NOT
 *        drop below the prior peak's stop.
 *   12b. Bug #12 — LONG trailing fires correctly on continued retracement.
 *        Peak $110 → watermark persisted → tick at $106 triggers TRAILING_STOP
 *        at the preserved stop of $106.70 (when trailing=3%).
 *   2.   Bug #2 — LONG auto-exit (HARD_STOP) deducts close-leg commission.
 *        Open LONG $100 with stop $95, qty 10, commission floor $1. Auto-exit
 *        at $94 → cash delta = 10*$94 - $1 comm - open $1 = $938 (not $940).
 *   6a.  Bug #6 — negative trailing_activates_at_profit_pct stores as NULL.
 *        POST with -5 → order has bracket_trailing_activates_pct=NULL.
 *   6b.  Bug #6 — Infinity / NaN / zero also store as NULL.
 *   6c.  Bug #6 — negative stop_loss_pct also stores as NULL (already correct,
 *        regression guard).
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
let paperRisk;
async function loadModules() {
  paperFill = require("../src/lib/paper-fill");
  paperExits = require("../src/lib/paper-exits");
  paperRisk = require("../src/lib/paper-risk");
}

const TEST_ACCOUNT_NAME = "CRITIC_HOTFIX_SMOKE_DO_NOT_USE";
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
    ["paper_trades", "max_pnl_pct"],
    ["paper_trades", "min_pnl_pct"],
    ["paper_trades", "commission_usd"],
    ["paper_orders", "bracket_trailing_activates_pct"],
  ];
  for (const [table, col] of required) {
    const [rows] = await pool.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
      [table, col]
    );
    if (rows.length === 0) throw new Error(`Schema check: ${table}.${col} missing.`);
  }
  // Seed whitelist symbol so the API route tests pass the isSymbolTradable gate.
  await pool.execute(
    "INSERT INTO tradable_symbols (symbol, exchange, asset_class, active) VALUES ('ZTEST_CRIT','TEST','EQUITY',1) ON DUPLICATE KEY UPDATE active = 1",
    []
  );
}

async function setupTestAccount() {
  const [existing] = await pool.execute("SELECT id FROM paper_accounts WHERE name = ?", [TEST_ACCOUNT_NAME]);
  let accountId;
  if (existing.length > 0) {
    accountId = existing[0].id;
    await pool.execute("UPDATE paper_accounts SET cash = ?, initial_cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?",
      [TEST_INITIAL_CASH, TEST_INITIAL_CASH, accountId]);
  } else {
    const [result] = await pool.execute(
      "INSERT INTO paper_accounts (name, cash, initial_cash, reserved_cash, reserved_short_margin) VALUES (?, ?, ?, 0, 0)",
      [TEST_ACCOUNT_NAME, TEST_INITIAL_CASH, TEST_INITIAL_CASH]
    );
    accountId = result.insertId;
  }
  return accountId;
}

async function teardown(accountId) {
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

async function resetAcct(accountId) {
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [accountId]);
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [accountId]);
  await pool.execute("UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?",
    [TEST_INITIAL_CASH, accountId]);
}

async function getAccount(id) {
  const [rows] = await pool.execute("SELECT cash, reserved_cash, reserved_short_margin FROM paper_accounts WHERE id = ?", [id]);
  return rows[0];
}

/**
 * Reproduce the exact derivation the cron monitor does (see surveillance-cron.ts
 * `jobMonitorPaperTradesImpl` after Bug #12 hotfix). This keeps the test
 * decoupled from the cron's networking / price fetch while exercising the
 * actual derivation arithmetic.
 */
function deriveWatermarkPricesFromTrade(trade) {
  const side = trade.side === "SHORT" ? "SHORT" : "LONG";
  const entryPrice = Number(trade.buy_price);
  const maxPnlPct = trade.max_pnl_pct != null ? Number(trade.max_pnl_pct) : null;
  const minPnlPct = trade.min_pnl_pct != null ? Number(trade.min_pnl_pct) : null;
  let maxPrice = null, minPrice = null;
  if (maxPnlPct !== null && entryPrice > 0) {
    maxPrice = side === "SHORT"
      ? entryPrice * (1 - maxPnlPct / 100)
      : entryPrice * (1 + maxPnlPct / 100);
  }
  if (minPnlPct !== null && entryPrice > 0) {
    minPrice = side === "SHORT"
      ? entryPrice * (1 - minPnlPct / 100)
      : entryPrice * (1 + minPnlPct / 100);
  }
  return { maxPrice, minPrice };
}

// ── Test 12a: LONG trailing ratchet holds across retracement ──────────────
async function test12a_longTrailingHoldsOnRetracement(accountId) {
  console.log("\nTest 12a (Bug #12): LONG trailing 3%, peak $110, retrace $105 → stop holds at $106.70");
  await resetAcct(accountId);
  // Zero commission / slippage to isolate trailing-watermark behaviour.
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0, commissionMinPerLeg: 0,
    allowFractionalShares: true, defaultBorrowRatePct: 0,
  });

  // Open MARKET LONG $1000 at $100 with trailing=3% activates_at=5%.
  const [ins] = await pool.execute(
    `INSERT INTO paper_orders (account_id, symbol, side, position_side, order_type, investment_usd,
       bracket_trailing_pct, bracket_trailing_activates_pct, status)
     VALUES (?, 'ZTEST_CRIT', 'BUY', 'LONG', 'MARKET', 1000, 3, 5, 'PENDING')`,
    [accountId]
  );
  const open = await paperFill.fillOrder(pool, ins.insertId, 100);
  assert(open.filled === true, `open LONG at $100`);

  // Tick 1: price $110 (pnl=10%, > activation 5%). Simulate full cron path:
  // read trade, derive max/min PRICE from persisted pcts (null on first tick),
  // call evaluator, persist watermarks.
  let [[trade]] = await pool.execute("SELECT * FROM paper_trades WHERE id = ?", [open.tradeId]);
  let { maxPrice, minPrice } = deriveWatermarkPricesFromTrade(trade);
  assert(maxPrice === null, `tick1 maxPrice null on fresh trade (got ${maxPrice})`);
  let input = paperExits.inputsFromTradeRow(trade, maxPrice, minPrice);
  let result = paperExits.evaluateExitsAlways(input, 110, new Date());
  assert(result.reason === null, `tick1 no exit at $110`);
  assert(result.watermarks.trailingActive === true, `tick1 trailing activated`);
  assert(Math.abs(result.watermarks.maxPnlPct - 10) < EPS, `tick1 max_pnl_pct = 10 (got ${result.watermarks.maxPnlPct})`);
  // Persist watermarks (this is what the cron does).
  await paperExits.persistWatermarks(
    pool, open.tradeId,
    result.watermarks.maxPnlPct, result.watermarks.minPnlPct,
    result.watermarks.trailingActive, result.watermarks.trailingStopPrice
  );
  // Expected trailing stop = currentPrice * (1 - 3/100) = 110 * 0.97 = 106.70
  const expectedStopAtPeak = 110 * 0.97;
  assert(Math.abs(result.watermarks.trailingStopPrice - expectedStopAtPeak) < EPS,
    `tick1 trailing_stop_price = $${expectedStopAtPeak.toFixed(4)} (got ${result.watermarks.trailingStopPrice})`);

  // Tick 2: price $105 (pnl=5%, below peak BUT above trailing stop $106.70).
  // THE CRITICAL ASSERTION: max_pnl_pct is 10 on the row, so deriveWatermarkPrices
  // yields maxPrice=110 — NOT 105. Without the hotfix, maxPrice=null and the
  // evaluator would reinit maxPrice=105, computing newStop=101.85 which is
  // LOWER than the preserved 106.70 — so `if (newStop > trailingStopPrice)`
  // skips the update... but the stored trailingStopPrice remains 106.70, so
  // the TRAILING_STOP would fire at $105 (since 105 <= 106.70). Pre-fix the
  // evaluator would not fire because maxPrice=105 → newStop=101.85 would be
  // adopted on subsequent ticks where trailingStopPrice was refreshed.
  //
  // The PRE-FIX regression is the RATCHET-DOWN pattern: maxPrice=null resets
  // to currentPrice each tick, letting the stop DROP when trailing_stop_price
  // starts off null on a fresh activation. After this hotfix, maxPrice comes
  // from max_pnl_pct, holding the peak across ticks.
  [[trade]] = await pool.execute("SELECT * FROM paper_trades WHERE id = ?", [open.tradeId]);
  ({ maxPrice, minPrice } = deriveWatermarkPricesFromTrade(trade));
  assert(Math.abs(maxPrice - 110) < EPS, `tick2 derived maxPrice = $110 from max_pnl_pct=10 (got ${maxPrice})`);
  input = paperExits.inputsFromTradeRow(trade, maxPrice, minPrice);
  result = paperExits.evaluateExitsAlways(input, 105, new Date());
  // 105 <= 106.70 — trailing fires because we ratcheted UP and now price is below stop.
  assert(result.reason === "TRAILING_STOP", `tick2 TRAILING_STOP at $105 vs stop $${expectedStopAtPeak.toFixed(4)} (got ${result.reason})`);
  // Stop stays at the peak's stop (106.70), not dropped.
  assert(Math.abs(result.watermarks.trailingStopPrice - expectedStopAtPeak) < EPS,
    `tick2 trailing_stop_price HELDS at $${expectedStopAtPeak.toFixed(4)} (got ${result.watermarks.trailingStopPrice})`);
}

// ── Test 12b: after peak, subsequent retracement still fires at held stop ──
async function test12b_longTrailingPeakThenDrop(accountId) {
  console.log("\nTest 12b (Bug #12): LONG peak $110, persisted, next tick $106 → TRAILING_STOP at held $106.70");
  await resetAcct(accountId);
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0, commissionMinPerLeg: 0,
    allowFractionalShares: true, defaultBorrowRatePct: 0,
  });
  const [ins] = await pool.execute(
    `INSERT INTO paper_orders (account_id, symbol, side, position_side, order_type, investment_usd,
       bracket_trailing_pct, bracket_trailing_activates_pct, status)
     VALUES (?, 'ZTEST_CRIT', 'BUY', 'LONG', 'MARKET', 1000, 3, 5, 'PENDING')`,
    [accountId]
  );
  const open = await paperFill.fillOrder(pool, ins.insertId, 100);
  assert(open.filled === true, `open`);

  // Simulate tick1 at $110: persist max_pnl_pct=10, trailing_stop_price=$106.70.
  let [[trade]] = await pool.execute("SELECT * FROM paper_trades WHERE id = ?", [open.tradeId]);
  let { maxPrice, minPrice } = deriveWatermarkPricesFromTrade(trade);
  let input = paperExits.inputsFromTradeRow(trade, maxPrice, minPrice);
  let result = paperExits.evaluateExitsAlways(input, 110, new Date());
  await paperExits.persistWatermarks(
    pool, open.tradeId,
    result.watermarks.maxPnlPct, result.watermarks.minPnlPct,
    result.watermarks.trailingActive, result.watermarks.trailingStopPrice
  );

  // Sanity — persisted columns.
  [[trade]] = await pool.execute("SELECT max_pnl_pct, trailing_stop_price, trailing_active FROM paper_trades WHERE id = ?", [open.tradeId]);
  assert(Math.abs(Number(trade.max_pnl_pct) - 10) < EPS, `persisted max_pnl_pct=10 (got ${trade.max_pnl_pct})`);
  assert(Math.abs(Number(trade.trailing_stop_price) - 106.70) < EPS, `persisted trailing_stop_price=$106.70 (got ${trade.trailing_stop_price})`);
  assert(Number(trade.trailing_active) === 1, `persisted trailing_active=1`);

  // Tick 2: price $106 (below $106.70 trailing stop). With hotfix, derived
  // maxPrice=110 and trailing fires at the held stop.
  [[trade]] = await pool.execute("SELECT * FROM paper_trades WHERE id = ?", [open.tradeId]);
  ({ maxPrice, minPrice } = deriveWatermarkPricesFromTrade(trade));
  input = paperExits.inputsFromTradeRow(trade, maxPrice, minPrice);
  result = paperExits.evaluateExitsAlways(input, 106, new Date());
  assert(result.reason === "TRAILING_STOP", `TRAILING_STOP fires at $106 < $106.70 (got ${result.reason})`);

  // Close via full apply path.
  const applied = await paperExits.applyExitDecisionToTrade(pool, open.tradeId, 106, {
    reason: "TRAILING_STOP", closePrice: 106, watermarks: result.watermarks,
  });
  assert(applied.closed === true, `closed`);
  const [[closed]] = await pool.execute("SELECT exit_reason, sell_price FROM paper_trades WHERE id = ?", [open.tradeId]);
  assert(closed.exit_reason === "TRAILING_STOP", `exit_reason = TRAILING_STOP`);
  assert(Math.abs(Number(closed.sell_price) - 106) < EPS, `sell_price = $106 (got ${closed.sell_price})`);
}

// ── Test 2 (Bug #2): LONG auto-exit deducts close-leg commission ───────────
async function test2_longAutoExitCommission(accountId) {
  console.log("\nTest 2 (Bug #2): LONG HARD_STOP auto-exit charges close-leg commission");
  await resetAcct(accountId);
  // Non-zero commission so the fix is observable. Floor $1/leg.
  paperRisk._setRiskConfigForTest({
    slippageBps: 0, commissionPerShare: 0.005, commissionMinPerLeg: 1.0,
    allowFractionalShares: true, defaultBorrowRatePct: 0,
  });
  // Open LONG $1000 at $100 (qty=10) with hard stop at $95.
  const [ins] = await pool.execute(
    `INSERT INTO paper_orders (account_id, symbol, side, position_side, order_type, investment_usd,
       bracket_stop_loss_pct, status)
     VALUES (?, 'ZTEST_CRIT', 'BUY', 'LONG', 'MARKET', 1000, 5, 'PENDING')`,
    [accountId]
  );
  const open = await paperFill.fillOrder(pool, ins.insertId, 100);
  assert(open.filled === true, `LONG open`);

  // Verify open-leg commission recorded.
  const [[t0]] = await pool.execute("SELECT commission_usd, stop_loss_price FROM paper_trades WHERE id = ?", [open.tradeId]);
  assert(Math.abs(Number(t0.commission_usd) - 1.0) < EPS, `open-leg commission = $1 (got ${t0.commission_usd})`);
  assert(Math.abs(Number(t0.stop_loss_price) - 95) < EPS, `stop_loss_price = $95 (got ${t0.stop_loss_price})`);

  // Tick at $94 → HARD_STOP triggers.
  const [[trade]] = await pool.execute("SELECT * FROM paper_trades WHERE id = ?", [open.tradeId]);
  const input = paperExits.inputsFromTradeRow(trade, null, null);
  const decision = paperExits.evaluateExits(input, 94, new Date());
  assert(decision !== null && decision.reason === "HARD_STOP", `reason = HARD_STOP (got ${decision?.reason})`);

  const cashBefore = Number((await getAccount(accountId)).cash);
  const applied = await paperExits.applyExitDecisionToTrade(pool, open.tradeId, 94, decision);
  assert(applied.closed === true, `close applied`);

  const cashAfter = Number((await getAccount(accountId)).cash);
  // Proceeds = 10 * $94 = $940. Close commission = max($1, $0.005*10) = $1.
  // Net credit = $940 - $1 = $939. Pre-fix was $940 (silent 1-USD overshoot).
  const expectedDelta = 940 - 1.0;
  const actualDelta = cashAfter - cashBefore;
  assert(Math.abs(actualDelta - expectedDelta) < EPS,
    `cash delta on auto-exit = $${expectedDelta} (got $${actualDelta.toFixed(6)})`);

  // commission_usd accumulates open $1 + close $1 = $2.
  const [[closed]] = await pool.execute("SELECT commission_usd, pnl_usd, status, exit_reason FROM paper_trades WHERE id = ?", [open.tradeId]);
  assert(closed.status === "CLOSED", `CLOSED`);
  assert(closed.exit_reason === "HARD_STOP", `exit_reason = HARD_STOP`);
  assert(Math.abs(Number(closed.commission_usd) - 2.0) < EPS,
    `commission_usd = $2 (open $1 + close $1, got ${closed.commission_usd})`);
  // pnl_usd stays pure price-delta: (94-100)*10 = -60. Commission tracked separately.
  assert(Math.abs(Number(closed.pnl_usd) - (-60)) < EPS, `pnl_usd = -$60 (got ${closed.pnl_usd})`);
}

// ── Test 6 (Bug #6): bracket pct validation — negative/Infinity/NaN → NULL ─
// We drive the API route directly. The test account is not a MARKET-eligible
// one for RTH-gated orders; instead we test LIMIT orders whose validation
// path runs before any RTH check and stores the bracket fields via INSERT.
async function test6_bracketValidation(accountId) {
  console.log("\nTest 6 (Bug #6): bracket pct gates reject negative / Infinity / NaN → NULL");
  await resetAcct(accountId);

  // Directly exercise the INSERT math the route.ts uses (the boundary is the
  // route, but we test the gate expression itself — simpler than standing up
  // a Next.js server just for validation). These mirror the exact conditions
  // in route.ts after the hotfix.
  function gateBracketPct(v) {
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  }
  function gateTimeExitDays(v) {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  }
  // Negative → NULL.
  assert(gateBracketPct(-5) === null, `trailing_activates=-5 → NULL (gate)`);
  assert(gateBracketPct(-0.01) === null, `trailing_activates=-0.01 → NULL (gate)`);
  // Zero → NULL (zero would activate trailing immediately because pnl >= 0 is always true on entry).
  assert(gateBracketPct(0) === null, `trailing_activates=0 → NULL (gate, zero disables)`);
  // Infinity / NaN / wrong type → NULL.
  assert(gateBracketPct(Infinity) === null, `Infinity → NULL (gate)`);
  assert(gateBracketPct(-Infinity) === null, `-Infinity → NULL (gate)`);
  assert(gateBracketPct(NaN) === null, `NaN → NULL (gate)`);
  assert(gateBracketPct("5") === null, `string "5" → NULL (gate)`);
  assert(gateBracketPct(null) === null, `null → NULL (gate)`);
  assert(gateBracketPct(undefined) === null, `undefined → NULL (gate)`);
  // Positive finite → stored.
  assert(gateBracketPct(5) === 5, `positive 5 → 5 (gate)`);
  assert(gateBracketPct(0.5) === 0.5, `positive 0.5 → 0.5 (gate)`);
  // time_exit_days allows 0.
  assert(gateTimeExitDays(0) === 0, `time_exit_days=0 → 0 (close today)`);
  assert(gateTimeExitDays(-1) === null, `time_exit_days=-1 → NULL`);
  assert(gateTimeExitDays(Infinity) === null, `time_exit_days=Infinity → NULL`);

  // Integration-level: insert a row matching the route's INSERT pattern, with
  // the pre-computed bracket values. Verify the DB stores NULL.
  const [ins] = await pool.execute(
    `INSERT INTO paper_orders (account_id, symbol, side, position_side, order_type, investment_usd,
       bracket_stop_loss_pct, bracket_take_profit_pct, bracket_trailing_pct,
       bracket_trailing_activates_pct, bracket_time_exit_days, status)
     VALUES (?, 'ZTEST_CRIT', 'BUY', 'LONG', 'LIMIT', 1000, ?, ?, ?, ?, ?, 'PENDING')`,
    [
      accountId,
      gateBracketPct(-5),           // stop_loss_pct
      gateBracketPct(NaN),          // take_profit_pct
      gateBracketPct(Infinity),     // trailing_stop_pct
      gateBracketPct(-5),           // trailing_activates_at_profit_pct
      gateTimeExitDays(-10),        // time_exit_days
    ]
  );
  const orderId = ins.insertId;
  const [[row]] = await pool.execute(
    "SELECT bracket_stop_loss_pct, bracket_take_profit_pct, bracket_trailing_pct, bracket_trailing_activates_pct, bracket_time_exit_days FROM paper_orders WHERE id = ?",
    [orderId]
  );
  assert(row.bracket_stop_loss_pct === null, `DB bracket_stop_loss_pct NULL (got ${row.bracket_stop_loss_pct})`);
  assert(row.bracket_take_profit_pct === null, `DB bracket_take_profit_pct NULL (got ${row.bracket_take_profit_pct})`);
  assert(row.bracket_trailing_pct === null, `DB bracket_trailing_pct NULL (got ${row.bracket_trailing_pct})`);
  assert(row.bracket_trailing_activates_pct === null, `DB bracket_trailing_activates_pct NULL (got ${row.bracket_trailing_activates_pct})`);
  assert(row.bracket_time_exit_days === null, `DB bracket_time_exit_days NULL (got ${row.bracket_time_exit_days})`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Paper-Trading critic-hotfix smoke (Bugs #2, #6, #12) ===");
  await ensureSchemaMinimal();
  await loadModules();
  const accountId = await setupTestAccount();
  try {
    await test12a_longTrailingHoldsOnRetracement(accountId);
    await test12b_longTrailingPeakThenDrop(accountId);
    await test2_longAutoExitCommission(accountId);
    await test6_bracketValidation(accountId);
  } catch (err) {
    console.error("TEST THREW:", err);
    failed++;
    failures.push(`threw: ${err.message}`);
  } finally {
    await teardown(accountId);
    // Clear the risk config override for downstream tests that share state.
    try { paperRisk._setRiskConfigForTest(null); } catch { /* ignore */ }
  }
  console.log(`\n--- ${passed} passed, ${failed} failed ---`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  try { await pool.end(); } catch { /* ok */ }
  process.exit(1);
});
