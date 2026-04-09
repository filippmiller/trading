import { getPool, mysql } from "@/lib/db";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS prices_daily (
    id INT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(16) NOT NULL DEFAULT 'SPY',
    date DATE NOT NULL,
    open DECIMAL(18,6) NOT NULL,
    high DECIMAL(18,6) NOT NULL,
    low DECIMAL(18,6) NOT NULL,
    close DECIMAL(18,6) NOT NULL,
    volume BIGINT NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY UX_prices_daily_symbol_date (symbol, date)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS strategy_runs (
    id CHAR(36) NOT NULL PRIMARY KEY,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    symbol VARCHAR(16) NOT NULL,
    lookback_days INT NOT NULL,
    spec_json LONGTEXT NOT NULL,
    voice_text LONGTEXT NULL,
    llm_provider VARCHAR(32) NULL,
    status VARCHAR(16) NOT NULL,
    error_message LONGTEXT NULL,
    preset_name VARCHAR(64) NULL
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS trades (
    id INT AUTO_INCREMENT PRIMARY KEY,
    run_id CHAR(36) NOT NULL,
    entry_date DATE NOT NULL,
    side VARCHAR(8) NOT NULL,
    entry_price DECIMAL(18,6) NOT NULL,
    exit_date DATE NOT NULL,
    exit_price DECIMAL(18,6) NOT NULL,
    exit_reason VARCHAR(32) NOT NULL,
    pnl_usd DECIMAL(18,6) NOT NULL,
    pnl_pct DECIMAL(18,6) NOT NULL,
    fees_usd DECIMAL(18,6) NOT NULL,
    interest_usd DECIMAL(18,6) NOT NULL,
    meta_json LONGTEXT NULL,
    INDEX IX_trades_run (run_id),
    CONSTRAINT FK_trades_run FOREIGN KEY (run_id) REFERENCES strategy_runs(id)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS run_metrics (
    run_id CHAR(36) NOT NULL PRIMARY KEY,
    total_pnl_usd DECIMAL(18,6) NOT NULL,
    total_return_pct DECIMAL(18,6) NOT NULL,
    win_rate DECIMAL(18,6) NOT NULL,
    trades_count INT NOT NULL,
    max_drawdown_pct DECIMAL(18,6) NOT NULL,
    worst_losing_streak INT NOT NULL,
    max_martingale_step_reached INT NOT NULL,
    martingale_step_escalations INT NOT NULL DEFAULT 0,
    avg_trade_pct DECIMAL(18,6) NOT NULL,
    median_trade_pct DECIMAL(18,6) NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT FK_metrics_run FOREIGN KEY (run_id) REFERENCES strategy_runs(id)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    \`key\` VARCHAR(64) NOT NULL PRIMARY KEY,
    \`value\` LONGTEXT NOT NULL,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS reversal_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cohort_date DATE NOT NULL,
    symbol VARCHAR(16) NOT NULL,
    direction VARCHAR(8) NOT NULL,
    day_change_pct DECIMAL(10,4) NOT NULL,
    entry_price DECIMAL(18,6) NOT NULL,
    d1_morning DECIMAL(18,6) NULL,
    d1_midday DECIMAL(18,6) NULL,
    d1_close DECIMAL(18,6) NULL,
    d2_morning DECIMAL(18,6) NULL,
    d2_midday DECIMAL(18,6) NULL,
    d2_close DECIMAL(18,6) NULL,
    d3_morning DECIMAL(18,6) NULL,
    d3_midday DECIMAL(18,6) NULL,
    d3_close DECIMAL(18,6) NULL,
    final_pnl_usd DECIMAL(18,6) NULL,
    final_pnl_pct DECIMAL(18,6) NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY UX_reversal_cohort_symbol (cohort_date, symbol),
    INDEX IX_reversal_status (status),
    INDEX IX_reversal_cohort (cohort_date)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS surveillance_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    finished_at DATETIME(6) NULL,
    status VARCHAR(16) NOT NULL, -- 'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED'
    stats_json LONGTEXT NULL, -- JSON with counts: enrolled, updated, failed
    error_message LONGTEXT NULL
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS surveillance_failures (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entry_id INT NOT NULL,
    symbol VARCHAR(16) NOT NULL,
    field_name VARCHAR(32) NOT NULL, -- e.g. 'd3_morning'
    error_message TEXT NULL,
    retry_count INT DEFAULT 0,
    last_attempt DATETIME DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(16) DEFAULT 'PENDING', -- 'PENDING', 'FAILED', 'GAVE_UP'
    INDEX IX_fail_entry (entry_id),
    CONSTRAINT FK_fail_reversal FOREIGN KEY (entry_id) REFERENCES reversal_entries(id) ON DELETE CASCADE
  ) ENGINE=InnoDB;`,
];

const ALLOWED_TABLES = new Set(["strategy_runs", "run_metrics", "reversal_entries"]);
const COLUMN_REGEX = /^[a-z_][a-z0-9_]{0,63}$/;

async function ensureColumn(table: string, column: string, definition: string) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`ensureColumn: unknown table '${table}'`);
  if (!COLUMN_REGEX.test(column)) throw new Error(`ensureColumn: invalid column '${column}'`);
  const pool = await getPool();
  try {
    await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  } catch (err: unknown) {
    // 1060 = Duplicate column name — safe to ignore (handles concurrent requests)
    if ((err as { errno?: number }).errno !== 1060) throw err;
  }
}

export async function ensureSchema() {
  const pool = await getPool();
  for (const statement of schemaStatements) {
    await pool.execute(statement);
  }
  await ensureColumn("strategy_runs", "preset_name", "VARCHAR(64) NULL");
  await ensureColumn("reversal_entries", "consecutive_days", "INT NULL");
  await ensureColumn("reversal_entries", "cumulative_change_pct", "DECIMAL(10,4) NULL");
  // Ensure unique constraint on surveillance_failures (matches init-db.sql)
  try {
    await pool.execute("ALTER TABLE surveillance_failures ADD UNIQUE KEY UX_fail_entry_field (entry_id, field_name)");
  } catch (err: unknown) {
    if ((err as { errno?: number }).errno !== 1061) throw err; // 1061 = duplicate key name
  }
  // Add 10-day tracking columns
  for (let d = 1; d <= 10; d++) {
    await ensureColumn("reversal_entries", `d${d}_morning`, "DECIMAL(18,6) NULL");
    await ensureColumn("reversal_entries", `d${d}_midday`, "DECIMAL(18,6) NULL");
    await ensureColumn("reversal_entries", `d${d}_close`, "DECIMAL(18,6) NULL");
  }
}

export async function ensureDefaultSettings() {
  const pool = await getPool();
  const defaults = {
    commission_per_side_usd: 1,
    slippage_bps: 2,
    margin_interest_apr: 0.12,
    leverage: 5,
    base_capital_usd: 500,
  };

  const key = "defaults";
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT `value` FROM app_settings WHERE `key` = ?",
    [key]
  );

  if (!rows.length) {
    await pool.execute("INSERT INTO app_settings (`key`, `value`) VALUES (?, ?)", [
      key,
      JSON.stringify(defaults),
    ]);
  }
}
