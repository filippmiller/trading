import { z } from "zod";

import {
  clampSpec,
  CostsSchema,
  MartingaleSchema,
  RegimeFilterSchema,
  StrategySpec,
  StrategySpecSchema,
} from "@/lib/strategy";

export type ScenarioField = {
  key: string;
  label: string;
  type: "number" | "checkbox";
  step?: number;
  min?: number;
  max?: number;
  helper?: string;
};

export type ScenarioDefinition = {
  id: string;
  name: string;
  description_en: string;
  description_ru: string;
  fields: ScenarioField[];
  defaultValues: Record<string, number | boolean>;
  schema: z.ZodTypeAny;
  buildSpec: (values: Record<string, number | boolean>, lookbackDays: number) => StrategySpec;
  riskWarning?: string;
};

const baseCostsSchema = z.object({
  commission_per_side_usd: z.number().min(0).max(50),
  slippage_bps: z.number().min(0).max(50),
  margin_interest_apr: z.number().min(0).max(1),
});

const baseSizingSchema = z.object({
  leverage: z.number().min(1).max(10),
  capital_base_usd: z.number().min(50).max(100000),
});

const streakFields: ScenarioField[] = [
  { key: "streak_length", label: "Streak length", type: "number", step: 1, min: 2, max: 5 },
  { key: "stop_loss_pct", label: "Stop loss (%)", type: "number", step: 0.001, min: 0.001, max: 0.2 },
  { key: "take_profit_pct", label: "Take profit (%)", type: "number", step: 0.001, min: 0, max: 0.2 },
  { key: "trailing_stop_pct", label: "Trailing stop (%)", type: "number", step: 0.001, min: 0, max: 0.2 },
  { key: "hold_max_days", label: "Hold max days", type: "number", step: 1, min: 1, max: 10 },
];

const sizingFields: ScenarioField[] = [
  { key: "leverage", label: "Leverage", type: "number", step: 1, min: 1, max: 10 },
  { key: "capital_base_usd", label: "Capital (USD)", type: "number", step: 50, min: 50, max: 100000 },
];

const costFields: ScenarioField[] = [
  { key: "commission_per_side_usd", label: "Commission per side ($)", type: "number", step: 0.1, min: 0, max: 50 },
  { key: "slippage_bps", label: "Slippage (bps)", type: "number", step: 0.5, min: 0, max: 50 },
  { key: "margin_interest_apr", label: "Margin APR", type: "number", step: 0.01, min: 0, max: 1 },
];

const martingaleFields: ScenarioField[] = [
  { key: "martingale_base_capital_usd", label: "Base capital (USD)", type: "number", step: 50, min: 50, max: 100000 },
  { key: "martingale_leverage", label: "Leverage", type: "number", step: 1, min: 1, max: 10 },
  { key: "martingale_max_steps", label: "Max steps", type: "number", step: 1, min: 0, max: 5 },
  { key: "martingale_step_multiplier", label: "Step multiplier", type: "number", step: 0.5, min: 1, max: 5 },
  { key: "martingale_max_exposure_usd", label: "Max exposure (USD)", type: "number", step: 100, min: 100, max: 250000 },
  { key: "martingale_max_daily_loss_usd", label: "Max daily loss (USD)", type: "number", step: 10, min: 50, max: 50000 },
];

const regimeFilterField: ScenarioField = {
  key: "use_regime_filter",
  label: "Enable MA200 regime filter",
  type: "checkbox",
};

const gapFields: ScenarioField[] = [
  { key: "gap_threshold_pct", label: "Gap threshold (%)", type: "number", step: 0.001, min: 0.001, max: 0.05 },
  { key: "stop_loss_pct", label: "Stop loss (%)", type: "number", step: 0.001, min: 0.001, max: 0.2 },
  { key: "take_profit_pct", label: "Take profit (%)", type: "number", step: 0.001, min: 0, max: 0.2 },
  { key: "trailing_stop_pct", label: "Trailing stop (%)", type: "number", step: 0.001, min: 0, max: 0.2 },
];

function buildCosts(values: Record<string, number | boolean>) {
  return CostsSchema.parse({
    commission_per_side_usd: Number(values.commission_per_side_usd),
    slippage_bps: Number(values.slippage_bps),
    margin_interest_apr: Number(values.margin_interest_apr),
  });
}

function optionalPct(value: number | boolean | undefined) {
  if (typeof value !== "number") return undefined;
  if (value <= 0) return undefined;
  return value;
}

function buildRegime(values: Record<string, number | boolean>) {
  if (!values.use_regime_filter) return undefined;
  return RegimeFilterSchema.parse({ type: "ma", length: 200, allow_fade_only_if: "price_near_ma" });
}

const baseDefaults = {
  streak_length: 3,
  stop_loss_pct: 0.005,
  take_profit_pct: 0.01,
  trailing_stop_pct: 0,
  hold_max_days: 1,
  leverage: 5,
  capital_base_usd: 500,
  commission_per_side_usd: 1,
  slippage_bps: 2,
  margin_interest_apr: 0.12,
  gap_threshold_pct: 0.007,
  flip_max_times: 1,
  use_regime_filter: false,
  martingale_base_capital_usd: 500,
  martingale_leverage: 10,
  martingale_max_steps: 3,
  martingale_step_multiplier: 2,
  martingale_max_exposure_usd: 5000,
  martingale_max_daily_loss_usd: 150,
};

export const scenarios: ScenarioDefinition[] = [
  {
    id: "streak-fade-3",
    name: "Streak Fade (3)",
    description_en: "Fade 3-day streaks. Contrarian entry at close.",
    description_ru: "Контртренд после 3-дневной серии.",
    fields: [...streakFields, ...sizingFields, ...costFields],
    defaultValues: { ...baseDefaults, streak_length: 3 },
    schema: z
      .object({
        streak_length: z.number().int().min(2).max(5),
        stop_loss_pct: z.number().min(0.001).max(0.2),
        take_profit_pct: z.number().min(0).max(0.2),
        trailing_stop_pct: z.number().min(0).max(0.2),
        hold_max_days: z.number().int().min(1).max(10),
      })
      .merge(baseSizingSchema)
      .merge(baseCostsSchema),
    buildSpec(values, lookbackDays) {
      const parsed = this.schema.parse(values);
      const spec: StrategySpec = {
        template: "streak_fade",
        symbol: "SPY",
        lookback_days: lookbackDays,
        direction: "fade",
        enter_on: "close",
        streak_length: parsed.streak_length,
        stop_loss_pct: parsed.stop_loss_pct,
        take_profit_pct: optionalPct(parsed.take_profit_pct),
        trailing_stop_pct: optionalPct(parsed.trailing_stop_pct),
        hold_max_days: parsed.hold_max_days,
        leverage: parsed.leverage,
        capital_base_usd: parsed.capital_base_usd,
        costs: buildCosts(values),
      };
      return clampSpec(StrategySpecSchema.parse(spec));
    },
  },
  {
    id: "streak-fade-2",
    name: "Streak Fade (2)",
    description_en: "Fade 2-day streaks. Faster mean reversion.",
    description_ru: "Контртренд после 2-дневной серии.",
    fields: [...streakFields, ...sizingFields, ...costFields],
    defaultValues: { ...baseDefaults, streak_length: 2 },
    schema: z
      .object({
        streak_length: z.number().int().min(2).max(5),
        stop_loss_pct: z.number().min(0.001).max(0.2),
        take_profit_pct: z.number().min(0).max(0.2),
        trailing_stop_pct: z.number().min(0).max(0.2),
        hold_max_days: z.number().int().min(1).max(10),
      })
      .merge(baseSizingSchema)
      .merge(baseCostsSchema),
    buildSpec(values, lookbackDays) {
      const parsed = this.schema.parse(values);
      const spec: StrategySpec = {
        template: "streak_fade",
        symbol: "SPY",
        lookback_days: lookbackDays,
        direction: "fade",
        enter_on: "close",
        streak_length: parsed.streak_length,
        stop_loss_pct: parsed.stop_loss_pct,
        take_profit_pct: optionalPct(parsed.take_profit_pct),
        trailing_stop_pct: optionalPct(parsed.trailing_stop_pct),
        hold_max_days: parsed.hold_max_days,
        leverage: parsed.leverage,
        capital_base_usd: parsed.capital_base_usd,
        costs: buildCosts(values),
      };
      return clampSpec(StrategySpecSchema.parse(spec));
    },
  },
  {
    id: "streak-follow-3",
    name: "Streak Follow (3)",
    description_en: "Follow 3-day streaks. Momentum bias.",
    description_ru: "Следование тренду после 3-дневной серии.",
    fields: [...streakFields, ...sizingFields, ...costFields],
    defaultValues: { ...baseDefaults, streak_length: 3 },
    schema: z
      .object({
        streak_length: z.number().int().min(2).max(5),
        stop_loss_pct: z.number().min(0.001).max(0.2),
        take_profit_pct: z.number().min(0).max(0.2),
        trailing_stop_pct: z.number().min(0).max(0.2),
        hold_max_days: z.number().int().min(1).max(10),
      })
      .merge(baseSizingSchema)
      .merge(baseCostsSchema),
    buildSpec(values, lookbackDays) {
      const parsed = this.schema.parse(values);
      const spec: StrategySpec = {
        template: "streak_follow",
        symbol: "SPY",
        lookback_days: lookbackDays,
        direction: "follow",
        enter_on: "close",
        streak_length: parsed.streak_length,
        stop_loss_pct: parsed.stop_loss_pct,
        take_profit_pct: optionalPct(parsed.take_profit_pct),
        trailing_stop_pct: optionalPct(parsed.trailing_stop_pct),
        hold_max_days: parsed.hold_max_days,
        leverage: parsed.leverage,
        capital_base_usd: parsed.capital_base_usd,
        costs: buildCosts(values),
      };
      return clampSpec(StrategySpecSchema.parse(spec));
    },
  },
  {
    id: "gap-reversion",
    name: "Gap Reversion (Daily)",
    description_en: "Fade large open gaps, exit same day.",
    description_ru: "Отработка дневных гэпов с выходом в тот же день.",
    fields: [...gapFields, ...sizingFields, ...costFields],
    defaultValues: { ...baseDefaults, take_profit_pct: 0.01, stop_loss_pct: 0.005 },
    schema: z
      .object({
        gap_threshold_pct: z.number().min(0.001).max(0.05),
        stop_loss_pct: z.number().min(0.001).max(0.2),
        take_profit_pct: z.number().min(0).max(0.2),
        trailing_stop_pct: z.number().min(0).max(0.2),
      })
      .merge(baseSizingSchema)
      .merge(baseCostsSchema),
    buildSpec(values, lookbackDays) {
      const parsed = this.schema.parse(values);
      const spec: StrategySpec = {
        template: "gap_fade",
        symbol: "SPY",
        lookback_days: lookbackDays,
        direction: "fade",
        enter_on: "open",
        gap_threshold_pct: parsed.gap_threshold_pct,
        stop_loss_pct: parsed.stop_loss_pct,
        take_profit_pct: optionalPct(parsed.take_profit_pct),
        trailing_stop_pct: optionalPct(parsed.trailing_stop_pct),
        hold_max_days: 0,
        leverage: parsed.leverage,
        capital_base_usd: parsed.capital_base_usd,
        costs: buildCosts(values),
      };
      return clampSpec(StrategySpecSchema.parse(spec));
    },
  },
  {
    id: "sar-fade-flip",
    name: "SAR Fade/Flip",
    description_en: "Fade streaks, flip once on stop.",
    description_ru: "Контртренд с одним переворотом по стопу.",
    fields: [...streakFields, ...sizingFields, ...costFields],
    defaultValues: { ...baseDefaults, streak_length: 3 },
    schema: z
      .object({
        streak_length: z.number().int().min(2).max(5),
        stop_loss_pct: z.number().min(0.001).max(0.2),
        take_profit_pct: z.number().min(0).max(0.2),
        trailing_stop_pct: z.number().min(0).max(0.2),
        hold_max_days: z.number().int().min(1).max(10),
      })
      .merge(baseSizingSchema)
      .merge(baseCostsSchema),
    buildSpec(values, lookbackDays) {
      const parsed = this.schema.parse(values);
      const spec: StrategySpec = {
        template: "sar_fade_flip",
        symbol: "SPY",
        lookback_days: lookbackDays,
        direction: "fade",
        enter_on: "close",
        streak_length: parsed.streak_length,
        stop_loss_pct: parsed.stop_loss_pct,
        take_profit_pct: optionalPct(parsed.take_profit_pct),
        trailing_stop_pct: optionalPct(parsed.trailing_stop_pct),
        hold_max_days: parsed.hold_max_days,
        flip_on_stop: true,
        flip_max_times: 1,
        leverage: parsed.leverage,
        capital_base_usd: parsed.capital_base_usd,
        costs: buildCosts(values),
      };
      return clampSpec(StrategySpecSchema.parse(spec));
    },
  },
  {
    id: "trailing-only",
    name: "Trailing Only (0.3%)",
    description_en: "Trailing stop dominates, hard SL as catastrophe.",
    description_ru: "Только трейлинг-стоп + аварийный стоп.",
    fields: [...streakFields, ...sizingFields, ...costFields],
    defaultValues: { ...baseDefaults, trailing_stop_pct: 0.003, take_profit_pct: 0 },
    schema: z
      .object({
        streak_length: z.number().int().min(2).max(5),
        stop_loss_pct: z.number().min(0.001).max(0.2),
        take_profit_pct: z.number().min(0).max(0.2),
        trailing_stop_pct: z.number().min(0).max(0.2),
        hold_max_days: z.number().int().min(1).max(10),
      })
      .merge(baseSizingSchema)
      .merge(baseCostsSchema),
    buildSpec(values, lookbackDays) {
      const parsed = this.schema.parse(values);
      const spec: StrategySpec = {
        template: "streak_fade",
        symbol: "SPY",
        lookback_days: lookbackDays,
        direction: "fade",
        enter_on: "close",
        streak_length: parsed.streak_length,
        stop_loss_pct: parsed.stop_loss_pct,
        take_profit_pct: optionalPct(parsed.take_profit_pct),
        trailing_stop_pct: optionalPct(parsed.trailing_stop_pct),
        hold_max_days: parsed.hold_max_days,
        leverage: parsed.leverage,
        capital_base_usd: parsed.capital_base_usd,
        costs: buildCosts(values),
      };
      return clampSpec(StrategySpecSchema.parse(spec));
    },
  },
  {
    id: "martingale-lite",
    name: "Martingale-lite (Capped)",
    description_en: "Size up after losses with strict caps.",
    description_ru: "Мартингейл с жесткими ограничениями.",
    fields: [...streakFields, ...martingaleFields, ...costFields],
    defaultValues: { ...baseDefaults },
    schema: z
      .object({
        streak_length: z.number().int().min(2).max(5),
        stop_loss_pct: z.number().min(0.001).max(0.2),
        take_profit_pct: z.number().min(0).max(0.2),
        trailing_stop_pct: z.number().min(0).max(0.2),
        hold_max_days: z.number().int().min(1).max(10),
      })
      .merge(
        z.object({
          martingale_base_capital_usd: z.number().min(50).max(100000),
          martingale_leverage: z.number().min(1).max(10),
          martingale_max_steps: z.number().int().min(0).max(5),
          martingale_step_multiplier: z.number().min(1).max(5),
          martingale_max_exposure_usd: z.number().min(100).max(250000),
          martingale_max_daily_loss_usd: z.number().min(50).max(50000),
        })
      )
      .merge(baseCostsSchema),
    riskWarning: "High risk. Capped martingale only.",
    buildSpec(values, lookbackDays) {
      const parsed = this.schema.parse(values);
      const martingale = MartingaleSchema.parse({
        base_capital_usd: parsed.martingale_base_capital_usd,
        leverage: parsed.martingale_leverage,
        max_steps: parsed.martingale_max_steps,
        step_multiplier: parsed.martingale_step_multiplier,
        max_exposure_usd: parsed.martingale_max_exposure_usd,
        max_daily_loss_usd: parsed.martingale_max_daily_loss_usd,
      });
      const spec: StrategySpec = {
        template: "streak_fade",
        symbol: "SPY",
        lookback_days: lookbackDays,
        direction: "fade",
        enter_on: "close",
        streak_length: parsed.streak_length,
        stop_loss_pct: parsed.stop_loss_pct,
        take_profit_pct: optionalPct(parsed.take_profit_pct),
        trailing_stop_pct: optionalPct(parsed.trailing_stop_pct),
        hold_max_days: parsed.hold_max_days,
        leverage: martingale.leverage,
        capital_base_usd: martingale.base_capital_usd,
        martingale_lite: martingale,
        costs: buildCosts(values),
      };
      return clampSpec(StrategySpecSchema.parse(spec));
    },
  },
  {
    id: "regime-filter",
    name: "Regime Filter MA200 (Fade in Range)",
    description_en: "Fade streaks only on the MA200-friendly side.",
    description_ru: "Контртренд с фильтром по MA200.",
    fields: [regimeFilterField, ...streakFields, ...sizingFields, ...costFields],
    defaultValues: { ...baseDefaults, use_regime_filter: true },
    schema: z
      .object({
        use_regime_filter: z.boolean(),
        streak_length: z.number().int().min(2).max(5),
        stop_loss_pct: z.number().min(0.001).max(0.2),
        take_profit_pct: z.number().min(0).max(0.2),
        trailing_stop_pct: z.number().min(0).max(0.2),
        hold_max_days: z.number().int().min(1).max(10),
      })
      .merge(baseSizingSchema)
      .merge(baseCostsSchema),
    buildSpec(values, lookbackDays) {
      const parsed = this.schema.parse(values);
      const spec: StrategySpec = {
        template: "streak_fade",
        symbol: "SPY",
        lookback_days: lookbackDays,
        direction: "fade",
        enter_on: "close",
        streak_length: parsed.streak_length,
        stop_loss_pct: parsed.stop_loss_pct,
        take_profit_pct: optionalPct(parsed.take_profit_pct),
        trailing_stop_pct: optionalPct(parsed.trailing_stop_pct),
        hold_max_days: parsed.hold_max_days,
        leverage: parsed.leverage,
        capital_base_usd: parsed.capital_base_usd,
        costs: buildCosts(values),
        regime_filter: buildRegime(values),
      };
      return clampSpec(StrategySpecSchema.parse(spec));
    },
  },
];
