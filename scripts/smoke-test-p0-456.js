#!/usr/bin/env node
/**
 * P0-4/5/6 smoke test via tunnel. Read-only; no writes.
 *   P0-4: ensure the dateStr helper produces the correct next trading day
 *   P0-5: check whether any orphan signals currently exist (COMPLETED cohort + open signal)
 *   P0-6: validate the new SHORT-aware SQL compiles and returns sane values
 */

const mysql = require("mysql2/promise");

// Require DATABASE_URL — never embed credentials in source.
if (!process.env.DATABASE_URL) {
  const fs = require("fs"), path = require("path");
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* ok */ }
}
if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL must be set. Never hardcode credentials.");
  process.exit(1);
}
const _dbUrl = new URL(process.env.DATABASE_URL);
const pool = mysql.createPool({
  host: _dbUrl.hostname,
  port: _dbUrl.port ? Number(_dbUrl.port) : 3306,
  user: decodeURIComponent(_dbUrl.username),
  password: decodeURIComponent(_dbUrl.password),
  database: _dbUrl.pathname.replace("/", ""),
  waitForConnections: true, connectionLimit: 2, timezone: "Z",
});

function addCalendarDaysET(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(base);
}
function isWeekendET(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(base);
  return dow === "Sat" || dow === "Sun";
}

async function testP04() {
  console.log("P0-4: ET-calendar date arithmetic");
  // Known: 2026-04-17 is Friday, next trading day = 2026-04-20 (Monday)
  let cursor = "2026-04-17"; // Fri
  let steps = 0;
  while (steps < 1) {
    cursor = addCalendarDaysET(cursor, 1);
    if (isWeekendET(cursor)) continue;
    steps++;
  }
  if (cursor !== "2026-04-20") throw new Error(`Fri+1tradingDay = ${cursor}, expected 2026-04-20`);
  console.log(`  OK  Fri 2026-04-17 + 1 trading day = ${cursor}`);

  // Another: 2026-04-13 (Mon) + 5 trading days = 2026-04-20 (Mon)
  cursor = "2026-04-13"; steps = 0;
  while (steps < 5) {
    cursor = addCalendarDaysET(cursor, 1);
    if (isWeekendET(cursor)) continue;
    steps++;
  }
  if (cursor !== "2026-04-20") throw new Error(`Mon+5tradingDays = ${cursor}, expected 2026-04-20`);
  console.log(`  OK  Mon 2026-04-13 + 5 trading days = ${cursor}`);
}

async function testP05() {
  console.log("\nP0-5: orphan-signal detection");
  const [orphans] = await pool.execute(`
    SELECT ps.id, ps.symbol, ps.direction, ps.entry_price, ps.investment_usd, re.cohort_date, re.status as entry_status
    FROM paper_signals ps
    JOIN reversal_entries re ON ps.reversal_entry_id = re.id
    WHERE re.status = 'COMPLETED' AND ps.status = 'EXECUTED' AND ps.exit_at IS NULL
  `);
  console.log(`  OK  found ${orphans.length} current orphan signal(s) across completed cohorts`);
  if (orphans.length > 0) {
    console.log(`       sample:`, orphans.slice(0, 3).map(o => ({ id: o.id, symbol: o.symbol, dir: o.direction })));
    // Compute dollar value locked
    const locked = orphans.reduce((s, o) => s + Number(o.investment_usd), 0);
    console.log(`       total investment locked: $${locked.toFixed(2)}`);
  }
}

async function testP06() {
  console.log("\nP0-6: SHORT-aware open_market_value");
  // Run the new SQL and compare to the buggy version for SHORT positions
  const [newVals] = await pool.execute(`
    SELECT
      ps.strategy_id,
      COALESCE(SUM(
        CASE
          WHEN ps.status = 'EXECUTED' AND ps.exit_at IS NULL THEN GREATEST(
            0,
            ps.investment_usd + (
              ps.investment_usd * GREATEST(
                (
                  (
                    (COALESCE(lp.price, ps.entry_price) - ps.entry_price)
                    / NULLIF(ps.entry_price, 0)
                  )
                  * (CASE WHEN ps.direction = 'SHORT' THEN -1 ELSE 1 END)
                ) * ps.leverage,
                -1
              )
            )
          )
          ELSE 0
        END
      ), 0) as new_omv
    FROM paper_signals ps
    LEFT JOIN (
      SELECT pp.signal_id, pp.price
      FROM paper_position_prices pp
      INNER JOIN (
        SELECT signal_id, MAX(fetched_at) AS max_fetched_at
        FROM paper_position_prices GROUP BY signal_id
      ) latest ON latest.signal_id = pp.signal_id AND latest.max_fetched_at = pp.fetched_at
    ) lp ON lp.signal_id = ps.id
    GROUP BY ps.strategy_id
  `);
  console.log(`  OK  new SQL executed, returned ${newVals.length} strategy rows`);

  const [oldVals] = await pool.execute(`
    SELECT
      ps.strategy_id,
      COALESCE(SUM(
        CASE
          WHEN ps.status = 'EXECUTED' AND ps.exit_at IS NULL THEN GREATEST(
            0,
            ps.investment_usd + (
              ps.investment_usd * GREATEST(
                ((COALESCE(lp.price, ps.entry_price) - ps.entry_price) / NULLIF(ps.entry_price, 0)) * ps.leverage,
                -1
              )
            )
          )
          ELSE 0
        END
      ), 0) as old_omv
    FROM paper_signals ps
    LEFT JOIN (
      SELECT pp.signal_id, pp.price
      FROM paper_position_prices pp
      INNER JOIN (
        SELECT signal_id, MAX(fetched_at) AS max_fetched_at
        FROM paper_position_prices GROUP BY signal_id
      ) latest ON latest.signal_id = pp.signal_id AND latest.max_fetched_at = pp.fetched_at
    ) lp ON lp.signal_id = ps.id
    GROUP BY ps.strategy_id
  `);

  const oldMap = new Map(oldVals.map(r => [r.strategy_id, Number(r.old_omv)]));
  let deltaTotal = 0, strategiesDiff = 0;
  for (const r of newVals) {
    const oldV = oldMap.get(r.strategy_id) ?? 0;
    const newV = Number(r.new_omv);
    const delta = newV - oldV;
    if (Math.abs(delta) > 0.01) {
      strategiesDiff++;
      deltaTotal += delta;
    }
  }
  console.log(`  OK  ${strategiesDiff} strategies show different open_market_value with fix`);
  console.log(`       net delta: ${deltaTotal >= 0 ? "+" : ""}$${deltaTotal.toFixed(2)} (fix - bug)`);
  console.log(`       (negative = fix REDUCES inflated equity where SHORTs were shown as gaining)`);
}

async function main() {
  try {
    await testP04();
    await testP05();
    await testP06();
    console.log("\nALL P0-4/5/6 SMOKE TESTS PASSED");
  } finally {
    await pool.end();
  }
}
main().catch(e => { console.error("FAIL:", e.message); console.error(e.stack); process.exit(1); });
