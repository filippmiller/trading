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
const comparison = compareAllScenarios(cohort, () => flatFuture, params1x);

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

// ---------------------------------------------------------------------------
// 11. Zero entry price / bad input safety
// ---------------------------------------------------------------------------
section("Input safety");

const zeroPriceTicker = { symbol: "ZERO", entryPrice: 0, dayChangePct: 1 };
const zeroRes = evaluateScenario("momentum", zeroPriceTicker, [{ key: "d1_close", price: 50 }], params1x);
ok(zeroRes.snapshots[0].pnlUsd === null, "zero entry price → null pnl (div-by-zero guard)");

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
