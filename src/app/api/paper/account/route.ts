import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { ensureSchema } from "@/lib/migrations";
import { getDefaultAccount, computeAccountEquity } from "@/lib/paper";

/**
 * GET /api/paper/account
 * Returns current account state (cash, equity, positions value).
 */
export async function GET() {
  try {
    await ensureSchema();
    const account = await getDefaultAccount();
    const equity = await computeAccountEquity(account.id);
    return NextResponse.json({
      id: account.id,
      name: account.name,
      initial_cash: account.initial_cash,
      cash: equity.cash,
      reserved_cash: equity.reserved_cash,
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
 * POST /api/paper/account/reset
 * Reset the account to initial state: delete all trades and orders, restore cash.
 * Body: { initial_cash?: number } — optional new starting balance.
 */
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = await req.json().catch(() => ({}));
    const newInitial = typeof body.initial_cash === "number" && body.initial_cash > 0
      ? body.initial_cash
      : null;

    const pool = await getPool();
    const account = await getDefaultAccount();

    // Clear trades and orders
    await pool.execute("DELETE FROM paper_orders WHERE account_id = ?", [account.id]);
    await pool.execute("DELETE FROM paper_trades WHERE account_id = ?", [account.id]);
    await pool.execute("DELETE FROM paper_equity_snapshots WHERE account_id = ?", [account.id]);

    // Reset cash AND clear reserved_cash — if we don't, a stale reservation
    // from a pre-reset PENDING order would leave the account showing less
    // cash than it should after reset.
    if (newInitial != null) {
      await pool.execute(
        "UPDATE paper_accounts SET initial_cash = ?, cash = ?, reserved_cash = 0 WHERE id = ?",
        [newInitial, newInitial, account.id]
      );
    } else {
      await pool.execute(
        "UPDATE paper_accounts SET cash = initial_cash, reserved_cash = 0 WHERE id = ?",
        [account.id]
      );
    }

    return NextResponse.json({ success: true, message: "Account reset" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
