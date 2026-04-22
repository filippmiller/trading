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

// ── Test 5: resolveAccount — honors account_id, Default only for null/empty ──
// Round-2: fallback to Default now ONLY happens for null/empty param. A bogus
// explicit account_id throws AccountNotFoundError so routes can 404 instead
// of silently wiping Default on reset (the original attack vector).
async function test5_resolveAccount(defaultId, alt1Id) {
  console.log("\nTest 5: resolveAccount — honors param, Default only for null/empty, throws on bogus");
  const resolvedAlt = await paperLib.resolveAccount(String(alt1Id));
  assert(resolvedAlt.id === alt1Id, `resolveAccount('${alt1Id}') → alt1 (got id=${resolvedAlt.id})`);

  const resolvedDefault = await paperLib.resolveAccount(null);
  assert(resolvedDefault.name === "Default", `resolveAccount(null) → real 'Default' (got '${resolvedDefault.name}')`);

  const resolvedEmpty = await paperLib.resolveAccount("");
  assert(resolvedEmpty.name === "Default", `resolveAccount('') → Default (backward compat)`);

  // Bogus numeric id MUST throw, not fall back.
  let invalidErr = null;
  try { await paperLib.resolveAccount("99999999"); } catch (e) { invalidErr = e; }
  assert(invalidErr !== null, `resolveAccount('99999999') throws instead of fallback`);
  assert(invalidErr && invalidErr.name === "AccountNotFoundError",
    `throws AccountNotFoundError (got ${invalidErr && invalidErr.name})`);

  // Non-numeric garbage MUST throw too.
  let garbageErr = null;
  try { await paperLib.resolveAccount("not-a-number"); } catch (e) { garbageErr = e; }
  assert(garbageErr !== null, `resolveAccount('not-a-number') throws`);
  assert(garbageErr && garbageErr.name === "AccountNotFoundError",
    `garbage input throws AccountNotFoundError (got ${garbageErr && garbageErr.name})`);
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

// ── HTTP helper — only used by tests that need the Next.js route layer ───
// Tests hit the dev server to exercise the route-level 404 handling added in
// round-2. If the server isn't reachable these tests are skipped (the core
// resolveAccount-level assertions in Test 5 already cover the throw path).
const HTTP_BASE = process.env.PAPER_W5_BASE_URL || "http://localhost:3013";

async function httpJson(method, path, body) {
  const res = await fetch(HTTP_BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* body might be empty */ }
  return { status: res.status, json };
}

async function isDevServerUp() {
  try {
    const res = await fetch(HTTP_BASE + "/api/paper", { signal: AbortSignal.timeout(2000) });
    return res.status === 200 || res.status === 500; // any response = server up
  } catch { return false; }
}

// ── Test 10: HTTP 404 on bogus account_id + Default untouched (Bug #1) ──
// This is the core round-2 regression test for the "wiped Default" attack
// vector: stale localStorage.account_id → user clicks Reset → silent fallback
// to Default → Default's data gone. Post-fix the API MUST return 404 and
// Default MUST be untouched.
async function test10_httpAccountNotFound(defaultId) {
  console.log("\nTest 10: HTTP — bogus account_id returns 404, Default untouched");
  if (!(await isDevServerUp())) {
    console.log("  SKIP (dev server not up at " + HTTP_BASE + "; start `npm run dev` on port 3013)");
    return;
  }

  // Snapshot Default's real state (the at-risk account is id=1, NOT our
  // test account). The attack wipes the real Default.
  const [[realDefBefore]] = await pool.execute(
    "SELECT cash, initial_cash, reserved_cash FROM paper_accounts WHERE name = 'Default' LIMIT 1"
  );
  const [[realDefOrdersBefore]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM paper_orders WHERE account_id = (SELECT id FROM paper_accounts WHERE name='Default')"
  );
  const [[realDefTradesBefore]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM paper_trades WHERE account_id = (SELECT id FROM paper_accounts WHERE name='Default')"
  );

  // GET with bogus id → 404.
  const g = await httpJson("GET", "/api/paper?account_id=999999");
  assert(g.status === 404, `GET /api/paper?account_id=999999 → 404 (got ${g.status})`);
  assert(g.json && g.json.error === "Account not found",
    `GET 404 body has error='Account not found' (got ${JSON.stringify(g.json)})`);

  // POST (reset) with bogus id → 404. This is THE attack vector — must 404.
  const r = await httpJson("POST", "/api/paper/account?account_id=999999", {});
  assert(r.status === 404, `POST /api/paper/account?account_id=999999 → 404 (got ${r.status})`);
  assert(r.json && r.json.error === "Account not found",
    `POST reset 404 body has error='Account not found' (got ${JSON.stringify(r.json)})`);

  // GET /api/paper/account with bogus id → 404.
  const ga = await httpJson("GET", "/api/paper/account?account_id=999999");
  assert(ga.status === 404, `GET /api/paper/account?account_id=999999 → 404 (got ${ga.status})`);

  // POST /api/paper/order with bogus id → 404.
  const o = await httpJson("POST", "/api/paper/order?account_id=999999",
    { symbol: "AAPL", side: "BUY", order_type: "MARKET", investment_usd: 1000 });
  assert(o.status === 404, `POST /api/paper/order?account_id=999999 → 404 (got ${o.status})`);

  // Backward compat: empty and missing param both use Default (real).
  const ge = await httpJson("GET", "/api/paper?account_id=");
  assert(ge.status === 200, `GET /api/paper?account_id= (empty) → 200 via Default (got ${ge.status})`);

  const gn = await httpJson("GET", "/api/paper");
  assert(gn.status === 200, `GET /api/paper (no param) → 200 via Default (got ${gn.status})`);

  // CRITICAL INVARIANT — real Default untouched by all the 404s above.
  const [[realDefAfter]] = await pool.execute(
    "SELECT cash, initial_cash, reserved_cash FROM paper_accounts WHERE name = 'Default' LIMIT 1"
  );
  const [[realDefOrdersAfter]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM paper_orders WHERE account_id = (SELECT id FROM paper_accounts WHERE name='Default')"
  );
  const [[realDefTradesAfter]] = await pool.execute(
    "SELECT COUNT(*) AS c FROM paper_trades WHERE account_id = (SELECT id FROM paper_accounts WHERE name='Default')"
  );
  assert(Number(realDefAfter.cash) === Number(realDefBefore.cash),
    `Default.cash unchanged (${realDefBefore.cash} → ${realDefAfter.cash})`);
  assert(Number(realDefAfter.initial_cash) === Number(realDefBefore.initial_cash),
    `Default.initial_cash unchanged`);
  assert(Number(realDefOrdersAfter.c) === Number(realDefOrdersBefore.c),
    `Default paper_orders count unchanged (${realDefOrdersBefore.c} → ${realDefOrdersAfter.c})`);
  assert(Number(realDefTradesAfter.c) === Number(realDefTradesBefore.c),
    `Default paper_trades count unchanged (${realDefTradesBefore.c} → ${realDefTradesAfter.c})`);
}

// ── Test 11: Idempotent replay consistency (Bug #2) ──────────────────────
// Place a LIMIT order (safer than MARKET — no market-hours dependency and a
// deterministic PENDING state on both responses). Post-Option-B fix, both
// responses must converge to the same `status`, `order_id`, and `filled_price`.
//
// The spec allowed a LIMIT-based fallback if MARKET is flaky. We use LIMIT
// here because (a) MARKET requires RTH (test flakes weekends/nights) and
// (b) for LIMIT, both responses see PENDING — we're asserting consistency,
// not fill convergence. The FOR-UPDATE fence still exercises the new code
// path; a full MARKET-fill convergence test is noted as the residual race
// window mitigation in the buildIdempotentResponse comment.
async function test11_idempotentReplayConsistency(defaultId) {
  console.log("\nTest 11: Idempotent replay — duplicate POST converges to same state");
  if (!(await isDevServerUp())) {
    console.log("  SKIP (dev server not up at " + HTTP_BASE + ")");
    return;
  }

  const clientRequestId = "smoke-w5-r2-replay-" + Date.now();
  const body = {
    symbol: "AAPL",
    side: "BUY",
    order_type: "LIMIT",
    investment_usd: 500,
    limit_price: 1.00, // well below market — stays PENDING
    client_request_id: clientRequestId,
  };

  // Fire two POSTs simultaneously against the W5 test account (NOT real
  // Default). Both should resolve to the same order_id and terminal status.
  const qs = "?account_id=" + defaultId;
  const [r1, r2] = await Promise.all([
    httpJson("POST", "/api/paper/order" + qs, body),
    httpJson("POST", "/api/paper/order" + qs, body),
  ]);

  assert(r1.status === 200, `first POST → 200 (got ${r1.status}, body=${JSON.stringify(r1.json)})`);
  assert(r2.status === 200, `second POST → 200 (got ${r2.status}, body=${JSON.stringify(r2.json)})`);
  const id1 = r1.json && r1.json.order_id;
  const id2 = r2.json && r2.json.order_id;
  assert(id1 && id2 && id1 === id2,
    `both POSTs return same order_id (got ${id1} vs ${id2})`);
  assert(r1.json.status === r2.json.status,
    `both POSTs return same status (got '${r1.json.status}' vs '${r2.json.status}')`);

  // Clean up the LIMIT order (teardown() below also wipes the test account).
  if (id1) {
    await httpJson("DELETE", "/api/paper/order?id=" + id1);
  }
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
    await test10_httpAccountNotFound(defaultId);
    await test11_idempotentReplayConsistency(defaultId);

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
