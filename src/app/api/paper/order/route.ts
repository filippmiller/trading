import { NextResponse } from "next/server";
import { getPool, mysql } from "@/lib/db";
import { ensureSchema } from "@/lib/migrations";
import {
  fetchLivePrice,
  resolveAccount,
  AccountNotFoundError,
  SYMBOL_RE,
} from "@/lib/paper";
import {
  fillOrder,
  reserveCashForOrder,
  reserveShortMarginForOrder,
  cancelOrderWithRefund,
  modifyPendingOrder,
} from "@/lib/paper-fill";
import { isSymbolTradable } from "@/lib/paper-risk";

/**
 * W5 idempotency key validation. Accepts UUID-like tokens, base32, or
 * anything crypto-random the client generates. Bounded 8..64 chars and a
 * conservative charset to avoid any accidental SQL / encoding edge cases
 * (the column is already VARCHAR(64) with a UNIQUE index, but we validate
 * at the boundary too so a malformed client can never pollute the index).
 */
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

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

  /**
   * W5 — client-generated idempotency key. If the same id is submitted twice
   * (Buy button mashed twice, network retry, etc) the second POST returns
   * the original order row instead of inserting a duplicate. See the
   * UNIQUE INDEX `idx_paper_orders_client_request_id` — errno 1062 on the
   * INSERT triggers the dedup-lookup branch.
   */
  client_request_id?: string;
};

/**
 * W5 — alias for the mysql pool type so helper funcs can receive it without
 * pulling `Pool` from the deep mysql2 typings. `Awaited<ReturnType<...>>` is
 * the canonical way to pick the pool instance type out of an async getter.
 */
type PoolType = Awaited<ReturnType<typeof getPool>>;

/**
 * W5 — return the minimal "already-placed" response shape so the client sees
 * the exact same `success: true, order_id: N` it got the first time. Reads
 * enough of the row to mirror the normal POST response including `status`,
 * `filled_price`, `trade_id`.
 *
 * W5 round-2 (Bug #2 fix — Option B): the SELECT runs inside a short
 * transaction with `FOR UPDATE` so that if the original request's
 * `fillOrder` is still in-flight (holds an X-lock on this row), we BLOCK
 * until it commits. This flips the replay from returning stale `PENDING`
 * to returning the final post-fill state (usually `FILLED` for MARKET).
 *
 * Hotfix 2026-04-22 (Bug #2): scoped by `accountId`. Without this, a
 * post-1062 re-SELECT on `client_request_id` alone could fetch a row
 * belonging to ANOTHER account (the pre-check + composite-index migration
 * above closes the insert-time leak, but the re-SELECT's WHERE clause
 * must also scope by account or it re-opens the gap when the caller's
 * id collides with a different account's legacy row).
 *
 * Residual race window (~milliseconds): if the replay's FOR UPDATE SELECT
 * runs BEFORE the original request has begun fillOrder's transaction
 * (i.e. after INSERT but before `conn.beginTransaction()` inside
 * fillOrder), the replay will see PENDING. In practice the window is the
 * time between the INSERT commit and the next line of code; the client's
 * retry must land inside that window. We accept this as the documented
 * best-effort mitigation — the task spec explicitly calls this out.
 */
async function buildIdempotentResponse(
  pool: PoolType,
  orderId: number,
  accountId: number
) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      "SELECT status, filled_price, rejection_reason, trade_id FROM paper_orders WHERE id = ? AND account_id = ? FOR UPDATE",
      [orderId, accountId]
    );
    await conn.commit();
    if (rows.length === 0) {
      return NextResponse.json({ error: "order vanished mid-request" }, { status: 500 });
    }
    const r = rows[0];
    return NextResponse.json({
      success: r.status === "FILLED" || r.status === "PENDING",
      order_id: orderId,
      status: r.status,
      filled_price: r.filled_price != null ? Number(r.filled_price) : null,
      rejection_reason: r.rejection_reason,
      trade_id: r.trade_id,
      idempotent_replay: true,
    });
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

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
    const accountIdParam = new URL(req.url).searchParams.get("account_id");
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
      client_request_id,
    } = body;

    if (!symbol || typeof symbol !== "string") {
      return NextResponse.json({ error: "symbol is required" }, { status: 400 });
    }
    const sym = symbol.toUpperCase();
    if (!SYMBOL_RE.test(sym)) {
      return NextResponse.json({ error: "invalid symbol" }, { status: 400 });
    }
    // W4 — whitelist check. tradable_symbols is seeded from NASDAQ+NYSE
    // listings (see scripts/sync-tradable-symbols.ts). Symbols not in the
    // table are rejected with SYMBOL_NOT_TRADABLE so nonsense tickers never
    // make it past submit. The whitelist enforces equity-only via
    // asset_class='EQUITY'; non-equity symbols (ETFs/crypto/etc) currently
    // fail-closed. Closes a hole where "NONSENSE123" would pass SYMBOL_RE.
    if (!(await isSymbolTradable(sym))) {
      return NextResponse.json({ error: "SYMBOL_NOT_TRADABLE" }, { status: 400 });
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

    // W5 idempotency — validate shape up-front so a malformed client
    // request fails fast (before any DB work). The actual dedup lookup
    // runs AFTER resolveAccount because the pre-check must be scoped by
    // account — see the AND account_id = ? lookup below. Hotfix 2026-04-22
    // (Bug #2): the previous implementation ran this SELECT before we
    // knew which account the caller meant, so Alice's id on account #1
    // would satisfy Bob's pre-check on account #2 → Bob saw Alice's row.
    let clientRequestId: string | null = null;
    if (client_request_id != null) {
      if (typeof client_request_id !== "string" || !CLIENT_REQUEST_ID_RE.test(client_request_id)) {
        return NextResponse.json({
          error: "client_request_id must be 8-64 chars matching [A-Za-z0-9_-]+"
        }, { status: 400 });
      }
      clientRequestId = client_request_id;
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
    let account;
    try {
      account = await resolveAccount(accountIdParam);
    } catch (err) {
      if (err instanceof AccountNotFoundError) {
        return NextResponse.json({ error: "Account not found" }, { status: 404 });
      }
      throw err;
    }

    // Hotfix 2026-04-22 (Bug #2) — account-scoped idempotency pre-check.
    // Must run AFTER resolveAccount so we have `account.id` to scope by.
    // Returning early here avoids any side-effects (price fetch, reservation,
    // insert) on genuine replays. The composite UNIQUE index
    // (account_id, client_request_id) is the final line of defense against
    // TOCTOU races between this SELECT and the INSERT below.
    if (clientRequestId != null) {
      const [existing] = await pool.execute<mysql.RowDataPacket[]>(
        "SELECT id FROM paper_orders WHERE account_id = ? AND client_request_id = ? LIMIT 1",
        [account.id, clientRequestId]
      );
      if (existing.length > 0) {
        return buildIdempotentResponse(pool, Number(existing[0].id), account.id);
      }
    }

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

    // W5 — pass `client_request_id` through on INSERT. The UNIQUE index
    // `idx_paper_orders_client_request_id` enforces dedup at the DB layer;
    // if a concurrent caller raced past our pre-check and inserted the same
    // id first, we catch errno 1062 and return the existing row. That
    // closes the TOCTOU gap between the pre-check and the INSERT.
    let orderId: number;
    try {
      const [result] = await pool.execute<mysql.ResultSetHeader>(
        `INSERT INTO paper_orders
         (account_id, symbol, side, position_side, order_type, investment_usd, limit_price, stop_price,
          trade_id, close_quantity, notes,
          bracket_stop_loss_pct, bracket_take_profit_pct,
          bracket_trailing_pct, bracket_trailing_activates_pct, bracket_time_exit_days,
          client_request_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
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
          // Hotfix Bug #6 (2026-04-21): every bracket pct is gated on
          // `isFinite && > 0` so bad client input (NaN, Infinity, negative,
          // zero) falls through to NULL instead of being stored and silently
          // activating immediately (pnlPct >= -5 is always true for any
          // positive-profit check). `time_exit_days` allows 0 (close today).
          (isOpenLong || isOpenShort) && typeof stop_loss_pct === "number" && Number.isFinite(stop_loss_pct) && stop_loss_pct > 0 ? stop_loss_pct : null,
          (isOpenLong || isOpenShort) && typeof take_profit_pct === "number" && Number.isFinite(take_profit_pct) && take_profit_pct > 0 ? take_profit_pct : null,
          (isOpenLong || isOpenShort) && typeof trailing_stop_pct === "number" && Number.isFinite(trailing_stop_pct) && trailing_stop_pct > 0 ? trailing_stop_pct : null,
          (isOpenLong || isOpenShort) && typeof trailing_activates_at_profit_pct === "number" && Number.isFinite(trailing_activates_at_profit_pct) && trailing_activates_at_profit_pct > 0 ? trailing_activates_at_profit_pct : null,
          (isOpenLong || isOpenShort) && typeof time_exit_days === "number" && Number.isFinite(time_exit_days) && time_exit_days >= 0 ? time_exit_days : null,
          clientRequestId,
        ]
      );
      orderId = result.insertId;
    } catch (err: unknown) {
      // errno 1062 = UNIQUE constraint violation on (account_id,
      // client_request_id) — a TOCTOU race between our pre-check and the
      // INSERT. Return the winning row. Hotfix 2026-04-22 (Bug #2):
      // the re-SELECT MUST scope by account_id too; without it a 1062
      // triggered by a composite collision with a DIFFERENT account's
      // row (shouldn't happen under the composite index, but defense in
      // depth) would return that foreign row.
      if ((err as { errno?: number }).errno === 1062 && clientRequestId) {
        const [existing] = await pool.execute<mysql.RowDataPacket[]>(
          "SELECT id FROM paper_orders WHERE account_id = ? AND client_request_id = ? LIMIT 1",
          [account.id, clientRequestId]
        );
        if (existing.length > 0) return buildIdempotentResponse(pool, Number(existing[0].id), account.id);
      }
      throw err;
    }

    // PENDING reservation logic per (side, position_side):
    //   - LIMIT/STOP BUY + LONG  → reserve from cash
    //   - LIMIT/STOP SELL + SHORT → reserve short margin from cash
    //   - close orders → no reservation
    if (order_type !== "MARKET") {
      if (isOpenLong) {
        const reserved = await reserveCashForOrder(pool, orderId, account.id, investment_usd!);
        if (!reserved) {
          // Hotfix Bug #5 (2026-04-21): atomic rejection with affectedRows
          // check. If a concurrent cron tick transitioned the order before
          // this UPDATE lands (filled, cancelled, or already rejected), the
          // WHERE guard returns 0 rows and we return 409 Conflict with the
          // actual current state rather than a misleading 400.
          const [rejectRes] = await pool.execute<mysql.ResultSetHeader>(
            "UPDATE paper_orders SET status='REJECTED', rejection_reason='Insufficient cash to reserve' WHERE id=? AND status='PENDING'",
            [orderId]
          );
          if (rejectRes.affectedRows !== 1) {
            const [curRows] = await pool.execute<mysql.RowDataPacket[]>(
              "SELECT status, rejection_reason, filled_price, trade_id FROM paper_orders WHERE id = ?",
              [orderId]
            );
            const cur = curRows[0] ?? null;
            return NextResponse.json({
              error: "Order state changed concurrently during reservation",
              order_id: orderId,
              current_status: cur?.status ?? "UNKNOWN",
              rejection_reason: cur?.rejection_reason ?? null,
              filled_price: cur?.filled_price != null ? Number(cur.filled_price) : null,
              trade_id: cur?.trade_id ?? null,
            }, { status: 409 });
          }
          return NextResponse.json({
            error: `Insufficient cash to reserve: need $${investment_usd!.toFixed(2)}`,
          }, { status: 400 });
        }
      } else if (isOpenShort) {
        const reserved = await reserveShortMarginForOrder(pool, orderId, account.id, investment_usd!);
        if (!reserved) {
          // Hotfix Bug #5 (2026-04-21): same atomic rejection guard on SHORT
          // open path.
          const [rejectRes] = await pool.execute<mysql.ResultSetHeader>(
            "UPDATE paper_orders SET status='REJECTED', rejection_reason='Insufficient cash to reserve short margin' WHERE id=? AND status='PENDING'",
            [orderId]
          );
          if (rejectRes.affectedRows !== 1) {
            const [curRows] = await pool.execute<mysql.RowDataPacket[]>(
              "SELECT status, rejection_reason, filled_price, trade_id FROM paper_orders WHERE id = ?",
              [orderId]
            );
            const cur = curRows[0] ?? null;
            return NextResponse.json({
              error: "Order state changed concurrently during reservation",
              order_id: orderId,
              current_status: cur?.status ?? "UNKNOWN",
              rejection_reason: cur?.rejection_reason ?? null,
              filled_price: cur?.filled_price != null ? Number(cur.filled_price) : null,
              trade_id: cur?.trade_id ?? null,
            }, { status: 409 });
          }
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

    // W3 hotfix #3: single atomic transaction for both reservation resize
    // AND price field changes. The old split (adjustReservation then
    // patchPendingOrderPrices) committed the money move before validating
    // the prices, so a bad limit_price left the user with a resized
    // reservation but stale prices.
    if (body.investment_usd != null || body.limit_price != null || body.stop_price != null) {
      const result = await modifyPendingOrder(pool, orderId, {
        limit_price: body.limit_price,
        stop_price: body.stop_price,
        investment_usd: body.investment_usd,
      });
      if (!result.ok) {
        const status = result.reason === "ORDER_NOT_FOUND" ? 404 : 400;
        return NextResponse.json({ error: result.reason }, { status });
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
    // W3 hotfix #2: single atomic transaction combines refund + status flip.
    // The old split (releaseReservationForOrder then UPDATE) let concurrent
    // DELETEs double-refund and let fillPendingOrders observe PENDING with
    // reserved_amount=0 between the two commits.
    const result = await cancelOrderWithRefund(pool, orderId);
    if (!result.cancelled) {
      return NextResponse.json({ error: result.reason ?? "Order not found or not pending" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
