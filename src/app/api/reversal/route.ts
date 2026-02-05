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
      cohorts[date].push({
        id: row.id,
        cohort_date: date,
        symbol: row.symbol,
        direction: row.direction as "LONG" | "SHORT",
        day_change_pct: Number(row.day_change_pct),
        entry_price: Number(row.entry_price),
        d1_morning: row.d1_morning ? Number(row.d1_morning) : null,
        d1_midday: row.d1_midday ? Number(row.d1_midday) : null,
        d1_close: row.d1_close ? Number(row.d1_close) : null,
        d2_morning: row.d2_morning ? Number(row.d2_morning) : null,
        d2_midday: row.d2_midday ? Number(row.d2_midday) : null,
        d2_close: row.d2_close ? Number(row.d2_close) : null,
        d3_morning: row.d3_morning ? Number(row.d3_morning) : null,
        d3_midday: row.d3_midday ? Number(row.d3_midday) : null,
        d3_close: row.d3_close ? Number(row.d3_close) : null,
        final_pnl_usd: row.final_pnl_usd ? Number(row.final_pnl_usd) : null,
        final_pnl_pct: row.final_pnl_pct ? Number(row.final_pnl_pct) : null,
        status: row.status as "ACTIVE" | "COMPLETED",
        created_at: row.created_at,
      });
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

    if (!cohort_date || !Array.isArray(entries) || entries.length === 0) {
      return NextResponse.json(
        { error: "cohort_date and entries array required." },
        { status: 400 }
      );
    }

    // Validate entries
    for (const entry of entries) {
      if (!entry.symbol || !entry.direction || entry.entry_price === undefined) {
        return NextResponse.json(
          { error: "Each entry needs symbol, direction, and entry_price." },
          { status: 400 }
        );
      }
    }

    // Insert entries
    const insertedIds: number[] = [];
    for (const entry of entries) {
      const [result] = await pool.execute<mysql.ResultSetHeader>(
        `INSERT INTO reversal_entries (cohort_date, symbol, direction, day_change_pct, entry_price, status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')
         ON DUPLICATE KEY UPDATE
           direction = VALUES(direction),
           day_change_pct = VALUES(day_change_pct),
           entry_price = VALUES(entry_price)`,
        [
          cohort_date,
          entry.symbol.toUpperCase(),
          entry.direction,
          entry.day_change_pct || 0,
          entry.entry_price,
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
