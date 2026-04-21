#!/usr/bin/env node
/**
 * Smoke test — Matrix Scenario Overlay (pure module, no DB).
 *
 * WHY: The /reversal scenario overlay recolors the matrix based on hypothetical
 * P&L of a bet placed at the enrollment close and marked to market at each
 * snapshot. This is pure math — test it with hand-crafted timelines.
 *
 * Exit 0 = all assertions pass. Exit 1 = any assertion fails.
 *
 * Run: node scripts/smoke-test-matrix-scenarios.js
 */

// Load TS module via tsx register (so we don't need to build)
require("tsx/cjs");
const mod = require("../src/lib/matrix-scenarios.ts");
const {
  SCENARIOS,
  getScenario,
  computeStreak,
  resolveDirection,
  evaluateScenario,
  summarizeScenario,
  compareAllScenarios,
  computeRecurrences,
} = mod;

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function near(actual, expected, eps, msg) {
  const diff = Math.abs(actual - expected);
  if (diff <= eps) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg} — expected ${expected}, got ${actual} (diff ${diff})`);
  }
}

function section(name) {
  console.log(`\n== ${name} ==`);
}

// ---------------------------------------------------------------------------
// 1. SCENARIOS registry shape
// ---------------------------------------------------------------------------
section("SCENARIOS registry");
ok(Array.isArray(SCENARIOS) && SCENARIOS.length === 5, "five scenarios registered");
const ids = SCENARIOS.map((s) => s.id).sort().join(",");
ok(
  ids === ["momentum", "reversal", "three_day_slide_bounce", "four_day_rally_fade", "extreme_streak_reversal"].sort().join(","),
  "scenario ids match spec",
);
ok(SCENARIOS.every((s) => s.label && s.description && s.directionRule), "every scenario has label/description/rule");

// ---------------------------------------------------------------------------
// 2. computeStreak on synthetic close series
// ---------------------------------------------------------------------------
section("computeStreak()");

// 3 consecutive down days: closes 100, 99, 98, 97 → streak of 3 down
ok(computeStreak([100, 99, 98, 97], 3) === "DOWN", "3 strict-down days detected");
// 2 down + 1 flat → last 3 of [100, 99, 98, 98] has a flat day → MIXED
ok(computeStreak([100, 99, 98, 98], 3) === "MIXED", "flat day breaks strict-down streak");
// 4 up days: 50 → 55 → 60 → 65 → 70
ok(computeStreak([50, 55, 60, 65, 70], 4) === "UP", "4-day up streak detected");
// 4 up days but window of 3
ok(computeStreak([50, 55, 60, 65, 70], 3) === "UP", "streak detection honors window size");
// 3 down but asking for 4 → not enough down-only history in last 4
ok(computeStreak([100, 101, 99, 98, 97], 4) === "MIXED", "up-then-down mixes within window=4");
// not enough history
ok(computeStreak([100, 99], 3) === "MIXED", "short history returns MIXED");
// boundary: exactly n+1 entries, all down
ok(computeStreak([100, 99, 98, 97], 3) === "DOWN", "minimum history for streak detection works");
// boundary: 2 down-days only vs requested 3
ok(computeStreak([100, 99, 98], 3) === "MIXED", "2 down days insufficient for 3-day streak");

// ---------------------------------------------------------------------------
// 3. resolveDirection for each scenario type
// ---------------------------------------------------------------------------
section("resolveDirection()");

const momentum = getScenario("momentum");
const reversal = getScenario("reversal");
const slide = getScenario("three_day_slide_bounce");
const rally = getScenario("four_day_rally_fade");
const extreme = getScenario("extreme_streak_reversal");

// Momentum: up-move → LONG, down-move → SHORT
ok(resolveDirection(momentum, { symbol: "A", entryPrice: 100, dayChangePct: 3 }) === 1, "momentum up → LONG");
ok(resolveDirection(momentum, { symbol: "A", entryPrice: 100, dayChangePct: -3 }) === -1, "momentum down → SHORT");

// Reversal: opposite of momentum
ok(resolveDirection(reversal, { symbol: "A", entryPrice: 100, dayChangePct: 3 }) === -1, "reversal up → SHORT");
ok(resolveDirection(reversal, { symbol: "A", entryPrice: 100, dayChangePct: -3 }) === 1, "reversal down → LONG");

// 3-Day Slide Bounce: requires 3+ down streak ending on enrollment
ok(
  resolveDirection(slide, { symbol: "A", entryPrice: 100, dayChangePct: -2, consecutiveDays: 3 }) === 1,
  "slide bounce: 3d down streak → LONG",
);
ok(
  resolveDirection(slide, { symbol: "A", entryPrice: 100, dayChangePct: -2, consecutiveDays: 2 }) === 0,
  "slide bounce: 2d streak → no bet",
);
ok(
  resolveDirection(slide, { symbol: "A", entryPrice: 100, dayChangePct: 2, consecutiveDays: 5 }) === 0,
  "slide bounce: streak but UP direction → no bet",
);

// 4-Day Rally Fade: requires 4+ up streak ending on enrollment
ok(
  resolveDirection(rally, { symbol: "A", entryPrice: 100, dayChangePct: 2, consecutiveDays: 4 }) === -1,
  "rally fade: 4d up streak → SHORT",
);
ok(
  resolveDirection(rally, { symbol: "A", entryPrice: 100, dayChangePct: 2, consecutiveDays: 3 }) === 0,
  "rally fade: 3d streak → no bet",
);

// Extreme Streak Reversal: |streak| >= 5, contrarian
ok(
  resolveDirection(extreme, { symbol: "A", entryPrice: 100, dayChangePct: 5, consecutiveDays: 5 }) === -1,
  "extreme streak: 5d up → SHORT (contrarian)",
);
ok(
  resolveDirection(extreme, { symbol: "A", entryPrice: 100, dayChangePct: -5, consecutiveDays: 7 }) === 1,
  "extreme streak: 7d down → LONG (contrarian)",
);
ok(
  resolveDirection(extreme, { symbol: "A", entryPrice: 100, dayChangePct: -3, consecutiveDays: 4 }) === 0,
  "extreme streak: 4d streak → no bet",
);

// ---------------------------------------------------------------------------
// 4. evaluateScenario — LONG bet, price up, unleveraged
// ---------------------------------------------------------------------------
section("evaluateScenario() — LONG wins when price rises");

const params1x = { investment: 100, leverage: 1 };
const up10Timeline = [
  { key: "d1_morning", price: 100 }, // flat
  { key: "d1_close", price: 105 }, // +5%
  { key: "d3_close", price: 110 }, // +10%
];

const longTicker = { symbol: "AAA", entryPrice: 100, dayChangePct: -5 }; // loss day → reversal bet LONG
const longRes = evaluateScenario("reversal", longTicker, up10Timeline, params1x);
ok(longRes.matches && longRes.direction === 1, "reversal on down-day ticker goes LONG");
near(longRes.snapshots[0].pnlUsd, 0, 0.01, "flat price → 0 P&L");
near(longRes.snapshots[1].pnlUsd, 5, 0.01, "+5% price, $100, 1x → +$5");
near(longRes.snapshots[2].pnlUsd, 10, 0.01, "+10% price, $100, 1x → +$10");
ok(!longRes.liquidated, "LONG on +10% is not liquidated");
near(longRes.latestPnlUsd, 10, 0.01, "latest P&L reflects last snapshot");
ok(longRes.daysHeld === 3, "daysHeld = 3 from d3_close key");

// ---------------------------------------------------------------------------
// 5. evaluateScenario — SHORT bet, price down, unleveraged
// ---------------------------------------------------------------------------
section("evaluateScenario() — SHORT wins when price falls");

const shortTicker = { symbol: "BBB", entryPrice: 100, dayChangePct: 5 }; // gain day → reversal bet SHORT
const downTimeline = [
  { key: "d1_morning", price: 98 }, // -2%
  { key: "d2_close", price: 90 }, // -10%
];
const shortRes = evaluateScenario("reversal", shortTicker, downTimeline, params1x);
ok(shortRes.direction === -1, "reversal on up-day ticker goes SHORT");
near(shortRes.snapshots[0].pnlUsd, 2, 0.01, "SHORT -2% move, $100 → +$2");
near(shortRes.snapshots[1].pnlUsd, 10, 0.01, "SHORT -10% move, $100 → +$10");
ok(!shortRes.liquidated, "SHORT profiting is not liquidated");

// ---------------------------------------------------------------------------
// 6. Leverage + liquidation cap
// ---------------------------------------------------------------------------
section("Liquidation cap (5x, -20% underlying → -100% P&L)");

// LONG 5x, price drops 20% → raw P&L = -20% * 5 = -100% → liquidated
const liq5x = { investment: 100, leverage: 5 };
const liqTicker = { symbol: "LIQ", entryPrice: 100, dayChangePct: -5 }; // reversal LONG
const liqTimeline = [
  { key: "d1_morning", price: 90 }, // -10%, leveraged = -50%
  { key: "d2_close", price: 80 }, // -20%, leveraged = -100% → LIQ
  { key: "d3_close", price: 75 }, // -25%, would be -125%, capped
];
const liqRes = evaluateScenario("reversal", liqTicker, liqTimeline, liq5x);
near(liqRes.snapshots[0].pnlPct, -50, 0.01, "-10% underlying × 5x = -50% P&L");
near(liqRes.snapshots[0].pnlUsd, -50, 0.01, "-50% × $100 = -$50");
ok(!liqRes.snapshots[0].liquidated, "not yet liquidated at -50%");
ok(liqRes.snapshots[1].liquidated === true, "liquidated at -100% boundary");
near(liqRes.snapshots[1].pnlPct, -100, 0.01, "pnlPct capped at -100");
ok(liqRes.snapshots[2].liquidated === true, "liquidation persists on later cells");
near(liqRes.snapshots[2].pnlUsd, -100, 0.01, "pnlUsd stuck at -$100 after liq");
ok(liqRes.liquidated === true && liqRes.firstLiquidatedKey === "d2_close", "firstLiquidatedKey is d2_close");

// ---------------------------------------------------------------------------
// 7. Non-matching tickers produce null pnl
// ---------------------------------------------------------------------------
section("Non-matching tickers (scenario filter fails)");

const notMatching = { symbol: "CCC", entryPrice: 100, dayChangePct: 3, consecutiveDays: 2 };
const slideRes = evaluateScenario("three_day_slide_bounce", notMatching, up10Timeline, params1x);
ok(slideRes.matches === false && slideRes.direction === 0, "2d streak fails 3-day slide bounce filter");
ok(slideRes.snapshots.every((s) => s.pnlUsd === null && s.pnlPct === null), "non-matching cells have null pnl");
ok(slideRes.latestPnlUsd === null, "latest pnl null for non-matching");

// ---------------------------------------------------------------------------
// 8. Null price snapshots pass through
// ---------------------------------------------------------------------------
section("Null price snapshots");

const partialTimeline = [
  { key: "d1_morning", price: null },
  { key: "d1_close", price: 105 },
  { key: "d2_close", price: null },
];
const partial = evaluateScenario("reversal", longTicker, partialTimeline, params1x);
ok(partial.snapshots[0].pnlUsd === null, "null price → null pnl");
near(partial.snapshots[1].pnlUsd, 5, 0.01, "price present → pnl computed");
ok(partial.snapshots[2].pnlUsd === null, "second null stays null");
ok(partial.latestSnapshotKey === "d1_close", "latest snapshot = last with a real price");

// ---------------------------------------------------------------------------
// 9. summarizeScenario aggregation
// ---------------------------------------------------------------------------
section("summarizeScenario()");

const tickers = [
  // LONG bet (reversal on down day), +10% gain → +$10 at 1x
  { symbol: "WIN1", entryPrice: 100, dayChangePct: -5, consecutiveDays: 1 },
  // LONG bet, -5% → -$5
  { symbol: "LOSS1", entryPrice: 100, dayChangePct: -5, consecutiveDays: 1 },
  // SHORT bet (reversal on up day), price up → loss
  { symbol: "LOSS2", entryPrice: 100, dayChangePct: 5, consecutiveDays: 1 },
];
const timelines = {
  WIN1: [{ key: "d1_close", price: 110 }], // LONG: +10 → +$10
  LOSS1: [{ key: "d1_close", price: 95 }], // LONG: -5 → -$5
  LOSS2: [{ key: "d1_close", price: 110 }], // SHORT: +10 → -$10
};
const perTicker = tickers.map((t) => evaluateScenario("reversal", t, timelines[t.symbol], params1x));
const rep = summarizeScenario("reversal", perTicker, params1x);

ok(rep.totalCohort === 3, "totalCohort counts all inputs");
ok(rep.eligibleCount === 3, "all 3 match reversal scenario");
near(rep.capitalDeployed, 300, 0.01, "3 × $100 deployed");
near(rep.unrealizedPnlUsd, 10 + -5 + -10, 0.01, "sum pnl = -5");
near(rep.currentValue, 300 + (10 - 5 - 10), 0.01, "current value = deployed + pnl");
ok(rep.inProfitCount === 1 && rep.atLossCount === 2, "1 in profit, 2 at loss");
ok(rep.longCount === 2 && rep.shortCount === 1, "2 LONG, 1 SHORT bets");
near(rep.longSumPnl, 10 - 5, 0.01, "LONG pnl = +$5");
near(rep.shortSumPnl, -10, 0.01, "SHORT pnl = -$10");
ok(rep.best && rep.best.symbol === "WIN1", "best = WIN1");
ok(rep.worst && rep.worst.symbol === "LOSS2", "worst = LOSS2");
ok(rep.liquidatedCount === 0, "no liquidations in this cohort");

// ---------------------------------------------------------------------------
// 10. Comparison block — all 5 scenarios over same cohort
// ---------------------------------------------------------------------------
section("compareAllScenarios()");

const cohort = [
  { symbol: "UP1", entryPrice: 100, dayChangePct: 2, consecutiveDays: 1 }, // UP day, short streak
  { symbol: "DOWN3", entryPrice: 100, dayChangePct: -3, consecutiveDays: 3 }, // DOWN 3-day
  { symbol: "UP4", entryPrice: 100, dayChangePct: 4, consecutiveDays: 4 }, // UP 4-day
  { symbol: "UP6", entryPrice: 100, dayChangePct: 6, consecutiveDays: 6 }, // UP 6-day (extreme)
];
const flatFuture = [{ key: "d1_close", price: 105 }]; // +5% on d1 close
const comparison = compareAllScenarios(
  cohort.map((t) => ({ ticker: t, timeline: flatFuture })),
  params1x,
);

const byId = Object.fromEntries(comparison.map((r) => [r.scenarioId, r]));
ok(byId.momentum.eligibleCount === 4, "momentum: all 4 eligible (all have a sign)");
// Momentum: UP1 LONG +$5, DOWN3 SHORT -$5, UP4 LONG +$5, UP6 LONG +$5 → sum +$10
near(byId.momentum.totalPnlUsd, 10, 0.01, "momentum total pnl = +$10");
// Reversal: opposite signs → -$10
near(byId.reversal.totalPnlUsd, -10, 0.01, "reversal total pnl = -$10");
// Slide bounce: only DOWN3 → LONG +$5
ok(byId.three_day_slide_bounce.eligibleCount === 1, "slide bounce: 1 eligible");
near(byId.three_day_slide_bounce.totalPnlUsd, 5, 0.01, "slide bounce total pnl = +$5");
// Rally fade: UP4, UP6 → SHORT -$5 each → -$10
ok(byId.four_day_rally_fade.eligibleCount === 2, "rally fade: 2 eligible");
near(byId.four_day_rally_fade.totalPnlUsd, -10, 0.01, "rally fade total pnl = -$10");
// Extreme: UP6 only → SHORT -$5
ok(byId.extreme_streak_reversal.eligibleCount === 1, "extreme streak: 1 eligible");
near(byId.extreme_streak_reversal.totalPnlUsd, -5, 0.01, "extreme streak pnl = -$5");

// Regression guard: same symbol across multiple cohort dates must be counted
// independently (the comparison block passes pairs, not a symbol lookup).
section("compareAllScenarios — duplicate symbols not collapsed");
const dupeCohort = [
  { ticker: { symbol: "DUP", entryPrice: 100, dayChangePct: -2, consecutiveDays: 1 }, timeline: [{ key: "d1_close", price: 110 }] }, // LONG +$10
  { ticker: { symbol: "DUP", entryPrice: 100, dayChangePct: -2, consecutiveDays: 1 }, timeline: [{ key: "d1_close", price: 120 }] }, // LONG +$20
];
const dupeCmp = compareAllScenarios(dupeCohort, params1x);
const dupeReversal = dupeCmp.find((r) => r.scenarioId === "reversal");
ok(dupeReversal.eligibleCount === 2, "same symbol counted twice when it appears twice");
near(dupeReversal.totalPnlUsd, 30, 0.01, "duplicate symbols each use their own timeline (+$10 + +$20 = +$30)");

// ---------------------------------------------------------------------------
// 11. Zero entry price / bad input safety
// ---------------------------------------------------------------------------
section("Input safety");

const zeroPriceTicker = { symbol: "ZERO", entryPrice: 0, dayChangePct: 1 };
const zeroRes = evaluateScenario("momentum", zeroPriceTicker, [{ key: "d1_close", price: 50 }], params1x);
ok(zeroRes.snapshots[0].pnlUsd === null, "zero entry price → null pnl (div-by-zero guard)");

// ---------------------------------------------------------------------------
// V2 — F1 cohort date filtering (intersection with scenario evaluator)
// ---------------------------------------------------------------------------
section("V2/F1 — cohort date filter narrows scenario sample");

// Three cohort dates, 5 tickers each. All momentum LONG (gainers).
function makeCohort(date, count) {
  return Array.from({ length: count }, (_, i) => ({
    entry: {
      id: `${date}-${i}`,
      symbol: `TKR${i}`,
      cohort_date: date,
      direction: "LONG",
      entry_price: 100,
      day_change_pct: 2, // up day → momentum LONG
      consecutive_days: 1,
    },
    timeline: [{ key: "d1_close", price: 110 }], // +10% → +$10 LONG
  }));
}
const d1cohort = makeCohort("2026-04-01", 5);
const d2cohort = makeCohort("2026-04-02", 5);
const d3cohort = makeCohort("2026-04-03", 5);
const allCohort = [...d1cohort, ...d2cohort, ...d3cohort];

// Simulate F1: user checks only "2026-04-02"
const onlyD2 = allCohort.filter((p) => p.entry.cohort_date === "2026-04-02");
const onlyD2Pairs = onlyD2.map((p) => ({
  ticker: { symbol: p.entry.symbol, entryPrice: p.entry.entry_price, dayChangePct: p.entry.day_change_pct, consecutiveDays: p.entry.consecutive_days },
  timeline: p.timeline,
}));
const f1Cmp = compareAllScenarios(onlyD2Pairs, params1x);
const f1Mom = f1Cmp.find((r) => r.scenarioId === "momentum");
ok(f1Mom.eligibleCount === 5, "F1: only 5 tickers (single cohort date) eligible after filter");
near(f1Mom.totalPnlUsd, 50, 0.01, "F1: 5 × +$10 LONG = +$50 after filter");
ok(onlyD2Pairs.length === 5, "F1: precomputed effective sample = 5");

// Simulate F1: two dates checked (d1 + d3) → excludes d2
const d1d3 = allCohort.filter((p) => p.entry.cohort_date !== "2026-04-02");
const d1d3Pairs = d1d3.map((p) => ({
  ticker: { symbol: p.entry.symbol, entryPrice: p.entry.entry_price, dayChangePct: p.entry.day_change_pct, consecutiveDays: p.entry.consecutive_days },
  timeline: p.timeline,
}));
const f1Cmp2 = compareAllScenarios(d1d3Pairs, params1x);
const f1Mom2 = f1Cmp2.find((r) => r.scenarioId === "momentum");
ok(f1Mom2.eligibleCount === 10, "F1: two dates × 5 tickers = 10 eligible");
near(f1Mom2.totalPnlUsd, 100, 0.01, "F1: 10 × +$10 LONG = +$100 after 2-date filter");

// ---------------------------------------------------------------------------
// V2 — F2 ticker selection (narrows sample)
// ---------------------------------------------------------------------------
section("V2/F2 — individual ticker selection");

// 15 tickers single-date, user picks 3
const fifteen = makeCohort("2026-04-10", 15);
const picked3 = fifteen.slice(0, 3);
const picked3Pairs = picked3.map((p) => ({
  ticker: { symbol: p.entry.symbol, entryPrice: p.entry.entry_price, dayChangePct: p.entry.day_change_pct, consecutiveDays: p.entry.consecutive_days },
  timeline: p.timeline,
}));
const f2Cmp = compareAllScenarios(picked3Pairs, params1x);
const f2Mom = f2Cmp.find((r) => r.scenarioId === "momentum");
ok(f2Mom.totalCohort === 3, "F2: only 3 tickers pass through as totalCohort");
near(f2Mom.totalPnlUsd, 30, 0.01, "F2: 3 × +$10 = +$30 after ticker filter");

// ---------------------------------------------------------------------------
// V2 — F1 ∩ F2 intersection
// ---------------------------------------------------------------------------
section("V2/F1∩F2 — date checked AND ticker checked");

// 3 dates × 5 tickers = 15 total. Select dates 1+2 (10 tickers) AND tickers TKR0,TKR2,TKR4 (global ticker names).
const d1d2 = [...d1cohort, ...d2cohort];
const pickedSymbols = new Set(["TKR0", "TKR2", "TKR4"]);
const intersection = d1d2.filter((p) => pickedSymbols.has(p.entry.symbol));
const interPairs = intersection.map((p) => ({
  ticker: { symbol: p.entry.symbol, entryPrice: p.entry.entry_price, dayChangePct: p.entry.day_change_pct, consecutiveDays: p.entry.consecutive_days },
  timeline: p.timeline,
}));
const f3Cmp = compareAllScenarios(interPairs, params1x);
const f3Mom = f3Cmp.find((r) => r.scenarioId === "momentum");
ok(intersection.length === 6, "F1∩F2: 2 dates × 3 tickers = 6 effective rows");
ok(f3Mom.totalCohort === 6, "F1∩F2: totalCohort reflects intersection");
near(f3Mom.totalPnlUsd, 60, 0.01, "F1∩F2: 6 × +$10 = +$60 aggregate");

// Empty selection guard: scenario evaluator should handle 0 pairs gracefully
const emptyCmp = compareAllScenarios([], params1x);
ok(emptyCmp.every((r) => r.eligibleCount === 0 && r.totalCohort === 0), "empty selection → zero eligible across all scenarios");
ok(emptyCmp.every((r) => r.totalPnlUsd === 0), "empty selection → zero pnl across all scenarios");

// ---------------------------------------------------------------------------
// V2 — F3 recurrence aggregation
// ---------------------------------------------------------------------------
section("V2/F3 — computeRecurrences()");

const recInput = [
  { symbol: "AAPL", cohort_date: "2026-04-01", direction: "LONG",  entry_price: 150, day_change_pct:  2.1 },
  { symbol: "AAPL", cohort_date: "2026-04-05", direction: "SHORT", entry_price: 152, day_change_pct:  3.0 },
  { symbol: "AAPL", cohort_date: "2026-04-10", direction: "LONG",  entry_price: 148, day_change_pct: -1.5 },
  { symbol: "AAPL", cohort_date: "2026-04-15", direction: "LONG",  entry_price: 151, day_change_pct:  0.9 },
  { symbol: "NVDA", cohort_date: "2026-04-02", direction: "LONG",  entry_price: 700, day_change_pct:  4.0 },
  { symbol: "MSFT", cohort_date: "2026-04-03", direction: "SHORT", entry_price: 400, day_change_pct:  1.2 },
  { symbol: "MSFT", cohort_date: "2026-04-09", direction: "SHORT", entry_price: 402, day_change_pct:  0.3 },
];
const recMap = computeRecurrences(recInput);
ok(recMap instanceof Map, "computeRecurrences returns a Map");
ok(recMap.get("AAPL").count === 4, "AAPL has 4 distinct cohort dates → count = 4");
ok(recMap.get("AAPL").appearances.length === 4, "AAPL appearances array has 4 entries");
ok(recMap.get("AAPL").appearances[0].cohortDate === "2026-04-15", "AAPL appearances sorted newest-first");
ok(recMap.get("AAPL").appearances[3].cohortDate === "2026-04-01", "AAPL oldest appearance last");
ok(recMap.get("NVDA").count === 1, "NVDA appears once → count = 1 (no badge)");
ok(recMap.get("MSFT").count === 2, "MSFT appears twice → count = 2 (badge)");
// Dedup: same (symbol, cohort_date) must not inflate count
const dedupInput = [
  { symbol: "TSLA", cohort_date: "2026-04-01", direction: "LONG",  entry_price: 200, day_change_pct: 1 },
  { symbol: "TSLA", cohort_date: "2026-04-01", direction: "LONG",  entry_price: 200, day_change_pct: 1 },
  { symbol: "TSLA", cohort_date: "2026-04-02", direction: "LONG",  entry_price: 201, day_change_pct: 1 },
];
const dedupMap = computeRecurrences(dedupInput);
ok(dedupMap.get("TSLA").count === 2, "duplicate (symbol, cohort_date) de-duped to 1 appearance");
// Date type tolerance (Date object and ISO string with time both slice to YYYY-MM-DD)
const dateObjInput = [
  { symbol: "AMD", cohort_date: "2026-04-01T12:00:00Z", direction: "LONG", entry_price: 100, day_change_pct: 1 },
  { symbol: "AMD", cohort_date: new Date("2026-04-02T12:00:00Z"), direction: "LONG", entry_price: 100, day_change_pct: 1 },
];
const dateObjMap = computeRecurrences(dateObjInput);
ok(dateObjMap.get("AMD").count === 2, "Date objects and ISO strings both normalized to YYYY-MM-DD");
ok(dateObjMap.get("AMD").appearances[0].cohortDate.length === 10, "cohortDate stored as YYYY-MM-DD (10 chars)");

// Empty input
const emptyRec = computeRecurrences([]);
ok(emptyRec.size === 0, "empty input → empty Map");

// ---------------------------------------------------------------------------
// V2 — F4 cell price: snapshot prices preserved through evaluateScenario
// ---------------------------------------------------------------------------
section("V2/F4 — snapshot price is carried through per-snapshot results");

const priceTl = [
  { key: "d1_morning", price: 667 },
  { key: "d1_close",   price: 680 },
];
const priceRes = evaluateScenario(
  "momentum",
  { symbol: "ABC", entryPrice: 667, dayChangePct: 1 },
  priceTl,
  params1x,
);
ok(priceRes.snapshots[0].price === 667, "F4: snapshot.price = 667 preserved from input");
ok(priceRes.snapshots[1].price === 680, "F4: later snapshot.price = 680 preserved");
near(priceRes.snapshots[1].pnlPct, ((680 - 667) / 667) * 100, 0.01, "F4: pnlPct still computed alongside price");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n----------------------------------------");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log("----------------------------------------");

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
