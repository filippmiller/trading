import { z } from "zod";

export const CostsSchema = z.object({
  commission_per_side_usd: z.number().min(0).max(50),
  slippage_bps: z.number().min(0).max(50),
  margin_interest_apr: z.number().min(0).max(1),
});

export const MartingaleSchema = z.object({
  base_capital_usd: z.number().min(50).max(100000),
  leverage: z.number().min(1).max(10),
  max_steps: z.number().int().min(0).max(5),
  step_multiplier: z.number().min(1).max(5).default(2),
  max_exposure_usd: z.number().min(100).max(250000),
  max_daily_loss_usd: z.number().min(50).max(50000),
});

export const RegimeFilterSchema = z.object({
  type: z.literal("ma"),
  length: z.number().int().min(50).max(400).default(200),
  allow_fade_only_if: z.enum(["price_near_ma", "low_trend_strength"]).default(
    "price_near_ma"
  ),
});

const BaseSpecSchema = z.object({
  symbol: z.literal("SPY"),
  lookback_days: z.number().int().min(20).max(260),
  capital_base_usd: z.number().min(50).max(100000),
  leverage: z.number().min(1).max(10),
  costs: CostsSchema,
  regime_filter: RegimeFilterSchema.optional(),
  martingale_lite: MartingaleSchema.optional(),
});

const StreakBaseSchema = z.object({
  streak_length: z.number().int().min(2).max(5),
  enter_on: z.literal("close"),
  direction: z.enum(["fade", "follow"]),
  stop_loss_pct: z.number().min(0.001).max(0.2),
  take_profit_pct: z.number().min(0).max(0.2).optional(),
  trailing_stop_pct: z.number().min(0.001).max(0.2).optional(),
  hold_max_days: z.number().int().min(1).max(10).default(1),
});

export const StreakFadeSchema = BaseSpecSchema.extend({
  template: z.literal("streak_fade"),
}).merge(StreakBaseSchema);

export const StreakFollowSchema = BaseSpecSchema.extend({
  template: z.literal("streak_follow"),
}).merge(StreakBaseSchema);

export const SarFadeFlipSchema = BaseSpecSchema.extend({
  template: z.literal("sar_fade_flip"),
  flip_on_stop: z.literal(true),
  flip_max_times: z.number().int().min(0).max(3).default(1),
}).merge(StreakBaseSchema);

export const GapFadeSchema = BaseSpecSchema.extend({
  template: z.literal("gap_fade"),
  enter_on: z.literal("open"),
  gap_threshold_pct: z.number().min(0.001).max(0.05),
  stop_loss_pct: z.number().min(0.001).max(0.2),
  take_profit_pct: z.number().min(0).max(0.2).optional(),
  trailing_stop_pct: z.number().min(0.001).max(0.2).optional(),
  hold_max_days: z.number().int().min(0).max(1).default(0),
  direction: z.literal("fade"),
});

export const StrategySpecSchema = z.discriminatedUnion("template", [
  StreakFadeSchema,
  StreakFollowSchema,
  SarFadeFlipSchema,
  GapFadeSchema,
]);

export type StrategySpec = z.infer<typeof StrategySpecSchema>;

export function clampSpec(input: StrategySpec): StrategySpec {
  const spec = { ...input } as StrategySpec;
  spec.leverage = Math.min(10, Math.max(1, spec.leverage));
  if (spec.martingale_lite) {
    spec.martingale_lite.leverage = Math.min(
      10,
      Math.max(1, spec.martingale_lite.leverage)
    );
    spec.martingale_lite.max_steps = Math.min(
      5,
      Math.max(0, spec.martingale_lite.max_steps)
    );
  }
  if ("trailing_stop_pct" in spec && spec.trailing_stop_pct !== undefined) {
    spec.trailing_stop_pct = Math.max(0.001, spec.trailing_stop_pct);
  }
  return spec;
}