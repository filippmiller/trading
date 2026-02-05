import { NextResponse } from "next/server";

import { getPool, mysql } from "@/lib/db";
import { MEASUREMENT_FIELDS, MeasurementField } from "@/lib/reversal";

// PATCH - Update a reversal entry (add measurement prices)
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const entryId = parseInt(id, 10);

    if (isNaN(entryId)) {
      return NextResponse.json({ error: "Invalid entry ID." }, { status: 400 });
    }

    const pool = await getPool();
    const body = await req.json();

    // Build update query dynamically based on provided fields
    const updates: string[] = [];
    const values: (number | string | null)[] = [];

    // Handle measurement fields
    for (const field of MEASUREMENT_FIELDS) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(body[field] === null ? null : Number(body[field]));
      }
    }

    // Handle status update
    if (body.status) {
      updates.push("status = ?");
      values.push(body.status);
    }

    // Handle P&L updates
    if (body.final_pnl_usd !== undefined) {
      updates.push("final_pnl_usd = ?");
      values.push(body.final_pnl_usd);
    }
    if (body.final_pnl_pct !== undefined) {
      updates.push("final_pnl_pct = ?");
      values.push(body.final_pnl_pct);
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: "No fields to update." }, { status: 400 });
    }

    values.push(entryId);
    await pool.execute(
      `UPDATE reversal_entries SET ${updates.join(", ")} WHERE id = ?`,
      values
    );

    // Fetch updated entry
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT * FROM reversal_entries WHERE id = ?",
      [entryId]
    );

    if (!rows.length) {
      return NextResponse.json({ error: "Entry not found." }, { status: 404 });
    }

    const row = rows[0];
    const entry = {
      id: row.id,
      cohort_date:
        row.cohort_date instanceof Date
          ? row.cohort_date.toISOString().split("T")[0]
          : String(row.cohort_date),
      symbol: row.symbol,
      direction: row.direction,
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
      status: row.status,
      created_at: row.created_at,
    };

    return NextResponse.json({ entry });
  } catch (error) {
    console.error("reversal PATCH error", error);
    return NextResponse.json({ error: "Failed to update entry." }, { status: 500 });
  }
}

// DELETE - Remove a reversal entry
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const entryId = parseInt(id, 10);

    if (isNaN(entryId)) {
      return NextResponse.json({ error: "Invalid entry ID." }, { status: 400 });
    }

    const pool = await getPool();
    await pool.execute("DELETE FROM reversal_entries WHERE id = ?", [entryId]);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("reversal DELETE error", error);
    return NextResponse.json({ error: "Failed to delete entry." }, { status: 500 });
  }
}
