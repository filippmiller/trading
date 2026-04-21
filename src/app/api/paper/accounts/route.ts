import { NextResponse } from "next/server";
import { getPool, mysql } from "@/lib/db";
import { ensureSchema } from "@/lib/migrations";
import { listPaperAccounts } from "@/lib/paper";

/**
 * GET /api/paper/accounts
 * W5 — list every paper account with basic metadata. Used by the
 * account-switcher dropdown at the top of /paper. Cash/equity is deliberately
 * not live-computed here — the UI hits /api/paper with ?account_id=<id> for
 * the selected account's live KPIs.
 */
export async function GET() {
  try {
    await ensureSchema();
    const accounts = await listPaperAccounts();
    return NextResponse.json({
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        initial_cash: a.initial_cash,
        cash: a.cash,
        reserved_cash: a.reserved_cash,
        reserved_short_margin: a.reserved_short_margin,
        created_at: a.created_at,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * POST /api/paper/accounts
 * W5 — create a new paper account. Body: { name: string, initial_cash: number }.
 * Enforces:
 *   - name non-empty, trimmed, max 64 chars
 *   - initial_cash > 0 (and finite)
 *   - unique name (UNIQUE KEY UX_paper_account_name already on table)
 * Returns 409 with a specific error code on name collision so the UI toast
 * can surface "Account name already exists" rather than a generic 500.
 */
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = await req.json().catch(() => ({})) as { name?: unknown; initial_cash?: unknown };
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    const initialCash = typeof body.initial_cash === "number" ? body.initial_cash : Number(body.initial_cash);

    if (!rawName) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (rawName.length > 64) {
      return NextResponse.json({ error: "name must be 64 characters or fewer" }, { status: 400 });
    }
    if (!Number.isFinite(initialCash) || initialCash <= 0) {
      return NextResponse.json({ error: "initial_cash must be a positive finite number" }, { status: 400 });
    }

    const pool = await getPool();
    try {
      const [result] = await pool.execute<mysql.ResultSetHeader>(
        "INSERT INTO paper_accounts (name, initial_cash, cash, reserved_cash, reserved_short_margin) VALUES (?, ?, ?, 0, 0)",
        [rawName, initialCash, initialCash]
      );
      return NextResponse.json({
        success: true,
        account: {
          id: result.insertId,
          name: rawName,
          initial_cash: initialCash,
          cash: initialCash,
          reserved_cash: 0,
          reserved_short_margin: 0,
        },
      });
    } catch (err: unknown) {
      // errno 1062 = UNIQUE constraint on UX_paper_account_name.
      if ((err as { errno?: number }).errno === 1062) {
        return NextResponse.json(
          { error: "DUPLICATE_ACCOUNT_NAME", message: `Account name '${rawName}' already exists` },
          { status: 409 }
        );
      }
      throw err;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
