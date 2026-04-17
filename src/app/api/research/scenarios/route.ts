import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/migrations";
import { getPool, mysql } from "@/lib/db";

/** GET /api/research/scenarios — list all saved scenarios. */
export async function GET() {
  try {
    await ensureSchema();
    const pool = await getPool();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id, name, description, filters_json, trade_json, costs_json, last_result_summary_json, updated_at FROM paper_scenarios ORDER BY updated_at DESC"
    );
    const scenarios = rows.map(r => ({
      id: Number(r.id),
      name: String(r.name),
      description: r.description as string | null,
      filters: JSON.parse(String(r.filters_json)),
      trade: JSON.parse(String(r.trade_json)),
      costs: JSON.parse(String(r.costs_json)),
      lastResultSummary: r.last_result_summary_json ? JSON.parse(String(r.last_result_summary_json)) : null,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    }));
    return NextResponse.json({ scenarios });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** POST /api/research/scenarios — create OR update (upsert by name) a saved scenario. */
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = await req.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 128) {
      return NextResponse.json({ error: "name required, max 128 chars" }, { status: 400 });
    }
    if (!body.filters || !body.trade || !body.costs) {
      return NextResponse.json({ error: "filters, trade, costs required" }, { status: 400 });
    }

    const pool = await getPool();
    // Upsert by name — simpler UX than separate create/update.
    await pool.execute(
      `INSERT INTO paper_scenarios (name, description, filters_json, trade_json, costs_json, last_result_summary_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         description = VALUES(description),
         filters_json = VALUES(filters_json),
         trade_json = VALUES(trade_json),
         costs_json = VALUES(costs_json),
         last_result_summary_json = VALUES(last_result_summary_json)`,
      [
        name,
        body.description ?? null,
        JSON.stringify(body.filters),
        JSON.stringify(body.trade),
        JSON.stringify(body.costs),
        body.lastResultSummary ? JSON.stringify(body.lastResultSummary) : null,
      ]
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
