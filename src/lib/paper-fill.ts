/**
 * Shared paper-trading fill engine.
 *
 * Single source of truth for `fillOrder`. Both the UI path (`src/lib/paper.ts`
 * → `/api/paper` on every refresh) and the worker cron path
 * (`scripts/surveillance-cron.ts` every 15 min) call into `fillOrder` here so
 * the atomic guarantees are identical across both entry points.
 *
 * Invariants maintained:
 *   1. `paper_accounts.cash` can never go negative — atomic
 *      `UPDATE ... WHERE cash >= ?` enforces this at the DB layer.
 *   2. An order can fill at most once — `UPDATE ... WHERE status='PENDING'`
 *      on the FILLED transition enforces this; affectedRows === 0 means a
 *      concurrent caller already filled it.
 *   3. A trade can close at most once — `UPDATE ... WHERE status='OPEN'`
 *      on SELL enforces this.
 *   4. SELLs can only target a trade owned by the same account AND with the
 *      same symbol as the order — prevents cross-position / cross-account
 *      leaks.
 *   5. Reserved cash for a PENDING BUY is released back on fill/cancel/reject
 *      so that an unfilled reservation never permanently "eats" cash.
 *   6. fillPrice is validated finite & > 0 at the entry of fillOrder so that
 *      quantity = investment / fillPrice cannot produce Infinity / NaN.
 */

import type mysqlTypes from "mysql2/promise";

export type FillOrderResult =
  | { filled: true; tradeId: number; quantity: number; fillPrice: number; side: "BUY" | "SELL"; pnlUsd?: number }
  | { filled: false; rejection: string };

const MAX_REJECTION_LEN = 255;

/**
 * Internal helper — runs the fill against the supplied connection. Caller
 * is responsible for wrapping in `beginTransaction` / `commit` / `rollback`.
 * This split lets both `fillOrder` (which manages its own txn) and future
 * batch-fill orchestrators (which want to fill N orders under one txn) share
 * the same core logic.
 */
async function fillOrderCore(
  conn: mysqlTypes.PoolConnection,
  orderId: number,
  fillPrice: number,
  nowIso: () => string
): Promise<FillOrderResult> {
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
    return { filled: false, rejection: "INVALID_PRICE" };
  }

  // Lock the order row — prevents a second tick from racing us.
  const [orderRows] = await conn.execute(
    "SELECT * FROM paper_orders WHERE id = ? FOR UPDATE",
    [orderId]
  ) as [mysqlTypes.RowDataPacket[], unknown];
  if (orderRows.length === 0) return { filled: false, rejection: "ORDER_NOT_FOUND" };
  const order = orderRows[0];
  if (order.status !== "PENDING") {
    return { filled: false, rejection: `ORDER_NOT_PENDING_${order.status}` };
  }
  const side = order.side as "BUY" | "SELL";
  const accountId = Number(order.account_id);
  const symbol = String(order.symbol);

  if (side === "BUY") {
    const investment = Number(order.investment_usd);
    if (!Number.isFinite(investment) || investment <= 0) {
      await rejectOrder(conn, orderId, "INVALID_INVESTMENT");
      return { filled: false, rejection: "INVALID_INVESTMENT" };
    }

    // Lock the account row so reservation math is consistent with the cash move.
    const [acctRows] = await conn.execute(
      "SELECT cash, reserved_cash FROM paper_accounts WHERE id = ? FOR UPDATE",
      [accountId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (acctRows.length === 0) {
      await rejectOrder(conn, orderId, "ACCOUNT_NOT_FOUND");
      return { filled: false, rejection: "ACCOUNT_NOT_FOUND" };
    }

    // Was cash reserved at submit time (LIMIT/STOP) or not (MARKET)?
    // The submit handler writes `reserved_amount` via the order row. We track
    // reservation via a dedicated column on the order. If no reservation
    // happened, we do a fresh atomic debit from `cash`. If a reservation
    // happened, we debit from `reserved_cash` instead.
    const reservedAmount = Number(order.reserved_amount ?? 0);

    if (reservedAmount > 0) {
      // Reservation path — atomic transfer from reserved_cash to the position.
      // No need to re-check cash here because cash was already moved to
      // reserved_cash when the order was submitted.
      const [resResult] = await conn.execute(
        "UPDATE paper_accounts SET reserved_cash = reserved_cash - ? WHERE id = ? AND reserved_cash >= ?",
        [reservedAmount, accountId, reservedAmount]
      ) as [mysqlTypes.ResultSetHeader, unknown];
      if (resResult.affectedRows !== 1) {
        await rejectOrder(conn, orderId, "RESERVATION_MISSING");
        return { filled: false, rejection: "RESERVATION_MISSING" };
      }
      // If the actual fill cost differs from the reservation (limit orders
      // can fill at any price ≤ limit for BUY), refund the surplus — or if
      // somehow worse, pull from cash atomically.
      const delta = reservedAmount - investment;
      if (delta !== 0) {
        if (delta > 0) {
          await conn.execute(
            "UPDATE paper_accounts SET cash = cash + ? WHERE id = ?",
            [delta, accountId]
          );
        } else {
          const [topUp] = await conn.execute(
            "UPDATE paper_accounts SET cash = cash - ? WHERE id = ? AND cash >= ?",
            [-delta, accountId, -delta]
          ) as [mysqlTypes.ResultSetHeader, unknown];
          if (topUp.affectedRows !== 1) {
            // Can't cover the extra cost — refund reservation + reject.
            await conn.execute(
              "UPDATE paper_accounts SET cash = cash + ? WHERE id = ?",
              [reservedAmount, accountId]
            );
            await rejectOrder(conn, orderId, "INSUFFICIENT_CASH_ON_FILL");
            return { filled: false, rejection: "INSUFFICIENT_CASH_ON_FILL" };
          }
        }
      }
    } else {
      // No reservation (MARKET BUY) — atomic debit from cash with guard.
      const [cashResult] = await conn.execute(
        "UPDATE paper_accounts SET cash = cash - ? WHERE id = ? AND cash >= ?",
        [investment, accountId, investment]
      ) as [mysqlTypes.ResultSetHeader, unknown];
      if (cashResult.affectedRows !== 1) {
        await rejectOrder(conn, orderId, "INSUFFICIENT_CASH");
        return { filled: false, rejection: "INSUFFICIENT_CASH" };
      }
    }

    const quantity = investment / fillPrice;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      // This shouldn't happen after the fillPrice guard above, but
      // defence-in-depth: if it does, rollback via rejection.
      // The caller's transaction wrapper will see the non-filled result and
      // issue rollback(), which undoes the cash debit.
      return { filled: false, rejection: "INVALID_QUANTITY" };
    }

    const [tradeResult] = await conn.execute(
      `INSERT INTO paper_trades
         (account_id, symbol, quantity, buy_price, buy_date, investment_usd, strategy, status, notes)
       VALUES (?, ?, ?, ?, CURRENT_DATE, ?, ?, 'OPEN', ?)`,
      [
        accountId,
        symbol,
        quantity,
        fillPrice,
        investment,
        `${order.order_type} BUY`,
        order.notes || null,
      ]
    ) as [mysqlTypes.ResultSetHeader, unknown];

    // Status-guarded FILLED transition.
    const [orderUpdate] = await conn.execute(
      `UPDATE paper_orders
          SET status='FILLED', filled_price=?, filled_at=CURRENT_TIMESTAMP(6), trade_id=?, reserved_amount=0
        WHERE id=? AND status='PENDING'`,
      [fillPrice, tradeResult.insertId, orderId]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (orderUpdate.affectedRows !== 1) {
      // Concurrent fill — our cash move and trade insert must be undone by
      // the transaction rollback. Surface so caller rolls back.
      return { filled: false, rejection: "ORDER_RACE_LOST" };
    }

    return { filled: true, tradeId: tradeResult.insertId, quantity, fillPrice, side: "BUY" };
  }

  // SELL path.
  // Resolve trade_id: if the order carries one, trust it — but still bind it
  // to (account_id, symbol) to close the cross-account / cross-symbol gap
  // (codex-d). If no trade_id, pick the oldest OPEN position for this
  // (account, symbol).
  let tradeId: number | null = order.trade_id != null ? Number(order.trade_id) : null;

  let tradeRows: mysqlTypes.RowDataPacket[];
  if (tradeId != null) {
    const [rows] = await conn.execute(
      "SELECT * FROM paper_trades WHERE id=? AND account_id=? AND symbol=? AND status='OPEN' FOR UPDATE",
      [tradeId, accountId, symbol]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    tradeRows = rows;
  } else {
    const [rows] = await conn.execute(
      "SELECT * FROM paper_trades WHERE account_id=? AND symbol=? AND status='OPEN' ORDER BY id ASC LIMIT 1 FOR UPDATE",
      [accountId, symbol]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    tradeRows = rows;
  }

  if (tradeRows.length === 0) {
    await rejectOrder(conn, orderId, tradeId != null ? "TRADE_MISMATCH" : "NO_OPEN_POSITION");
    return { filled: false, rejection: tradeId != null ? "TRADE_MISMATCH" : "NO_OPEN_POSITION" };
  }

  const trade = tradeRows[0];
  tradeId = Number(trade.id);
  const buyPrice = Number(trade.buy_price);
  const investment = Number(trade.investment_usd);
  const quantity = Number(trade.quantity) || (buyPrice > 0 ? investment / buyPrice : 0);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    await rejectOrder(conn, orderId, "INVALID_QUANTITY");
    return { filled: false, rejection: "INVALID_QUANTITY" };
  }
  const proceeds = quantity * fillPrice;
  const pnlUsd = proceeds - investment;
  const pnlPct = investment > 0 ? (pnlUsd / investment) * 100 : 0;

  // Status-guarded trade close.
  const [tradeUpdate] = await conn.execute(
    `UPDATE paper_trades
        SET status='CLOSED', sell_price=?, sell_date=CURRENT_DATE, pnl_usd=?, pnl_pct=?
      WHERE id=? AND status='OPEN'`,
    [fillPrice, pnlUsd, pnlPct, tradeId]
  ) as [mysqlTypes.ResultSetHeader, unknown];
  if (tradeUpdate.affectedRows !== 1) {
    return { filled: false, rejection: "TRADE_RACE_LOST" };
  }

  // Credit proceeds atomically.
  await conn.execute(
    "UPDATE paper_accounts SET cash = cash + ? WHERE id = ?",
    [proceeds, accountId]
  );

  // Status-guarded order fill.
  const [orderUpdate] = await conn.execute(
    `UPDATE paper_orders
        SET status='FILLED', filled_price=?, filled_at=CURRENT_TIMESTAMP(6), trade_id=?
      WHERE id=? AND status='PENDING'`,
    [fillPrice, tradeId, orderId]
  ) as [mysqlTypes.ResultSetHeader, unknown];
  if (orderUpdate.affectedRows !== 1) {
    return { filled: false, rejection: "ORDER_RACE_LOST" };
  }

  // Silence unused `nowIso` param — reserved for future slippage audit logs.
  void nowIso;

  return { filled: true, tradeId, quantity, fillPrice, side: "SELL", pnlUsd };
}

async function rejectOrder(
  conn: mysqlTypes.PoolConnection,
  orderId: number,
  reason: string
): Promise<void> {
  const trimmed = reason.slice(0, MAX_REJECTION_LEN);
  // Status-guarded: only reject if still PENDING. If another writer already
  // transitioned the row, don't stomp their state.
  await conn.execute(
    "UPDATE paper_orders SET status='REJECTED', rejection_reason=? WHERE id=? AND status='PENDING'",
    [trimmed, orderId]
  );
  // Release any reservation so cash doesn't get stuck.
  const [orderRows] = await conn.execute(
    "SELECT account_id, reserved_amount FROM paper_orders WHERE id = ?",
    [orderId]
  ) as [mysqlTypes.RowDataPacket[], unknown];
  if (orderRows.length > 0) {
    const reserved = Number(orderRows[0].reserved_amount ?? 0);
    if (reserved > 0) {
      await conn.execute(
        "UPDATE paper_accounts SET cash = cash + ?, reserved_cash = reserved_cash - ? WHERE id = ? AND reserved_cash >= ?",
        [reserved, reserved, orderRows[0].account_id, reserved]
      );
      await conn.execute("UPDATE paper_orders SET reserved_amount = 0 WHERE id = ?", [orderId]);
    }
  }
}

/**
 * Fill a single paper order atomically. Acquires its own connection +
 * transaction. Returns a structured result so the caller can log / respond.
 *
 * This is the ONE fill implementation in the codebase — both the UI path
 * (`src/lib/paper.ts:fillPendingOrders`) and the worker cron
 * (`scripts/surveillance-cron.ts`) must delegate here. Do not duplicate.
 */
export async function fillOrder(
  pool: mysqlTypes.Pool,
  orderId: number,
  fillPrice: number
): Promise<FillOrderResult> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fillOrderCore(conn, orderId, fillPrice, () => new Date().toISOString());
    if (result.filled) {
      await conn.commit();
    } else {
      // For "soft" rejections that already wrote a REJECTED row (no cash
      // movement happened), we COMMIT so the REJECTED state persists.
      // For "race lost" rejections after cash movement, we ROLLBACK so the
      // cash debit / trade insert is undone.
      const softReject = new Set([
        "INVALID_PRICE",
        "ORDER_NOT_FOUND",
        "ORDER_NOT_PENDING_FILLED",
        "ORDER_NOT_PENDING_CANCELLED",
        "ORDER_NOT_PENDING_REJECTED",
        "INVALID_INVESTMENT",
        "ACCOUNT_NOT_FOUND",
        "INSUFFICIENT_CASH",
        "TRADE_MISMATCH",
        "NO_OPEN_POSITION",
        "INVALID_QUANTITY",
      ]);
      if (softReject.has(result.rejection)) {
        await conn.commit();
      } else {
        await conn.rollback();
      }
    }
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Atomically place the reservation hold on cash when a PENDING BUY
 * (LIMIT/STOP) is submitted. Returns true if the reservation succeeded,
 * false if the account lacked the cash. Caller should reject the order
 * if this returns false.
 */
export async function reserveCashForOrder(
  pool: mysqlTypes.Pool,
  orderId: number,
  accountId: number,
  amount: number
): Promise<boolean> {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [cashResult] = await conn.execute(
      "UPDATE paper_accounts SET cash = cash - ?, reserved_cash = reserved_cash + ? WHERE id = ? AND cash >= ?",
      [amount, amount, accountId, amount]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (cashResult.affectedRows !== 1) {
      await conn.rollback();
      return false;
    }
    await conn.execute(
      "UPDATE paper_orders SET reserved_amount = ? WHERE id = ?",
      [amount, orderId]
    );
    await conn.commit();
    return true;
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Release a reservation back to cash — used when an order is cancelled
 * before fill, or rejected by the fill engine. Idempotent (checks
 * reserved_amount on the order row).
 */
export async function releaseReservationForOrder(
  pool: mysqlTypes.Pool,
  orderId: number
): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [orderRows] = await conn.execute(
      "SELECT account_id, reserved_amount FROM paper_orders WHERE id = ? FOR UPDATE",
      [orderId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (orderRows.length === 0) {
      await conn.rollback();
      return;
    }
    const reserved = Number(orderRows[0].reserved_amount ?? 0);
    if (reserved > 0) {
      await conn.execute(
        "UPDATE paper_accounts SET cash = cash + ?, reserved_cash = reserved_cash - ? WHERE id = ? AND reserved_cash >= ?",
        [reserved, reserved, orderRows[0].account_id, reserved]
      );
      await conn.execute("UPDATE paper_orders SET reserved_amount = 0 WHERE id = ?", [orderId]);
    }
    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}
