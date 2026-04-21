import { NextResponse } from "next/server";
import { getPool, mysql } from "@/lib/db";
import { ensureSchema } from "@/lib/migrations";
import {
  fetchLivePrice,
  getDefaultAccount,
  SYMBOL_RE,
} from "@/lib/paper";
import {
  fillOrder,
  releaseReservationForOrder,
  reserveCashForOrder,
  reserveShortMarginForOrder,
  adjustReservation,
  patchPendingOrderPrices,
} from "@/lib/paper-fill";

type OrderBody = {
  symbol: string;
  side: "BUY" | "SELL";
  /** W3: LONG (default) or SHORT. Combined with `side` to discriminate:
   *   side=BUY  + position_side=LONG  → open long (existing)
   *   side=SELL + position_side=LONG  → close long (existing; supports close_quantity)
   *   side=SELL + position_side=SHORT → open short
   *   side=BUY  + position_side=SHORT → cover short (supports close_quantity)
   */
  position_side?: "LONG" | "SHORT";
  order_type?: "MARKET" | "LIMIT" | "STOP";
  investment_usd?: number;
  limit_price?: number;
  stop_price?: number;
  trade_id?: number; // for close orders tied to a specific position
  close_quantity?: number; // W3: partial-close quantity (SELL long / BUY-to-cover short)
  notes?: string;

  // W3: optional exit-bracket fields for OPEN orders. Persisted on the
  // paper_trades row at fill time (absolute prices computed from fill price).
  stop_loss_pct?: number;
  take_profit_pct?: number;
  trailing_stop_pct?: number;
  trailing_activates_at_profit_pct?: number;
  time_exit_days?: number;
};

/**
 * POST /api/paper/order
 * Place a new order.
 *
 * W3: supports SHORT side and partial close. The (side, position_side)
 * cross-product determines the action. Open orders (BUY+LONG, SELL+SHORT)
 * take an `investment_usd`; close orders (SELL+LONG, BUY+SHORT) take an
 * optional `close_quantity` and reference a `trade_id`.
 */
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = (await req.json()) as OrderBody;
    const {
      symbol,
      side,
      position_side = "LONG",
      order_type = "MARKET",
      investment_usd,
      limit_price,
      stop_price,
      trade_id,
      close_quantity,
      notes,
      stop_loss_pct,
      take_profit_pct,
      trailing_stop_pct,
      trailing_activates_at_profit_pct,
      time_exit_days,
    } = body;

    if (!symbol || typeof symbol !== "string") {
      return NextResponse.json({ error: "symbol is required" }, { status: 400 });
    }
    const sym = symbol.toUpperCase();
    if (!SYMBOL_RE.test(sym)) {
      return NextResponse.json({ error: "invalid symbol" }, { status: 400 });
    }
    if (side !== "BUY" && side !== "SELL") {
      return NextResponse.json({ error: "side must be BUY or SELL" }, { status: 400 });
    }
    if (position_side !== "LONG" && position_side !== "SHORT") {
      return NextResponse.json({ error: "position_side must be LONG or SHORT" }, { status: 400 });
    }
    if (!["MARKET", "LIMIT", "STOP"].includes(order_type)) {
      return NextResponse.json({ error: "order_type must be MARKET, LIMIT, or STOP" }, { status: 400 });
    }

    // Classify the action via (side, position_side).
    const isOpenLong   = side === "BUY"  && position_side === "LONG";
    const isOpenShort  = side === "SELL" && position_side === "SHORT";
    const isCloseLong  = side === "SELL" && position_side === "LONG";
    const isCoverShort = side === "BUY"  && position_side === "SHORT";

    // Investment is required for open orders; close orders don't use it.
    if (isOpenLong || isOpenShort) {
      if (typeof investment_usd !== "number" || !isFinite(investment_usd) || investment_usd <= 0) {
        return NextResponse.json({ error: "investment_usd must be a positive number for open orders" }, { status: 400 });
      }
    }
    if (order_type === "LIMIT" && (typeof limit_price !== "number" || !isFinite(limit_price) || limit_price <= 0)) {
      return NextResponse.json({ error: "limit_price required for LIMIT orders" }, { status: 400 });
    }
    if (order_type === "STOP" && (typeof stop_price !== "number" || !isFinite(stop_price) || stop_price <= 0)) {
      return NextResponse.json({ error: "stop_price required for STOP orders" }, { status: 400 });
    }
    if (close_quantity != null && (!isFinite(close_quantity) || close_quantity <= 0)) {
      return NextResponse.json({ error: "close_quantity must be a positive number" }, { status: 400 });
    }

    const pool = await getPool();
    const account = await getDefaultAccount();

    // For MARKET close: verify an open position of the correct side exists
    // up-front so the user sees an immediate error. Account/side match is
    // re-enforced atomically inside fillOrder.
    if ((isCloseLong || isCoverShort) && order_type === "MARKET") {
      const expectedSide = isCloseLong ? "LONG" : "SHORT";
      const [tradeRows] = await pool.execute<mysql.RowDataPacket[]>(
        trade_id
          ? "SELECT id, quantity, closed_quantity FROM paper_trades WHERE id = ? AND account_id = ? AND symbol = ? AND side = ? AND status = 'OPEN'"
          : "SELECT id, quantity, closed_quantity FROM paper_trades WHERE account_id = ? AND symbol = ? AND side = ? AND status = 'OPEN' ORDER BY id ASC LIMIT 1",
        trade_id ? [trade_id, account.id, sym, expectedSide] : [account.id, sym, expectedSide]
      );
      if (tradeRows.length === 0) {
        return NextResponse.json({ error: "No open position found" }, { status: 400 });
      }
      // Guard close_quantity against the remaining amount.
      if (close_quantity != null) {
        const t = tradeRows[0];
        const remaining = Number(t.quantity) - Number(t.closed_quantity ?? 0);
        if (close_quantity > remaining + 1e-9) {
          return NextResponse.json({ error: `close_quantity (${close_quantity}) exceeds remaining (${remaining})` }, { status: 400 });
        }
      }
    }

    // For MARKET orders: check live price + RTH BEFORE inserting.
    let marketLivePrice: number | null = null;
    if (order_type === "MARKET") {
      const quote = await fetchLivePrice(sym);
      if (!quote) {
        return NextResponse.json({ error: "Could not fetch live price for symbol" }, { status: 502 });
      }
      if (!quote.isLive) {
        return NextResponse.json({
          error: "MARKET_CLOSED: regular trading hours required for MARKET orders. Use a LIMIT order to queue.",
          asOf: quote.asOf.toISOString(),
        }, { status: 409 });
      }
      marketLivePrice = quote.price;
    }

    const [result] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO paper_orders
       (account_id, symbol, side, position_side, order_type, investment_usd, limit_price, stop_price,
        trade_id, close_quantity, notes,
        bracket_stop_loss_pct, bracket_take_profit_pct,
        bracket_trailing_pct, bracket_trailing_activates_pct, bracket_time_exit_days,
        status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [
        account.id,
        sym,
        side,
        position_side,
        order_type,
        (isOpenLong || isOpenShort) ? investment_usd : null,
        limit_price ?? null,
        stop_price ?? null,
        trade_id ?? null,
        close_quantity ?? null,
        notes ?? null,
        (isOpenLong || isOpenShort) && stop_loss_pct != null && stop_loss_pct > 0 ? stop_loss_pct : null,
        (isOpenLong || isOpenShort) && take_profit_pct != null && take_profit_pct > 0 ? take_profit_pct : null,
        (isOpenLong || isOpenShort) && trailing_stop_pct != null && trailing_stop_pct > 0 ? trailing_stop_pct : null,
        (isOpenLong || isOpenShort) && trailing_activates_at_profit_pct != null ? trailing_activates_at_profit_pct : null,
        (isOpenLong || isOpenShort) && time_exit_days != null && time_exit_days >= 0 ? time_exit_days : null,
      ]
    );
    const orderId = result.insertId;

    // PENDING reservation logic per (side, position_side):
    //   - LIMIT/STOP BUY + LONG  → reserve from cash
    //   - LIMIT/STOP SELL + SHORT → reserve short margin from cash
    //   - close orders → no reservation
    if (order_type !== "MARKET") {
      if (isOpenLong) {
        const reserved = await reserveCashForOrder(pool, orderId, account.id, investment_usd!);
        if (!reserved) {
          await pool.execute(
            "UPDATE paper_orders SET status='REJECTED', rejection_reason='Insufficient cash to reserve' WHERE id=? AND status='PENDING'",
            [orderId]
          );
          return NextResponse.json({
            error: `Insufficient cash to reserve: need $${investment_usd!.toFixed(2)}`,
          }, { status: 400 });
        }
      } else if (isOpenShort) {
        const reserved = await reserveShortMarginForOrder(pool, orderId, account.id, investment_usd!);
        if (!reserved) {
          await pool.execute(
            "UPDATE paper_orders SET status='REJECTED', rejection_reason='Insufficient cash to reserve short margin' WHERE id=? AND status='PENDING'",
            [orderId]
          );
          return NextResponse.json({
            error: `Insufficient cash for short margin: need $${investment_usd!.toFixed(2)}`,
          }, { status: 400 });
        }
      }
    }

    // For MARKET: immediately attempt fill at the live price captured above.
    if (order_type === "MARKET" && marketLivePrice != null) {
      const fill = await fillOrder(pool, orderId, marketLivePrice, {
        strategyId: null,
        strategyLabel: `MANUAL ${side}`,
        fillRationale: "MANUAL",
      });
      const [orderRows] = await pool.execute<mysql.RowDataPacket[]>(
        "SELECT status, filled_price, rejection_reason, trade_id FROM paper_orders WHERE id = ?",
        [orderId]
      );
      const order = orderRows[0];
      if (!fill.filled) {
        return NextResponse.json({
          success: false,
          order_id: orderId,
          status: order.status,
          rejection_reason: order.rejection_reason ?? fill.rejection,
          error: fill.rejection,
        }, { status: 400 });
      }
      return NextResponse.json({
        success: true,
        order_id: orderId,
        status: order.status,
        filled_price: order.filled_price != null ? Number(order.filled_price) : null,
        rejection_reason: order.rejection_reason,
        trade_id: order.trade_id,
        position_side: fill.positionSide,
        remaining_quantity: fill.remainingQuantity,
      });
    }

    return NextResponse.json({
      success: true,
      order_id: orderId,
      status: "PENDING",
      message: `${order_type} ${side} ${position_side} order placed, waiting for trigger`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * PATCH /api/paper/order?id=123
 * Modify a PENDING order. W3 — supports:
 *   - limit_price (new limit)
 *   - stop_price (new stop)
 *   - investment_usd (re-sizes the reservation atomically via adjustReservation)
 * Rejects with 400 if the order is not PENDING.
 */
export async function PATCH(req: Request) {
  try {
    await ensureSchema();
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id || !/^\d+$/.test(id)) {
      return NextResponse.json({ error: "valid numeric id required" }, { status: 400 });
    }
    const orderId = Number(id);
    const body = (await req.json()) as {
      limit_price?: number;
      stop_price?: number;
      investment_usd?: number;
    };
    const pool = await getPool();

    // If investment_usd is supplied, re-size the reservation first. This
    // runs in its own atomic transaction so failure to cover the delta
    // rejects cleanly without touching the price fields.
    if (body.investment_usd != null) {
      const adj = await adjustReservation(pool, orderId, body.investment_usd);
      if (!adj.ok) {
        return NextResponse.json({ error: adj.reason }, { status: 400 });
      }
    }

    // Then apply price patches (separate UPDATE — no reservation math).
    if (body.limit_price != null || body.stop_price != null) {
      const priceResult = await patchPendingOrderPrices(pool, orderId, {
        limit_price: body.limit_price,
        stop_price: body.stop_price,
      });
      if (!priceResult.ok) {
        return NextResponse.json({ error: priceResult.reason }, { status: 400 });
      }
    }

    const [orderRows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id, status, limit_price, stop_price, investment_usd, reserved_amount, reserved_short_margin FROM paper_orders WHERE id = ?",
      [orderId]
    );
    if (orderRows.length === 0) {
      return NextResponse.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({ success: true, order: orderRows[0] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * DELETE /api/paper/order?id=123
 * Cancel a pending order. Releases any cash reservation back to the account.
 */
export async function DELETE(req: Request) {
  try {
    await ensureSchema();
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id || !/^\d+$/.test(id)) {
      return NextResponse.json({ error: "valid numeric id required" }, { status: 400 });
    }

    const pool = await getPool();
    const orderId = Number(id);
    await releaseReservationForOrder(pool, orderId);
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      "UPDATE paper_orders SET status = 'CANCELLED' WHERE id = ? AND status = 'PENDING'",
      [orderId]
    );
    if (result.affectedRows === 0) {
      return NextResponse.json({ error: "Order not found or not pending" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
