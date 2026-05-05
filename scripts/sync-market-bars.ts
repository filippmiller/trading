import fs from "node:fs";

import mysql from "mysql2/promise";

import { ensureMarketDataArchiveSchema } from "../src/lib/market-data/schema";

function loadEnvLocal() {
  if (process.env.DATABASE_URL) return;
  const envPath = `${process.cwd()}/.env.local`;
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
    source: args.get("source") ?? "MOVERS",
    limit: Number(args.get("limit") ?? 25),
  };
}

function mysqlDateTime(isoTs: string): string {
  return isoTs.slice(0, 19).replace("T", " ");
}

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

async function main() {
  loadEnvLocal();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const { yahooStooqProvider } = await import("../src/lib/market-data/providers/yahoo-stooq");

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

  const [symbols] = (await executeWithRetry(
    pool,
    `SELECT symbol FROM market_universe
      WHERE source = ? AND active = 1
      ORDER BY symbol
      LIMIT ${Math.max(1, Math.min(5000, Math.floor(args.limit)))}`,
    [args.source],
  )) as [mysql.RowDataPacket[], mysql.FieldPacket[]];

  let barsUpserted = 0;
  let failures = 0;
  for (const row of symbols) {
    const symbol = String(row.symbol);
    try {
      const bars = await yahooStooqProvider.fetchDailyBars?.({ symbol });
      for (const bar of bars ?? []) {
        await executeWithRetry(
          pool,
          `INSERT INTO market_bars
            (symbol, ts, timeframe, provider, open, high, low, close, volume)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
            open = VALUES(open),
            high = VALUES(high),
            low = VALUES(low),
            close = VALUES(close),
            volume = VALUES(volume),
            updated_at = CURRENT_TIMESTAMP(6)`,
          [
            bar.symbol,
            mysqlDateTime(bar.ts),
            bar.timeframe,
            bar.provider,
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.volume,
          ],
        );
        barsUpserted++;
      }
      console.log(`[market-bars] ${symbol} ${bars?.length ?? 0} daily bars`);
    } catch (err) {
      failures++;
      console.warn(`[market-bars] ${symbol} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`[market-bars] source=${args.source} symbols=${symbols.length} bars=${barsUpserted} failures=${failures}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
