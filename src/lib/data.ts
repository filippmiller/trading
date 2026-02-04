import { ensureDefaultSettings, ensureSchema } from "@/lib/migrations";
import { getPool, sql } from "@/lib/db";

export type PriceRow = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function parseCsv(csv: string): PriceRow[] {
  const lines = csv.trim().split(/\r?\n/);
  const rows: PriceRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const [date, open, high, low, close, volume] = line.split(",");
    if (!date || date === "Date") continue;
    rows.push({
      date,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    });
  }
  return rows;
}

export async function fetchSpyDailyBars() {
  const response = await fetch("https://stooq.com/q/d/l/?s=spy.us&i=d", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Failed to fetch SPY data from Stooq.");
  }
  const csv = await response.text();
  const rows = parseCsv(csv);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return rows.filter((row) => row.date >= cutoffStr);
}

export async function refreshSpyData() {
  await ensureSchema();
  await ensureDefaultSettings();
  const pool = await getPool();
  const rows = await fetchSpyDailyBars();
  let inserted = 0;

  for (const row of rows) {
    const result = await pool
      .request()
      .input("symbol", sql.VarChar(16), "SPY")
      .input("date", sql.Date, row.date)
      .input("open", sql.Decimal(18, 6), row.open)
      .input("high", sql.Decimal(18, 6), row.high)
      .input("low", sql.Decimal(18, 6), row.low)
      .input("close", sql.Decimal(18, 6), row.close)
      .input("volume", sql.BigInt, row.volume)
      .query(
        "IF NOT EXISTS (SELECT 1 FROM prices_daily WHERE symbol = @symbol AND date = @date) BEGIN INSERT INTO prices_daily (symbol, date, open, high, low, close, volume) VALUES (@symbol, @date, @open, @high, @low, @close, @volume) END"
      );
    if (result.rowsAffected[0] > 0) inserted += 1;
  }

  return { inserted, total: rows.length };
}

export async function getDataStatus() {
  await ensureSchema();
  await ensureDefaultSettings();
  const pool = await getPool();
  const result = await pool
    .request()
    .query("SELECT COUNT(*) as count, MAX(date) as latest FROM prices_daily WHERE symbol = 'SPY'");
  const row = result.recordset[0];
  return {
    count: Number(row.count || 0),
    latest: row.latest ? row.latest.toISOString().slice(0, 10) : null,
  };
}

export async function loadPrices(lookbackDays: number) {
  await ensureSchema();
  await ensureDefaultSettings();
  const pool = await getPool();
  const result = await pool
    .request()
    .input("limit", sql.Int, lookbackDays)
    .query(
      "SELECT TOP (@limit) date, open, high, low, close, volume FROM prices_daily WHERE symbol = 'SPY' ORDER BY date DESC"
    );
  type PriceDbRow = {
    date: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  const rows = (result.recordset as PriceDbRow[])
    .map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    }))
    .reverse();
  return rows;
}

export async function getDefaultSettings() {
  await ensureSchema();
  await ensureDefaultSettings();
  const pool = await getPool();
  const result = await pool
    .request()
    .input("key", sql.VarChar(64), "defaults")
    .query("SELECT [value] FROM app_settings WHERE [key] = @key");
  if (result.recordset.length === 0) return null;
  try {
    return JSON.parse(result.recordset[0].value);
  } catch {
    return null;
  }
}

export async function updateDefaultSettings(values: Record<string, unknown>) {
  await ensureSchema();
  const pool = await getPool();
  const key = "defaults";
  await pool
    .request()
    .input("key", sql.VarChar(64), key)
    .input("value", sql.NVarChar(sql.MAX), JSON.stringify(values))
    .query(
      "UPDATE app_settings SET [value] = @value, updated_at = SYSUTCDATETIME() WHERE [key] = @key"
    );
}
