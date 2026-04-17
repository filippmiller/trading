#!/usr/bin/env node
/**
 * P0 smoke test — validates the transaction path + schema against prod DB via tunnel.
 * ROLLBACK is used everywhere; no prod data is modified.
 *
 * Usage:
 *   bash scripts/tunnel-db.sh   (in one terminal)
 *   node scripts/smoke-test-p0.js
 */

const mysql = require("mysql2/promise");

const POOL_CONFIG = {
  host: "127.0.0.1",
  port: 3319,
  user: "root",
  password: "trading123",
  database: "trading",
  waitForConnections: true,
  connectionLimit: 3,
  timezone: "Z",
};

async function assertColumn(pool, table, column) {
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = 'trading' AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length === 0) throw new Error(`MISSING column ${table}.${column}`);
  console.log(`  OK  ${table}.${column} (${rows[0].DATA_TYPE})`);
}

async function testTransaction(pool) {
  // Pick any real strategy account to test against — we will ONLY roll back.
  const [accts] = await pool.execute(
    "SELECT id, cash, initial_cash FROM paper_accounts ORDER BY id LIMIT 1"
  );
  if (accts.length === 0) throw new Error("No paper_accounts found");
  const acct = accts[0];
  const testDelta = 100;

  console.log(`  Testing on account_id=${acct.id} (cash=$${acct.cash})`);

  const conn = await pool.getConnection();
  try {
    // Read cash BEFORE
    const [beforeRows] = await conn.execute(
      "SELECT cash FROM paper_accounts WHERE id = ?", [acct.id]
    );
    const cashBefore = Number(beforeRows[0].cash);

    await conn.beginTransaction();

    // Exercise the P0-2 UPDATE pattern
    const [upd] = await conn.execute(
      "UPDATE paper_accounts SET cash = cash - ? WHERE id = ? AND cash >= ?",
      [testDelta, acct.id, testDelta]
    );
    if (upd.affectedRows !== 1) {
      throw new Error(`Expected affectedRows=1, got ${upd.affectedRows}`);
    }

    // Read cash WITHIN transaction — should reflect the deduction
    const [midRows] = await conn.execute(
      "SELECT cash FROM paper_accounts WHERE id = ?", [acct.id]
    );
    const cashMid = Number(midRows[0].cash);
    if (cashMid !== cashBefore - testDelta) {
      throw new Error(`Txn isolation fail: expected ${cashBefore - testDelta}, got ${cashMid}`);
    }
    console.log(`  OK  txn BEGIN + UPDATE cash - $${testDelta} visible in same conn (${cashBefore} → ${cashMid})`);

    // ROLLBACK — we never modify prod state
    await conn.rollback();

    // Verify cash reverted (re-read using SAME connection to be sure of visibility)
    const [afterRows] = await conn.execute(
      "SELECT cash FROM paper_accounts WHERE id = ?", [acct.id]
    );
    const cashAfter = Number(afterRows[0].cash);
    if (cashAfter !== cashBefore) {
      throw new Error(`ROLLBACK fail: ${cashBefore} → ${cashAfter}`);
    }
    console.log(`  OK  txn ROLLBACK restored cash to $${cashAfter}`);
  } finally {
    conn.release();
  }
}

async function testCashExhaustedPath(pool) {
  // Force the 0-row UPDATE by requiring more cash than any account could have.
  const HUGE = 999999999;
  const conn = await pool.getConnection();
  try {
    const [accts] = await conn.execute(
      "SELECT id FROM paper_accounts ORDER BY id LIMIT 1"
    );
    await conn.beginTransaction();
    const [upd] = await conn.execute(
      "UPDATE paper_accounts SET cash = cash - ? WHERE id = ? AND cash >= ?",
      [HUGE, accts[0].id, HUGE]
    );
    if (upd.affectedRows !== 0) {
      throw new Error(`Cash-exhausted path fail: got affectedRows=${upd.affectedRows}`);
    }
    await conn.rollback();
    console.log(`  OK  cash-exhausted path: affectedRows=0 as expected`);
  } finally {
    conn.release();
  }
}

async function testCohortQuery(pool) {
  // Exercise the P0-3 SQL verbatim
  const today = new Date().toISOString().split("T")[0];
  const [rows] = await pool.execute(
    `SELECT id, symbol, direction, cohort_date, enrollment_source, status
     FROM reversal_entries
     WHERE status = 'ACTIVE'
       AND cohort_date >= DATE_SUB(?, INTERVAL 7 DAY)
       AND cohort_date <= ?
     ORDER BY cohort_date DESC`,
    [today, today]
  );
  console.log(`  OK  P0-3 query returned ${rows.length} ACTIVE entries in last 7 days`);

  const byDate = {};
  const bySource = {};
  for (const r of rows) {
    const d = r.cohort_date instanceof Date ? r.cohort_date.toISOString().split("T")[0] : String(r.cohort_date);
    byDate[d] = (byDate[d] || 0) + 1;
    bySource[r.enrollment_source || "NULL"] = (bySource[r.enrollment_source || "NULL"] || 0) + 1;
  }
  console.log(`       by cohort_date:`, byDate);
  console.log(`       by source:`, bySource);
  if (rows.length > 0 && !("TREND" in bySource)) {
    console.log(`       WARN: no TREND entries yet — scanner may not have run yet`);
  }
}

async function testOldCohortQuery(pool) {
  // What the old buggy P0-3 query would have seen today
  const today = new Date().toISOString().split("T")[0];
  const [rows] = await pool.execute(
    "SELECT COUNT(*) as cnt FROM reversal_entries WHERE cohort_date = ?",
    [today]
  );
  console.log(`  OK  old query "cohort_date = today" matches ${rows[0].cnt} entries`);
}

async function testMonitorSignalsQuery(pool) {
  // P0-1 setup — exercise the exact SELECT the monitor runs
  const [rows] = await pool.execute(
    "SELECT id, symbol, direction, status, exit_at FROM paper_signals WHERE status = 'EXECUTED' AND exit_at IS NULL"
  );
  console.log(`  OK  monitor SELECT returned ${rows.length} open signals`);
  const byDir = {};
  for (const r of rows) byDir[r.direction || "NULL"] = (byDir[r.direction || "NULL"] || 0) + 1;
  console.log(`       by direction:`, byDir);
}

async function testConditionalExitUpdate(pool) {
  // Validate the P0-1 conditional WHERE clause works as intended.
  // Use a non-existent id so the UPDATE naturally affects 0 rows.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [upd] = await conn.execute(
      `UPDATE paper_signals SET exit_price = ?, exit_at = CURRENT_TIMESTAMP(6), exit_reason = 'TEST_SHOULD_NOT_PERSIST'
       WHERE id = ? AND status = 'EXECUTED' AND exit_at IS NULL`,
      [99.99, -1]
    );
    if (upd.affectedRows !== 0) throw new Error(`Expected 0 affected for bogus id, got ${upd.affectedRows}`);
    await conn.rollback();
    console.log(`  OK  P0-1 conditional exit UPDATE: 0 rows on non-existent id`);
  } finally {
    conn.release();
  }
}

async function main() {
  console.log("P0 smoke test against prod MySQL via tunnel (localhost:3319)");
  console.log("All writes use BEGIN/ROLLBACK — no prod data is modified.\n");

  const pool = mysql.createPool(POOL_CONFIG);

  try {
    console.log("Schema:");
    await assertColumn(pool, "paper_signals", "direction");
    await assertColumn(pool, "reversal_entries", "enrollment_source");
    await assertColumn(pool, "paper_accounts", "cash");
    await assertColumn(pool, "paper_signals", "max_pnl_pct");
    await assertColumn(pool, "paper_signals", "min_pnl_pct");
    console.log("");

    console.log("P0-2 transaction path:");
    await testTransaction(pool);
    await testCashExhaustedPath(pool);
    console.log("");

    console.log("P0-3 cohort query:");
    await testOldCohortQuery(pool);
    await testCohortQuery(pool);
    console.log("");

    console.log("P0-1 monitor + conditional UPDATE:");
    await testMonitorSignalsQuery(pool);
    await testConditionalExitUpdate(pool);
    console.log("");

    console.log("ALL SMOKE TESTS PASSED");
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error("FAIL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
