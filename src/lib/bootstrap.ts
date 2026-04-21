import { getPool, mysql } from "@/lib/db";
import { ensureDefaultSettings, ensureSchema } from "@/lib/migrations";
import { generateAllStrategies } from "@/lib/strategy-engine";

let bootstrapPromise: Promise<void> | null = null;

type SeedStrategy = {
  accountName: string;
  name: string;
  strategyType: "TRADING" | "ANALYSIS" | "CONFIRMATION";
  leverage: number;
  initialCash: number;
  config: Record<string, unknown>;
};

const CONFIRMATION_STRATEGIES: SeedStrategy[] = [
  {
    accountName: "Strategy: Double Confirm Bounce",
    name: "Double Confirm Bounce",
    strategyType: "CONFIRMATION",
    leverage: 5,
    initialCash: 5000,
    config: {
      entry: { direction: "LONG", confirmation_days: 2, d1_must_be_favorable: true, d2_must_be_favorable: true, min_d1_move_pct: 2, min_drop_pct: -5, max_drop_pct: -30, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 100, max_concurrent: 10, max_new_per_day: 5 },
      exits: { trailing_stop_pct: 3, trailing_activates_at_profit_pct: 1, hard_stop_pct: -2, time_exit_days: 5 },
    },
  },
  {
    accountName: "Strategy: Big Drop Confirmed",
    name: "Big Drop Confirmed",
    strategyType: "CONFIRMATION",
    leverage: 5,
    initialCash: 5000,
    config: {
      entry: { direction: "LONG", confirmation_days: 2, d1_must_be_favorable: true, d2_must_be_favorable: true, min_drop_pct: -8, max_drop_pct: -20, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 100, max_concurrent: 10, max_new_per_day: 5 },
      exits: { trailing_stop_pct: 5, trailing_activates_at_profit_pct: 2, hard_stop_pct: -3, time_exit_days: 5 },
    },
  },
  {
    accountName: "Strategy: Gainer Fade Confirmed",
    name: "Gainer Fade Confirmed",
    strategyType: "CONFIRMATION",
    leverage: 5,
    initialCash: 5000,
    config: {
      entry: { direction: "SHORT", confirmation_days: 2, d1_must_be_favorable: true, d2_must_be_favorable: true, min_rise_pct: 5, max_rise_pct: 30, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 100, max_concurrent: 10, max_new_per_day: 5 },
      exits: { trailing_stop_pct: 3, trailing_activates_at_profit_pct: 1, hard_stop_pct: -2, time_exit_days: 3 },
    },
  },
  {
    accountName: "Strategy: Washout Recovery",
    name: "Washout Recovery",
    strategyType: "CONFIRMATION",
    leverage: 5,
    initialCash: 5000,
    config: {
      entry: { direction: "LONG", confirmation_days: 2, d1_must_be_unfavorable: true, d2_must_be_unfavorable: true, min_drop_pct: -8, max_drop_pct: -30, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 100, max_concurrent: 10, max_new_per_day: 5 },
      exits: { trailing_stop_pct: 5, trailing_activates_at_profit_pct: 3, hard_stop_pct: -5, time_exit_days: 8 },
    },
  },
  {
    accountName: "Strategy: Momentum Scalp",
    name: "Momentum Scalp",
    strategyType: "CONFIRMATION",
    leverage: 5,
    initialCash: 5000,
    config: {
      entry: { direction: "LONG", confirmation_days: 2, d1_must_be_favorable: true, d2_must_be_favorable: true, min_d1_move_pct: 2, min_drop_pct: -5, max_drop_pct: -30, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 100, max_concurrent: 10, max_new_per_day: 5 },
      exits: { take_profit_pct: 3, hard_stop_pct: -2, time_exit_days: 3 },
    },
  },
  {
    accountName: "Strategy: 3-Day Slide Bounce",
    name: "3-Day Slide Bounce",
    strategyType: "CONFIRMATION",
    leverage: 5,
    initialCash: 5000,
    config: {
      entry: { direction: "LONG", enrollment_source: "TREND", min_consecutive_days: 3, max_consecutive_days: 4, confirmation_days: 2, d1_must_be_favorable: true, d2_must_be_favorable: true, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 100, max_concurrent: 15, max_new_per_day: 10 },
      exits: { trailing_stop_pct: 3, trailing_activates_at_profit_pct: 1, hard_stop_pct: -3, time_exit_days: 5 },
    },
  },
  {
    accountName: "Strategy: 4-Day UP Fade",
    name: "4-Day UP Fade",
    strategyType: "CONFIRMATION",
    leverage: 5,
    initialCash: 5000,
    config: {
      entry: { direction: "SHORT", enrollment_source: "TREND", min_consecutive_days: 4, confirmation_days: 2, d1_must_be_favorable: true, d2_must_be_favorable: true, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 100, max_concurrent: 10, max_new_per_day: 5 },
      exits: { trailing_stop_pct: 3, trailing_activates_at_profit_pct: 1, hard_stop_pct: -3, time_exit_days: 4 },
    },
  },
  {
    accountName: "Strategy: Extreme Streak Reversal",
    name: "Extreme Streak Reversal",
    strategyType: "CONFIRMATION",
    leverage: 5,
    initialCash: 5000,
    config: {
      entry: { enrollment_source: "TREND", min_consecutive_days: 5, confirmation_days: 1, d1_must_be_favorable: true, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 100, max_concurrent: 10, max_new_per_day: 5 },
      exits: { trailing_stop_pct: 4, trailing_activates_at_profit_pct: 2, hard_stop_pct: -4, time_exit_days: 5 },
    },
  },
];

async function insertStrategies(strategies: SeedStrategy[]) {
  const pool = await getPool();
  for (const strategy of strategies) {
    await pool.execute(
      "INSERT IGNORE INTO paper_accounts (name, initial_cash, cash) VALUES (?, ?, ?)",
      [strategy.accountName, strategy.initialCash, strategy.initialCash]
    );

    const [accountRows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id FROM paper_accounts WHERE name = ? LIMIT 1",
      [strategy.accountName]
    );
    const accountId = Number(accountRows[0]?.id);
    if (!accountId) {
      throw new Error(`Failed to create paper account for strategy '${strategy.name}'`);
    }

    await pool.execute(
      `INSERT INTO paper_strategies (account_id, name, strategy_type, leverage, enabled, config_json)
       VALUES (?, ?, ?, ?, 1, ?)`,
      [accountId, strategy.name, strategy.strategyType, strategy.leverage, JSON.stringify(strategy.config)]
    );
  }
}

async function seedDefaultStrategies() {
  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS cnt FROM paper_strategies WHERE strategy_type IN ('TRADING', 'ANALYSIS')"
  );
  const existingCount = Number(rows[0]?.cnt ?? 0);
  if (existingCount > 0) return;

  await insertStrategies(
    generateAllStrategies().map((strategy) => ({
      accountName: `Strategy: ${strategy.name}`,
      name: strategy.name,
      strategyType: strategy.strategy_type,
      leverage: strategy.leverage,
      initialCash: 100000,
      config: strategy.config as unknown as Record<string, unknown>,
    }))
  );
}

async function seedConfirmationStrategies() {
  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS cnt FROM paper_strategies WHERE strategy_type = 'CONFIRMATION'"
  );
  const existingCount = Number(rows[0]?.cnt ?? 0);
  if (existingCount > 0) return;

  await insertStrategies(CONFIRMATION_STRATEGIES);
}

export async function ensureAppBootstrapReady() {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      await ensureSchema();
      await ensureDefaultSettings();
      await seedDefaultStrategies();
      await seedConfirmationStrategies();
    })().catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }

  return bootstrapPromise;
}
