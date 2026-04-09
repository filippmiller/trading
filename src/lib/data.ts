import { ensureDefaultSettings, ensureSchema } from "@/lib/migrations";
import { getPool, mysql } from "@/lib/db";
import { normalizeSymbol, toStooqSymbol } from "@/lib/symbols";

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
    const o = Number(open), h = Number(high), l = Number(low), c = Number(close), v = Number(volume);
    if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c) || isNaN(v) || c <= 0) continue;
    rows.push({ date, open: o, high: h, low: l, close: c, volume: v });
  }
  return rows;
}

export async function fetchDailyBars(symbol: string) {
  const normalized = normalizeSymbol(symbol);

  // Try Stooq first, fall back to Yahoo Finance chart API
  try {
    const stooqSymbol = toStooqSymbol(normalized);
    const response = await fetch(
      `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`,
      { cache: "no-store" }
    );
    if (response.ok) {
      const csv = await response.text();
      const rows = parseCsv(csv);
      if (rows.length) return rows;
    }
  } catch { /* fall through to Yahoo */ }

  // Yahoo Finance fallback
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}?range=1mo&interval=1d`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${normalized} daily bars.`);
  }
  const data = await response.json();
  const result = data?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};

  const rows: PriceRow[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = Number(quote.open?.[i]), h = Number(quote.high?.[i]);
    const l = Number(quote.low?.[i]), c = Number(quote.close?.[i]);
    const v = Number(quote.volume?.[i] ?? 0);
    if (isNaN(c) || c <= 0) continue;
    rows.push({
      date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
      open: o, high: h, low: l, close: c, volume: v,
    });
  }
  if (!rows.length) {
    throw new Error(`No data returned for ${normalized}.`);
  }
  return rows;
}

export async function refreshSymbolData(symbol: string) {
  await ensureSchema();
  await ensureDefaultSettings();
  const normalized = normalizeSymbol(symbol);
  const pool = await getPool();
  const rows = await fetchDailyBars(normalized);
  let inserted = 0;

  for (const row of rows) {
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO prices_daily (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE open = VALUES(open), high = VALUES(high), low = VALUES(low), close = VALUES(close), volume = VALUES(volume)",
      [normalized, row.date, row.open, row.high, row.low, row.close, row.volume]
    );
    if (result.affectedRows === 1) inserted += 1;
  }

  return { inserted, total: rows.length, symbol: normalized };
}

export async function getDataStatus(symbol: string) {
  await ensureSchema();
  await ensureDefaultSettings();
  const normalized = normalizeSymbol(symbol);
  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) as count, MAX(date) as latest FROM prices_daily WHERE symbol = ?",
    [normalized]
  );
  const row = rows[0];
  return {
    symbol: normalized,
    count: Number(row?.count ?? 0),
    latest: row?.latest ? new Date(row.latest).toISOString().slice(0, 10) : null,
  };
}

export async function loadPrices(lookbackDays: number, symbol: string) {
  await ensureSchema();
  await ensureDefaultSettings();
  const normalized = normalizeSymbol(symbol);
  const pool = await getPool();
  const limit = Math.min(260, Math.max(1, Math.floor(lookbackDays)));
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT date, open, high, low, close, volume FROM prices_daily WHERE symbol = ? ORDER BY date DESC LIMIT ?",
    [normalized, limit]
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

export async function getAvailableSymbols() {
  await ensureSchema();
  const pool = await getPool();
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT DISTINCT symbol FROM prices_daily ORDER BY symbol ASC"
  );
  return rows.map((row) => String(row.symbol));
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
