/**
 * Matrix Scenario Overlay — pure, deterministic module.
 *
 * WHY: The /reversal matrix shows neutral price snapshots over a 10-day
 * window. Users want to ask "what if I had taken a momentum bet on every
 * ticker with $100 × 5x?" and see each cell recolor green/red against that
 * hypothetical. This is a pure mark-to-market overlay — NOT paper trading:
 * no position is actually opened, no exit is simulated, no costs are
 * deducted. Just P&L at each snapshot vs a hypothetical entry at the close
 * of the enrollment day.
 *
 * DESIGN:
 * - Pure functions only. No DB access. No I/O. Fully unit-testable.
 * - Each scenario is a (filter, directionSign) pair.
 *   filter: does this ticker qualify? (grey-out if no)
 *   directionSign: +1 LONG, −1 SHORT, 0 = scenario doesn't apply
 * - P&L per snapshot = clamp((price - entry)/entry × direction × leverage, −1, ∞)
 *   Liquidation = when raw pnl pct <= −100%.
 * - Entry price = the enrollment-day close. We use reversal_entries.entry_price
 *   which is the 5-min-before-close snapshot on the trigger day — close enough
 *   to treat as "close of enrollment day" for this overlay.
 *
 * STREAK SEMANTICS (per spec):
 * - 3-Day Slide Bounce = enrollment day closed DOWN and was part of a 3+ day
 *   DOWN streak. Direction = LONG (betting on the bounce).
 * - 4-Day Rally Fade  = enrollment day closed UP and was part of a 4+ day UP
 *   streak. Direction = SHORT (betting on the fade).
 * - Extreme Streak    = |streak| >= 5 in either direction. Direction is
 *   contrarian: −sign(streak).
 *
 * We treat reversal_entries.consecutive_days as POSITIVE streak length
 * (1..n) and derive direction from sign(day_change_pct). That matches how
 * the surveillance pipeline populates it.
 */

export type ScenarioId =
  | "momentum"
  | "reversal"
  | "three_day_slide_bounce"
  | "four_day_rally_fade"
  | "extreme_streak_reversal";

export type ScenarioDirection = -1 | 0 | 1;

export type MatrixScenario = {
  id: ScenarioId;
  label: string;
  description: string;
  /** Minimum streak length required, null = ignore streak */
  requiresStreakGte?: number;
  /** UP | DOWN | EITHER when a streak is required */
  requiresStreakSide?: "UP" | "DOWN" | "EITHER";
  /**
   * How the direction is assigned for qualifying tickers.
   *  "momentum"    — follow the day-1 move
   *  "reversal"    — against the day-1 move
   *  "long"        — always LONG (for slide bounce)
   *  "short"       — always SHORT (for rally fade)
   *  "contrarian"  — against the streak sign (for extreme streak)
   */
  directionRule: "momentum" | "reversal" | "long" | "short" | "contrarian";
};

export const SCENARIOS: readonly MatrixScenario[] = [
  {
    id: "momentum",
    label: "Momentum (Day 1)",
    description: "Bet WITH the enrollment-day move on every ticker.",
    directionRule: "momentum",
  },
  {
    id: "reversal",
    label: "Reversal (Day 1)",
    description: "Bet AGAINST the enrollment-day move on every ticker.",
    directionRule: "reversal",
  },
  {
    id: "three_day_slide_bounce",
    label: "3-Day Slide Bounce",
    description:
      "Only tickers in a 3+ day DOWN streak through enrollment. LONG the bounce.",
    requiresStreakGte: 3,
    requiresStreakSide: "DOWN",
    directionRule: "long",
  },
  {
    id: "four_day_rally_fade",
    label: "4-Day Rally Fade",
    description:
      "Only tickers in a 4+ day UP streak through enrollment. SHORT the fade.",
    requiresStreakGte: 4,
    requiresStreakSide: "UP",
    directionRule: "short",
  },
  {
    id: "extreme_streak_reversal",
    label: "Extreme Streak Reversal",
    description:
      "Only tickers with |streak| >= 5 (either direction). Bet against the streak.",
    requiresStreakGte: 5,
    requiresStreakSide: "EITHER",
    directionRule: "contrarian",
  },
] as const;

export function getScenario(id: ScenarioId): MatrixScenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown scenario: ${id}`);
  return s;
}

// ---------------------------------------------------------------------------
// Streak detection on arbitrary close series (used by tests + scripts)
// ---------------------------------------------------------------------------

/**
 * Classify the last `n` closes of `closes` as an UP, DOWN, or MIXED streak.
 * UP    = strictly every day up   (close[i] > close[i-1] for all i)
 * DOWN  = strictly every day down (close[i] < close[i-1] for all i)
 * MIXED = anything else (flat day, or reversal within the window)
 *
 * `closes` must contain at least (n + 1) entries so we can compute n diffs.
 * If not enough history, returns MIXED.
 */
export function computeStreak(
  closes: number[],
  n: number,
): "UP" | "DOWN" | "MIXED" {
  if (!Array.isArray(closes) || closes.length < n + 1 || n < 1) return "MIXED";
  const start = closes.length - n;
  let allUp = true;
  let allDown = true;
  for (let i = start; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (!(curr > prev)) allUp = false;
    if (!(curr < prev)) allDown = false;
  }
  if (allUp) return "UP";
  if (allDown) return "DOWN";
  return "MIXED";
}

// ---------------------------------------------------------------------------
// Scenario evaluation
// ---------------------------------------------------------------------------

/**
 * Minimal shape the evaluator needs per ticker. Designed to be a subset of
 * ReversalEntry so /reversal can pass entries straight through.
 */
export type ScenarioTickerInput = {
  symbol: string;
  entryPrice: number;
  /** The enrollment-day move in percent (sign is what matters) */
  dayChangePct: number;
  /** Consecutive streak length through enrollment day (>= 1, positive). */
  consecutiveDays?: number | null;
};

export type ScenarioSnapshotInput = {
  /** Identifier of this snapshot in the matrix (e.g. "d1_morning"). */
  key: string;
  /** ET timestamp / label for display */
  at?: string;
  /** Price at this snapshot, or null if not yet captured */
  price: number | null;
};

export type ScenarioParams = {
  investment: number; // USD per ticker
  leverage: number; // multiplier, e.g. 5 for 5x
};

export type PerSnapshotResult = {
  key: string;
  at?: string;
  price: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  liquidated: boolean;
};

export type PerTickerResult = {
  symbol: string;
  matches: boolean;
  direction: ScenarioDirection; // 0 if doesn't match scenario
  entryPrice: number;
  /** All snapshots, in input order. Non-matching tickers still get a row but pnl=null everywhere. */
  snapshots: PerSnapshotResult[];
  /** Summary over snapshots with price != null */
  latestSnapshotKey: string | null;
  latestPnlUsd: number | null;
  latestPnlPct: number | null;
  liquidated: boolean; // true if ever liquidated
  firstLiquidatedKey: string | null;
  /** Days held: counted as the 1-based day index if snapshot key starts with "d<n>_" */
  daysHeld: number;
};

/**
 * Resolve the direction sign for a scenario + ticker. 0 = ticker doesn't
 * qualify (grey cells).
 */
export function resolveDirection(
  scenario: MatrixScenario,
  t: ScenarioTickerInput,
): ScenarioDirection {
  // Streak gate first
  if (scenario.requiresStreakGte != null) {
    const streak = Math.abs(t.consecutiveDays ?? 0);
    if (streak < scenario.requiresStreakGte) return 0;
    if (scenario.requiresStreakSide === "UP" && !(t.dayChangePct > 0)) return 0;
    if (scenario.requiresStreakSide === "DOWN" && !(t.dayChangePct < 0)) return 0;
    // EITHER: both signs allowed (but dayChangePct must be non-zero to have a sign)
    if (scenario.requiresStreakSide === "EITHER" && t.dayChangePct === 0) return 0;
  }

  switch (scenario.directionRule) {
    case "momentum":
      return t.dayChangePct > 0 ? 1 : t.dayChangePct < 0 ? -1 : 0;
    case "reversal":
      return t.dayChangePct > 0 ? -1 : t.dayChangePct < 0 ? 1 : 0;
    case "long":
      return 1;
    case "short":
      return -1;
    case "contrarian":
      return t.dayChangePct > 0 ? -1 : t.dayChangePct < 0 ? 1 : 0;
  }
}

/** Extract the 1-based day index from a snapshot key like "d3_close". */
function dayIndexFromKey(key: string): number {
  const m = /^d(\d+)_/.exec(key);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * W3 hotfix #4 — order snapshots by an intraday ordinal so "As-of" reports
 * pick the latest snapshot within a day, not just the newest day. Matches
 * the reversal_entries schema (`d{N}_morning` < `d{N}_midday` < `d{N}_close`).
 *
 * Returns a numeric ordinal that is monotonic across (day, intraday-slot).
 * Unknown suffixes sort after the three known slots so we still pick them
 * over an older day.
 */
function snapshotOrdinal(key: string): number {
  const m = /^d(\d+)_([a-z_]+)$/i.exec(key);
  if (!m) return 0;
  const day = parseInt(m[1], 10);
  const slot = m[2].toLowerCase();
  const slotOrder: Record<string, number> = { morning: 0, midday: 1, close: 2 };
  const offset = slot in slotOrder ? slotOrder[slot] : 3;
  return day * 10 + offset;
}

/**
 * Evaluate a scenario for a single ticker across its timeline.
 * Returns a full per-ticker result even if the ticker doesn't match the
 * scenario filter — in that case, pnl values are null and direction=0,
 * so the UI can grey-out the row.
 */
export function evaluateScenario(
  scenarioId: ScenarioId,
  ticker: ScenarioTickerInput,
  timeline: ScenarioSnapshotInput[],
  params: ScenarioParams,
): PerTickerResult {
  const scenario = getScenario(scenarioId);
  const direction = resolveDirection(scenario, ticker);

  const base: PerTickerResult = {
    symbol: ticker.symbol,
    matches: direction !== 0,
    direction,
    entryPrice: ticker.entryPrice,
    snapshots: [],
    latestSnapshotKey: null,
    latestPnlUsd: null,
    latestPnlPct: null,
    liquidated: false,
    firstLiquidatedKey: null,
    daysHeld: 0,
  };

  // Build per-snapshot results regardless of matching so keys line up with UI cells.
  let liquidated = false;
  let firstLiquidatedKey: string | null = null;
  let latestWithPrice: PerSnapshotResult | null = null;

  for (const s of timeline) {
    if (direction === 0 || s.price == null || !(ticker.entryPrice > 0)) {
      base.snapshots.push({
        key: s.key,
        at: s.at,
        price: s.price,
        pnlUsd: null,
        pnlPct: null,
        liquidated: false,
      });
      continue;
    }

    const movePct = (s.price - ticker.entryPrice) / ticker.entryPrice;
    const rawPnlPct = movePct * direction * params.leverage * 100;
    const pnlPct = Math.max(rawPnlPct, -100);
    const pnlUsd = (params.investment * pnlPct) / 100;
    const wasLiquidated = rawPnlPct <= -100;

    if (wasLiquidated && !liquidated) {
      liquidated = true;
      firstLiquidatedKey = s.key;
    }
    // If already liquidated, keep liquidated flag true on every later cell too.
    const snapLiquidated = liquidated;

    const snap: PerSnapshotResult = {
      key: s.key,
      at: s.at,
      price: s.price,
      pnlUsd: snapLiquidated ? (-params.investment) : pnlUsd,
      pnlPct: snapLiquidated ? -100 : pnlPct,
      liquidated: snapLiquidated,
    };
    base.snapshots.push(snap);
    latestWithPrice = snap;
  }

  base.liquidated = liquidated;
  base.firstLiquidatedKey = firstLiquidatedKey;

  if (latestWithPrice) {
    base.latestSnapshotKey = latestWithPrice.key;
    base.latestPnlUsd = latestWithPrice.pnlUsd;
    base.latestPnlPct = latestWithPrice.pnlPct;
    base.daysHeld = Math.max(base.daysHeld, dayIndexFromKey(latestWithPrice.key));
  }

  return base;
}

// ---------------------------------------------------------------------------
// Aggregate (report) computation
// ---------------------------------------------------------------------------

export type ScenarioReport = {
  scenarioId: ScenarioId;
  scenarioLabel: string;
  investmentPerTicker: number;
  leverage: number;
  totalCohort: number; // all tickers passed in
  eligibleCount: number; // direction != 0
  capitalDeployed: number; // eligibleCount * investment
  currentValue: number; // sum of (investment + latestPnlUsd) for eligible tickers
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  inProfitCount: number;
  atLossCount: number;
  liquidatedCount: number;
  longCount: number;
  shortCount: number;
  longSumPnl: number;
  shortSumPnl: number;
  longAvgPnlPct: number;
  shortAvgPnlPct: number;
  best: { symbol: string; pnlUsd: number; pnlPct: number; daysHeld: number } | null;
  worst: { symbol: string; pnlUsd: number; pnlPct: number; daysHeld: number } | null;
  /** As-of key (latest snapshot key seen across eligible tickers) */
  asOfKey: string | null;
};

export function summarizeScenario(
  scenarioId: ScenarioId,
  results: PerTickerResult[],
  params: ScenarioParams,
): ScenarioReport {
  const scenario = getScenario(scenarioId);
  const eligible = results.filter((r) => r.direction !== 0);

  let inProfit = 0;
  let atLoss = 0;
  let liquidated = 0;
  let longCount = 0;
  let shortCount = 0;
  let longSum = 0;
  let shortSum = 0;
  let longPctSum = 0;
  let shortPctSum = 0;
  let capitalDeployed = 0;
  let currentValue = 0;
  let unrealizedPnl = 0;
  let best: ScenarioReport["best"] = null;
  let worst: ScenarioReport["worst"] = null;
  let asOfKey: string | null = null;

  for (const r of eligible) {
    capitalDeployed += params.investment;
    const pnl = r.latestPnlUsd ?? 0;
    const pnlPct = r.latestPnlPct ?? 0;
    currentValue += params.investment + pnl;
    unrealizedPnl += pnl;

    if (pnl > 0) inProfit++;
    else if (pnl < 0) atLoss++;

    if (r.liquidated) liquidated++;

    if (r.direction === 1) {
      longCount++;
      longSum += pnl;
      longPctSum += pnlPct;
    } else if (r.direction === -1) {
      shortCount++;
      shortSum += pnl;
      shortPctSum += pnlPct;
    }

    if (r.latestSnapshotKey && (!asOfKey || snapshotOrdinal(r.latestSnapshotKey) > snapshotOrdinal(asOfKey))) {
      asOfKey = r.latestSnapshotKey;
    }

    const cand = { symbol: r.symbol, pnlUsd: pnl, pnlPct, daysHeld: r.daysHeld };
    if (best === null || cand.pnlUsd > best.pnlUsd) best = cand;
    if (worst === null || cand.pnlUsd < worst.pnlUsd) worst = cand;
  }

  const unrealizedPnlPct = capitalDeployed > 0 ? (unrealizedPnl / capitalDeployed) * 100 : 0;
  const longAvgPnlPct = longCount > 0 ? longPctSum / longCount : 0;
  const shortAvgPnlPct = shortCount > 0 ? shortPctSum / shortCount : 0;

  return {
    scenarioId,
    scenarioLabel: scenario.label,
    investmentPerTicker: params.investment,
    leverage: params.leverage,
    totalCohort: results.length,
    eligibleCount: eligible.length,
    capitalDeployed,
    currentValue,
    unrealizedPnlUsd: unrealizedPnl,
    unrealizedPnlPct,
    inProfitCount: inProfit,
    atLossCount: atLoss,
    liquidatedCount: liquidated,
    longCount,
    shortCount,
    longSumPnl: longSum,
    shortSumPnl: shortSum,
    longAvgPnlPct,
    shortAvgPnlPct,
    best,
    worst,
    asOfKey,
  };
}

// ---------------------------------------------------------------------------
// Recurrence aggregation (F3: "aggressive-swings" badges)
// ---------------------------------------------------------------------------

/**
 * One appearance of a ticker in the matrix (i.e. one cohort enrollment).
 * Stored compactly so the UI can render a tooltip table on hover.
 */
export type RecurrenceAppearance = {
  cohortDate: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  dayChangePct: number;
};

export type RecurrenceInfo = {
  count: number;
  appearances: RecurrenceAppearance[];
};

/**
 * Minimal entry shape needed to compute recurrences. A subset of
 * ReversalEntry so /reversal can pass its loaded entries through directly.
 */
export type RecurrenceInput = {
  symbol: string;
  cohort_date: string | Date;
  direction: "LONG" | "SHORT";
  entry_price: number;
  day_change_pct: number;
};

/**
 * Group matrix entries by symbol and count how many distinct cohort dates
 * each symbol has been enrolled on. Symbols with count >= 2 are "recurring"
 * ("aggressive-swing") tickers worth flagging in the UI.
 *
 * WHY: When the same symbol re-enrolls across multiple cohort dates the
 * underlying market moved enough to trigger a reversal pattern more than
 * once in a short window — that's behavioural signal separate from any
 * scenario. Aggregation is client-side from the already-loaded matrix data.
 *
 * The same symbol on the SAME cohort date is treated as one appearance
 * (de-duped via a Set on cohort_date). Appearances are returned sorted
 * newest-first so tooltips read top-to-bottom chronologically.
 */
export function computeRecurrences(
  entries: RecurrenceInput[],
): Map<string, RecurrenceInfo> {
  const acc = new Map<string, Map<string, RecurrenceAppearance>>();
  for (const e of entries) {
    if (!e || !e.symbol) continue;
    const dateStr =
      typeof e.cohort_date === "string"
        ? e.cohort_date.slice(0, 10)
        : new Date(e.cohort_date).toISOString().slice(0, 10);
    const perSymbol = acc.get(e.symbol) ?? new Map<string, RecurrenceAppearance>();
    // Last write wins if the same (symbol, cohortDate) appears twice — but we
    // only count it once. entry_price/direction from the latest occurrence is fine.
    perSymbol.set(dateStr, {
      cohortDate: dateStr,
      direction: e.direction,
      entryPrice: Number(e.entry_price),
      dayChangePct: Number(e.day_change_pct),
    });
    acc.set(e.symbol, perSymbol);
  }
  const out = new Map<string, RecurrenceInfo>();
  for (const [sym, dateMap] of acc) {
    const appearances = Array.from(dateMap.values()).sort((a, b) =>
      b.cohortDate.localeCompare(a.cohortDate),
    );
    out.set(sym, { count: appearances.length, appearances });
  }
  return out;
}

/**
 * Evaluate all 5 scenarios over the same cohort and return aggregate P&L
 * per scenario.
 *
 * Input is an array of (ticker, timeline) PAIRS — not a symbol-keyed lookup —
 * because the same symbol can legitimately appear multiple times (once per
 * cohort date), and each occurrence must be evaluated against its own
 * timeline. A name-based lookup would collapse them and double-count.
 */
export function compareAllScenarios(
  pairs: Array<{ ticker: ScenarioTickerInput; timeline: ScenarioSnapshotInput[] }>,
  params: ScenarioParams,
): { scenarioId: ScenarioId; label: string; eligibleCount: number; totalCohort: number; totalPnlUsd: number }[] {
  return SCENARIOS.map((scn) => {
    const perTicker = pairs.map((p) => evaluateScenario(scn.id, p.ticker, p.timeline, params));
    const report = summarizeScenario(scn.id, perTicker, params);
    return {
      scenarioId: scn.id,
      label: scn.label,
      eligibleCount: report.eligibleCount,
      totalCohort: report.totalCohort,
      totalPnlUsd: report.unrealizedPnlUsd,
    };
  });
}
