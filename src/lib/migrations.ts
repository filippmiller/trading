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
];

async function ensureColumn(table: string, column: string, definition: string) {
  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) as count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [table, column]
  );
  const count = Number(rows[0]?.count ?? 0);
  if (count === 0) {
    await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

export async function ensureSchema() {
  const pool = await getPool();
  for (const statement of schemaStatements) {
    await pool.execute(statement);
  }
  await ensureColumn("strategy_runs", "preset_name", "preset_name VARCHAR(64) NULL");
  await ensureColumn(
    "run_metrics",
    "martingale_step_escalations",
    "martingale_step_escalations INT NOT NULL DEFAULT 0"
  );
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
