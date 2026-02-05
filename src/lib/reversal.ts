import { z } from "zod";

// Settings for the reversal study
export const ReversalSettingsSchema = z.object({
  position_size_usd: z.number().min(10).max(10000).default(100),
  commission_per_trade_usd: z.number().min(0).max(50).default(1),
  short_borrow_rate_apr: z.number().min(0).max(0.5).default(0.03), // 3% annual
  leverage_interest_apr: z.number().min(0).max(0.5).default(0.08), // 8% annual
  leverage_multiplier: z.number().min(1).max(5).default(1), // 1 = no leverage
});

export type ReversalSettings = z.infer<typeof ReversalSettingsSchema>;

// A single stock entry in a daily cohort
export type ReversalEntry = {
  id: number;
  cohort_date: string; // Date when position was opened (YYYY-MM-DD)
  symbol: string;
  direction: "LONG" | "SHORT"; // LONG = was a loser (buy), SHORT = was a gainer (sell)
  day_change_pct: number; // How much it moved on the trigger day
  entry_price: number; // Price at entry (5 min before close)

  // Measurement grid: 3 days × 3 times = 9 cells
  // Day 1 (next day after entry)
  d1_morning: number | null;
  d1_midday: number | null;
  d1_close: number | null;
  // Day 2
  d2_morning: number | null;
  d2_midday: number | null;
  d2_close: number | null;
  // Day 3
  d3_morning: number | null;
  d3_midday: number | null;
  d3_close: number | null;

  // Computed when all measurements are in
  final_pnl_usd: number | null;
  final_pnl_pct: number | null;
  status: "ACTIVE" | "COMPLETED";
  created_at: string;
};

// A cohort is a day's worth of entries (5 gainers + 5 losers = 10 stocks)
export type ReversalCohort = {
  date: string;
  entries: ReversalEntry[];
  total_pnl_usd: number | null;
  total_pnl_pct: number | null;
};

// Calculate P&L for a single entry including costs
export function calculateEntryPnL(
  entry: ReversalEntry,
  settings: ReversalSettings
): { pnl_usd: number; pnl_pct: number; gross_pnl: number; costs: number } | null {
  // Use the last available price as exit price
  const exitPrice =
    entry.d3_close ??
    entry.d3_midday ??
    entry.d3_morning ??
    entry.d2_close ??
    entry.d2_midday ??
    entry.d2_morning ??
    entry.d1_close ??
    entry.d1_midday ??
    entry.d1_morning;

  if (!exitPrice) return null;

  const positionValue = settings.position_size_usd * settings.leverage_multiplier;
  const shares = positionValue / entry.entry_price;

  // Gross P&L
  let grossPnl: number;
  if (entry.direction === "LONG") {
    grossPnl = (exitPrice - entry.entry_price) * shares;
  } else {
    grossPnl = (entry.entry_price - exitPrice) * shares;
  }

  // Costs
  const commissions = settings.commission_per_trade_usd * 2; // Entry + exit

  // Days held (estimate based on which measurements exist)
  let daysHeld = 1;
  if (entry.d2_morning !== null) daysHeld = 2;
  if (entry.d3_morning !== null) daysHeld = 3;

  // Borrow cost for shorts
  let borrowCost = 0;
  if (entry.direction === "SHORT") {
    borrowCost = positionValue * (settings.short_borrow_rate_apr / 365) * daysHeld;
  }

  // Leverage interest (on the borrowed portion)
  let leverageCost = 0;
  if (settings.leverage_multiplier > 1) {
    const borrowedAmount = positionValue - settings.position_size_usd;
    leverageCost = borrowedAmount * (settings.leverage_interest_apr / 365) * daysHeld;
  }

  const totalCosts = commissions + borrowCost + leverageCost;
  const netPnl = grossPnl - totalCosts;
  const pnlPct = netPnl / settings.position_size_usd;

  return {
    pnl_usd: netPnl,
    pnl_pct: pnlPct,
    gross_pnl: grossPnl,
    costs: totalCosts,
  };
}

// Measurement time labels
export const MEASUREMENT_LABELS = {
  d1_morning: "Day 1 Morning (15min after open)",
  d1_midday: "Day 1 Midday (after lunch)",
  d1_close: "Day 1 Close (5min before)",
  d2_morning: "Day 2 Morning",
  d2_midday: "Day 2 Midday",
  d2_close: "Day 2 Close",
  d3_morning: "Day 3 Morning",
  d3_midday: "Day 3 Midday",
  d3_close: "Day 3 Close (Final)",
} as const;

export type MeasurementField = keyof typeof MEASUREMENT_LABELS;

export const MEASUREMENT_FIELDS: MeasurementField[] = [
  "d1_morning",
  "d1_midday",
  "d1_close",
  "d2_morning",
  "d2_midday",
  "d2_close",
  "d3_morning",
  "d3_midday",
  "d3_close",
];
