import { NextResponse } from "next/server";
import { getPool, mysql } from "@/lib/db";
import { ensureSchema } from "@/lib/migrations";
import {
  fetchLivePrice,
  getDefaultAccount,
  SYMBOL_RE,
  fillPendingOrders,
} from "@/lib/paper";

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
 * Market orders fill immediately at current price.
 * Limit/Stop orders go into PENDING state and get filled by fillPendingOrders()
 * on every GET /api/paper (or via a future cron).
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

    // Validation
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
      if (typeof investment_usd !== "number" || investment_usd <= 0) {
        return NextResponse.json({ error: "investment_usd must be a positive number for BUY" }, { status: 400 });
      }
    }
    if (order_type === "LIMIT" && (typeof limit_price !== "number" || limit_price <= 0)) {
      return NextResponse.json({ error: "limit_price required for LIMIT orders" }, { status: 400 });
    }
    if (order_type === "STOP" && (typeof stop_price !== "number" || stop_price <= 0)) {
      return NextResponse.json({ error: "stop_price required for STOP orders" }, { status: 400 });
    }

    const pool = await getPool();
    const account = await getDefaultAccount();

    // For MARKET BUY: pre-check cash
    if (side === "BUY" && order_type === "MARKET") {
      if (account.cash < investment_usd!) {
        return NextResponse.json({
          error: `Insufficient cash: have $${account.cash.toFixed(2)}, need $${investment_usd!.toFixed(2)}`,
        }, { status: 400 });
      }
    }

    // For MARKET SELL: need an open position
    if (side === "SELL" && order_type === "MARKET") {
      const [tradeRows] = await pool.execute<mysql.RowDataPacket[]>(
        trade_id
          ? "SELECT id FROM paper_trades WHERE id = ? AND status = 'OPEN'"
          : "SELECT id FROM paper_trades WHERE account_id = ? AND symbol = ? AND status = 'OPEN' ORDER BY id ASC LIMIT 1",
        trade_id ? [trade_id] : [account.id, sym]
      );
      if (tradeRows.length === 0) {
        return NextResponse.json({ error: "No open position found" }, { status: 400 });
      }
    }

    // Insert order
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

    // For MARKET orders, fill immediately
    if (order_type === "MARKET") {
      const livePrice = await fetchLivePrice(sym);
      if (livePrice == null) {
        await pool.execute(
          "UPDATE paper_orders SET status='REJECTED', rejection_reason='Could not fetch live price' WHERE id=?",
          [result.insertId]
        );
        return NextResponse.json({ error: "Could not fetch live price for symbol" }, { status: 502 });
      }
      await fillPendingOrders();

      // Return the filled order + trade details
      const [orderRows] = await pool.execute<mysql.RowDataPacket[]>(
        "SELECT * FROM paper_orders WHERE id = ?",
        [result.insertId]
      );
      const order = orderRows[0];
      return NextResponse.json({
        success: true,
        order_id: result.insertId,
        status: order.status,
        filled_price: order.filled_price ? Number(order.filled_price) : null,
        rejection_reason: order.rejection_reason,
        trade_id: order.trade_id,
      });
    }

    // LIMIT/STOP orders: return PENDING
    return NextResponse.json({
      success: true,
      order_id: result.insertId,
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
 * Cancel a pending order.
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
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      "UPDATE paper_orders SET status = 'CANCELLED' WHERE id = ? AND status = 'PENDING'",
      [Number(id)]
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
