/**
 * Shared protective-exit evaluator — W3.
 *
 * Extracted from `scripts/surveillance-cron.ts:jobMonitorPositionsImpl` so the
 * EXACT same logic drives both:
 *   - `paper_signals` (strategy-engine positions, pre-existing behaviour)
 *   - `paper_trades`  (user-placed positions with optional exit bracket, NEW)
 *
 * The caller supplies an `ExitInputs` structure — raw numeric fields — and
 * receives a structured `ExitDecision | null`. No DB writes happen inside
 * `evaluateExits`; that's a pure function so smoke tests can prove behaviour
 * without a live DB. `applyExitDecisionToTrade` writes the final CLOSED row
 * back for `paper_trades`; `paper_signals`' dedicated adapter lives in the
 * cron module (it writes to a different table with different column names).
 *
 * Direction semantics (inherited from the original signal-monitor code):
 *   LONG:  profit when price rises. trailing stop sits BELOW price.
 *   SHORT: profit when price falls. trailing stop sits ABOVE price.
 *
 * Watermarks (`max_pnl_pct`, `min_pnl_pct`) are BEST / WORST direction-aware
 * PnL percentages observed since the position opened. They drive the trailing
 * stop ratchet and surface in analytics.
 */

import type mysqlTypes from "mysql2/promise";
import { recordEquitySnapshotInTx } from "./paper-fill";

export type Side = "LONG" | "SHORT";

export type ExitInputs = {
  /** Current direction-aware entry price. For paper_trades this is `buy_price`. */
  entryPrice: number;
  side: Side;
  /** leverage is signal-only; paper_trades always passes 1. */
  leverage: number;

  /** Absolute hard-stop price (NULL if not set). */
  stopLossPrice: number | null;
  /** Absolute take-profit price (NULL if not set). */
  takeProfitPrice: number | null;

  /** Trailing stop % (e.g. 3 = 3%). NULL disables trailing. */
  trailingStopPct: number | null;
  /** Profit % at which trailing activates (e.g. 5 = activate once up 5%). */
  trailingActivatesAtProfitPct: number | null;
  /** Current ratcheted trailing stop price (may be null before activation). */
  trailingStopPrice: number | null;
  /** 1 once trailing has been activated. */
  trailingActive: boolean;

  /** Date (YYYY-MM-DD) at/after which the position must be closed. */
  timeExitDate: string | null;

  /** Historical best PnL % observed (direction-aware). */
  maxPnlPct: number | null;
  /** Historical worst PnL % observed (direction-aware). */
  minPnlPct: number | null;

  /** Historical highest price observed (for SHORT watermark arithmetic too). */
  maxPrice: number | null;
  minPrice: number | null;
};

export type ExitReason = "HARD_STOP" | "TAKE_PROFIT" | "TRAILING_STOP" | "TIME_EXIT" | "LIQUIDATED";

export type ExitDecision = {
  reason: ExitReason;
  /** Price the position closes at. For ranged exits (stop/take-profit we
   *  close at the triggering price, not the ideal limit — matches
   *  the conservative behaviour of the signal-monitor cron). */
  closePrice: number;
  /** Updated watermarks + trailing state to persist. Always returned so the
   *  caller can write them back even when reason === null (no exit but
   *  max_pnl / trailing_active moved). See `evaluateExitsAlways`. */
  watermarks: {
    maxPnlPct: number;
    minPnlPct: number;
    maxPrice: number;
    minPrice: number;
    trailingActive: boolean;
    trailingStopPrice: number | null;
  };
};

/**
 * Compute direction-aware PnL % given entry + current. Positive = winning.
 * For LONG: (cur - entry) / entry * 100. For SHORT: (entry - cur) / entry * 100.
 */
export function computePnlPct(entryPrice: number, currentPrice: number, side: Side): number {
  if (entryPrice <= 0) return 0;
  const rawPct = ((currentPrice - entryPrice) / entryPrice) * 100;
  return side === "SHORT" ? -rawPct : rawPct;
}

/**
 * Core exit-decision evaluator. Runs ALL checks and returns either:
 *   - `ExitDecision` with `reason` set (one of HARD_STOP / TAKE_PROFIT /
 *     TRAILING_STOP / TIME_EXIT / LIQUIDATED), OR
 *   - `ExitDecision` with `reason` === null-sentinel branch NOT used —
 *     instead `evaluateExitsAlways` wraps this and returns the updated
 *     watermarks + null-reason when no exit triggered.
 *
 * This is the low-level function; most callers want `evaluateExits` which
 * returns `null` when nothing fires.
 *
 * Priority order (matches signal-monitor cron): HARD_STOP > LIQUIDATED >
 * TAKE_PROFIT > TRAILING_STOP > TIME_EXIT. Subsequent rules can overwrite
 * `reason` — same semantics as the cron, preserved for parity.
 */
export function evaluateExitsAlways(
  input: ExitInputs,
  currentPrice: number,
  now: Date
): { reason: ExitReason | null; closePrice: number; watermarks: ExitDecision["watermarks"] } {
  const { entryPrice, side, leverage, stopLossPrice, takeProfitPrice, timeExitDate } = input;
  const trailingStopPct = input.trailingStopPct;
  const activateAt = input.trailingActivatesAtProfitPct ?? 0;

  const pnlPct = computePnlPct(entryPrice, currentPrice, side);
  const leveragedPnl = pnlPct * Math.max(1, leverage || 1);

  // Watermarks — track actual price extremes. Use explicit null checks,
  // not `|| fallback`, because a legitimate watermark of 0 is falsy and would
  // otherwise get swapped with the incoming price.
  const maxPrice = input.maxPrice == null ? currentPrice : Math.max(input.maxPrice, currentPrice);
  const minPrice = input.minPrice == null ? currentPrice : Math.min(input.minPrice, currentPrice);
  const maxPnl = input.maxPnlPct == null ? leveragedPnl : Math.max(input.maxPnlPct, leveragedPnl);
  const minPnl = input.minPnlPct == null ? leveragedPnl : Math.min(input.minPnlPct, leveragedPnl);

  let reason: ExitReason | null = null;

  // 1. Hard stop. Absolute price gate — LONG fires when current <= stopLoss;
  //    SHORT fires when current >= stopLoss (price moved against the short).
  if (stopLossPrice != null && stopLossPrice > 0) {
    const breached = side === "LONG" ? currentPrice <= stopLossPrice : currentPrice >= stopLossPrice;
    if (breached) reason = "HARD_STOP";
  }

  // 2. Leverage liquidation. Matches signal-monitor's -90% gate.
  if ((leverage || 1) > 1 && leveragedPnl <= -90) {
    reason = "LIQUIDATED";
  }

  // 3. Take profit. Absolute price — LONG fires when current >= takeProfit;
  //    SHORT fires when current <= takeProfit.
  if (takeProfitPrice != null && takeProfitPrice > 0) {
    const reached = side === "LONG" ? currentPrice >= takeProfitPrice : currentPrice <= takeProfitPrice;
    if (reached) reason = "TAKE_PROFIT";
  }

  // 4. Trailing stop. If pct not configured, skip entirely. Otherwise:
  //    - activate once pnlPct >= activateAt (matches signal-monitor)
  //    - once active, ratchet stop against the best watermark
  //    - fire when current crosses the stop
  let trailingActive = input.trailingActive;
  let trailingStopPrice = input.trailingStopPrice;
  if (trailingStopPct != null && trailingStopPct > 0) {
    if (!trailingActive && pnlPct >= activateAt) {
      trailingActive = true;
      // Initial stop position relative to CURRENT price (not historical max),
      // so a position that activates exactly at the threshold gets a stop
      // immediately trailing_stop_pct away from current — same as the cron.
      trailingStopPrice = side === "SHORT"
        ? currentPrice * (1 + trailingStopPct / 100)
        : currentPrice * (1 - trailingStopPct / 100);
    }
    if (trailingActive) {
      if (side === "SHORT") {
        // Best SHORT price = lowest observed. Stop sits trailing_stop_pct
        // ABOVE that — ratchets DOWN as price makes new lows.
        const newStop = minPrice * (1 + trailingStopPct / 100);
        if (trailingStopPrice == null || newStop < trailingStopPrice) {
          trailingStopPrice = newStop;
        }
        if (trailingStopPrice != null && currentPrice >= trailingStopPrice) {
          reason = "TRAILING_STOP";
        }
      } else {
        // Best LONG price = highest observed. Stop sits trailing_stop_pct
        // BELOW that — ratchets UP as price makes new highs.
        const newStop = maxPrice * (1 - trailingStopPct / 100);
        if (trailingStopPrice == null || newStop > trailingStopPrice) {
          trailingStopPrice = newStop;
        }
        if (trailingStopPrice != null && currentPrice <= trailingStopPrice) {
          reason = "TRAILING_STOP";
        }
      }
    }
  }

  // 5. Time exit. Date-only comparison — once `now` (in UTC) is at/after the
  //    time_exit_date, close. Intentionally coarse; W4 can upgrade to ET
  //    market-close timing if needed.
  if (timeExitDate) {
    const nowDate = new Date(now.toISOString().slice(0, 10));
    const exitDate = new Date(typeof timeExitDate === "string" ? timeExitDate.slice(0, 10) : timeExitDate);
    if (!isNaN(exitDate.getTime()) && nowDate >= exitDate) {
      reason = "TIME_EXIT";
    }
  }

  return {
    reason,
    closePrice: currentPrice,
    watermarks: {
      maxPnlPct: maxPnl,
      minPnlPct: minPnl,
      maxPrice,
      minPrice,
      trailingActive,
      trailingStopPrice,
    },
  };
}

/**
 * Convenience wrapper — returns `ExitDecision` only when a real exit
 * triggered (reason != null). Used by callers that want to short-circuit and
 * only write back on exit. If the caller also needs to persist updated
 * watermarks on no-exit ticks, call `evaluateExitsAlways` directly.
 */
export function evaluateExits(
  input: ExitInputs,
  currentPrice: number,
  now: Date
): ExitDecision | null {
  const result = evaluateExitsAlways(input, currentPrice, now);
  if (result.reason == null) return null;
  return {
    reason: result.reason,
    closePrice: result.closePrice,
    watermarks: result.watermarks,
  };
}

// ── paper_trades adapter ──────────────────────────────────────────────────
//
// Writes the CLOSED row back and credits cash for LONGs or releases short-
// margin for SHORTs. Obeys the global lock order:
//   paper_accounts → paper_orders → paper_trades → paper_equity_snapshots
//
// Caller MUST have already locked paper_accounts and paper_trades rows (this
// function does NOT lock; it assumes the caller owns an open transaction with
// the right FOR UPDATE rows already held). This matches the existing pattern
// in paper-fill.ts where fillOrderCore locks before mutating.
//
// NOTE: This closes the FULL remaining quantity. For partial close use the
// dedicated path in paper-fill.ts. The exit engine only supports full-close
// because stop/trailing/take-profit are position-level triggers.

export type PaperTradeRow = {
  id: number;
  account_id: number;
  symbol: string;
  side: Side;
  quantity: number;
  closed_quantity: number;
  buy_price: number;
  investment_usd: number;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  trailing_stop_pct: number | null;
  trailing_activates_at_profit_pct: number | null;
  trailing_stop_price: number | null;
  trailing_active: number;
  time_exit_date: string | Date | null;
  max_pnl_pct: number | null;
  min_pnl_pct: number | null;
};

/** Build an `ExitInputs` struct from a paper_trades row. */
export function inputsFromTradeRow(row: PaperTradeRow, maxPrice: number | null, minPrice: number | null): ExitInputs {
  return {
    entryPrice: Number(row.buy_price),
    side: row.side === "SHORT" ? "SHORT" : "LONG",
    leverage: 1,
    stopLossPrice: row.stop_loss_price != null ? Number(row.stop_loss_price) : null,
    takeProfitPrice: row.take_profit_price != null ? Number(row.take_profit_price) : null,
    trailingStopPct: row.trailing_stop_pct != null ? Number(row.trailing_stop_pct) : null,
    trailingActivatesAtProfitPct: row.trailing_activates_at_profit_pct != null ? Number(row.trailing_activates_at_profit_pct) : null,
    trailingStopPrice: row.trailing_stop_price != null ? Number(row.trailing_stop_price) : null,
    trailingActive: Number(row.trailing_active) === 1,
    timeExitDate: row.time_exit_date
      ? (row.time_exit_date instanceof Date
          ? row.time_exit_date.toISOString().slice(0, 10)
          : String(row.time_exit_date).slice(0, 10))
      : null,
    maxPnlPct: row.max_pnl_pct != null ? Number(row.max_pnl_pct) : null,
    minPnlPct: row.min_pnl_pct != null ? Number(row.min_pnl_pct) : null,
    maxPrice,
    minPrice,
  };
}

/**
 * Persist an exit decision AND watermarks to paper_trades + paper_accounts.
 * Wraps its own transaction (acquires a fresh connection). The caller is
 * responsible for passing a pool (not a connection) — the function locks in
 * canonical order internally.
 *
 * This is the ONE place paper_trades exits are written. `monitorPaperTrades`
 * in surveillance-cron calls here. If partial close mechanics need to merge
 * in the future, coordinate via the same lock order.
 */
export async function applyExitDecisionToTrade(
  pool: mysqlTypes.Pool,
  tradeId: number,
  currentPrice: number,
  decision: ExitDecision
): Promise<{ closed: boolean; pnlUsd: number; remainingQty: number }> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Pre-read — resolve account_id so we can lock accounts FIRST. No FOR
    // UPDATE here; it's just to learn the account_id.
    const [preRows] = await conn.execute(
      "SELECT account_id, side, quantity, closed_quantity, buy_price, investment_usd FROM paper_trades WHERE id = ?",
      [tradeId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (preRows.length === 0) {
      await conn.rollback();
      return { closed: false, pnlUsd: 0, remainingQty: 0 };
    }
    const accountId = Number(preRows[0].account_id);

    // LOCK STEP 1 — account (canonical order).
    const [acctRows] = await conn.execute(
      "SELECT id, cash, reserved_short_margin FROM paper_accounts WHERE id = ? FOR UPDATE",
      [accountId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (acctRows.length === 0) {
      await conn.rollback();
      return { closed: false, pnlUsd: 0, remainingQty: 0 };
    }

    // LOCK STEP 2 — trade. Authoritative state under lock.
    const [tradeRows] = await conn.execute(
      "SELECT * FROM paper_trades WHERE id = ? AND status = 'OPEN' FOR UPDATE",
      [tradeId]
    ) as [mysqlTypes.RowDataPacket[], unknown];
    if (tradeRows.length === 0) {
      await conn.rollback();
      return { closed: false, pnlUsd: 0, remainingQty: 0 };
    }
    const trade = tradeRows[0];
    const side = trade.side === "SHORT" ? "SHORT" : "LONG";
    const totalQty = Number(trade.quantity);
    const alreadyClosed = Number(trade.closed_quantity ?? 0);
    const remaining = Math.max(0, totalQty - alreadyClosed);
    if (remaining <= 0) {
      // Nothing left to close — concurrent partial-close raced us. Commit
      // empty and return false. The monitor tick is idempotent.
      await conn.rollback();
      return { closed: false, pnlUsd: 0, remainingQty: 0 };
    }
    const entryPrice = Number(trade.buy_price);
    const investment = Number(trade.investment_usd);
    // (investmentShare removed round-3: SHORT cover now uses `buy_price *
    //  remaining` for margin release, not `investment * remaining/totalQty`.
    //  Under Option A, investment_usd stores NOMINAL for both sides; margin
    //  holds adj*qty = buy_price*qty. Releasing nominal would over-release.)
    const proceeds = remaining * currentPrice;
    const pnlUsd = side === "SHORT"
      ? (entryPrice - currentPrice) * remaining
      : (currentPrice - entryPrice) * remaining;

    // Mark CLOSED. Include accumulated pnl from any prior partial closes
    // (existing pnl_usd value) plus this final leg.
    const existingPnl = Number(trade.pnl_usd ?? 0);
    const finalPnl = existingPnl + pnlUsd;
    // pnl_pct is ALWAYS measured against the full original investment in this
    // project's model (matches paper-fill.ts:521 full-close path). If the user
    // already partial-closed part of the position, `finalPnl` accumulates
    // those realized legs; dividing by `investmentShare` (slice) would give a
    // pct that's inconsistent with `finalPnl` (total). So divide by the full
    // `investment`. See hotfix #1 (2026-04-21).
    const finalPnlPct = investment > 0 ? (finalPnl / investment) * 100 : 0;
    // For LONG: sell_price = close. For SHORT: same — sell_price is the
    // closing (cover) price regardless of direction; the sign of pnl_usd
    // tells direction-aware profitability.
    const [tradeUpdate] = await conn.execute(
      `UPDATE paper_trades
          SET status='CLOSED', sell_price=?, sell_date=CURRENT_DATE,
              pnl_usd=?, pnl_pct=?,
              closed_quantity = quantity,
              max_pnl_pct=?, min_pnl_pct=?,
              trailing_active=?, trailing_stop_price=?,
              exit_reason=?
        WHERE id=? AND status='OPEN'`,
      [
        currentPrice,
        finalPnl,
        finalPnlPct,
        decision.watermarks.maxPnlPct,
        decision.watermarks.minPnlPct,
        decision.watermarks.trailingActive ? 1 : 0,
        decision.watermarks.trailingStopPrice,
        decision.reason,
        tradeId,
      ]
    ) as [mysqlTypes.ResultSetHeader, unknown];
    if (tradeUpdate.affectedRows !== 1) {
      // Race — another monitor tick or manual close already flipped this row.
      await conn.rollback();
      return { closed: false, pnlUsd: 0, remainingQty: 0 };
    }

    // Cash/margin arithmetic — differs by side.
    if (side === "LONG") {
      // Credit proceeds to cash. Account locked above so no contention.
      const [credit] = await conn.execute(
        "UPDATE paper_accounts SET cash = cash + ? WHERE id = ?",
        [proceeds, accountId]
      ) as [mysqlTypes.ResultSetHeader, unknown];
      if (credit.affectedRows !== 1) {
        await conn.rollback();
        return { closed: false, pnlUsd: 0, remainingQty: 0 };
      }
    } else {
      // SHORT cover — matches paper-fill's SHORT_COVER branch.
      //
      // Codex round-3: margin bucket holds `adj_open * qty = buy_price * qty`
      // (NOT nominal investment_usd). Round-2 fixed the open-side to seat
      // margin at adj*qty; this path must release THAT amount, not the
      // nominal `investmentShare`.
      //
      // Accounting on cover:
      //   marginRelease = buy_price * remaining_qty
      //                 = adj_open * remaining_qty (the actual dollars held)
      //   cashCredit    = 2 * marginRelease - proceeds
      //                 = marginRelease + pnlSlice
      //   margin -= marginRelease
      //
      // Auto-exits don't apply slippage (the trigger price IS the fill) and
      // don't charge commission here (paper-exits is the legacy direct-close
      // path; W4 slippage/commission flow through paper-fill.ts fillOrder).
      // See paper-fill.ts:763 for the equivalent explicit-fill path.
      const marginRelease = entryPrice * remaining;
      const cashCredit = 2 * marginRelease - proceeds;
      const [release] = await conn.execute(
        "UPDATE paper_accounts SET reserved_short_margin = reserved_short_margin - ?, cash = cash + ? WHERE id = ? AND reserved_short_margin >= ?",
        [marginRelease, cashCredit, accountId, marginRelease]
      ) as [mysqlTypes.ResultSetHeader, unknown];
      if (release.affectedRows !== 1) {
        await conn.rollback();
        return { closed: false, pnlUsd: 0, remainingQty: 0 };
      }
    }

    // C2 — record equity snapshot in-transaction, mirroring the manual-exit
    // path in `fillOrder`. Auto-exits (hard stop / trailing / time / TP)
    // trigger real cash movement and must leave an equity curve data point,
    // otherwise the hourly snapshot cron produces a gap that looks like a
    // dead hour rather than a known close event. Throws on error so the
    // caller rolls back — no committing a closed trade without its snapshot.
    await recordEquitySnapshotInTx(conn, accountId);

    await conn.commit();
    return { closed: true, pnlUsd, remainingQty: 0 };
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Write updated watermarks (max/min PnL + trailing state) WITHOUT closing
 * the position. Called on monitor ticks where no exit triggered but one of
 * those columns moved. Lightweight — no account lock.
 */
export async function persistWatermarks(
  pool: mysqlTypes.Pool,
  tradeId: number,
  maxPnlPct: number,
  minPnlPct: number,
  trailingActive: boolean,
  trailingStopPrice: number | null
): Promise<void> {
  await pool.execute(
    `UPDATE paper_trades
        SET max_pnl_pct=?, min_pnl_pct=?,
            trailing_active=?, trailing_stop_price=?
      WHERE id=? AND status='OPEN'`,
    [maxPnlPct, minPnlPct, trailingActive ? 1 : 0, trailingStopPrice, tradeId]
  );
}
