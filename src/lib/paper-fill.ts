/**
 * Shared paper-trading fill engine.
 *
 * Single source of truth for `fillOrder`. Both the UI path (`src/lib/paper.ts`
 * → `/api/paper` on every refresh) and the worker cron path
 * (`scripts/surveillance-cron.ts` every 15 min) call into `fillOrder` here so
 * the atomic guarantees are identical across both entry points.
 *
 * CRON STRATEGY ATTRIBUTION (W2): The cron's `fillOrder` call site processes
 * user-placed `paper_orders` rows (LIMIT/STOP queued from the UI) — NOT
 * strategy-engine signals, which are owned by `paper_signals` and bypass
 * `fillOrder` entirely (they mutate `paper_accounts.cash` directly from the
 * cron's signal-close branch). Because `paper_orders` carries no `strategy_id`
 * column today, cron-path fills store `strategy_id = NULL`. That is the
 * SAME behaviour as manual UI fills — both end up as "user-initiated orders
 * with no strategy FK". When W3+ introduces a strategy-emits-an-order path,
 * add `paper_orders.strategy_id` and thread it through `opts.strategyId`.
 *
 * SNAPSHOT ERROR MODES (W2, codex F1): `recordEquitySnapshot` is split into
 * two variants with opposite error semantics — `recordEquitySnapshotInTx`
 * throws (so a snapshot INSERT failure rolls the fill back), while
 * `recordEquitySnapshotSafe` catches + logs + returns false (so the hourly
 * cron never aborts on one bad account). Never swap them.
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
  | {
      filled: true;
      tradeId: number;
      quantity: number;
      fillPrice: number;
      /** Legacy BUY/SELL indicator. Paired with `positionSide` to disambiguate. */
      side: "BUY" | "SELL";
      /**
       * Target position side — LONG for buy-to-open / sell-to-close-long,
       * SHORT for sell-to-open / buy-to-cover. W3 addition.
       */
      positionSide: "LONG" | "SHORT";
      pnlUsd?: number;
      fillRationale?: FillRationale;
      /** Quantity still open after this fill (for partials). */
      remainingQuantity?: number;
    }
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
  "DUPLICATE_SHORT_POSITION",
]);

/**
 * Core snapshot routine — reads current cash + open-position book value and
 * inserts into `paper_equity_snapshots`. Split into two exported wrappers
 * (`recordEquitySnapshotInTx` / `recordEquitySnapshotSafe`) because the
 * semantic around errors differs between callers:
 *
 *   - In-transaction: a snapshot INSERT failure MUST roll the fill back.
 *     Committing a fill without the matching snapshot violates the
 *     "snapshot-atomic-with-fill" claim, leaves the equity curve with a
 *     missing data point whose absence looks like an empty hour rather than
 *     a known anomaly. Throw → caller's `conn.rollback()` runs.
 *
 *   - Hourly cron: a snapshot failure for one account MUST NOT crash the
 *     batch — other accounts still need their hourly data point. Catch →
 *     log → return false. Caller continues with the next account.
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
 */
async function recordEquitySnapshotCore(
  accountId: number,
  connOrPool: mysqlTypes.PoolConnection | mysqlTypes.Pool
): Promise<boolean> {
  const [acctRows] = await connOrPool.execute(
    "SELECT cash, reserved_cash, reserved_short_margin FROM paper_accounts WHERE id = ?",
    [accountId]
  ) as [mysqlTypes.RowDataPacket[], unknown];
  if (acctRows.length === 0) return false;
  const cash = Number(acctRows[0].cash);
  const reservedCash = Number(acctRows[0].reserved_cash ?? 0);
  const reservedShortMargin = Number(acctRows[0].reserved_short_margin ?? 0);

  // Mark open positions at buy_price — conservative book value, avoids a
  // network call inside the transaction. LONG positions contribute
  // quantity*buy_price (asset owned). SHORT positions' book value is the
  // held margin (already counted in reserved_short_margin), so we only sum
  // remaining-quantity for LONGs here. (closed_quantity tracks partials.)
  const [openRows] = await connOrPool.execute(
    `SELECT COALESCE(SUM((quantity - COALESCE(closed_quantity,0)) * buy_price), 0) AS open_value
       FROM paper_trades
      WHERE account_id = ? AND status = 'OPEN' AND side = 'LONG'`,
    [accountId]
  ) as [mysqlTypes.RowDataPacket[], unknown];
  const positionsValue = Number(openRows[0]?.open_value ?? 0);

  const [closedRows] = await connOrPool.execute(
    "SELECT COALESCE(SUM(pnl_usd), 0) AS realized FROM paper_trades WHERE account_id = ? AND status = 'CLOSED'",
    [accountId]
  ) as [mysqlTypes.RowDataPacket[], unknown];
  const realizedPnl = Number(closedRows[0]?.realized ?? 0);

  // Equity = cash + reserved_cash + reserved_short_margin + LONG book value.
  // (SHORT book value is the held margin, already in reserved_short_margin.)
  const equity = cash + reservedCash + reservedShortMargin + positionsValue;

  await connOrPool.execute(
    `INSERT INTO paper_equity_snapshots
       (account_id, cash, reserved_cash, reserved_short_margin, positions_value, equity, realized_pnl)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [accountId, cash, reservedCash, reservedShortMargin, positionsValue, equity, realizedPnl]
  );
  return true;
}

/**
 * Transactional snapshot — call from inside `fillOrder` (or any other
 * money-moving transaction). Throws on any DB error so the caller's
 * `conn.rollback()` runs. NEVER swallows errors: a missing snapshot row
 * after a successful fill is a correctness bug, not advisory.
 *
 * Caller MUST pass a `PoolConnection` that already owns an open transaction.
 */
export async function recordEquitySnapshotInTx(
  conn: mysqlTypes.PoolConnection,
  accountId: number
): Promise<boolean> {
  return recordEquitySnapshotCore(accountId, conn);
}

/**
 * Cron-safe snapshot — call from the hourly cron path that iterates over
 * many accounts. Catches + logs errors + returns `false` so a single failing
 * account doesn't poison the batch for the rest. Accepts either a Pool or
 * a Connection; no transaction is required.
 */
export async function recordEquitySnapshotSafe(
  pool: mysqlTypes.Pool | mysqlTypes.PoolConnection,
  accountId: number
): Promise<boolean> {
  try {
    return await recordEquitySnapshotCore(accountId, pool);
  } catch (err) {
    // Logged so the cron can surface repeated failures; swallowed so the
    // per-account loop carries on to the next account.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`recordEquitySnapshotSafe: account=${accountId} failed: ${msg}`);
    return false;
  }
}

/**
 * Internal helper — runs the fill against the supplied connection. Caller
 * is responsible for wrapping in `beginTransaction` / `commit` / `rollback`.
 *
 * W3 — four orthogonal (side, position_side) combinations are handled:
 *   BUY  + LONG  → open LONG (existing behaviour; debits cash or releases reservation)
 *   SELL + LONG  → close LONG in full or part (partial via order.close_quantity)
 *   SELL + SHORT → open SHORT (debits cash into reserved_short_margin)
 *   BUY  + SHORT → cover SHORT in full or part (releases margin, settles P&L)
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
    "SELECT id, cash, reserved_cash, reserved_short_margin FROM paper_accounts WHERE id = ? FOR UPDATE",
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
  const positionSide: "LONG" | "SHORT" = (order.position_side === "SHORT") ? "SHORT" : "LONG";
  const symbol = String(order.symbol);

  // ── OPEN LONG (BUY + LONG) ───────────────────────────────────────────
  if (side === "BUY" && positionSide === "LONG") {
    const investment = Number(order.investment_usd);
    if (!Number.isFinite(investment) || investment <= 0) {
      await rejectOrder(conn, orderId, "INVALID_INVESTMENT");
      return { filled: false, rejection: "INVALID_INVESTMENT" };
    }

    // P1 — Validate quantity BEFORE any cash movement. If fillPrice is
    // tiny (e.g. 1e-30) the resulting quantity is Infinity; if we let that
    // through we'd debit cash and THEN reject, leaving funds stranded.
    const quantity = investment / fillPrice;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      await rejectOrder(conn, orderId, "INVALID_QUANTITY");
      return { filled: false, rejection: "INVALID_QUANTITY" };
    }

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
            return { filled: false, rejection: "INSUFFICIENT_CASH_ON_FILL" };
          }
        }
      }
    } else {
      const [cashResult] = await conn.execute(
        "UPDATE paper_accounts SET cash = cash - ? WHERE id = ? AND cash >= ?",
        [investment, accountId, investment]
      ) as [mysqlTypes.ResultSetHeader, unknown];
      if (cashResult.affectedRows !== 1) {
        await rejectOrder(conn, orderId, "INSUFFICIENT_CASH");
        return { filled: false, rejection: "INSUFFICIENT_CASH" };
      }
    }

    return await insertOpenTrade(conn, {
      accountId, symbol, quantity, fillPrice, investment,
      positionSide: "LONG", side: "BUY", order, orderId, opts,
    });
  }

  // ── OPEN SHORT (SELL + SHORT) ────────────────────────────────────────
  if (side === "SELL" && positionSide === "SHORT") {
    const investment = Number(order.investment_usd);
    if (!Number.isFinite(investment) || investment <= 0) {
      await rejectOrder(conn, orderId, "INVALID_INVESTMENT");
      return { filled: false, rejection: "INVALID_INVESTMENT" };
    }
    const quantity = investment / fillPrice;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      await rejectOrder(conn, orderId, "INVALID_QUANTITY");
      return { filled: false, rejection: "INVALID_QUANTITY" };
    }

    // PF2 — reject new SHORT if an OPEN SHORT already exists for this
    // (account, symbol). The cover path resolves "which position to close"
    // via `trade_id` OR `LIMIT 1` on OPEN SHORTs — allowing a second OPEN
    // SHORT for the same symbol would make the LIMIT 1 cover ambiguous.
    // Users that want multiple legs per symbol must pass `trade_id` on cover.
    const [dupRows] = await conn.execute(
      "SELECT id FROM paper_trades WHERE account_id=? AND symbol=? AND side='SHORT' AND status='OPEN' LIMIT 1 FOR UPDATE",
      [accountId, symbol]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (dupRows.length > 0) {
      await rejectOrder(conn, orderId, "DUPLICATE_SHORT_POSITION");
      return { filled: false, rejection: "DUPLICATE_SHORT_POSITION" };
    }

    // Short margin: held in paper_accounts.reserved_short_margin. If the order
    // pre-reserved via reserveShortMarginForOrder (LIMIT/STOP short), that
    // column already reflects the hold — we only need to reconcile any delta
    // between pre-reserved and actual short-value at fill. If not pre-reserved
    // (MARKET short), debit cash into reserved_short_margin now.
    const reservedShort = Number(order.reserved_short_margin ?? 0);
    if (reservedShort > 0) {
      // Already held — nothing to do on cash / margin ledger other than
      // adjust for delta between reserved amount and actual fill-value.
      const delta = reservedShort - investment;
      if (delta !== 0) {
        if (delta > 0) {
          // Over-reserved — release the surplus back to cash.
          const [rel] = await conn.execute(
            "UPDATE paper_accounts SET reserved_short_margin = reserved_short_margin - ?, cash = cash + ? WHERE id = ? AND reserved_short_margin >= ?",
            [delta, delta, accountId, delta]
          ) as [mysqlTypes.ResultSetHeader, unknown];
          if (rel.affectedRows !== 1) {
            return { filled: false, rejection: "SHORT_MARGIN_MISSING" };
          }
        } else {
          // Under-reserved — need to move more from cash to margin.
          const extra = -delta;
          const [top] = await conn.execute(
            "UPDATE paper_accounts SET cash = cash - ?, reserved_short_margin = reserved_short_margin + ? WHERE id = ? AND cash >= ?",
            [extra, extra, accountId, extra]
          ) as [mysqlTypes.ResultSetHeader, unknown];
          if (top.affectedRows !== 1) {
            return { filled: false, rejection: "INSUFFICIENT_CASH_ON_FILL" };
          }
        }
      }
    } else {
      // No pre-reservation — this is a MARKET short. Atomically debit cash
      // into reserved_short_margin.
      const [move] = await conn.execute(
        "UPDATE paper_accounts SET cash = cash - ?, reserved_short_margin = reserved_short_margin + ? WHERE id = ? AND cash >= ?",
        [investment, investment, accountId, investment]
      ) as [mysqlTypes.ResultSetHeader, unknown];
      if (move.affectedRows !== 1) {
        await rejectOrder(conn, orderId, "INSUFFICIENT_CASH");
        return { filled: false, rejection: "INSUFFICIENT_CASH" };
      }
    }

    return await insertOpenTrade(conn, {
      accountId, symbol, quantity, fillPrice, investment,
      positionSide: "SHORT", side: "SELL", order, orderId, opts,
    });
  }

  // ── CLOSE LONG (SELL + LONG) or COVER SHORT (BUY + SHORT) ────────────
  // Shared path: both decrement an open position, compute direction-aware
  // P&L on the closed slice, and move cash accordingly.
  let tradeId: number | null = order.trade_id != null ? Number(order.trade_id) : null;

  // W3: order.close_quantity (optional) — partial-close support. NULL =
  // close the full remaining quantity.
  const requestedCloseQty = order.close_quantity != null ? Number(order.close_quantity) : null;

  // Expected position-side on the target trade must match the order's
  // position_side (closing LONG vs covering SHORT).
  const expectedTradeSide: "LONG" | "SHORT" = positionSide;

  let tradeRows: mysqlTypes.RowDataPacket[];
  if (tradeId != null) {
    const [rows] = await conn.execute(
      "SELECT * FROM paper_trades WHERE id=? AND account_id=? AND symbol=? AND side=? AND status='OPEN' FOR UPDATE",
      [tradeId, accountId, symbol, expectedTradeSide]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    tradeRows = rows;
  } else {
    const [rows] = await conn.execute(
      "SELECT * FROM paper_trades WHERE account_id=? AND symbol=? AND side=? AND status='OPEN' ORDER BY id ASC LIMIT 1 FOR UPDATE",
      [accountId, symbol, expectedTradeSide]
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
  const totalQty = Number(trade.quantity) || (buyPrice > 0 ? investment / buyPrice : 0);
  const alreadyClosed = Number(trade.closed_quantity ?? 0);
  const remainingBefore = Math.max(0, totalQty - alreadyClosed);
  if (!Number.isFinite(remainingBefore) || remainingBefore <= 0) {
    await rejectOrder(conn, orderId, "NO_OPEN_POSITION");
    return { filled: false, rejection: "NO_OPEN_POSITION" };
  }

  // Quantity actually to close on this fill — bounded by remaining.
  let closeQty = remainingBefore;
  if (requestedCloseQty != null) {
    if (!Number.isFinite(requestedCloseQty) || requestedCloseQty <= 0) {
      await rejectOrder(conn, orderId, "INVALID_QUANTITY");
      return { filled: false, rejection: "INVALID_QUANTITY" };
    }
    closeQty = Math.min(requestedCloseQty, remainingBefore);
  }

  const investmentShare = totalQty > 0 ? investment * (closeQty / totalQty) : 0;
  // Proceeds for LONG close = qty * fillPrice.
  // Proceeds semantic for SHORT cover = qty * fillPrice (cash we pay to buy
  // back). Margin release happens separately.
  const closeValue = closeQty * fillPrice;

  // Direction-aware P&L on the closed slice. LONG profits when fill > entry;
  // SHORT profits when entry > fill.
  const pnlSlice = expectedTradeSide === "SHORT"
    ? (buyPrice - fillPrice) * closeQty
    : (fillPrice - buyPrice) * closeQty;
  const pnlPctSlice = investmentShare > 0 ? (pnlSlice / investmentShare) * 100 : 0;

  const newClosedQty = alreadyClosed + closeQty;
  const willBeFullyClosed = newClosedQty >= totalQty - 1e-9; // float tolerance

  // Partial-close race guard: UPDATE is status-guarded AND verifies
  // closed_quantity has not raced past quantity. If two partial-close orders
  // hit the same trade simultaneously the second one sees a higher
  // closed_quantity and the `closed_quantity + ? <= quantity` guard (enforced
  // by the subquery) rejects with TRADE_RACE_LOST.
  if (willBeFullyClosed) {
    // Full close — flip to CLOSED.
    const existingPnl = Number(trade.pnl_usd ?? 0);
    const finalPnl = existingPnl + pnlSlice;
    const investmentShareTotal = investment; // full investment realized
    const finalPnlPct = investmentShareTotal > 0 ? (finalPnl / investmentShareTotal) * 100 : 0;
    const [tradeUpdate] = await conn.execute(
      `UPDATE paper_trades
          SET status='CLOSED', sell_price=?, sell_date=CURRENT_DATE,
              pnl_usd=?, pnl_pct=?,
              closed_quantity=quantity
        WHERE id=? AND status='OPEN' AND closed_quantity = ?`,
      [fillPrice, finalPnl, finalPnlPct, tradeId, alreadyClosed]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (tradeUpdate.affectedRows !== 1) {
      return { filled: false, rejection: "TRADE_RACE_LOST" };
    }
  } else {
    // Partial close — accumulate into pnl_usd, advance closed_quantity,
    // leave status OPEN. Guarded so a concurrent partial cannot over-close.
    const existingPnl = Number(trade.pnl_usd ?? 0);
    const accumulatedPnl = existingPnl + pnlSlice;
    const [tradeUpdate] = await conn.execute(
      `UPDATE paper_trades
          SET pnl_usd=?, closed_quantity=closed_quantity + ?
        WHERE id=? AND status='OPEN' AND closed_quantity + ? <= quantity + 1e-9`,
      [accumulatedPnl, closeQty, tradeId, closeQty]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (tradeUpdate.affectedRows !== 1) {
      return { filled: false, rejection: "TRADE_RACE_LOST" };
    }
  }

  // Cash + margin arithmetic — differs by side.
  if (expectedTradeSide === "LONG") {
    // Credit closeValue (proceeds) to cash. No margin involvement.
    const [creditResult] = await conn.execute(
      "UPDATE paper_accounts SET cash = cash + ? WHERE id = ?",
      [closeValue, accountId]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (creditResult.affectedRows !== 1) {
      return { filled: false, rejection: "ACCOUNT_VANISHED" };
    }
  } else {
    // SHORT cover. Accounting model:
    //   OPEN:  cash -= investment    (deposit collateral)
    //          reserved_short_margin += investment
    //          Conceptually margin holds BOTH collateral AND the short-sale
    //          proceeds — a standard cash-account short requires 100% of
    //          position value as margin, and the short-sale generates the
    //          other 100% which is also held. So equity is unchanged at open:
    //            equity = cash + margin = (C - I) + I = C.
    //
    //   COVER: release investmentShare of margin, pay closeValue to buy back.
    //          Net cash delta = investmentShare_released_from_margin + pnl
    //          where pnl = investmentShare - closeValue = (entry - close) * qty.
    //          Equivalently: cash += (2 * investmentShare - closeValue)
    //                                = investmentShare + pnlSlice.
    //          reserved_short_margin -= investmentShare.
    //
    // Concrete example: open $1000 short at $100 (qty 10), cover at $90.
    //   At open: cash 100k→99k, margin 0→1k, equity 100k.
    //   At cover: closeValue = 10*90 = 900. investmentShare = 1000.
    //   cash += (1000 + 1000 - 900) = 1100. margin -= 1000.
    //   Final: cash 99k+1.1k = 100.1k, margin 0, equity 100.1k = initial + pnl(+100) ✓
    const cashCredit = 2 * investmentShare - closeValue;
    const [release] = await conn.execute(
      "UPDATE paper_accounts SET reserved_short_margin = reserved_short_margin - ?, cash = cash + ? WHERE id = ? AND reserved_short_margin >= ?",
      [investmentShare, cashCredit, accountId, investmentShare]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (release.affectedRows !== 1) {
      return { filled: false, rejection: "SHORT_MARGIN_MISSING" };
    }
  }

  // Status-guarded order fill — regardless of partial vs full, this order
  // is now FILLED.
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
    quantity: closeQty,
    fillPrice,
    side,
    positionSide: expectedTradeSide,
    pnlUsd: pnlSlice,
    fillRationale: opts?.fillRationale,
    remainingQuantity: willBeFullyClosed ? 0 : (remainingBefore - closeQty),
  };
}

/**
 * Shared insert path for OPEN trades — LONG or SHORT. Writes the new
 * paper_trades row, captures exit-bracket fields from the order, and flips
 * the order to FILLED. Returns the FillOrderResult.
 *
 * Bracket capture: if the order supplied any `bracket_*_pct` / `bracket_time_exit_days`
 * we compute the absolute bracket prices from the fill price and persist them.
 * This is the "compute at fill time" option from the plan — a stop-loss % of
 * 5% on a fill at $100 becomes `stop_loss_price = $95` (LONG) or `$105` (SHORT).
 */
async function insertOpenTrade(
  conn: mysqlTypes.PoolConnection,
  args: {
    accountId: number;
    symbol: string;
    quantity: number;
    fillPrice: number;
    investment: number;
    positionSide: "LONG" | "SHORT";
    side: "BUY" | "SELL";
    order: mysqlTypes.RowDataPacket;
    orderId: number;
    opts?: FillOrderOptions;
  }
): Promise<FillOrderResult> {
  const { accountId, symbol, quantity, fillPrice, investment, positionSide, side, order, orderId, opts } = args;

  const strategyLabel = opts?.strategyLabel ?? `${order.order_type} ${side}`;
  const strategyId = opts?.strategyId ?? null;
  const noteParts: string[] = [];
  if (order.notes) noteParts.push(String(order.notes));
  if (opts?.fillRationale) noteParts.push(`fill_rationale=${opts.fillRationale}`);
  const notes = noteParts.length > 0 ? noteParts.join(" | ") : null;

  // Bracket absolute-price computation. For LONG positions: stop below entry,
  // take-profit above entry. For SHORT: stop above entry (loss = price rises),
  // take-profit below entry (profit = price falls).
  const stopLossPct = order.bracket_stop_loss_pct != null ? Number(order.bracket_stop_loss_pct) : null;
  const takeProfitPct = order.bracket_take_profit_pct != null ? Number(order.bracket_take_profit_pct) : null;
  const trailingPct = order.bracket_trailing_pct != null ? Number(order.bracket_trailing_pct) : null;
  const trailingActivatesPct = order.bracket_trailing_activates_pct != null ? Number(order.bracket_trailing_activates_pct) : null;
  const timeExitDays = order.bracket_time_exit_days != null ? Number(order.bracket_time_exit_days) : null;

  const stopLossPrice = stopLossPct != null && stopLossPct > 0
    ? (positionSide === "LONG" ? fillPrice * (1 - stopLossPct / 100) : fillPrice * (1 + stopLossPct / 100))
    : null;
  const takeProfitPrice = takeProfitPct != null && takeProfitPct > 0
    ? (positionSide === "LONG" ? fillPrice * (1 + takeProfitPct / 100) : fillPrice * (1 - takeProfitPct / 100))
    : null;
  const timeExitDate = timeExitDays != null && timeExitDays >= 0
    ? new Date(Date.now() + timeExitDays * 86_400_000).toISOString().slice(0, 10)
    : null;

  const [tradeResult] = await conn.execute(
    `INSERT INTO paper_trades
       (account_id, symbol, side, quantity, buy_price, buy_date, investment_usd,
        strategy, strategy_id, status, notes,
        stop_loss_price, take_profit_price,
        trailing_stop_pct, trailing_activates_at_profit_pct,
        time_exit_date,
        closed_quantity)
     VALUES (?, ?, ?, ?, ?, CURRENT_DATE, ?, ?, ?, 'OPEN', ?,
             ?, ?, ?, ?, ?, 0)`,
    [
      accountId,
      symbol,
      positionSide,
      quantity,
      fillPrice,
      investment,
      strategyLabel,
      strategyId,
      notes,
      stopLossPrice,
      takeProfitPrice,
      trailingPct,
      trailingActivatesPct,
      timeExitDate,
    ]
  ) as [mysqlTypes.ResultSetHeader, unknown];

  // Status-guarded FILLED transition. reset reserved_amount AND
  // reserved_short_margin columns on the order.
  const [orderUpdate] = await conn.execute(
    `UPDATE paper_orders
        SET status='FILLED', filled_price=?, filled_at=CURRENT_TIMESTAMP(6),
            trade_id=?, reserved_amount=0, reserved_short_margin=0
      WHERE id=? AND status='PENDING'`,
    [fillPrice, tradeResult.insertId, orderId]
  ) as [mysqlTypes.ResultSetHeader, unknown];
  if (orderUpdate.affectedRows !== 1) {
    return { filled: false, rejection: "ORDER_RACE_LOST" };
  }

  return {
    filled: true,
    tradeId: tradeResult.insertId,
    quantity,
    fillPrice,
    side,
    positionSide,
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
    "SELECT account_id, reserved_amount, reserved_short_margin FROM paper_orders WHERE id = ?",
    [orderId]
  ) as [mysqlTypes.RowDataPacket[], unknown];
  if (orderRows.length === 0) return;
  const reserved = Number(orderRows[0].reserved_amount ?? 0);
  const reservedShort = Number(orderRows[0].reserved_short_margin ?? 0);
  const accountId = orderRows[0].account_id;

  // Refund BUY-side reserved_cash if any.
  if (reserved > 0) {
    const [refund] = await conn.execute(
      "UPDATE paper_accounts SET cash = cash + ?, reserved_cash = reserved_cash - ? WHERE id = ? AND reserved_cash >= ?",
      [reserved, reserved, accountId, reserved]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (refund.affectedRows !== 1) {
      throw new Error(
        `rejectOrder: reserved_cash refund failed for order=${orderId} account=${accountId} reserved=${reserved} — rolling back`
      );
    }
  }
  // W3 — refund SHORT-side reserved_short_margin if any.
  if (reservedShort > 0) {
    const [refundShort] = await conn.execute(
      "UPDATE paper_accounts SET cash = cash + ?, reserved_short_margin = reserved_short_margin - ? WHERE id = ? AND reserved_short_margin >= ?",
      [reservedShort, reservedShort, accountId, reservedShort]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (refundShort.affectedRows !== 1) {
      throw new Error(
        `rejectOrder: reserved_short_margin refund failed for order=${orderId} account=${accountId} reservedShort=${reservedShort} — rolling back`
      );
    }
  }
  if (reserved > 0 || reservedShort > 0) {
    const [clear] = await conn.execute(
      "UPDATE paper_orders SET reserved_amount = 0, reserved_short_margin = 0 WHERE id = ?",
      [orderId]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (clear.affectedRows !== 1) {
      throw new Error(
        `rejectOrder: clearing reservations failed for order=${orderId} — rolling back`
      );
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
    // don't change cash don't need a new snapshot row. `recordEquitySnapshotInTx`
    // THROWS on any DB error so we roll back the fill rather than commit a
    // fill without its matching snapshot (codex F1 — the old advisory-swallow
    // behaviour let the fill commit silently with no snapshot row).
    if (result.filled && accountIdForSnapshot != null) {
      await recordEquitySnapshotInTx(conn, accountIdForSnapshot);
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
 * before fill. Idempotent (checks reserved_amount + reserved_short_margin on
 * the order row and releases both).
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
      "SELECT account_id, reserved_amount, reserved_short_margin FROM paper_orders WHERE id = ?",
      [orderId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (preRows.length === 0) {
      await conn.commit();
      return;
    }
    const accountId = Number(preRows[0].account_id);
    const preReserved = Number(preRows[0].reserved_amount ?? 0);
    const preReservedShort = Number(preRows[0].reserved_short_margin ?? 0);
    if (preReserved <= 0 && preReservedShort <= 0) {
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

    // LOCK STEP 2 — order. Re-read authoritative amounts under lock.
    const [orderRows] = await conn.execute(
      "SELECT account_id, reserved_amount, reserved_short_margin FROM paper_orders WHERE id = ? FOR UPDATE",
      [orderId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (orderRows.length === 0) {
      await conn.commit();
      return;
    }
    const reserved = Number(orderRows[0].reserved_amount ?? 0);
    const reservedShort = Number(orderRows[0].reserved_short_margin ?? 0);
    if (reserved <= 0 && reservedShort <= 0) {
      await conn.commit();
      return;
    }

    if (reserved > 0) {
      const [refund] = await conn.execute(
        "UPDATE paper_accounts SET cash = cash + ?, reserved_cash = reserved_cash - ? WHERE id = ? AND reserved_cash >= ?",
        [reserved, reserved, accountId, reserved]
      ) as [mysqlTypes.ResultSetHeader, unknown];
      if (refund.affectedRows !== 1) {
        throw new Error(
          `releaseReservationForOrder: reserved_cash refund failed for order=${orderId} account=${accountId} reserved=${reserved}`
        );
      }
    }
    if (reservedShort > 0) {
      const [refundShort] = await conn.execute(
        "UPDATE paper_accounts SET cash = cash + ?, reserved_short_margin = reserved_short_margin - ? WHERE id = ? AND reserved_short_margin >= ?",
        [reservedShort, reservedShort, accountId, reservedShort]
      ) as [mysqlTypes.ResultSetHeader, unknown];
      if (refundShort.affectedRows !== 1) {
        throw new Error(
          `releaseReservationForOrder: reserved_short_margin refund failed for order=${orderId} account=${accountId} reservedShort=${reservedShort}`
        );
      }
    }
    const [clear] = await conn.execute(
      "UPDATE paper_orders SET reserved_amount = 0, reserved_short_margin = 0 WHERE id = ?",
      [orderId]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (clear.affectedRows !== 1) {
      throw new Error(
        `releaseReservationForOrder: clear reservations failed for order=${orderId}`
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

/**
 * W3 — reserve SHORT margin for a pending sell-to-open short order.
 * Symmetric to `reserveCashForOrder` but writes to the dedicated
 * `reserved_short_margin` column. Moves `amount` from `cash` into margin.
 *
 * Lock order: accounts → orders.
 */
export async function reserveShortMarginForOrder(
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
      "UPDATE paper_accounts SET cash = cash - ?, reserved_short_margin = reserved_short_margin + ? WHERE id = ? AND cash >= ?",
      [amount, amount, accountId, amount]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (cashResult.affectedRows !== 1) {
      await conn.rollback();
      return false;
    }

    const [orderResult] = await conn.execute(
      "UPDATE paper_orders SET reserved_short_margin = ? WHERE id = ? AND status = 'PENDING'",
      [amount, orderId]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (orderResult.affectedRows !== 1) {
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
 * W3 — atomically adjust the reservation on a PENDING order.
 *
 * Used by `PATCH /api/paper/order` when the user modifies a pending order's
 * `investment_usd`. Moves the delta between old and new reservations from
 * cash ↔ reservation bucket without ever writing the order or account to an
 * invalid intermediate state. If the order is not PENDING, or the account
 * lacks cash for the delta, returns false and makes no change.
 *
 * Which bucket (`reserved_cash` vs `reserved_short_margin`) is picked based
 * on the order's `(side, position_side)`: only BUY+LONG uses `reserved_cash`
 * and only SELL+SHORT uses `reserved_short_margin`. SELL+LONG (close long)
 * and BUY+SHORT (cover short) never reserve so PATCH on those is a no-op
 * (still returns true).
 *
 * Lock order: accounts → orders.
 */
export async function adjustReservation(
  pool: mysqlTypes.Pool,
  orderId: number,
  newInvestment: number
): Promise<{ ok: true; oldAmount: number; newAmount: number } | { ok: false; reason: string }> {
  if (!Number.isFinite(newInvestment) || newInvestment <= 0) {
    return { ok: false, reason: "INVALID_INVESTMENT" };
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [preRows] = await conn.execute(
      "SELECT account_id, side, position_side, status FROM paper_orders WHERE id = ?",
      [orderId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (preRows.length === 0) {
      await conn.rollback();
      return { ok: false, reason: "ORDER_NOT_FOUND" };
    }
    const accountId = Number(preRows[0].account_id);
    const side = String(preRows[0].side) as "BUY" | "SELL";
    const positionSide: "LONG" | "SHORT" = preRows[0].position_side === "SHORT" ? "SHORT" : "LONG";

    // LOCK STEP 1 — accounts.
    await conn.execute(
      "SELECT id FROM paper_accounts WHERE id = ? FOR UPDATE",
      [accountId]
    );

    // LOCK STEP 2 — order. Authoritative state + status guard.
    const [orderRows] = await conn.execute(
      "SELECT * FROM paper_orders WHERE id = ? FOR UPDATE",
      [orderId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (orderRows.length === 0) {
      await conn.rollback();
      return { ok: false, reason: "ORDER_NOT_FOUND" };
    }
    const order = orderRows[0];
    if (order.status !== "PENDING") {
      await conn.rollback();
      return { ok: false, reason: `ORDER_NOT_PENDING_${order.status}` };
    }

    // Determine which bucket this order uses.
    const usesCashReservation = side === "BUY" && positionSide === "LONG";
    const usesShortMargin = side === "SELL" && positionSide === "SHORT";
    if (!usesCashReservation && !usesShortMargin) {
      // Close orders — no reservation to adjust. Just update investment_usd
      // if the column is nullable; but close orders are driven by close_quantity,
      // not investment_usd, so we simply ack.
      await conn.execute(
        "UPDATE paper_orders SET investment_usd = ? WHERE id = ? AND status = 'PENDING'",
        [newInvestment, orderId]
      );
      await conn.commit();
      return { ok: true, oldAmount: 0, newAmount: 0 };
    }

    const oldAmount = usesCashReservation
      ? Number(order.reserved_amount ?? 0)
      : Number(order.reserved_short_margin ?? 0);
    const newAmount = newInvestment;
    const delta = newAmount - oldAmount;

    if (delta > 0) {
      // Need MORE reservation — move delta from cash.
      const col = usesCashReservation ? "reserved_cash" : "reserved_short_margin";
      const [move] = await conn.execute(
        `UPDATE paper_accounts SET cash = cash - ?, ${col} = ${col} + ? WHERE id = ? AND cash >= ?`,
        [delta, delta, accountId, delta]
      ) as [mysqlTypes.ResultSetHeader, unknown];
      if (move.affectedRows !== 1) {
        await conn.rollback();
        return { ok: false, reason: "INSUFFICIENT_CASH" };
      }
    } else if (delta < 0) {
      // LESS reservation — release abs(delta) back to cash.
      const col = usesCashReservation ? "reserved_cash" : "reserved_short_margin";
      const diff = -delta;
      const [move] = await conn.execute(
        `UPDATE paper_accounts SET cash = cash + ?, ${col} = ${col} - ? WHERE id = ? AND ${col} >= ?`,
        [diff, diff, accountId, diff]
      ) as [mysqlTypes.ResultSetHeader, unknown];
      if (move.affectedRows !== 1) {
        await conn.rollback();
        return { ok: false, reason: "RESERVATION_MISSING" };
      }
    }

    // Update the order's investment + reservation field to match.
    const orderCol = usesCashReservation ? "reserved_amount" : "reserved_short_margin";
    const [upd] = await conn.execute(
      `UPDATE paper_orders SET investment_usd = ?, ${orderCol} = ? WHERE id = ? AND status = 'PENDING'`,
      [newAmount, newAmount, orderId]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (upd.affectedRows !== 1) {
      await conn.rollback();
      return { ok: false, reason: "ORDER_RACE_LOST" };
    }

    await conn.commit();
    return { ok: true, oldAmount, newAmount };
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * W3 — lightweight price-field patch for a PENDING order. Allows the UI to
 * change `limit_price` and/or `stop_price` without cancel-and-replace. No
 * reservation math involved — reservation is pinned to `investment_usd` (use
 * `adjustReservation` for that).
 */
export async function patchPendingOrderPrices(
  pool: mysqlTypes.Pool,
  orderId: number,
  patch: { limit_price?: number; stop_price?: number }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const sets: string[] = [];
  const params: (number | null)[] = [];
  if (patch.limit_price != null) {
    if (!Number.isFinite(patch.limit_price) || patch.limit_price <= 0) {
      return { ok: false, reason: "INVALID_LIMIT_PRICE" };
    }
    sets.push("limit_price = ?");
    params.push(patch.limit_price);
  }
  if (patch.stop_price != null) {
    if (!Number.isFinite(patch.stop_price) || patch.stop_price <= 0) {
      return { ok: false, reason: "INVALID_STOP_PRICE" };
    }
    sets.push("stop_price = ?");
    params.push(patch.stop_price);
  }
  if (sets.length === 0) return { ok: true };
  params.push(orderId);
  const [r] = await pool.execute(
    `UPDATE paper_orders SET ${sets.join(", ")} WHERE id = ? AND status = 'PENDING'`,
    params
  ) as [mysqlTypes.ResultSetHeader, unknown];
  if (r.affectedRows !== 1) {
    return { ok: false, reason: "ORDER_NOT_PENDING" };
  }
  return { ok: true };
}

/**
 * W3 hotfix #2 — atomic cancel-with-refund for a PENDING order.
 *
 * The old DELETE /api/paper/order path did (a) releaseReservationForOrder
 * which committed its own transaction, then (b) a separate UPDATE to flip
 * status to CANCELLED. Between those two commits the order is PENDING with
 * reserved_amount = 0 — a concurrent `fillPendingOrders` run could see this
 * half-state and attempt to fill from cash that has already been refunded.
 * Two concurrent DELETEs could also double-refund.
 *
 * Collapsing both steps into ONE transaction under the canonical account →
 * order lock order makes the cancellation observable atomically: either the
 * caller sees PENDING-with-reservation, or CANCELLED-with-zero. No gap.
 *
 * Returns `{cancelled: true}` for the first caller that flips PENDING →
 * CANCELLED. Every later caller returns `{cancelled: false}` — either the
 * order no longer existed, was already cancelled/filled/rejected, or was
 * raced out from under us.
 */
export async function cancelOrderWithRefund(
  pool: mysqlTypes.Pool,
  orderId: number
): Promise<{ cancelled: boolean; reason?: string }> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Pre-read — learn account_id without holding a lock so we can acquire
    // locks in canonical order (accounts → orders). If the order is gone we
    // report {cancelled:false} and commit the empty transaction.
    const [preRows] = await conn.execute(
      "SELECT account_id FROM paper_orders WHERE id = ?",
      [orderId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (preRows.length === 0) {
      await conn.rollback();
      return { cancelled: false, reason: "ORDER_NOT_FOUND" };
    }
    const accountId = Number(preRows[0].account_id);

    // LOCK STEP 1 — account (canonical order).
    const [acctRows] = await conn.execute(
      "SELECT id FROM paper_accounts WHERE id = ? FOR UPDATE",
      [accountId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (acctRows.length === 0) {
      await conn.rollback();
      return { cancelled: false, reason: "ACCOUNT_NOT_FOUND" };
    }

    // LOCK STEP 2 — order. Authoritative status under lock.
    const [orderRows] = await conn.execute(
      "SELECT status, reserved_amount, reserved_short_margin FROM paper_orders WHERE id = ? FOR UPDATE",
      [orderId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (orderRows.length === 0) {
      await conn.rollback();
      return { cancelled: false, reason: "ORDER_NOT_FOUND" };
    }
    const order = orderRows[0];
    if (order.status !== "PENDING") {
      // Already cancelled / filled / rejected — another caller won.
      await conn.rollback();
      return { cancelled: false, reason: `ORDER_NOT_PENDING_${order.status}` };
    }
    const reservedCash = Number(order.reserved_amount ?? 0);
    const reservedShort = Number(order.reserved_short_margin ?? 0);

    // Refund both reservation buckets atomically. Each UPDATE is guarded by a
    // >= check on the destination column so an account with a bad invariant
    // can't silently decrement past zero.
    if (reservedCash > 0) {
      const [refund] = await conn.execute(
        "UPDATE paper_accounts SET cash = cash + ?, reserved_cash = reserved_cash - ? WHERE id = ? AND reserved_cash >= ?",
        [reservedCash, reservedCash, accountId, reservedCash]
      ) as [mysqlTypes.ResultSetHeader, unknown];
      if (refund.affectedRows !== 1) {
        await conn.rollback();
        return { cancelled: false, reason: "RESERVED_CASH_UNDERFLOW" };
      }
    }
    if (reservedShort > 0) {
      const [refundShort] = await conn.execute(
        "UPDATE paper_accounts SET cash = cash + ?, reserved_short_margin = reserved_short_margin - ? WHERE id = ? AND reserved_short_margin >= ?",
        [reservedShort, reservedShort, accountId, reservedShort]
      ) as [mysqlTypes.ResultSetHeader, unknown];
      if (refundShort.affectedRows !== 1) {
        await conn.rollback();
        return { cancelled: false, reason: "RESERVED_SHORT_UNDERFLOW" };
      }
    }

    // Flip the order in the same transaction. Status guard means the first
    // caller to reach here wins; concurrent cancels see affectedRows === 0
    // and roll back (leaving their refund-undo implicit via the rollback).
    const [flip] = await conn.execute(
      "UPDATE paper_orders SET status = 'CANCELLED', reserved_amount = 0, reserved_short_margin = 0 WHERE id = ? AND status = 'PENDING'",
      [orderId]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (flip.affectedRows !== 1) {
      await conn.rollback();
      return { cancelled: false, reason: "ORDER_RACE_LOST" };
    }

    await conn.commit();
    return { cancelled: true };
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}
