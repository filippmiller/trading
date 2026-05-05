import fs from "node:fs";
import path from "node:path";

import mysql from "mysql2/promise";

import { ensureMarketDataArchiveSchema } from "../src/lib/market-data/schema";

type UniverseRow = {
  symbol: string;
  source: string;
  name?: string | null;
  exchange?: string | null;
  asset_type?: string | null;
  active?: number;
  raw_json?: string | null;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientMysqlError(err: unknown) {
  const code = typeof err === "object" && err != null && "code" in err ? String((err as { code?: unknown }).code) : "";
  return ["ECONNRESET", "PROTOCOL_CONNECTION_LOST", "ETIMEDOUT", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(code);
}

async function executeWithRetry(pool: mysql.Pool, sql: string, params: unknown[] = []) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await pool.execute(sql, params);
    } catch (err) {
      lastError = err;
      if (!isTransientMysqlError(err) || attempt === 3) break;
      await sleep(300 * attempt);
    }
  }
  throw lastError;
}

function loadEnvLocal() {
  if (process.env.DATABASE_URL) return;
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseArgs() {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    args.set(key, value);
  }
  return {
    sp500Csv: args.get("sp500-csv") ?? "scripts/market-universe-sp500-seed.csv",
  };
}

function readSp500Csv(csvPath: string): UniverseRow[] {
  if (!fs.existsSync(csvPath)) return [];
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
  const [header, ...body] = lines;
  const cols = header.split(",").map((col) => col.trim().toLowerCase());
  const symbolIdx = cols.indexOf("symbol");
  const nameIdx = cols.indexOf("name");
  const exchangeIdx = cols.indexOf("exchange");
  if (symbolIdx < 0) throw new Error(`${csvPath} must include a symbol column`);
  return body.map((line) => {
    const cells = line.split(",").map((cell) => cell.trim());
    return {
      symbol: cells[symbolIdx].toUpperCase(),
      source: "SP500",
      name: nameIdx >= 0 ? cells[nameIdx] : null,
      exchange: exchangeIdx >= 0 ? cells[exchangeIdx] : null,
      asset_type: "EQUITY",
      active: 1,
    };
  });
}

async function main() {
  loadEnvLocal();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const args = parseArgs();
  const url = new URL(process.env.DATABASE_URL);
  const pool = mysql.createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    timezone: "Z",
    connectionLimit: 1,
  });
  await ensureMarketDataArchiveSchema(pool);

  const rows: UniverseRow[] = [];
  rows.push(...readSp500Csv(args.sp500Csv));

  const [tradable] = (await executeWithRetry(
    pool,
    "SELECT symbol, exchange, asset_class, active FROM tradable_symbols WHERE active = 1 AND asset_class = 'EQUITY'",
  )) as [mysql.RowDataPacket[], mysql.FieldPacket[]];
  for (const row of tradable) {
    const exchange = row.exchange == null ? null : String(row.exchange);
    if (exchange === "LAZY_SYNC") continue;
    rows.push({
      symbol: String(row.symbol).toUpperCase(),
      source: exchange === "NASDAQ" ? "NASDAQ" : "CUSTOM",
      exchange,
      asset_type: "EQUITY",
      active: Number(row.active) === 1 ? 1 : 0,
      raw_json: JSON.stringify({ origin: "tradable_symbols" }),
    });
  }

  const [movers] = (await executeWithRetry(
    pool,
    "SELECT DISTINCT symbol FROM reversal_entries WHERE enrollment_source = 'MOVERS' ORDER BY symbol",
  )) as [mysql.RowDataPacket[], mysql.FieldPacket[]];
  for (const row of movers) {
    rows.push({
      symbol: String(row.symbol).toUpperCase(),
      source: "MOVERS",
      exchange: null,
      asset_type: "EQUITY",
      active: 1,
      raw_json: JSON.stringify({ origin: "reversal_entries" }),
    });
  }

  const validRows = rows.filter((row) => /^[A-Z0-9.\-]{1,16}$/.test(row.symbol));
  let upserted = 0;
  for (let i = 0; i < validRows.length; i += 200) {
    const chunk = validRows.slice(i, i + 200);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = chunk.flatMap((row) => [
      row.symbol,
      row.source,
      row.name ?? null,
      row.exchange ?? null,
      row.asset_type ?? "EQUITY",
      row.active ?? 1,
      row.raw_json ?? null,
    ]);
    await executeWithRetry(
      pool,
      `INSERT INTO market_universe
        (symbol, source, name, exchange, asset_type, active, raw_json)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE
        name = COALESCE(VALUES(name), name),
        exchange = COALESCE(VALUES(exchange), exchange),
        asset_type = VALUES(asset_type),
        active = VALUES(active),
        last_seen_at = CURRENT_TIMESTAMP(6),
        raw_json = COALESCE(VALUES(raw_json), raw_json)`,
      params,
    );
    upserted += chunk.length;
  }

  console.log(`[market-universe] upserted ${upserted} rows across ${new Set(rows.map((row) => row.symbol)).size} symbols`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
