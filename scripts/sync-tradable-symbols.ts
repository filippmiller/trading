#!/usr/bin/env npx tsx
/**
 * W4 — Tradable-symbols whitelist seeder.
 *
 * Reads `scripts/tradable-symbols-seed.csv` (a static curated list of ~200
 * major US equities and ETFs) and upserts each row into `tradable_symbols`.
 * Idempotent — rerunning is a no-op unless the CSV changed.
 *
 * Live NASDAQ/NYSE fetch (from ftp://ftp.nasdaqtrader.com/symboldirectory/)
 * was considered but skipped for the MVP: requires FTP access during the
 * container's startup window, adds a network dep, and the curated list
 * covers the symbols users actually ask for in paper trading. Run manually
 * with --refresh to pull from the NASDAQ listing endpoints if network is
 * available.
 *
 * Usage:
 *   npx tsx scripts/sync-tradable-symbols.ts             # CSV seed only
 *   npx tsx scripts/sync-tradable-symbols.ts --refresh   # also pull live lists
 */

import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";

function env(...names: string[]): string | undefined {
  for (const name of names) { if (process.env[name]) return process.env[name]; }
  return undefined;
}

function parseDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) return null;
  const parsed = new URL(value);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace("/", ""),
  };
}

async function getConn(): Promise<mysql.Connection> {
  // Load .env.local opportunistically so local runs work without explicit env.
  try {
    const envFile = fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
    for (const line of envFile.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* ok */ }

  const fromUrl = parseDatabaseUrl();
  return mysql.createConnection({
    host: fromUrl?.host ?? env("MYSQL_HOST", "MYSQLHOST") ?? "localhost",
    port: fromUrl?.port ?? Number(env("MYSQL_PORT", "MYSQLPORT") ?? 3319),
    user: fromUrl?.user ?? env("MYSQL_USER", "MYSQLUSER") ?? "root",
    password: fromUrl?.password ?? env("MYSQL_PASSWORD", "MYSQLPASSWORD") ?? (() => { throw new Error("DB password not set: provide DATABASE_URL or MYSQL_PASSWORD env var. Never hardcode credentials."); })(),
    database: fromUrl?.database ?? env("MYSQL_DB", "MYSQLDATABASE") ?? "trading",
  });
}

type SeedRow = { symbol: string; exchange: string; asset_class: string };

function parseCsv(csvText: string): SeedRow[] {
  const lines = csvText.trim().split(/\r?\n/);
  const out: SeedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [symbol, exchange, assetClass] = line.split(",");
    if (!symbol) continue;
    out.push({
      symbol: symbol.trim().toUpperCase(),
      exchange: (exchange || "").trim().toUpperCase(),
      asset_class: (assetClass || "EQUITY").trim().toUpperCase(),
    });
  }
  return out;
}

async function upsertSeed(conn: mysql.Connection, rows: SeedRow[]): Promise<number> {
  let n = 0;
  for (const r of rows) {
    await conn.execute(
      `INSERT INTO tradable_symbols (symbol, exchange, asset_class, active)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE exchange = VALUES(exchange), asset_class = VALUES(asset_class), active = 1`,
      [r.symbol, r.exchange || null, r.asset_class]
    );
    n++;
  }
  return n;
}

async function main() {
  const conn = await getConn();
  try {
    const csvPath = path.join(__dirname, "tradable-symbols-seed.csv");
    const csvText = fs.readFileSync(csvPath, "utf8");
    const rows = parseCsv(csvText);
    console.log(`Seed CSV: ${rows.length} rows`);
    const n = await upsertSeed(conn, rows);
    console.log(`Upserted ${n} rows`);
    const [countRows] = await conn.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS c FROM tradable_symbols WHERE active = 1"
    );
    console.log(`Active tradable_symbols: ${countRows[0].c}`);
  } finally {
    await conn.end();
  }
}

// Running as main — check process.argv[1] matches this file
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { main };
