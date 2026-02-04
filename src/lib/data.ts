import { ensureDefaultSettings, ensureSchema } from "@/lib/migrations";
import { getPool, mysql } from "@/lib/db";

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
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO prices_daily (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE open = VALUES(open), high = VALUES(high), low = VALUES(low), close = VALUES(close), volume = VALUES(volume)",
      ["SPY", row.date, row.open, row.high, row.low, row.close, row.volume]
    );
    if (result.affectedRows === 1) inserted += 1;
  }

  return { inserted, total: rows.length };
}

export async function getDataStatus() {
  await ensureSchema();
  await ensureDefaultSettings();
  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) as count, MAX(date) as latest FROM prices_daily WHERE symbol = 'SPY'"
  );
  const row = rows[0];
  return {
    count: Number(row?.count ?? 0),
    latest: row?.latest ? new Date(row.latest).toISOString().slice(0, 10) : null,
  };
}

export async function loadPrices(lookbackDays: number) {
  await ensureSchema();
  await ensureDefaultSettings();
  const pool = await getPool();
  const limit = Math.min(260, Math.max(1, Math.floor(lookbackDays)));
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT date, open, high, low, close, volume FROM prices_daily WHERE symbol = 'SPY' ORDER BY date DESC LIMIT ?",
    [limit]
  );
  return rows
    .map((row) => ({
      date: new Date(row.date).toISOString().slice(0, 10),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    }))
    .reverse();
}

export async function getDefaultSettings() {
  await ensureSchema();
  await ensureDefaultSettings();
  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT `value` FROM app_settings WHERE `key` = ?",
    ["defaults"]
  );
  if (!rows.length) return null;
  try {
    return JSON.parse(rows[0].value);
  } catch {
    return null;
  }
}

export async function updateDefaultSettings(values: Record<string, unknown>) {
  await ensureSchema();
  const pool = await getPool();
  const key = "defaults";
  await pool.execute(
    "UPDATE app_settings SET `value` = ?, updated_at = CURRENT_TIMESTAMP(6) WHERE `key` = ?",
    [JSON.stringify(values), key]
  );
}
