import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { ensureSchema } from "@/lib/migrations";
import { resolveAccount, computeAccountEquity, AccountNotFoundError } from "@/lib/paper";

/**
 * GET /api/paper/account
 * Returns current account state (cash, equity, positions value).
 *
 * W5 — supports `?account_id=<n>` to target a specific account. Falls back
 * to Default when the param is absent (backward compat).
 */
export async function GET(req: Request) {
  try {
    await ensureSchema();
    const accountIdParam = new URL(req.url).searchParams.get("account_id");
    let account;
    try {
      account = await resolveAccount(accountIdParam);
    } catch (err) {
      if (err instanceof AccountNotFoundError) {
        return NextResponse.json({ error: "Account not found" }, { status: 404 });
      }
      throw err;
    }
    const equity = await computeAccountEquity(account.id);
    return NextResponse.json({
      id: account.id,
      name: account.name,
      initial_cash: account.initial_cash,
      cash: equity.cash,
      reserved_cash: equity.reserved_cash,
      reserved_short_margin: equity.reserved_short_margin,
      positions_value: equity.positions_value,
      equity: equity.equity,
      open_positions: equity.open_positions,
      stale_positions: equity.stale_positions,
      total_return_pct: account.initial_cash > 0
        ? ((equity.equity - account.initial_cash) / account.initial_cash) * 100
        : 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * POST /api/paper/account
 * Reset the account to initial state: delete all trades and orders, restore
 * cash, clear reservations.
 *
 * W5 — supports `?account_id=<n>`. Reset is SCOPED to the targeted account
 * only; other accounts are untouched. Body: `{ initial_cash?: number }` —
 * optional new starting balance.
 */
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const accountIdParam = new URL(req.url).searchParams.get("account_id");
    const body = await req.json().catch(() => ({}));
    const newInitial = typeof body.initial_cash === "number" && body.initial_cash > 0
      ? body.initial_cash
      : null;

    const pool = await getPool();
    let account;
    try {
      account = await resolveAccount(accountIdParam);
    } catch (err) {
      if (err instanceof AccountNotFoundError) {
        // Critical: reset on a stale/deleted account_id MUST NOT silently
        // fall through to Default. Returning 404 here is what prevents the
        // "wiped Default" data-loss scenario.
        return NextResponse.json({ error: "Account not found" }, { status: 404 });
      }
      throw err;
    }

    // Clear trades and orders SCOPED to the targeted account — W5 acceptance:
    // resetting "Alt1" must leave Default's data untouched.
    await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [account.id]);
    await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [account.id]);
    await pool.execute("DELETE FROM paper_equity_snapshots WHERE account_id = ?", [account.id]);

    // Reset cash AND clear reserved_cash + reserved_short_margin. A stale
    // reservation from a pre-reset PENDING order (deleted above) would
    // otherwise leave the account showing less cash than it should after reset.
    if (newInitial != null) {
      await pool.execute(
        "UPDATE paper_accounts SET initial_cash = ?, cash = ?, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?",
        [newInitial, newInitial, account.id]
      );
    } else {
      await pool.execute(
        "UPDATE paper_accounts SET cash = initial_cash, reserved_cash = 0, reserved_short_margin = 0 WHERE id = ?",
        [account.id]
      );
    }

    return NextResponse.json({ success: true, message: `Account '${account.name}' reset`, account_id: account.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
