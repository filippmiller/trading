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
} from "@/lib/paper-fill";

type OrderBody = {
  symbol: string;
  side: "BUY" | "SELL";
  order_type?: "MARKET" | "LIMIT" | "STOP";
  investment_usd?: number;
  limit_price?: number;
  stop_price?: number;
  trade_id?: number; // for SELL orders tied to a specific position
  notes?: string;
};

/**
 * POST /api/paper/order
 * Place a new order (BUY or SELL, MARKET / LIMIT / STOP).
 *
 * MARKET orders try to fill immediately at the current live price. If the
 * market is closed (price stale / outside RTH) the order is rejected with
 * `MARKET_CLOSED` before any row is inserted — we don't create phantom
 * PENDING MARKETs that'd execute against a stale close.
 *
 * LIMIT / STOP BUYs reserve `investment_usd` from cash into `reserved_cash`
 * atomically at submit. Cancel/reject releases it. Fill transfers from
 * reserved to the position. This prevents the overdraft race where the UI
 * lets a user queue $10k × 20 LIMIT BUYs on $100k.
 */
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = (await req.json()) as OrderBody;
    const {
      symbol,
      side,
      order_type = "MARKET",
      investment_usd,
      limit_price,
      stop_price,
      trade_id,
      notes,
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
    if (!["MARKET", "LIMIT", "STOP"].includes(order_type)) {
      return NextResponse.json({ error: "order_type must be MARKET, LIMIT, or STOP" }, { status: 400 });
    }
    if (side === "BUY") {
      if (typeof investment_usd !== "number" || !isFinite(investment_usd) || investment_usd <= 0) {
        return NextResponse.json({ error: "investment_usd must be a positive number for BUY" }, { status: 400 });
      }
    }
    if (order_type === "LIMIT" && (typeof limit_price !== "number" || !isFinite(limit_price) || limit_price <= 0)) {
      return NextResponse.json({ error: "limit_price required for LIMIT orders" }, { status: 400 });
    }
    if (order_type === "STOP" && (typeof stop_price !== "number" || !isFinite(stop_price) || stop_price <= 0)) {
      return NextResponse.json({ error: "stop_price required for STOP orders" }, { status: 400 });
    }

    const pool = await getPool();
    const account = await getDefaultAccount();

    // For MARKET SELL we still need to verify an open position exists up-front
    // so a user sees an immediate error instead of a silently-rejected order.
    // Account/symbol match is re-enforced atomically inside fillOrder.
    if (side === "SELL" && order_type === "MARKET") {
      const [tradeRows] = await pool.execute<mysql.RowDataPacket[]>(
        trade_id
          ? "SELECT id FROM paper_trades WHERE id = ? AND account_id = ? AND symbol = ? AND status = 'OPEN'"
          : "SELECT id FROM paper_trades WHERE account_id = ? AND symbol = ? AND status = 'OPEN' ORDER BY id ASC LIMIT 1",
        trade_id ? [trade_id, account.id, sym] : [account.id, sym]
      );
      if (tradeRows.length === 0) {
        return NextResponse.json({ error: "No open position found" }, { status: 400 });
      }
    }

    // For MARKET orders: check live price + RTH BEFORE inserting. We do NOT
    // want a PENDING MARKET row sitting around if the market is closed.
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
       (account_id, symbol, side, order_type, investment_usd, limit_price, stop_price, trade_id, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [
        account.id,
        sym,
        side,
        order_type,
        side === "BUY" ? investment_usd : null,
        limit_price ?? null,
        stop_price ?? null,
        trade_id ?? null,
        notes ?? null,
      ]
    );
    const orderId = result.insertId;

    // For PENDING LIMIT/STOP BUY orders: atomically reserve the cash. If the
    // reservation fails (not enough cash), reject the order so a second caller
    // doesn't wake up a zombie.
    if (side === "BUY" && order_type !== "MARKET") {
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
    }

    // For MARKET: immediately attempt fill at the live price captured above.
    if (order_type === "MARKET" && marketLivePrice != null) {
      const fill = await fillOrder(pool, orderId, marketLivePrice);
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
      });
    }

    return NextResponse.json({
      success: true,
      order_id: orderId,
      status: "PENDING",
      message: `${order_type} ${side} order placed, waiting for trigger`,
    });
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
    // Release reservation BEFORE flipping to CANCELLED — releaseReservationForOrder
    // is idempotent and only releases if reserved_amount > 0.
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
