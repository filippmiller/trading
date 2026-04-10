#!/usr/bin/env npx tsx
/**
 * Seed all 24 strategy scenarios (8 strategies × 3 leverage tiers).
 * Each strategy gets its own $100k paper account.
 *
 * Usage: DATABASE_URL=mysql://... npx tsx scripts/seed-strategies.ts
 */

import mysql from "mysql2/promise";
import { generateAllStrategies } from "../src/lib/strategy-engine";

const DB_URL = process.env.DATABASE_URL || "mysql://root:trading123@localhost:3319/trading";

async function main() {
  const parsed = new URL(DB_URL);
  const pool = mysql.createPool({
    host: parsed.hostname,
    port: Number(parsed.port) || 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace("/", ""),
    connectionLimit: 5,
    timezone: "Z",
  });

  const strategies = generateAllStrategies();
  console.log(`Seeding ${strategies.length} strategies...\n`);

  let created = 0, skipped = 0;

  for (const s of strategies) {
    // Check if already exists
    const [existing] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id FROM paper_strategies WHERE name = ?",
      [s.name]
    );
    if (existing.length > 0) {
      skipped++;
      continue;
    }

    // Create dedicated account
    const accountName = `Strategy: ${s.name}`;
    await pool.execute(
      "INSERT IGNORE INTO paper_accounts (name, initial_cash, cash) VALUES (?, 100000, 100000)",
      [accountName]
    );
    const [accRows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id FROM paper_accounts WHERE name = ?",
      [accountName]
    );
    const accountId = accRows[0].id;

    // Create strategy
    await pool.execute(
      `INSERT INTO paper_strategies (account_id, name, strategy_type, leverage, enabled, config_json)
       VALUES (?, ?, ?, ?, 1, ?)`,
      [accountId, s.name, s.strategy_type, s.leverage, JSON.stringify(s.config)]
    );
    created++;
    console.log(`  ✓ ${s.name} → account #${accountId}`);
  }

  console.log(`\nDone: ${created} created, ${skipped} already existed.`);

  // Summary
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT s.name, s.leverage, s.strategy_type, a.cash FROM paper_strategies s JOIN paper_accounts a ON s.account_id = a.id ORDER BY s.name"
  );
  console.log("\nAll strategies:");
  console.log("─".repeat(70));
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(30)} ${r.strategy_type.padEnd(10)} ${r.leverage}x  $${Number(r.cash).toFixed(0)}`);
  }

  await pool.end();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
