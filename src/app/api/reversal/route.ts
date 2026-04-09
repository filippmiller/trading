import { NextResponse } from "next/server";

import { getPool, mysql } from "@/lib/db";
import { ensureSchema } from "@/lib/migrations";
import { ReversalEntry } from "@/lib/reversal";

// GET - Fetch all reversal entries, optionally filtered by status or cohort date
export async function GET(req: Request) {
  try {
    await ensureSchema();
    const pool = await getPool();

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const cohortDate = searchParams.get("cohort_date");

    let query = "SELECT * FROM reversal_entries";
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }
    if (cohortDate) {
      conditions.push("cohort_date = ?");
      params.push(cohortDate);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY cohort_date DESC, direction, symbol";

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(query, params);

    // Group by cohort date
    const cohorts: Record<string, ReversalEntry[]> = {};
    for (const row of rows) {
      const date = row.cohort_date instanceof Date
        ? row.cohort_date.toISOString().split("T")[0]
        : String(row.cohort_date);
      if (!cohorts[date]) {
        cohorts[date] = [];
      }
      const entry: any = {
        id: row.id,
        cohort_date: date,
        symbol: row.symbol,
        direction: row.direction as "LONG" | "SHORT",
        day_change_pct: Number(row.day_change_pct),
        entry_price: Number(row.entry_price),
        consecutive_days: row.consecutive_days ? Number(row.consecutive_days) : undefined,
        cumulative_change_pct: row.cumulative_change_pct ? Number(row.cumulative_change_pct) : undefined,
        final_pnl_usd: row.final_pnl_usd ? Number(row.final_pnl_usd) : null,
        final_pnl_pct: row.final_pnl_pct ? Number(row.final_pnl_pct) : null,
        status: row.status as "ACTIVE" | "COMPLETED",
        created_at: row.created_at,
      };
      for (let d = 1; d <= 10; d++) {
        for (const t of ['morning', 'midday', 'close']) {
          const col = `d${d}_${t}`;
          entry[col] = row[col] != null ? Number(row[col]) : null;
        }
      }
      cohorts[date].push(entry as ReversalEntry);
    }

    return NextResponse.json({ cohorts });
  } catch (error) {
    console.error("reversal GET error", error);
    return NextResponse.json({ error: "Failed to fetch entries." }, { status: 500 });
  }
}

// POST - Create new reversal entries for a cohort
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const pool = await getPool();

    const body = await req.json();
    const { cohort_date, entries } = body;

    const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
    if (!cohort_date || !DATE_REGEX.test(cohort_date)) {
      return NextResponse.json({ error: "cohort_date must be YYYY-MM-DD." }, { status: 400 });
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      return NextResponse.json({ error: "entries array required." }, { status: 400 });
    }

    const VALID_DIRECTIONS = ["LONG", "SHORT"];
    for (const entry of entries) {
      if (!entry.symbol || typeof entry.symbol !== "string") {
        return NextResponse.json({ error: "Each entry needs a symbol string." }, { status: 400 });
      }
      if (!VALID_DIRECTIONS.includes(entry.direction)) {
        return NextResponse.json({ error: "direction must be LONG or SHORT." }, { status: 400 });
      }
      const price = Number(entry.entry_price);
      if (!isFinite(price) || price <= 0) {
        return NextResponse.json({ error: "entry_price must be a positive number." }, { status: 400 });
      }
    }

    // Insert entries
    const insertedIds: number[] = [];
    for (const entry of entries) {
      const [result] = await pool.execute<mysql.ResultSetHeader>(
        `INSERT INTO reversal_entries (cohort_date, symbol, direction, day_change_pct, entry_price, consecutive_days, cumulative_change_pct, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
         ON DUPLICATE KEY UPDATE
           direction = VALUES(direction),
           day_change_pct = VALUES(day_change_pct),
           entry_price = VALUES(entry_price),
           consecutive_days = VALUES(consecutive_days),
           cumulative_change_pct = VALUES(cumulative_change_pct)`,
        [
          cohort_date,
          entry.symbol.toUpperCase(),
          entry.direction,
          entry.day_change_pct || 0,
          entry.entry_price,
          entry.consecutive_days ?? null,
          entry.cumulative_change_pct ?? null,
        ]
      );
      insertedIds.push(result.insertId || 0);
    }

    return NextResponse.json({ success: true, count: entries.length, ids: insertedIds });
  } catch (error) {
    console.error("reversal POST error", error);
    return NextResponse.json({ error: "Failed to create entries." }, { status: 500 });
  }
}
