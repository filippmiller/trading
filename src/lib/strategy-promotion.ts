import { z } from "zod";

import type { StrategyConfig } from "@/lib/strategy-engine";

const BarTimeSchema = z.enum(["morning", "midday", "close"]);

const FiltersSchema = z.object({
  cohortDateFrom: z.string().optional(),
  cohortDateTo: z.string().optional(),
  direction: z.enum(["UP", "DOWN", "BOTH"]).optional(),
  minDayChangePct: z.number().finite().nonnegative().optional(),
  maxDayChangePct: z.number().finite().nonnegative().optional(),
  minStreak: z.number().int().min(1).max(20).optional(),
  maxStreak: z.number().int().min(1).max(20).optional(),
  enrollmentSources: z.array(z.enum(["MOVERS", "TREND"])).max(2).optional(),
});

const CostsSchema = z.object({
  commissionRoundTrip: z.number().finite().min(0).max(1_000),
  marginApyPct: z.number().finite().min(0).max(100),
});

const GridRowSchema = z.object({
  holdDays: z.number().int().min(1).max(10),
  exitBar: BarTimeSchema,
  entryDelayDays: z.number().int().min(0).max(9),
  entryBar: BarTimeSchema,
  hardStopPct: z.number().finite().max(0).nullable(),
  takeProfitPct: z.number().finite().min(0).nullable(),
  trailingStopPct: z.number().finite().min(0).nullable(),
  breakevenAtPct: z.number().finite().min(0).nullable(),
  n: z.number().int().min(0),
  winRate: z.number().finite(),
  totalPnlUsd: z.number().finite(),
  avgPnlPct: z.number().finite(),
  bestPct: z.number().finite(),
  worstPct: z.number().finite(),
  profitFactor: z.number().finite().nullable(),
  sharpeRatio: z.number().finite(),
  avgHoldDays: z.number().finite(),
});

export const PromoteStrategySchema = z.object({
  name: z.string().trim().min(1).max(128),
  accountInitialCash: z.number().finite().min(100).max(10_000_000).default(100_000),
  filters: FiltersSchema,
  trade: z.object({
    investmentUsd: z.number().finite().min(1).max(1_000_000),
    leverage: z.number().int().min(1).max(100),
    tradeDirection: z.enum(["LONG", "SHORT"]),
  }),
  costs: CostsSchema,
  row: GridRowSchema,
});

export type PromoteStrategyInput = z.infer<typeof PromoteStrategySchema>;

export type PromotedStrategyConfig = StrategyConfig & {
  research_provenance: {
    source: "grid_sweep";
    promotion_key: string;
    promoted_at: string;
    filters: PromoteStrategyInput["filters"];
    grid_row: PromoteStrategyInput["row"];
    trade: PromoteStrategyInput["trade"];
    costs: PromoteStrategyInput["costs"];
    warnings: string[];
  };
};

export function buildPromotedStrategyConfig(
  input: PromoteStrategyInput,
  promotedAt = new Date().toISOString(),
): { config: PromotedStrategyConfig; warnings: string[] } {
  const warnings: string[] = [];
  const promotionKey = buildPromotionKey(input);
  const entry: StrategyConfig["entry"] = {
    direction: cohortDirectionFromFilter(input.filters.direction),
    trade_direction: input.trade.tradeDirection,
  };

  applyDayChangeFilters(entry, input.filters);

  if (input.filters.minStreak != null) {
    entry.min_consecutive_days = input.filters.minStreak;
  }
  if (input.filters.maxStreak != null) {
    entry.max_consecutive_days = input.filters.maxStreak;
  }
  if (input.filters.enrollmentSources?.length === 1) {
    entry.enrollment_source = input.filters.enrollmentSources[0];
  } else if (input.filters.enrollmentSources?.length && input.filters.enrollmentSources.length > 1) {
    entry.enrollment_source = "ANY";
  }

  if (input.row.entryDelayDays > 0) {
    warnings.push("Entry delay is preserved in provenance but cron execution currently enters on fresh enrolled entries.");
  }
  if (input.row.entryBar !== "close") {
    warnings.push("Entry bar is preserved in provenance but cron execution currently uses the enrollment entry price.");
  }
  if (input.row.exitBar !== "close") {
    warnings.push("Exit bar is preserved in provenance but paper signal exits are evaluated on monitor ticks, not a fixed bar.");
  }
  if (input.row.breakevenAtPct != null) {
    warnings.push("Breakeven arm is preserved in provenance but not executable by paper_strategies yet.");
  }
  if (input.costs.commissionRoundTrip > 0 || input.costs.marginApyPct > 0) {
    warnings.push("Research costs are preserved in provenance; live paper strategy execution uses global paper risk settings.");
  }

  const exits: StrategyConfig["exits"] = {
    time_exit_days: input.row.holdDays,
  };
  if (input.row.hardStopPct != null) exits.hard_stop_pct = input.row.hardStopPct;
  if (input.row.takeProfitPct != null) exits.take_profit_pct = input.row.takeProfitPct;
  if (input.row.trailingStopPct != null) {
    exits.trailing_stop_pct = input.row.trailingStopPct;
    exits.trailing_activates_at_profit_pct = 0;
  }

  const config: PromotedStrategyConfig = {
    entry,
    sizing: {
      type: "fixed",
      amount_usd: input.trade.investmentUsd,
      max_concurrent: 15,
      max_new_per_day: 3,
    },
    exits,
    research_provenance: {
      source: "grid_sweep",
      promotion_key: promotionKey,
      promoted_at: promotedAt,
      filters: input.filters,
      grid_row: input.row,
      trade: input.trade,
      costs: input.costs,
      warnings,
    },
  };

  return { config, warnings };
}

export function buildPromotionKey(input: PromoteStrategyInput): string {
  return [
    "grid_sweep",
    stableStringify(normalizeForKey(input.filters)),
    stableStringify(normalizeForKey(input.trade)),
    stableStringify(normalizeForKey(input.costs)),
    stableStringify(normalizeForKey(input.row)),
  ].join("|");
}

export function summarizePromotedStrategy(input: PromoteStrategyInput): string {
  const direction = input.filters.direction ?? "BOTH";
  const stop = input.row.hardStopPct == null ? "no SL" : `SL ${input.row.hardStopPct}%`;
  const profit = input.row.takeProfitPct == null ? "no TP" : `TP ${input.row.takeProfitPct}%`;
  const trail = input.row.trailingStopPct == null ? "no trail" : `trail ${input.row.trailingStopPct}%`;
  const streak = [
    input.filters.minStreak != null ? `min streak ${input.filters.minStreak}` : null,
    input.filters.maxStreak != null ? `max streak ${input.filters.maxStreak}` : null,
  ].filter(Boolean).join(", ");
  return [
    `${direction} cohort traded ${input.trade.tradeDirection}`,
    `$${input.trade.investmentUsd} at ${input.trade.leverage}x`,
    `${input.row.holdDays}d hold`,
    stop,
    profit,
    trail,
    streak || null,
  ].filter(Boolean).join(" · ");
}

function cohortDirectionFromFilter(direction: PromoteStrategyInput["filters"]["direction"]): "LONG" | "SHORT" | "ANY" {
  if (direction === "UP") return "SHORT";
  if (direction === "DOWN") return "LONG";
  return "ANY";
}

function applyDayChangeFilters(entry: StrategyConfig["entry"], filters: PromoteStrategyInput["filters"]) {
  const min = filters.minDayChangePct;
  const max = filters.maxDayChangePct;

  if (filters.direction === "DOWN") {
    if (min != null) entry.min_drop_pct = -min;
    if (max != null) entry.max_drop_pct = -max;
    return;
  }

  if (filters.direction === "UP") {
    if (min != null) entry.min_rise_pct = min;
    if (max != null) entry.max_rise_pct = max;
    return;
  }

  if (min != null) {
    entry.min_drop_pct = -min;
    entry.min_rise_pct = min;
  }
  if (max != null) {
    entry.max_drop_pct = -max;
    entry.max_rise_pct = max;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeForKey<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForKey(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (entryValue !== undefined) out[key] = normalizeForKey(entryValue);
    }
    return out as T;
  }
  return value;
}
