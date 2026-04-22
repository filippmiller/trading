/**
 * W4 — Paper-trading economic realism: slippage, commission, symbol whitelist,
 * fractional-share mode, short-borrow cost.
 *
 * This module is the SINGLE source of truth for risk-model configuration and
 * the pure functions that apply it to a fill. `paper-fill.ts` calls into
 * `applySlippage` and `applyCommission` inside `fillOrderCore` BEFORE the
 * trade row is written, so the paper_trades.slippage_usd and .commission_usd
 * columns reflect the exact numbers the cash ledger was debited with.
 *
 * Config is loaded from `app_settings` (key-value rows seeded by the
 * migration). Loader caches aggressively — settings rarely change during a
 * fill, so we accept up-to 30s of staleness in exchange for not hitting the
 * DB on every order. A manual override hook (`_setRiskConfigForTest`) lets
 * the smoke test pin deterministic values without racing the cache TTL.
 *
 * SEMANTICS — SLIPPAGE:
 *   For MARKET BUYs the fill price moves UP by `bps` (adverse for the buyer).
 *   For MARKET SELLs (opening SHORT or closing LONG) the fill price moves
 *   DOWN by `bps` (adverse for the seller). LIMIT/STOP orders default to
 *   ZERO slippage — the user already accepted the worst price by setting
 *   the trigger. The `slippage_usd` recorded on the trade row equals
 *   `qty * abs(adjustedPrice - basePrice)` — the total economic cost of
 *   the slippage for this fill.
 *
 * SEMANTICS — COMMISSION:
 *   `commission = max(min_per_leg, per_share * quantity)`. Default $0.005/share
 *   with $1.00 minimum mirrors Alpaca's retail schedule. Commission is debited
 *   in ADDITION to investment on open and ADDITION to close-proceeds on exit
 *   (i.e. the trader's round-trip commission cost is 2 × fee).
 *
 * LOCK ORDER: These functions do NOT touch the DB and therefore do NOT
 * acquire locks. They run INSIDE the caller's transaction (paper-fill.ts's
 * `fillOrderCore`) which holds accounts → orders → trades locks already.
 * Config loading happens OUTSIDE that transaction via `loadRiskConfig()` to
 * avoid deadlocking the writer if app_settings ever needs a lock upgrade.
 */

import { getPool, mysql } from "@/lib/db";

export type RiskConfig = {
  /** Market-order adverse slippage in basis points. 5 = 0.05%. */
  slippageBps: number;
  /** Per-share commission in USD. */
  commissionPerShare: number;
  /** Minimum commission per leg (open OR close separately). */
  commissionMinPerLeg: number;
  /** If false, fills floor qty to integer and reject if floor yields 0. */
  allowFractionalShares: boolean;
  /** Annualized % borrow cost seeded on new SHORT opens when the form
   *  doesn't override. Used by the nightly borrow-cost accrual cron. */
  defaultBorrowRatePct: number;
};

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  slippageBps: 5,
  commissionPerShare: 0.005,
  commissionMinPerLeg: 1.0,
  allowFractionalShares: true,
  defaultBorrowRatePct: 2.5,
};

const CACHE_TTL_MS = 30_000;
let _cache: { cfg: RiskConfig; at: number } | null = null;
let _override: RiskConfig | null = null;

/**
 * Load the risk config from `app_settings`. Cached for 30s. Falls back to
 * DEFAULT_RISK_CONFIG when a key is missing or malformed so a half-migrated
 * DB still fills orders (with safe defaults) rather than 500ing.
 *
 * The override slot (`_setRiskConfigForTest`) short-circuits the cache so
 * smoke tests can pin a value without racing the TTL.
 *
 * Hotfix 2026-04-22 (Bug #3): distinguish "table missing" (legitimate —
 * still booting / fresh DB) from "any other DB error" (op signal — silent
 * drift would be worse than a visible log). On any non-table-missing
 * exception we STILL return DEFAULT (breaking the fill engine is worse
 * than drifting to defaults), but we `console.warn` the error message so
 * the drift shows up in Railway logs as an operational signal. Pragmatic
 * middle ground between "always silent" and "throw and break fills".
 */
export async function loadRiskConfig(): Promise<RiskConfig> {
  if (_override) return _override;
  const now = Date.now();
  if (_cache && (now - _cache.at) < CACHE_TTL_MS) return _cache.cfg;
  try {
    const pool = await getPool();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT `key`, `value` FROM app_settings WHERE `key` LIKE 'risk.%'"
    );
    const map: Record<string, string> = {};
    for (const r of rows) map[String(r.key)] = String(r.value);
    const cfg: RiskConfig = {
      slippageBps: parseNumberOr(map["risk.slippage_bps"], DEFAULT_RISK_CONFIG.slippageBps),
      commissionPerShare: parseNumberOr(map["risk.commission_per_share"], DEFAULT_RISK_CONFIG.commissionPerShare),
      commissionMinPerLeg: parseNumberOr(map["risk.commission_min_per_leg"], DEFAULT_RISK_CONFIG.commissionMinPerLeg),
      allowFractionalShares: parseBoolOr(map["risk.allow_fractional_shares"], DEFAULT_RISK_CONFIG.allowFractionalShares),
      defaultBorrowRatePct: parseNumberOr(map["risk.default_borrow_rate_pct"], DEFAULT_RISK_CONFIG.defaultBorrowRatePct),
    };
    _cache = { cfg, at: now };
    return cfg;
  } catch (err: unknown) {
    // MySQL errno 1146 = "Table doesn't exist" — legitimate during initial
    // boot before ensureSchema finishes. Silent fallback is correct here.
    // Any OTHER exception (connection lost, permission denied, malformed
    // rows, post-migration schema skew) means the user's configured risk
    // values are being silently ignored — log.warn so it surfaces in ops.
    const e = err as { errno?: number; code?: string; message?: string };
    const isTableMissing = e.errno === 1146 || e.code === "ER_NO_SUCH_TABLE";
    if (!isTableMissing) {
      console.warn(
        `[paper-risk] loadRiskConfig failed, using DEFAULT_RISK_CONFIG: ${e.message ?? String(err)}`
      );
    }
    return DEFAULT_RISK_CONFIG;
  }
}

/** Testing hook — pin a fixed config for deterministic smoke runs. */
export function _setRiskConfigForTest(cfg: RiskConfig | null): void {
  _override = cfg;
  _cache = null;
}

/**
 * Invalidate the in-process cache so the next `loadRiskConfig()` call re-reads
 * `app_settings`. Called by the PATCH endpoint after a risk-knob edit so
 * subsequent fills pick up the new value immediately instead of waiting out
 * the 30s TTL. Does NOT clear `_override` (tests stay pinned).
 */
export function invalidateRiskConfigCache(): void {
  _cache = null;
}

function parseNumberOr(v: string | undefined, fallback: number): number {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolOr(v: string | undefined, fallback: boolean): boolean {
  if (v == null) return fallback;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return fallback;
}

/**
 * Adverse-slippage adjustment for a fill price.
 *
 * @param basePrice  The pre-slippage quote price (Yahoo live).
 * @param side       BUY or SELL of the ORDER (not position side).
 * @param orderType  MARKET applies slippage; LIMIT/STOP return basePrice.
 * @param cfg        Risk config (see `loadRiskConfig()`).
 * @returns the adjusted fill price. Always > 0 when basePrice > 0.
 *
 * MARKET BUY:  price * (1 + bps/10000) — buyer pays a hair extra
 * MARKET SELL: price * (1 - bps/10000) — seller gets a hair less
 * LIMIT/STOP:  price unchanged
 */
export function applySlippage(
  basePrice: number,
  side: "BUY" | "SELL",
  orderType: "MARKET" | "LIMIT" | "STOP",
  cfg: RiskConfig
): number {
  if (!Number.isFinite(basePrice) || basePrice <= 0) return basePrice;
  if (orderType !== "MARKET") return basePrice;
  const edgePct = cfg.slippageBps / 10_000;
  if (side === "BUY") return basePrice * (1 + edgePct);
  return basePrice * (1 - edgePct);
}

/**
 * Commission for a fill given quantity and trade size.
 *
 * commission = max(min_per_leg, per_share * quantity)
 *
 * Per-leg means open and close are independently charged — a round trip
 * costs 2 × this amount.
 *
 * @param quantity  Shares in this fill (may be fractional).
 * @param sizeUsd   The investment USD — RESERVED for percentage-based tiers
 *                  (not used in the default $/share schedule; kept on the
 *                  signature so future tiered models don't break callers).
 * @param cfg       Risk config.
 * @returns commission in USD, always ≥ 0 and finite.
 */
export function applyCommission(
  quantity: number,
  sizeUsd: number,
  cfg: RiskConfig
): number {
  void sizeUsd; // not used in default schedule; reserved for future tiers
  if (!Number.isFinite(quantity) || quantity <= 0) return cfg.commissionMinPerLeg;
  const perShareCost = cfg.commissionPerShare * quantity;
  return Math.max(cfg.commissionMinPerLeg, perShareCost);
}

/**
 * Total economic slippage in dollars for a fill — the gap between base and
 * adjusted price times the quantity. Always ≥ 0.
 */
export function slippageCostUsd(
  basePrice: number,
  adjustedPrice: number,
  quantity: number
): number {
  if (!Number.isFinite(basePrice) || !Number.isFinite(adjustedPrice) || !Number.isFinite(quantity)) return 0;
  return Math.abs(adjustedPrice - basePrice) * Math.max(0, quantity);
}

/**
 * Floor quantity to integer when fractional shares are disabled.
 *
 * @returns `{ quantity, rejected }`. `rejected=true` means the floored
 *          result is 0 so the caller must reject with INSUFFICIENT_INVESTMENT.
 *          When fractional is allowed the quantity passes through unchanged.
 */
export function normalizeQuantity(
  quantity: number,
  cfg: RiskConfig
): { quantity: number; rejected: boolean } {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { quantity: 0, rejected: true };
  }
  if (cfg.allowFractionalShares) {
    return { quantity, rejected: false };
  }
  const floored = Math.floor(quantity);
  if (floored <= 0) return { quantity: 0, rejected: true };
  return { quantity: floored, rejected: false };
}

/**
 * Thrown by `isSymbolTradable` when the whitelist table can't be queried
 * (DB cold-start, connection loss, schema skew). Distinguishes "DB failed"
 * from "symbol genuinely not in whitelist" so the API boundary can surface
 * a 503 instead of a misleading 400 SYMBOL_NOT_TRADABLE.
 */
export class WhitelistLookupError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`Whitelist lookup failed: ${msg}`);
    this.name = "WhitelistLookupError";
    this.cause = cause;
  }
}

/**
 * Whitelist check — is this symbol currently tradable?
 *
 * Returns true if the symbol is present in `tradable_symbols` with
 * active=1 AND asset_class='EQUITY'. Returns false on absence (whitelist
 * enforcement).
 *
 * THROWS `WhitelistLookupError` on any DB error — distinguishes "symbol not
 * whitelisted" (deterministic rejection) from "DB unavailable, unknown" so
 * the route can surface 503 to the user instead of a misleading
 * SYMBOL_NOT_TRADABLE 400. Closes the cold-start window where users saw
 * their AAPL orders rejected as "invalid" during a Railway DB restart.
 *
 * In dev/CI mode where the whitelist is empty, all symbols are rejected —
 * the seed script (`scripts/sync-tradable-symbols.ts`) MUST have run, or
 * the smoke tests must insert their test symbols into the table.
 */
export async function isSymbolTradable(symbol: string): Promise<boolean> {
  if (!symbol || typeof symbol !== "string") return false;
  try {
    const pool = await getPool();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT 1 FROM tradable_symbols WHERE symbol = ? AND active = 1 AND asset_class = 'EQUITY' LIMIT 1",
      [symbol.toUpperCase()]
    );
    return rows.length > 0;
  } catch (err) {
    // Operational signal — surface drift in logs so the 503 is traceable.
    // Bare `console.warn` is consistent with loadRiskConfig's drift-log
    // pattern; no logger framework in this codebase yet.
    console.warn(
      "[paper-risk] isSymbolTradable: whitelist lookup failed for",
      symbol,
      "— returning WhitelistLookupError:",
      err instanceof Error ? err.message : String(err)
    );
    throw new WhitelistLookupError(err);
  }
}

/**
 * Bulk whitelist lookup — returns the subset of the input symbols that are
 * currently tradable (active EQUITY rows in `tradable_symbols`). Designed
 * for the batch-order endpoint so N tickers cost ONE round-trip instead of
 * N sequential SELECTs.
 *
 * Contract mirrors `isSymbolTradable`:
 *   - input symbols are uppercased before the IN (...) query
 *   - returns a Set<string> of UPPERCASE symbols that matched
 *   - THROWS `WhitelistLookupError` on any DB error (same cold-start
 *     semantics as the single-symbol variant so the route can surface 503
 *     instead of falsely rejecting every symbol as SYMBOL_NOT_TRADABLE)
 *
 * Empty input → empty Set, no DB call. Duplicate inputs are de-duped
 * before the query.
 */
export async function filterTradableSymbols(symbols: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!Array.isArray(symbols) || symbols.length === 0) return out;
  const unique = Array.from(
    new Set(
      symbols
        .filter((s) => typeof s === "string" && s.length > 0)
        .map((s) => s.toUpperCase()),
    ),
  );
  if (unique.length === 0) return out;
  try {
    const pool = await getPool();
    const placeholders = unique.map(() => "?").join(",");
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT symbol FROM tradable_symbols WHERE symbol IN (${placeholders}) AND active = 1 AND asset_class = 'EQUITY'`,
      unique,
    );
    for (const r of rows) out.add(String(r.symbol).toUpperCase());
    return out;
  } catch (err) {
    // Same drift-visibility pattern as isSymbolTradable: surface the failure
    // in logs so a 503 from the route has a traceable cause.
    console.warn(
      "[paper-risk] filterTradableSymbols: bulk whitelist lookup failed for",
      unique.length,
      "symbols — returning WhitelistLookupError:",
      err instanceof Error ? err.message : String(err),
    );
    throw new WhitelistLookupError(err);
  }
}

/**
 * Lazy-insert a symbol into the whitelist if missing. Designed for the
 * surveillance enrollment paths (MOVERS + TREND) so the /reversal matrix
 * and the `tradable_symbols` whitelist stay in sync without a manual
 * `sync-tradable-symbols.ts --refresh` step.
 *
 * Safe-by-construction: Yahoo's day_gainers / day_losers and the TREND
 * multi-day scan only return symbols that actually trade on US exchanges,
 * so any enrollment is a legitimate paper-trade target. The curated CSV
 * seed remains the "base" whitelist (and the `sync-tradable-symbols.ts`
 * source of truth for any operator-driven refresh); this function expands
 * coverage at runtime as the enrollment surface grows.
 *
 * Best-effort: any failure is logged but does NOT throw. Enrollment is
 * the canonical side-effect; whitelist sync is advisory. `INSERT IGNORE`
 * makes re-adding the same symbol a no-op — idempotent on every call.
 *
 * Columns: `exchange` is set to `'LAZY_SYNC'` so lazy-added rows are
 * distinguishable from the curated-CSV seed (which carries `'NASDAQ'` or
 * `'NYSE'`). This closes a foot-gun flagged in review: if future code
 * ever adds a "filter by exchange" surface, the lazy rows would silently
 * drop out under a `NULL`. The marker also lets an optional enricher
 * script target ONLY lazy rows to backfill a real listing venue.
 * `asset_class` defaults to 'EQUITY', `active=1`.
 */
export async function ensureTradableSymbol(symbol: string): Promise<void> {
  if (!symbol || typeof symbol !== "string") return;
  try {
    const pool = await getPool();
    await pool.execute(
      "INSERT IGNORE INTO tradable_symbols (symbol, exchange, asset_class, active) VALUES (?, 'LAZY_SYNC', 'EQUITY', 1)",
      [symbol.toUpperCase()]
    );
  } catch (err) {
    // Best-effort. Enrollment is more important than whitelist sync; don't
    // let a transient DB glitch break the enrollment transaction.
    console.warn(
      "[paper-risk] ensureTradableSymbol failed for",
      symbol,
      "—",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Default tolerance for caller-supplied `fill_price` vs last known close
 * in the paper-batch-order flow. 20% is deliberately generous — penny
 * and low-float names can open 10-15% off their prior close and we still
 * want the user's "I pretend I bought at close" flow to work. But 200%
 * isn't "volatile name," it's a typo (e.g. $1 instead of $10) or active
 * abuse of the synthetic-fill privilege.
 *
 * The band is a fat-finger guard and a safeguard against the "catastrophic
 * success" footgun highlighted during review: without it, a user (or
 * automation) could submit `fill_price=$1` for a $300 stock and the paper
 * account would silently print +$299/share of fake equity.
 */
export const FILL_PRICE_DEVIATION_BAND = 0.2; // 20%

/**
 * Pure helper — validates a caller-supplied fill price against the last
 * known close for the symbol. Returns `{ ok: true }` if within the band
 * OR if no reference close is available (caller should treat that case
 * with its own policy — batch route rejects unknowns).
 *
 * `band=0.2` → reject if deviation > 20%. For symmetric treatment of
 * LONG and SHORT we use absolute deviation — a fill 20% below close is
 * equally "synthetic" as one 20% above.
 */
export function checkFillPriceDeviation(
  fillPrice: number,
  lastClose: number | null | undefined,
  band: number = FILL_PRICE_DEVIATION_BAND,
): { ok: true } | { ok: false; reason: string; deviation: number; lastClose: number } {
  if (lastClose == null || !Number.isFinite(lastClose) || lastClose <= 0) {
    return { ok: true };
  }
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
    return { ok: false, reason: "fill_price must be a positive finite number", deviation: NaN, lastClose };
  }
  const deviation = Math.abs(fillPrice - lastClose) / lastClose;
  if (deviation > band) {
    const pct = (deviation * 100).toFixed(1);
    const limitPct = (band * 100).toFixed(0);
    return {
      ok: false,
      reason: `SYNTHETIC_DEVIATION_TOO_LARGE: fill_price $${fillPrice.toFixed(2)} is ${pct}% off last close $${lastClose.toFixed(2)} (max ${limitPct}%)`,
      deviation,
      lastClose,
    };
  }
  return { ok: true };
}

/**
 * Bulk fetch the latest `close` from `prices_daily` per symbol. One
 * round-trip for N symbols via IN(...) + the classic "max-date per
 * symbol" self-join pattern. Missing symbols simply don't appear in
 * the returned map — caller decides reject / allow policy.
 *
 * Empty input → empty Map, no DB call. Results are case-normalized to
 * UPPERCASE keys.
 */
export async function getLastCloseMap(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!Array.isArray(symbols) || symbols.length === 0) return out;
  const unique = Array.from(
    new Set(
      symbols
        .filter((s) => typeof s === "string" && s.length > 0)
        .map((s) => s.toUpperCase()),
    ),
  );
  if (unique.length === 0) return out;
  const pool = await getPool();
  const placeholders = unique.map(() => "?").join(",");
  // INNER JOIN on the (symbol, MAX(date)) sub-select — one query, no N+1.
  // prices_daily has a UNIQUE (symbol, date) so the join is 1:1 safe.
  const sql = `
    SELECT p.symbol, p.close
      FROM prices_daily p
      INNER JOIN (
        SELECT symbol, MAX(date) AS max_date
          FROM prices_daily
         WHERE symbol IN (${placeholders})
         GROUP BY symbol
      ) latest
        ON p.symbol = latest.symbol AND p.date = latest.max_date
  `;
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(sql, unique);
  for (const r of rows) {
    const sym = String(r.symbol).toUpperCase();
    const close = Number(r.close);
    if (Number.isFinite(close) && close > 0) out.set(sym, close);
  }
  return out;
}
