import { NextResponse } from "next/server";
import { z } from "zod";

import { getPool, mysql } from "@/lib/db";
import { ensureSchema } from "@/lib/migrations";
import {
  resolveAccount,
  AccountNotFoundError,
  SYMBOL_RE,
} from "@/lib/paper";
import { fillOrder } from "@/lib/paper-fill";
import { isSymbolTradable, WhitelistLookupError } from "@/lib/paper-risk";

/**
 * POST /api/paper/batch-order?account_id=N
 *
 * Paper-fill N tickers at once at caller-supplied prices. Unlike
 * /api/paper/order this endpoint DELIBERATELY skips the RTH gate and the
 * live-price fetch: the feature exists to let the user "paper-fill at
 * yesterday's matrix close" even when the market is shut. Each row's
 * `fill_price` is taken as the canonical execution price; slippage applies
 * on top per the risk config (same helper path as a regular MARKET fill).
 *
 * Semantics:
 *  - `side: LONG`  → open long  (internally BUY + position_side=LONG)
 *  - `side: SHORT` → open short (internally SELL + position_side=SHORT)
 *  - `qty` is integer (matches `allow_fractional_shares=false` default).
 *    Users who want fractional can flip the setting and submit qty=0.5;
 *    the DB column is DECIMAL so it persists.
 *  - `fill_price` is the price the user wants to pretend they filled at —
 *    typically `entry_price` from the matrix, i.e. the previous day's close.
 *  - `stop_loss_pct` / `take_profit_pct` / `trailing_stop_pct` are optional
 *    bracket values in PERCENT (1 = 1%, not 0.01). Engine stores them as
 *    `bracket_*_pct` columns on paper_orders; `applyExitDecisionToTrade`
 *    evaluates them against future bars.
 *
 * Partial-success semantics: the endpoint processes each row independently
 * and returns per-row {filled | rejected | error}. A single bad row does
 * NOT abort the batch. The summary object gives totals. Clients should
 * surface failures per-row instead of "all or nothing".
 */

export const BatchOrderItemSchema = z.object({
  symbol: z.string().transform((s) => s.toUpperCase()).refine((s) => SYMBOL_RE.test(s), {
    message: "invalid symbol — must match [A-Z]{1,5}(\\.[A-Z])?",
  }),
  side: z.enum(["LONG", "SHORT"]),
  // Integer quantity at the API boundary; if fractional shares are enabled
  // in risk config the client can submit a fractional `qty` and the DB will
  // store it as DECIMAL. Keeping the API bound at 1..100000 blocks both
  // zero/negative and absurd (billion-share) typos.
  qty: z.number().positive().max(100000),
  fill_price: z.number().positive().max(100000),
  // Brackets in PERCENT (1 = 1%). Upper bounds chosen to reject clearly-wrong
  // input (a 99% stop or 500% trail is not a real strategy). See the risk
  // validation hotfix in PR #36 — same philosophy: pick upper bounds that
  // leave headroom for illiquid edges but reject typos.
  stop_loss_pct: z.number().min(0.1).max(50).optional(),
  take_profit_pct: z.number().min(0.1).max(100).optional(),
  trailing_stop_pct: z.number().min(0.1).max(20).optional(),
});

export const BatchOrderSchema = z.object({
  // Max 50 per batch keeps the endpoint predictable under DB-lock pressure
  // and bounds the per-request compute. A determined user can send two
  // batches back-to-back — the limit is UX insurance, not a security gate.
  orders: z.array(BatchOrderItemSchema).min(1).max(50),
});

export type BatchOrderItem = z.infer<typeof BatchOrderItemSchema>;
export type BatchOrderPayload = z.infer<typeof BatchOrderSchema>;

type PerRowResult =
  | { symbol: string; status: "filled"; order_id: number; trade_id: number; fill_price: number; quantity: number }
  | { symbol: string; status: "rejected"; reason: string }
  | { symbol: string; status: "error"; reason: string };

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const accountIdParam = new URL(req.url).searchParams.get("account_id");

    let parsedBody: BatchOrderPayload;
    try {
      const raw = await req.json();
      const parsed = BatchOrderSchema.safeParse(raw);
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Invalid payload", issues: parsed.error.issues },
          { status: 400 },
        );
      }
      parsedBody = parsed.data;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const pool = await getPool();
    let account;
    try {
      account = await resolveAccount(accountIdParam);
    } catch (err) {
      if (err instanceof AccountNotFoundError) {
        return NextResponse.json({ error: "Account not found" }, { status: 404 });
      }
      throw err;
    }

    const results: PerRowResult[] = [];

    for (const item of parsedBody.orders) {
      const symbol = item.symbol;

      // Whitelist check per ticker. Whitelist-unavailable is recorded as
      // "error" (DB/cold-start issue, retryable) to distinguish from a
      // genuine "not tradable" rejection.
      try {
        if (!(await isSymbolTradable(symbol))) {
          results.push({ symbol, status: "rejected", reason: "SYMBOL_NOT_TRADABLE" });
          continue;
        }
      } catch (err) {
        if (err instanceof WhitelistLookupError) {
          results.push({ symbol, status: "error", reason: "WHITELIST_UNAVAILABLE" });
          continue;
        }
        throw err;
      }

      // LONG → BUY+LONG (open long). SHORT → SELL+SHORT (open short).
      const side: "BUY" | "SELL" = item.side === "LONG" ? "BUY" : "SELL";
      const positionSide: "LONG" | "SHORT" = item.side;
      const investmentUsd = Number((item.qty * item.fill_price).toFixed(4));

      let orderId: number;
      try {
        const [ins] = await pool.execute<mysql.ResultSetHeader>(
          `INSERT INTO paper_orders
           (account_id, symbol, side, position_side, order_type,
            investment_usd, limit_price, stop_price, trade_id, close_quantity, notes,
            bracket_stop_loss_pct, bracket_take_profit_pct, bracket_trailing_pct,
            bracket_trailing_activates_pct, bracket_time_exit_days,
            client_request_id, status)
           VALUES (?, ?, ?, ?, 'MARKET', ?, NULL, NULL, NULL, NULL, 'BATCH', ?, ?, ?, NULL, NULL, NULL, 'PENDING')`,
          [
            account.id,
            symbol,
            side,
            positionSide,
            investmentUsd,
            item.stop_loss_pct ?? null,
            item.take_profit_pct ?? null,
            item.trailing_stop_pct ?? null,
          ],
        );
        orderId = ins.insertId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ symbol, status: "error", reason: `INSERT failed: ${msg.slice(0, 200)}` });
        continue;
      }

      try {
        const fill = await fillOrder(pool, orderId, item.fill_price, {
          strategyId: null,
          strategyLabel: `BATCH ${item.side}`,
          fillRationale: "MANUAL",
        });
        if (fill.filled) {
          results.push({
            symbol,
            status: "filled",
            order_id: orderId,
            trade_id: fill.tradeId,
            fill_price: fill.fillPrice,
            quantity: fill.quantity,
          });
        } else {
          results.push({ symbol, status: "rejected", reason: fill.rejection });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ symbol, status: "error", reason: `fill error: ${msg.slice(0, 200)}` });
      }
    }

    const summary = {
      total: results.length,
      filled: results.filter((r) => r.status === "filled").length,
      rejected: results.filter((r) => r.status === "rejected").length,
      errored: results.filter((r) => r.status === "error").length,
    };

    return NextResponse.json({ summary, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
