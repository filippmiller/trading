import { NextResponse } from "next/server";

import { ensureSchema } from "@/lib/migrations";
import { getPool, mysql } from "@/lib/db";

export async function GET(req: Request) {
  await ensureSchema();
  const { searchParams } = new URL(req.url);
  const limitRaw = Number(searchParams.get("limit") || 60);
  const limit = Math.min(260, Math.max(1, Math.floor(limitRaw)));

  const pool = await getPool();
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT date, open, high, low, close FROM prices_daily WHERE symbol = 'SPY' ORDER BY date DESC LIMIT ${limit}`
  );

  const items = rows.map((row) => ({
    date: new Date(row.date).toISOString().slice(0, 10),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  }));

  return NextResponse.json({ items });
}
