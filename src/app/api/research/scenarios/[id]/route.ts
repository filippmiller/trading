import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/migrations";
import { getPool, mysql } from "@/lib/db";

/** DELETE /api/research/scenarios/:id — remove a saved scenario. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const { id } = await ctx.params;
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) {
      return NextResponse.json({ error: "invalid id" }, { status: 400 });
    }
    const pool = await getPool();
    const [res] = await pool.execute<mysql.ResultSetHeader>(
      "DELETE FROM paper_scenarios WHERE id = ?", [numId]
    );
    return NextResponse.json({ ok: true, deleted: res.affectedRows });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
