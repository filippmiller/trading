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
import {
  filterTradableSymbols,
  getLastCloseMap,
  checkFillPriceDeviation,
  WhitelistLookupError,
} from "@/lib/paper-risk";

/**
 * Per-item idempotency key validator. Mirrors the single-order route's
 * CLIENT_REQUEST_ID_RE (8..64 chars, `[A-Za-z0-9_-]`) so both endpoints
 * share the same client contract. Clients generate `${batchId}-${index}`
 * style keys so a retry of the same batch re-hits the same slot for each
 * row (see `paper_orders.idx_paper_orders_client_request_id` UNIQUE INDEX
 * on `(account_id, client_request_id)`).
 */
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

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
 *
 * ORDER-DEPENDENT EXECUTION — IMPORTANT:
 *   Rows are processed SEQUENTIALLY in request order. Each fill mutates
 *   the account's cash / short-margin reserves BEFORE the next row is
 *   attempted. Two payloads with identical rows but different order can
 *   produce different outcomes near buying-power limits — e.g. a batch of
 *   [$80k AAPL, $80k MSFT] on a $100k account fills AAPL and rejects MSFT,
 *   while [$80k MSFT, $80k AAPL] fills MSFT and rejects AAPL.
 *
 *   Clients should therefore either:
 *   (a) sort rows deterministically client-side before submitting, OR
 *   (b) treat batch results as execution-order-dependent and surface the
 *       rejection reason to the user so they can re-submit a smaller
 *       basket.
 *
 *   This is a conscious design choice — matches how real retail brokers
 *   handle basket entries — but it means "submit the same batch twice" is
 *   NOT the same as "this is a set operation." The idempotency layer (via
 *   `client_request_id`) ensures a literal retry produces the same result,
 *   but reordering produces different results.
 *
 * SYNTHETIC FILL PROVENANCE:
 *   All orders inserted here are marked `paper_orders.is_manual_fill=1`
 *   (vs `0` for rows from /api/paper/order which go through RTH + live-
 *   price). Downstream analytics that want realistic P&L attribution
 *   should filter synthetic fills out. Do NOT rely on `order_type='MARKET'`
 *   as a synonym for "live quote, RTH-gated" — this endpoint writes
 *   MARKET orders that were filled at caller-supplied prices.
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
  // Bumped from 20 → 50 after review: 20% was too tight for volatile
  // penny/low-float names that can trade in 30-50% daily ranges. The Zod
  // upper bound is a fat-finger guard, NOT a strategy policy — a 50% trail
  // is still absurd for blue-chips, but rejecting it on the server would
  // encode "no volatile names" into the API instead of the client.
  trailing_stop_pct: z.number().min(0.1).max(50).optional(),
  // Per-item idempotency key. If the same key is submitted twice on the
  // same account, the second call returns the stored row instead of
  // inserting a duplicate (same contract as /api/paper/order's
  // `client_request_id`). Clients should generate `${batchId}-${index}`
  // so a retried batch re-hits the same slot for every row.
  client_request_id: z.string().regex(CLIENT_REQUEST_ID_RE, {
    message: "client_request_id must be 8-64 chars matching [A-Za-z0-9_-]+",
  }).optional(),
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
  | { symbol: string; status: "filled"; order_id: number; trade_id: number; fill_price: number; quantity: number; idempotent_replay?: true }
  | { symbol: string; status: "rejected"; reason: string; order_id?: number; idempotent_replay?: true }
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

    // BULK whitelist check — one IN(...) query instead of N sequential
    // SELECTs. The response Set contains only the symbols currently marked
    // `active=1 AND asset_class='EQUITY'`. Cold-start DB failure surfaces
    // as WhitelistLookupError so we can mark every row "error" (retryable)
    // rather than falsely rejecting each one as SYMBOL_NOT_TRADABLE.
    let tradableSet: Set<string> | null = null;
    let whitelistUnavailable = false;
    try {
      tradableSet = await filterTradableSymbols(parsedBody.orders.map((o) => o.symbol));
    } catch (err) {
      if (err instanceof WhitelistLookupError) {
        whitelistUnavailable = true;
      } else {
        throw err;
      }
    }

    // Bulk fetch last-known-close per symbol so the per-row deviation
    // check is cheap. Missing-from-map means prices_daily has no row for
    // that symbol — the route allows that case through (`checkFillPriceDeviation`
    // returns ok when lastClose is null). This matches the paper-trading
    // mental model: the user is free to fill at any price when we have no
    // reference; the band only fires when we can prove deviation is absurd.
    // One query instead of N sequential SELECTs (same rationale as the
    // filterTradableSymbols batching).
    let lastCloseMap: Map<string, number> = new Map();
    try {
      lastCloseMap = await getLastCloseMap(parsedBody.orders.map((o) => o.symbol));
    } catch (err) {
      // Best-effort — if prices_daily is unavailable, fall through with an
      // empty map. Every row will be allowed (no reference to deviate from).
      // Surface the drift in logs so Ops can catch the missing-backfill
      // class of bug.
      console.warn(
        "[batch-order] getLastCloseMap failed — deviation band effectively disabled this call:",
        err instanceof Error ? err.message : String(err),
      );
    }

    const results: PerRowResult[] = [];

    for (const item of parsedBody.orders) {
      const symbol = item.symbol;

      if (whitelistUnavailable) {
        results.push({ symbol, status: "error", reason: "WHITELIST_UNAVAILABLE" });
        continue;
      }
      if (!tradableSet!.has(symbol)) {
        results.push({ symbol, status: "rejected", reason: "SYMBOL_NOT_TRADABLE" });
        continue;
      }

      // Fat-finger guard: reject fill prices absurdly far from last close.
      // Closes the "catastrophic success" footgun — without this, `fill_price=$1`
      // on a $300 stock would silently print +$299/share of fake equity on
      // the paper account. `checkFillPriceDeviation` returns ok when the
      // reference close is unknown (map miss) so we fail open on data gaps.
      const devCheck = checkFillPriceDeviation(item.fill_price, lastCloseMap.get(symbol));
      if (!devCheck.ok) {
        results.push({ symbol, status: "rejected", reason: devCheck.reason });
        continue;
      }

      // LONG → BUY+LONG (open long). SHORT → SELL+SHORT (open short).
      const side: "BUY" | "SELL" = item.side === "LONG" ? "BUY" : "SELL";
      const positionSide: "LONG" | "SHORT" = item.side;
      const investmentUsd = Number((item.qty * item.fill_price).toFixed(4));
      const clientRequestId = item.client_request_id ?? null;

      // Idempotency pre-check mirrors /api/paper/order. If the caller
      // submitted this key before on this account, return the stored row
      // instead of inserting a duplicate. The account-scoped WHERE is
      // required — a UNIQUE(account_id, client_request_id) means the same
      // key CAN legally exist on another account, and replays MUST be
      // scoped to the submitting account to avoid leaking cross-account
      // rows.
      if (clientRequestId != null) {
        try {
          // LEFT JOIN paper_trades → pull the actual fill quantity on FILLED
          // replays. `paper_orders.quantity` is NULL for open orders sized by
          // `investment_usd`; the real quantity lives on the linked
          // paper_trades row. A non-FILLED replay returns NULL trade_quantity,
          // which we map to 0 in the "rejected" branch where it isn't
          // surfaced anyway.
          const [existing] = await pool.execute<mysql.RowDataPacket[]>(
            `SELECT o.id, o.status, o.filled_price, o.trade_id, o.rejection_reason, t.quantity AS trade_quantity
             FROM paper_orders o LEFT JOIN paper_trades t ON t.id = o.trade_id
             WHERE o.account_id = ? AND o.client_request_id = ? LIMIT 1`,
            [account.id, clientRequestId],
          );
          if (existing.length > 0) {
            const e = existing[0];
            const eStatus = String(e.status);
            if (eStatus === "FILLED") {
              results.push({
                symbol,
                status: "filled",
                order_id: Number(e.id),
                trade_id: Number(e.trade_id),
                fill_price: Number(e.filled_price),
                quantity: Number(e.quantity ?? 0),
                idempotent_replay: true,
              });
            } else {
              // PENDING / REJECTED / CANCELLED replays all map to "rejected"
              // with the stored reason (or the raw status). Keeping the
              // original order_id in the payload lets the client still
              // surface "order #123 already placed" UX.
              results.push({
                symbol,
                status: "rejected",
                reason: e.rejection_reason ? String(e.rejection_reason) : `IDEMPOTENT_REPLAY: ${eStatus}`,
                order_id: Number(e.id),
                idempotent_replay: true,
              });
            }
            continue;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ symbol, status: "error", reason: `idempotency check failed: ${msg.slice(0, 160)}` });
          continue;
        }
      }

      let orderId: number;
      try {
        // `is_manual_fill=1` flags these as batch-paper-fills: filled at
        // caller-supplied `fill_price`, NOT against a live quote. Lets
        // downstream analytics filter synthetic fills out of P&L attribution.
        // The column defaults to 0 on every paper_orders row, so single-order
        // inserts from /api/paper/order stay at 0 without code change there.
        const [ins] = await pool.execute<mysql.ResultSetHeader>(
          `INSERT INTO paper_orders
           (account_id, symbol, side, position_side, order_type,
            investment_usd, limit_price, stop_price, trade_id, close_quantity, notes,
            bracket_stop_loss_pct, bracket_take_profit_pct, bracket_trailing_pct,
            bracket_trailing_activates_pct, bracket_time_exit_days,
            client_request_id, is_manual_fill, status)
           VALUES (?, ?, ?, ?, 'MARKET', ?, NULL, NULL, NULL, NULL, 'BATCH', ?, ?, ?, NULL, NULL, ?, 1, 'PENDING')`,
          [
            account.id,
            symbol,
            side,
            positionSide,
            investmentUsd,
            item.stop_loss_pct ?? null,
            item.take_profit_pct ?? null,
            item.trailing_stop_pct ?? null,
            clientRequestId,
          ],
        );
        orderId = ins.insertId;
      } catch (err) {
        // errno 1062 = UNIQUE on (account_id, client_request_id). A
        // concurrent POST raced past the pre-check and inserted first;
        // re-SELECT and return its state so the replay semantic holds
        // end-to-end (TOCTOU close — same pattern as single-order route).
        if ((err as { errno?: number }).errno === 1062 && clientRequestId) {
          try {
            // Hotfix (Codex-3 finding, 2026-04-22): SYMMETRY with the
            // pre-check branch. The prior version read `paper_orders.quantity`,
            // but the batch path NEVER sets that column (it sizes by
            // `investment_usd`), so the replay returned quantity: 0 for
            // every FILLED idempotent replay via the 1062-race path. The
            // real quantity lives on the linked paper_trades row; LEFT JOIN
            // pulls it back. Must match the pre-check SELECT exactly so
            // both replay paths return identical payloads.
            const [existing] = await pool.execute<mysql.RowDataPacket[]>(
              `SELECT o.id, o.status, o.filled_price, o.trade_id, o.rejection_reason, t.quantity AS trade_quantity
               FROM paper_orders o LEFT JOIN paper_trades t ON t.id = o.trade_id
               WHERE o.account_id = ? AND o.client_request_id = ? LIMIT 1`,
              [account.id, clientRequestId],
            );
            if (existing.length > 0) {
              const e = existing[0];
              const eStatus = String(e.status);
              if (eStatus === "FILLED") {
                results.push({
                  symbol,
                  status: "filled",
                  order_id: Number(e.id),
                  trade_id: Number(e.trade_id),
                  fill_price: Number(e.filled_price),
                  quantity: Number(e.trade_quantity ?? 0),
                  idempotent_replay: true,
                });
              } else {
                results.push({
                  symbol,
                  status: "rejected",
                  reason: e.rejection_reason ? String(e.rejection_reason) : `IDEMPOTENT_REPLAY: ${eStatus}`,
                  order_id: Number(e.id),
                  idempotent_replay: true,
                });
              }
              continue;
            }
          } catch { /* fall through to generic error */ }
        }
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
          results.push({ symbol, status: "rejected", reason: fill.rejection, order_id: orderId });
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
