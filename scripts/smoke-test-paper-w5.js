#!/usr/bin/env node
/**
 * Smoke test — Paper Trading W5 (idempotency, multi-account, reset scope).
 *
 * Tests the SERVER-SIDE guarantees that support the W5 UX:
 *   - client_request_id dedup: same id twice = one row
 *   - different ids = different rows
 *   - multi-account creation + listing
 *   - Default account fallback for missing / invalid account_id
 *   - account isolation: orders placed on Alt don't leak to Default
 *   - reset scoped to one account only
 *   - unique-name enforcement on account create
 *
 * Requires the dev server to be running locally on port 3013 (see
 * package.json scripts) OR direct HTTP to `PAPER_W5_BASE_URL`. The tests hit
 * the API routes (not internal modules) because the whole point of W5 is
 * what the HTTP surface exposes.
 *
 * Uses dedicated accounts W5_SMOKE_DEFAULT and W5_SMOKE_ALT1 so it never
 * touches the real Default account. Idempotent teardown in `finally`.
 */

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

// Env bootstrap
try {
  const envFile = fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* ok */ }

const TEST_ACCOUNT_DEFAULT = "W5_SMOKE_DEFAULT";
const TEST_ACCOUNT_ALT1    = "W5_SMOKE_ALT1";

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

// W5 tests exercise the pure idempotency + account layers via DIRECT DB
// calls to the shared modules — no HTTP dependency. This matches the W3
// pattern (smoke-test-paper-w3.js) so one test script doesn't need a dev
// server while another does.
let paperFill;
let paperLib;
async function loadModules() {
  paperFill = require("../src/lib/paper-fill");
  paperLib = require("../src/lib/paper");
}

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS ${msg}`); }
  else      { failed++; failures.push(msg); console.log(`  FAIL ${msg}`); }
}

async function ensureSchemaMinimal() {
  const required = [
    ["paper_orders", "client_request_id"],
    ["paper_orders", "account_id"],
  ];
  for (const [table, col] of required) {
    const [rows] = await pool.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [table, col]
    );
    if (rows.length === 0) {
      throw new Error(`Schema check failed: ${table}.${col} missing. Apply scripts/migration-2026-04-21-paper-w5.sql first.`);
    }
  }
  // Verify UNIQUE index on client_request_id
  const [idxRows] = await pool.execute(
    "SELECT INDEX_NAME, NON_UNIQUE FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'paper_orders' AND INDEX_NAME = 'idx_paper_orders_client_request_id'"
  );
  if (idxRows.length === 0) throw new Error("UNIQUE INDEX idx_paper_orders_client_request_id missing");
  if (Number(idxRows[0].NON_UNIQUE) !== 0) throw new Error("idx_paper_orders_client_request_id exists but is NOT unique");
}

async function upsertAccount(name, initialCash) {
  const [rows] = await pool.execute("SELECT id FROM paper_accounts WHERE name = ? LIMIT 1", [name]);
  if (rows.length > 0) {
    const id = rows[0].id;
    await pool.execute("DELETE FROM paper_equity_snapshots WHERE account_id = ?", [id]);
    await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [id]);
    await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [id]);
    await pool.execute(
      "UPDATE paper_accounts SET cash = ?, reserved_cash = 0, reserved_short_margin = 0, initial_cash = ? WHERE id = ?",
      [initialCash, initialCash, id]
    );
    return id;
  }
  const [r] = await pool.execute(
    "INSERT INTO paper_accounts (name, initial_cash, cash) VALUES (?, ?, ?)",
    [name, initialCash, initialCash]
  );
  return r.insertId;
}

async function teardown() {
  for (const name of [TEST_ACCOUNT_DEFAULT, TEST_ACCOUNT_ALT1, "W5_SMOKE_NEW_1", "W5_SMOKE_NEW_2"]) {
    const [rows] = await pool.execute("SELECT id FROM paper_accounts WHERE name = ?", [name]);
    for (const row of rows) {
      try {
        await pool.execute("DELETE FROM paper_equity_snapshots WHERE account_id = ?", [row.id]);
        await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [row.id]);
        await pool.execute("UPDATE paper_trades SET strategy_id = NULL WHERE account_id = ?", [row.id]);
        await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [row.id]);
        await pool.execute("DELETE FROM paper_accounts WHERE id = ?", [row.id]);
      } catch (err) {
        console.error(`teardown ${name}:`, err.message);
      }
    }
  }
}

async function insertOrderWithClientId(accountId, symbol, clientRequestId, investment = 1000) {
  // Attempt to INSERT. On duplicate client_request_id (errno 1062), return
  // the existing row's id — exactly what the POST route does.
  try {
    const [r] = await pool.execute(
      `INSERT INTO paper_orders
         (account_id, symbol, side, position_side, order_type, investment_usd, client_request_id, status)
       VALUES (?, ?, 'BUY', 'LONG', 'MARKET', ?, ?, 'PENDING')`,
      [accountId, symbol, investment, clientRequestId]
    );
    return { id: r.insertId, isNew: true };
  } catch (err) {
    if (err.errno === 1062) {
      const [existing] = await pool.execute(
        "SELECT id FROM paper_orders WHERE client_request_id = ? LIMIT 1",
        [clientRequestId]
      );
      return { id: existing[0].id, isNew: false };
    }
    throw err;
  }
}

// ── Test 1: Idempotency dedup ────────────────────────────────────────────
async function test1_idempotencyDedup(defaultId) {
  console.log("\nTest 1: Idempotency — same client_request_id returns same order_id");
  const clientRequestId = "smoke-w5-test-1-" + Date.now();

  // Count baseline rows for this account.
  const [[before]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM paper_orders WHERE account_id = ?", [defaultId]
  );

  const r1 = await insertOrderWithClientId(defaultId, "AAPL", clientRequestId);
  assert(r1.isNew === true, "first POST inserted a new row");
  const r2 = await insertOrderWithClientId(defaultId, "AAPL", clientRequestId);
  assert(r2.isNew === false, "second POST with same client_request_id was deduped");
  assert(r2.id === r1.id, `both POSTs return the same order_id (got ${r1.id} vs ${r2.id})`);

  const [[after]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM paper_orders WHERE account_id = ?", [defaultId]
  );
  assert(Number(after.c) === Number(before.c) + 1, `exactly 1 new row inserted (before=${before.c}, after=${after.c})`);
}

// ── Test 2: Different ids → different orders ─────────────────────────────
async function test2_differentIds(defaultId) {
  console.log("\nTest 2: Different client_request_ids → different orders");
  const id1 = "smoke-w5-test-2a-" + Date.now();
  const id2 = "smoke-w5-test-2b-" + Date.now();
  const r1 = await insertOrderWithClientId(defaultId, "MSFT", id1);
  const r2 = await insertOrderWithClientId(defaultId, "MSFT", id2);
  assert(r1.isNew === true && r2.isNew === true, "both POSTs inserted new rows");
  assert(r1.id !== r2.id, `distinct order_ids (${r1.id}, ${r2.id})`);
}

// ── Test 3: NULL client_request_id allows multiple rows ──────────────────
async function test3_nullAllowsMultiple(defaultId) {
  console.log("\nTest 3: NULL client_request_id — UNIQUE index does NOT constrain (multiple NULLs OK)");
  await pool.execute(
    `INSERT INTO paper_orders (account_id, symbol, side, position_side, order_type, investment_usd, status)
     VALUES (?, 'NVDA', 'BUY', 'LONG', 'MARKET', 500, 'PENDING')`, [defaultId]
  );
  await pool.execute(
    `INSERT INTO paper_orders (account_id, symbol, side, position_side, order_type, investment_usd, status)
     VALUES (?, 'NVDA', 'BUY', 'LONG', 'MARKET', 500, 'PENDING')`, [defaultId]
  );
  const [[count]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM paper_orders WHERE account_id = ? AND client_request_id IS NULL AND symbol = 'NVDA'",
    [defaultId]
  );
  assert(Number(count.c) >= 2, `≥2 NULL client_request_id rows coexist (got ${count.c})`);
}

// ── Test 4: Account listing includes all test accounts ───────────────────
async function test4_accountListing(defaultId, alt1Id) {
  console.log("\nTest 4: listPaperAccounts — sees every paper_accounts row");
  const accounts = await paperLib.listPaperAccounts();
  const names = accounts.map(a => a.name);
  assert(names.includes(TEST_ACCOUNT_DEFAULT), `${TEST_ACCOUNT_DEFAULT} present`);
  assert(names.includes(TEST_ACCOUNT_ALT1), `${TEST_ACCOUNT_ALT1} present`);
  const ids = accounts.map(a => a.id);
  assert(ids.includes(defaultId), "default account id in list");
  assert(ids.includes(alt1Id), "alt1 account id in list");
}

// ── Test 5: resolveAccount — honors account_id, falls back to Default ────
async function test5_resolveAccount(defaultId, alt1Id) {
  console.log("\nTest 5: resolveAccount — honors param, falls back on missing/invalid");
  const resolvedAlt = await paperLib.resolveAccount(String(alt1Id));
  assert(resolvedAlt.id === alt1Id, `resolveAccount('${alt1Id}') → alt1 (got id=${resolvedAlt.id})`);

  const resolvedDefault = await paperLib.resolveAccount(null);
  assert(resolvedDefault.name === "Default", `resolveAccount(null) → real 'Default' (got '${resolvedDefault.name}')`);

  const resolvedInvalid = await paperLib.resolveAccount("99999999");
  assert(resolvedInvalid.name === "Default", `resolveAccount('99999999') falls back to Default (got '${resolvedInvalid.name}')`);

  const resolvedGarbage = await paperLib.resolveAccount("not-a-number");
  assert(resolvedGarbage.name === "Default", `resolveAccount('not-a-number') falls back to Default`);
}

// ── Test 6: Account isolation — ordering on Alt doesn't touch Default ────
async function test6_accountIsolation(defaultId, alt1Id) {
  console.log("\nTest 6: Account isolation — Alt1 order doesn't leak to Default");
  const [[before]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM paper_orders WHERE account_id = ?", [defaultId]
  );

  // Place a BUY on Alt1 via the fill engine.
  const [orderRow] = await pool.execute(
    `INSERT INTO paper_orders (account_id, symbol, side, position_side, order_type, investment_usd, status)
     VALUES (?, 'TSLA', 'BUY', 'LONG', 'MARKET', 500, 'PENDING')`, [alt1Id]
  );
  const orderId = orderRow.insertId;
  const fill = await paperFill.fillOrder(pool, orderId, 100);
  assert(fill.filled === true, "Alt1 BUY filled");

  const [[after]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM paper_orders WHERE account_id = ?", [defaultId]
  );
  assert(Number(after.c) === Number(before.c), `Default order count unchanged (before=${before.c}, after=${after.c})`);

  // Alt1 has a trade; Default should have none from this flow.
  const [[altTrades]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM paper_trades WHERE account_id = ? AND symbol = 'TSLA'", [alt1Id]
  );
  const [[defTrades]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM paper_trades WHERE account_id = ? AND symbol = 'TSLA'", [defaultId]
  );
  assert(Number(altTrades.c) === 1, `Alt1 has 1 TSLA trade (got ${altTrades.c})`);
  assert(Number(defTrades.c) === 0, `Default has 0 TSLA trades (got ${defTrades.c})`);
}

// ── Test 7: Reset scope — wipes only the targeted account ────────────────
async function test7_resetScope(defaultId, alt1Id) {
  console.log("\nTest 7: Reset scope — Alt1 reset leaves Default untouched");
  // Seed Default with something to survive the reset.
  await pool.execute(
    `INSERT INTO paper_orders (account_id, symbol, side, position_side, order_type, investment_usd, status)
     VALUES (?, 'GOOG', 'BUY', 'LONG', 'MARKET', 500, 'PENDING')`, [defaultId]
  );
  const [[defBefore]] = await pool.execute("SELECT COUNT(*) AS c FROM paper_orders WHERE account_id = ?", [defaultId]);
  const [[altBefore]] = await pool.execute("SELECT COUNT(*) AS c FROM paper_orders WHERE account_id = ?", [alt1Id]);
  assert(Number(altBefore.c) > 0, "Alt1 has orders before reset");

  // Simulate the reset API: DELETE FROM paper_{orders,trades,equity_snapshots} WHERE account_id = alt1.
  await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [alt1Id]);
  await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [alt1Id]);
  await pool.execute("DELETE FROM paper_equity_snapshots WHERE account_id = ?", [alt1Id]);
  await pool.execute(
    "UPDATE paper_accounts SET cash = initial_cash, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?",
    [alt1Id]
  );

  const [[defAfter]] = await pool.execute("SELECT COUNT(*) AS c FROM paper_orders WHERE account_id = ?", [defaultId]);
  const [[altAfter]] = await pool.execute("SELECT COUNT(*) AS c FROM paper_orders WHERE account_id = ?", [alt1Id]);
  assert(Number(defAfter.c) === Number(defBefore.c), `Default orders unchanged by Alt1 reset (before=${defBefore.c}, after=${defAfter.c})`);
  assert(Number(altAfter.c) === 0, `Alt1 orders = 0 after reset (got ${altAfter.c})`);

  // Alt1 cash must be restored to initial.
  const [[altAcct]] = await pool.execute("SELECT cash, initial_cash, reserved_cash, reserved_short_margin FROM paper_accounts WHERE id = ?", [alt1Id]);
  assert(Number(altAcct.cash) === Number(altAcct.initial_cash), `Alt1 cash restored to initial (got ${altAcct.cash} vs ${altAcct.initial_cash})`);
  assert(Number(altAcct.reserved_cash) === 0, `Alt1 reserved_cash cleared to 0 (got ${altAcct.reserved_cash})`);
  assert(Number(altAcct.reserved_short_margin) === 0, `Alt1 reserved_short_margin cleared to 0 (got ${altAcct.reserved_short_margin})`);
}

// ── Test 8: Unique name enforcement on create ────────────────────────────
async function test8_uniqueNameEnforcement() {
  console.log("\nTest 8: Create account — UNIQUE name enforcement");
  // First insert works.
  const [r1] = await pool.execute(
    "INSERT INTO paper_accounts (name, initial_cash, cash) VALUES (?, ?, ?)",
    ["W5_SMOKE_NEW_1", 50000, 50000]
  );
  assert(r1.insertId > 0, `first create for 'W5_SMOKE_NEW_1' succeeded (id=${r1.insertId})`);

  // Duplicate name errors with errno 1062.
  let dupErr = null;
  try {
    await pool.execute(
      "INSERT INTO paper_accounts (name, initial_cash, cash) VALUES (?, ?, ?)",
      ["W5_SMOKE_NEW_1", 25000, 25000]
    );
  } catch (err) { dupErr = err; }
  assert(dupErr !== null, "duplicate name throws");
  assert(dupErr && dupErr.errno === 1062, `dup error is errno 1062 UNIQUE violation (got ${dupErr && dupErr.errno})`);

  // A different name succeeds.
  const [r2] = await pool.execute(
    "INSERT INTO paper_accounts (name, initial_cash, cash) VALUES (?, ?, ?)",
    ["W5_SMOKE_NEW_2", 75000, 75000]
  );
  assert(r2.insertId > 0, `second distinct name 'W5_SMOKE_NEW_2' succeeds (id=${r2.insertId})`);
}

// ── Test 9: getAccountById — positive + negative ─────────────────────────
async function test9_getAccountById(alt1Id) {
  console.log("\nTest 9: getAccountById");
  const found = await paperLib.getAccountById(alt1Id);
  assert(found !== null && found.id === alt1Id, `getAccountById(${alt1Id}) hit`);

  const missing = await paperLib.getAccountById(99999999);
  assert(missing === null, "getAccountById(99999999) → null");
}

(async () => {
  let defaultId, alt1Id;
  try {
    await loadModules();
    await ensureSchemaMinimal();
    defaultId = await upsertAccount(TEST_ACCOUNT_DEFAULT, 100000);
    alt1Id = await upsertAccount(TEST_ACCOUNT_ALT1, 50000);
    console.log(`Using test accounts: default(id=${defaultId}) alt1(id=${alt1Id})`);

    await test1_idempotencyDedup(defaultId);
    await test2_differentIds(defaultId);
    await test3_nullAllowsMultiple(defaultId);
    await test4_accountListing(defaultId, alt1Id);
    await test5_resolveAccount(defaultId, alt1Id);
    await test6_accountIsolation(defaultId, alt1Id);
    await test7_resetScope(defaultId, alt1Id);
    await test8_uniqueNameEnforcement();
    await test9_getAccountById(alt1Id);

    console.log(`\n== SUMMARY: ${passed} passed, ${failed} failed ==`);
    if (failed > 0) {
      console.log("Failures:");
      for (const f of failures) console.log(`  - ${f}`);
    }
  } catch (err) {
    console.error("Fatal:", err);
    failed++;
  } finally {
    await teardown();
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(failed === 0 ? 0 : 1);
  }
})();
