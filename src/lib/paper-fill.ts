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
 *   2. `paper_accounts.reserved_cash` can never go negative — atomic
 *      `UPDATE ... WHERE reserved_cash >= ?` enforces this, and every
 *      release asserts affectedRows === 1 so a missing account cannot
 *      silently consume the reservation marker.
 *   3. An order can fill at most once — `UPDATE ... WHERE status='PENDING'`
 *      on the FILLED transition enforces this; affectedRows === 0 means a
 *      concurrent caller already filled it.
 *   4. A trade can close at most once — `UPDATE ... WHERE status='OPEN'`
 *      on SELL enforces this.
 *   5. SELLs can only target a trade owned by the same account AND with the
 *      same symbol as the order — prevents cross-position / cross-account
 *      leaks.
 *   6. Reserved cash for a PENDING BUY is released back on fill/cancel/reject
 *      so that an unfilled reservation never permanently "eats" cash.
 *   7. fillPrice is validated finite & > 0 at the entry of fillOrder, AND
 *      quantity = investment / fillPrice is validated BEFORE any cash moves,
 *      so an invalid quantity can never soft-commit after funds were debited.
 *
 * GLOBAL LOCK ORDER (invariant — do not violate):
 *     paper_accounts  →  paper_orders  →  paper_trades
 *
 * Every `FOR UPDATE` / mutating write in this file acquires row locks in that
 * order. Mixing it (e.g. locking orders before accounts) creates a deadlock
 * cycle when two concurrent fills touch the same (account, order) pair from
 * opposite entry points. If you add a new code path, audit it against this
 * invariant before committing.
 */

import type mysqlTypes from "mysql2/promise";

export type FillOrderResult =
  | { filled: true; tradeId: number; quantity: number; fillPrice: number; side: "BUY" | "SELL"; pnlUsd?: number; fillRationale?: FillRationale }
  | { filled: false; rejection: string };

/**
 * How a BUY/SELL was matched. SPOT = current live quote touched the trigger.
 * OHLC_TOUCH = historical 5-min bar showed the limit price was pierced between
 * polls (W2 LIMIT OHLC best-effort fill). MANUAL = immediate MARKET at quote.
 */
export type FillRationale = "SPOT" | "OHLC_TOUCH" | "MANUAL";

/**
 * Options that modify how a fill is recorded. Both are optional — MARKET
 * orders placed via the UI typically pass neither (strategy defaults to
 * MANUAL label, rationale defaults to SPOT). The cron path passes
 * strategyId to attribute the trade to the strategy that emitted the signal;
 * the OHLC limit path passes rationale='OHLC_TOUCH'.
 */
export type FillOrderOptions = {
  /** FK to paper_strategies.id. NULL = manual user trade. */
  strategyId?: number | null;
  /** Provenance tag recorded in the trade row's `notes` column. */
  fillRationale?: FillRationale;
  /** Override strategy VARCHAR label (defaults to "{order_type} {side}"). */
  strategyLabel?: string;
};

const MAX_REJECTION_LEN = 255;

/**
 * Rejections that describe a state decision (order is invalid / account
 * missing / trade mismatch) — no cash was moved, so committing the REJECTED
 * row is the correct outcome.
 *
 * Rejections NOT in this set are "race lost" variants where another writer
 * transitioned a row mid-flight; the caller MUST roll back to undo any
 * intermediate writes.
 */
const SOFT_REJECT = new Set([
  "INVALID_PRICE",
  "ORDER_NOT_FOUND",
  "ORDER_NOT_PENDING_FILLED",
  "ORDER_NOT_PENDING_CANCELLED",
  "ORDER_NOT_PENDING_REJECTED",
  "INVALID_INVESTMENT",
  "INVALID_QUANTITY",
  "ACCOUNT_NOT_FOUND",
  "INSUFFICIENT_CASH",
  "TRADE_MISMATCH",
  "NO_OPEN_POSITION",
]);

/**
 * Write an equity snapshot row for the account. Uses the supplied connection
 * so the snapshot can participate in an in-flight transaction (price-accurate
 * state at the instant of commit), or a fresh pool connection when called
 * from an idle hourly cron.
 *
 * Positions are marked at `buy_price` here — not live price. That's
 * intentional: this helper runs inside a DB transaction without an outbound
 * Yahoo call so it can stay fast and not fail the parent transaction on a
 * network blip. Live marking happens in `computeAccountEquity` for display;
 * `paper_equity_snapshots` is the conservative book-value record.
 *
 * Lock order: this takes NO `FOR UPDATE` locks. It reads current cash and
 * open-position book value, then inserts into `paper_equity_snapshots`.
 * `paper_equity_snapshots` sits at the END of the lock order chain
 * (paper_accounts → paper_orders → paper_trades → paper_equity_snapshots),
 * so inserting into it never precedes a write against the earlier three.
 *
 * Returns true if a row was written; false on any error (swallowed — a
 * snapshot write must NEVER fail the parent fill transaction).
 */
export async function recordEquitySnapshot(
  accountId: number,
  connOrPool: mysqlTypes.PoolConnection | mysqlTypes.Pool
): Promise<boolean> {
  try {
    const [acctRows] = await connOrPool.execute(
      "SELECT cash, reserved_cash FROM paper_accounts WHERE id = ?",
      [accountId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (acctRows.length === 0) return false;
    const cash = Number(acctRows[0].cash);
    const reservedCash = Number(acctRows[0].reserved_cash ?? 0);

    // Mark open positions at buy_price — conservative book value, avoids a
    // network call inside the transaction. See helper header.
    const [openRows] = await connOrPool.execute(
      "SELECT COALESCE(SUM(quantity * buy_price), 0) AS open_value FROM paper_trades WHERE account_id = ? AND status = 'OPEN'",
      [accountId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    const positionsValue = Number(openRows[0]?.open_value ?? 0);

    const [closedRows] = await connOrPool.execute(
      "SELECT COALESCE(SUM(pnl_usd), 0) AS realized FROM paper_trades WHERE account_id = ? AND status = 'CLOSED'",
      [accountId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    const realizedPnl = Number(closedRows[0]?.realized ?? 0);

    const equity = cash + reservedCash + positionsValue;

    await connOrPool.execute(
      `INSERT INTO paper_equity_snapshots
         (account_id, cash, reserved_cash, positions_value, equity, realized_pnl)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [accountId, cash, reservedCash, positionsValue, equity, realizedPnl]
    );
    return true;
  } catch {
    // Snapshot writes are advisory — never let a failure here cascade into
    // rolling back a money-moving transaction. Caller should not check the
    // return value for correctness decisions, only for telemetry.
    return false;
  }
}

/**
 * Internal helper — runs the fill against the supplied connection. Caller
 * is responsible for wrapping in `beginTransaction` / `commit` / `rollback`.
 */
async function fillOrderCore(
  conn: mysqlTypes.PoolConnection,
  orderId: number,
  fillPrice: number,
  nowIso: () => string,
  opts?: FillOrderOptions
): Promise<FillOrderResult> {
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
    return { filled: false, rejection: "INVALID_PRICE" };
  }

  // Preliminary non-locking read purely to discover account_id / side so we
  // can lock in canonical order (accounts first). We re-read the order
  // under FOR UPDATE below to get authoritative state + status guard.
  const [preRows] = await conn.execute(
    "SELECT account_id, side FROM paper_orders WHERE id = ?",
    [orderId]
  ) as [mysqlTypes.RowDataPacket[], unknown];
  if (preRows.length === 0) return { filled: false, rejection: "ORDER_NOT_FOUND" };
  const accountId = Number(preRows[0].account_id);
  const preSide = preRows[0].side as "BUY" | "SELL";

  // LOCK STEP 1 — paper_accounts. For BUY we need it to move cash; for SELL
  // we need it to credit proceeds. Always lock first per global invariant.
  const [acctRows] = await conn.execute(
    "SELECT id, cash, reserved_cash FROM paper_accounts WHERE id = ? FOR UPDATE",
    [accountId]
  ) as [mysqlTypes.RowDataPacket[], unknown];
  if (acctRows.length === 0) {
    // Even for a missing account we still need to transition the order to
    // REJECTED so it doesn't sit forever. rejectOrder locks the order row
    // internally in canonical order.
    await rejectOrder(conn, orderId, "ACCOUNT_NOT_FOUND");
    return { filled: false, rejection: "ACCOUNT_NOT_FOUND" };
  }

  // LOCK STEP 2 — paper_orders. Authoritative read with status guard.
  const [orderRows] = await conn.execute(
    "SELECT * FROM paper_orders WHERE id = ? FOR UPDATE",
    [orderId]
  ) as [mysqlTypes.RowDataPacket[], unknown];
  if (orderRows.length === 0) return { filled: false, rejection: "ORDER_NOT_FOUND" };
  const order = orderRows[0];
  if (order.status !== "PENDING") {
    return { filled: false, rejection: `ORDER_NOT_PENDING_${order.status}` };
  }
  // Side must not change between preliminary read and authoritative read
  // (orders never swap side). If it did, treat as corruption → reject.
  if (order.side !== preSide) {
    await rejectOrder(conn, orderId, "ORDER_SIDE_MISMATCH");
    return { filled: false, rejection: "ORDER_SIDE_MISMATCH" };
  }
  const side = order.side as "BUY" | "SELL";
  const symbol = String(order.symbol);

  if (side === "BUY") {
    const investment = Number(order.investment_usd);
    if (!Number.isFinite(investment) || investment <= 0) {
      await rejectOrder(conn, orderId, "INVALID_INVESTMENT");
      return { filled: false, rejection: "INVALID_INVESTMENT" };
    }

    // P1 — Validate quantity BEFORE any cash movement. If fillPrice is
    // tiny (e.g. 1e-30) the resulting quantity is Infinity; if we let that
    // through we'd debit cash and THEN reject, leaving funds stranded.
    // Reject early so the soft-commit path writes only the REJECTED row
    // without ever touching cash or reserved_cash.
    const quantity = investment / fillPrice;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      await rejectOrder(conn, orderId, "INVALID_QUANTITY");
      return { filled: false, rejection: "INVALID_QUANTITY" };
    }

    // Was cash reserved at submit time (LIMIT/STOP) or not (MARKET)?
    const reservedAmount = Number(order.reserved_amount ?? 0);

    if (reservedAmount > 0) {
      // Reservation path — atomic transfer from reserved_cash to the position.
      const [resResult] = await conn.execute(
        "UPDATE paper_accounts SET reserved_cash = reserved_cash - ? WHERE id = ? AND reserved_cash >= ?",
        [reservedAmount, accountId, reservedAmount]
      ) as [mysqlTypes.ResultSetHeader, unknown];
      if (resResult.affectedRows !== 1) {
        await rejectOrder(conn, orderId, "RESERVATION_MISSING");
        return { filled: false, rejection: "RESERVATION_MISSING" };
      }
      // Reconcile delta between reserved amount and actual fill cost.
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
            // Can't cover the extra cost — force rollback by returning a
            // non-soft rejection.
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

    // LOCK STEP 3 — paper_trades (via INSERT; no row pre-exists to FOR UPDATE).
    // W2 fields:
    //   strategy_id — FK attribution. Cron path passes it; UI passes null.
    //   strategy    — denormalized VARCHAR label. Defaults to "{type} BUY".
    //                 UI path passes "MANUAL BUY" via opts.strategyLabel.
    //   notes       — plain-text rationale suffix lets smoke tests/audit
    //                 surface OHLC_TOUCH vs SPOT without a new column.
    const strategyLabel = opts?.strategyLabel ?? `${order.order_type} BUY`;
    const strategyId = opts?.strategyId ?? null;
    const noteParts: string[] = [];
    if (order.notes) noteParts.push(String(order.notes));
    if (opts?.fillRationale) noteParts.push(`fill_rationale=${opts.fillRationale}`);
    const notes = noteParts.length > 0 ? noteParts.join(" | ") : null;

    const [tradeResult] = await conn.execute(
      `INSERT INTO paper_trades
         (account_id, symbol, quantity, buy_price, buy_date, investment_usd, strategy, strategy_id, status, notes)
       VALUES (?, ?, ?, ?, CURRENT_DATE, ?, ?, ?, 'OPEN', ?)`,
      [
        accountId,
        symbol,
        quantity,
        fillPrice,
        investment,
        strategyLabel,
        strategyId,
        notes,
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

    return {
      filled: true,
      tradeId: tradeResult.insertId,
      quantity,
      fillPrice,
      side: "BUY",
      fillRationale: opts?.fillRationale,
    };
  }

  // SELL path.
  // LOCK STEP 3 — paper_trades. Resolve trade_id with account/symbol binding
  // to close the cross-account / cross-symbol gap.
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

  // Credit proceeds atomically. Account row is already locked (LOCK STEP 1).
  // Assert affectedRows === 1 — the row existed at lock time, so losing it
  // now means DB corruption; force rollback.
  const [creditResult] = await conn.execute(
    "UPDATE paper_accounts SET cash = cash + ? WHERE id = ?",
    [proceeds, accountId]
  ) as [mysqlTypes.ResultSetHeader, unknown];
  if (creditResult.affectedRows !== 1) {
    return { filled: false, rejection: "ACCOUNT_VANISHED" };
  }

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

  return {
    filled: true,
    tradeId,
    quantity,
    fillPrice,
    side: "SELL",
    pnlUsd,
    fillRationale: opts?.fillRationale,
  };
}

/**
 * Write the REJECTED state for an order and release any associated
 * reservation. Called from inside an in-flight transaction — throws if the
 * account-side refund cannot complete (e.g. account row vanished or
 * reserved_cash insufficient), forcing the caller's transaction to roll back
 * rather than silently committing a reservation leak.
 *
 * Lock order: this function assumes LOCK STEP 1 (accounts) is already held
 * by the caller when a reservation needs to be released. If the caller did
 * not hold the account lock, the caller must not pass through this path
 * with a positive `reserved_amount` — in practice every entry point to this
 * function either (a) has no reservation to release (MARKET orders), or
 * (b) has already locked the account in `fillOrderCore`.
 */
async function rejectOrder(
  conn: mysqlTypes.PoolConnection,
  orderId: number,
  reason: string
): Promise<void> {
  const trimmed = reason.slice(0, MAX_REJECTION_LEN);
  // Status-guarded: only reject if still PENDING.
  await conn.execute(
    "UPDATE paper_orders SET status='REJECTED', rejection_reason=? WHERE id=? AND status='PENDING'",
    [trimmed, orderId]
  );
  // Release any reservation so cash doesn't get stuck. The SELECT runs
  // without FOR UPDATE here because the caller holds the order lock already
  // (every call site is inside fillOrderCore after LOCK STEP 2).
  const [orderRows] = await conn.execute(
    "SELECT account_id, reserved_amount FROM paper_orders WHERE id = ?",
    [orderId]
  ) as [mysqlTypes.RowDataPacket[], unknown];
  if (orderRows.length === 0) return;
  const reserved = Number(orderRows[0].reserved_amount ?? 0);
  if (reserved <= 0) return;

  // P3 — assert both (a) the account exists and (b) reserved_cash >= reserved.
  // The `WHERE reserved_cash >= ?` guard means the UPDATE only matches when
  // the reservation is actually backed. If affectedRows !== 1, the refund
  // cannot be honoured atomically — throw so the caller's transaction rolls
  // back instead of wiping `reserved_amount` while cash stays put.
  const [refund] = await conn.execute(
    "UPDATE paper_accounts SET cash = cash + ?, reserved_cash = reserved_cash - ? WHERE id = ? AND reserved_cash >= ?",
    [reserved, reserved, orderRows[0].account_id, reserved]
  ) as [mysqlTypes.ResultSetHeader, unknown];
  if (refund.affectedRows !== 1) {
    throw new Error(
      `rejectOrder: refund failed for order=${orderId} account=${orderRows[0].account_id} reserved=${reserved} — rolling back`
    );
  }
  const [clear] = await conn.execute(
    "UPDATE paper_orders SET reserved_amount = 0 WHERE id = ?",
    [orderId]
  ) as [mysqlTypes.ResultSetHeader, unknown];
  if (clear.affectedRows !== 1) {
    throw new Error(
      `rejectOrder: clearing reserved_amount failed for order=${orderId} — rolling back`
    );
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
  fillPrice: number,
  opts?: FillOrderOptions
): Promise<FillOrderResult> {
  const conn = await pool.getConnection();
  let accountIdForSnapshot: number | null = null;
  try {
    await conn.beginTransaction();
    let result: FillOrderResult;
    try {
      result = await fillOrderCore(conn, orderId, fillPrice, () => new Date().toISOString(), opts);
    } catch (err) {
      // rejectOrder (or any core step) may throw to force rollback when
      // a refund / state update could not complete atomically. Treat as a
      // hard rejection; the outer finally-rollback runs below.
      await conn.rollback();
      throw err;
    }

    // Resolve the account_id for the eventual snapshot before we commit the
    // fill. We need this for BOTH filled AND soft-reject branches when the
    // reservation was refunded (cash-moving rejection). Do the lookup while
    // the transaction is still open so it's a single consistent snapshot.
    if (result.filled || SOFT_REJECT.has(result.rejection ?? "")) {
      try {
        const [rows] = await conn.execute(
          "SELECT account_id FROM paper_orders WHERE id = ?",
          [orderId]
        ) as [mysqlTypes.RowDataPacket[], unknown];
        if (rows.length > 0) accountIdForSnapshot = Number(rows[0].account_id);
      } catch { /* ignore — snapshot is advisory */ }
    }

    // W2 — write the equity snapshot INSIDE the transaction so it reflects the
    // fill atomically. paper_equity_snapshots sits at the END of the lock
    // order chain so this insert never precedes an earlier-chain write.
    //
    // Only write on `filled` (positive cash move) — soft rejects that
    // don't change cash don't need a new snapshot row. Failures inside
    // recordEquitySnapshot are swallowed so a snapshot write never fails
    // the fill.
    if (result.filled && accountIdForSnapshot != null) {
      await recordEquitySnapshot(accountIdForSnapshot, conn);
    }

    if (result.filled) {
      await conn.commit();
    } else if (SOFT_REJECT.has(result.rejection)) {
      await conn.commit();
    } else {
      await conn.rollback();
    }
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore — already rolled back or conn dead */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Atomically place the reservation hold on cash when a PENDING BUY
 * (LIMIT/STOP) is submitted. Returns true if the reservation succeeded,
 * false if the account lacked the cash OR the order is not PENDING
 * (already cancelled / filled / rejected / missing). Caller should reject
 * the order if this returns false.
 *
 * Lock order: accounts → orders (matches the global invariant).
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

    // LOCK STEP 1 — accounts. Atomic cash → reserved_cash transfer.
    const [cashResult] = await conn.execute(
      "UPDATE paper_accounts SET cash = cash - ?, reserved_cash = reserved_cash + ? WHERE id = ? AND cash >= ?",
      [amount, amount, accountId, amount]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (cashResult.affectedRows !== 1) {
      await conn.rollback();
      return false;
    }

    // LOCK STEP 2 — orders. P2 fix: guard with status='PENDING' and assert
    // affectedRows === 1. If the order is missing, CANCELLED, FILLED, or
    // REJECTED, we rolled back the cash move above — the reservation never
    // persisted.
    const [orderResult] = await conn.execute(
      "UPDATE paper_orders SET reserved_amount = ? WHERE id = ? AND status = 'PENDING'",
      [amount, orderId]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (orderResult.affectedRows !== 1) {
      // Order is gone / not PENDING — undo the cash move.
      await conn.rollback();
      return false;
    }

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
 * before fill. Idempotent (checks reserved_amount on the order row).
 *
 * Lock order: accounts → orders. Both UPDATEs assert affectedRows === 1
 * and will throw if the refund cannot be honoured atomically; caller's
 * transaction rolls back via the catch-and-rethrow.
 */
export async function releaseReservationForOrder(
  pool: mysqlTypes.Pool,
  orderId: number
): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Non-locking read to discover the account_id so we can lock in canonical
    // order. If the order is gone, nothing to release.
    const [preRows] = await conn.execute(
      "SELECT account_id, reserved_amount FROM paper_orders WHERE id = ?",
      [orderId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (preRows.length === 0) {
      await conn.commit();
      return;
    }
    const accountId = Number(preRows[0].account_id);
    const preReserved = Number(preRows[0].reserved_amount ?? 0);
    if (preReserved <= 0) {
      await conn.commit();
      return;
    }

    // LOCK STEP 1 — accounts (canonical order).
    const [acctRows] = await conn.execute(
      "SELECT id FROM paper_accounts WHERE id = ? FOR UPDATE",
      [accountId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (acctRows.length === 0) {
      throw new Error(
        `releaseReservationForOrder: account=${accountId} not found for order=${orderId}`
      );
    }

    // LOCK STEP 2 — order. Re-read authoritative reserved_amount under lock.
    const [orderRows] = await conn.execute(
      "SELECT account_id, reserved_amount FROM paper_orders WHERE id = ? FOR UPDATE",
      [orderId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (orderRows.length === 0) {
      await conn.commit();
      return;
    }
    const reserved = Number(orderRows[0].reserved_amount ?? 0);
    if (reserved <= 0) {
      await conn.commit();
      return;
    }

    // P3 — assert both refund arms succeed atomically.
    const [refund] = await conn.execute(
      "UPDATE paper_accounts SET cash = cash + ?, reserved_cash = reserved_cash - ? WHERE id = ? AND reserved_cash >= ?",
      [reserved, reserved, accountId, reserved]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (refund.affectedRows !== 1) {
      throw new Error(
        `releaseReservationForOrder: refund failed for order=${orderId} account=${accountId} reserved=${reserved}`
      );
    }
    const [clear] = await conn.execute(
      "UPDATE paper_orders SET reserved_amount = 0 WHERE id = ?",
      [orderId]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (clear.affectedRows !== 1) {
      throw new Error(
        `releaseReservationForOrder: clear reserved_amount failed for order=${orderId}`
      );
    }

    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}
