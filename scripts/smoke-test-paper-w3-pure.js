#!/usr/bin/env node
/**
 * Pure-function unit tests for paper-exits.ts — no DB required.
 * Exercises the core decision logic used by both the paper_signals cron
 * and the new paper_trades monitor.
 */

const paperExits = require("../src/lib/paper-exits");

let passed = 0, failed = 0;
function assert(c, msg) {
  if (c) { passed++; console.log(`  PASS ${msg}`); }
  else   { failed++; console.log(`  FAIL ${msg}`); }
}

function baseInput(overrides = {}) {
  return {
    entryPrice: 100,
    side: "LONG",
    leverage: 1,
    stopLossPrice: null,
    takeProfitPrice: null,
    trailingStopPct: null,
    trailingActivatesAtProfitPct: null,
    trailingStopPrice: null,
    trailingActive: false,
    timeExitDate: null,
    maxPnlPct: null,
    minPnlPct: null,
    maxPrice: null,
    minPrice: null,
    ...overrides,
  };
}

console.log("Pure-function paper-exits tests:\n");

// Hard stop LONG/SHORT
{
  const inp = baseInput({ stopLossPrice: 95 });
  assert(paperExits.evaluateExits(inp, 94, new Date("2026-04-21")).reason === "HARD_STOP", "LONG hard stop @94 with stop=95");
  assert(paperExits.evaluateExits(inp, 96, new Date("2026-04-21")) === null, "LONG hard stop silent @96");
}
{
  const inp = baseInput({ side: "SHORT", stopLossPrice: 105 });
  assert(paperExits.evaluateExits(inp, 106, new Date("2026-04-21")).reason === "HARD_STOP", "SHORT hard stop @106 with stop=105");
  assert(paperExits.evaluateExits(inp, 104, new Date("2026-04-21")) === null, "SHORT hard stop silent @104");
}

// Take profit LONG/SHORT
{
  const inp = baseInput({ takeProfitPrice: 110 });
  assert(paperExits.evaluateExits(inp, 111, new Date()).reason === "TAKE_PROFIT", "LONG TP @111 with tp=110");
}
{
  const inp = baseInput({ side: "SHORT", takeProfitPrice: 90 });
  assert(paperExits.evaluateExits(inp, 89, new Date()).reason === "TAKE_PROFIT", "SHORT TP @89 with tp=90");
}

// Trailing stop LONG ratchet
{
  const inp1 = baseInput({ trailingStopPct: 3, trailingActivatesAtProfitPct: 5 });
  const r1 = paperExits.evaluateExitsAlways(inp1, 110, new Date());
  assert(r1.reason === null, "trail tick1: no exit at 110");
  assert(r1.watermarks.trailingActive === true, "trail tick1: activates at 10% pnl > 5% threshold");
  assert(Math.abs(r1.watermarks.trailingStopPrice - 106.7) < 0.01, `trail tick1: stop = 110*0.97 = 106.7 (got ${r1.watermarks.trailingStopPrice})`);

  const inp2 = baseInput({ trailingStopPct: 3, trailingActivatesAtProfitPct: 5, trailingActive: true, trailingStopPrice: 106.7, maxPrice: 110, minPrice: 110, maxPnlPct: 10 });
  const r2 = paperExits.evaluateExitsAlways(inp2, 115, new Date());
  assert(r2.reason === null, "trail tick2: no exit at 115");
  assert(Math.abs(r2.watermarks.trailingStopPrice - 111.55) < 0.01, `trail tick2: ratchets to 115*0.97 = 111.55 (got ${r2.watermarks.trailingStopPrice})`);

  const inp3 = baseInput({ trailingStopPct: 3, trailingActivatesAtProfitPct: 5, trailingActive: true, trailingStopPrice: 111.55, maxPrice: 115, minPrice: 110, maxPnlPct: 15 });
  const r3 = paperExits.evaluateExitsAlways(inp3, 111, new Date());
  assert(r3.reason === "TRAILING_STOP", `trail tick3: TRAILING_STOP fires at 111 < 111.55 (got ${r3.reason})`);
}

// Trailing stop SHORT ratchet
{
  const inp1 = baseInput({ side: "SHORT", trailingStopPct: 3, trailingActivatesAtProfitPct: 5 });
  // SHORT profits when price falls. 10% profit at 90.
  const r1 = paperExits.evaluateExitsAlways(inp1, 90, new Date());
  assert(r1.reason === null, "SHORT trail tick1: no exit at 90");
  assert(r1.watermarks.trailingActive === true, "SHORT trail tick1: activates at 10% pnl");
  assert(Math.abs(r1.watermarks.trailingStopPrice - 92.7) < 0.01, `SHORT trail tick1: stop = 90*1.03 = 92.7 (got ${r1.watermarks.trailingStopPrice})`);

  // Price drops further to 85 → ratchet stop down.
  const inp2 = baseInput({ side: "SHORT", trailingStopPct: 3, trailingActivatesAtProfitPct: 5, trailingActive: true, trailingStopPrice: 92.7, maxPrice: 90, minPrice: 90, maxPnlPct: 10 });
  const r2 = paperExits.evaluateExitsAlways(inp2, 85, new Date());
  assert(r2.reason === null, "SHORT trail tick2: no exit at 85");
  assert(Math.abs(r2.watermarks.trailingStopPrice - 87.55) < 0.01, `SHORT trail tick2: stop ratchets to 85*1.03 = 87.55 (got ${r2.watermarks.trailingStopPrice})`);

  // Price bounces back to 88 → fires (> 87.55 stop for SHORT).
  const inp3 = baseInput({ side: "SHORT", trailingStopPct: 3, trailingActivatesAtProfitPct: 5, trailingActive: true, trailingStopPrice: 87.55, maxPrice: 90, minPrice: 85, maxPnlPct: 15 });
  const r3 = paperExits.evaluateExitsAlways(inp3, 88, new Date());
  assert(r3.reason === "TRAILING_STOP", `SHORT trail tick3: fires at 88 > 87.55 (got ${r3.reason})`);
}

// Time exit — today / future
{
  const today = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  assert(paperExits.evaluateExits(baseInput({ timeExitDate: today }), 100, new Date()).reason === "TIME_EXIT", "TIME_EXIT fires on target date");
  assert(paperExits.evaluateExits(baseInput({ timeExitDate: future }), 100, new Date()) === null, "TIME_EXIT silent with future date");
}

// Direction-aware PnL
{
  assert(Math.abs(paperExits.computePnlPct(100, 110, "LONG") - 10) < 0.0001, "LONG 100→110 = +10%");
  assert(Math.abs(paperExits.computePnlPct(100, 110, "SHORT") - (-10)) < 0.0001, "SHORT 100→110 = -10%");
  assert(Math.abs(paperExits.computePnlPct(100, 90, "SHORT") - 10) < 0.0001, "SHORT 100→90 = +10%");
}

// Priority: HARD_STOP beats nothing; TAKE_PROFIT overwrites
{
  // When hard_stop AND take_profit both would hit, tp wins (priority order).
  // This preserves the signal-monitor original semantics where rules run in
  // sequence and later rules can overwrite earlier ones.
  const inp = baseInput({ stopLossPrice: 95, takeProfitPrice: 105 });
  const dHit = paperExits.evaluateExits(inp, 120, new Date());
  // Only TP applies (price went up); HARD_STOP does not fire for LONG at 120.
  assert(dHit && dHit.reason === "TAKE_PROFIT", `LONG @120 with stop=95 tp=105: TAKE_PROFIT wins`);
}

console.log(`\n== ${passed} passed, ${failed} failed ==`);
process.exit(failed === 0 ? 0 : 1);
