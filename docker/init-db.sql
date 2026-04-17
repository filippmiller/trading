-- Trading Platform Schema (Surveillance + Web App)
-- Auto-created on first container start

-- ─── Web App Tables ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS prices_daily (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS strategy_runs (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trades (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS run_metrics (
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
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS app_settings (
  `key` VARCHAR(64) NOT NULL PRIMARY KEY,
  `value` LONGTEXT NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;

-- ─── Surveillance Tables ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reversal_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cohort_date DATE NOT NULL,
  symbol VARCHAR(16) NOT NULL,
  direction VARCHAR(8) NOT NULL,
  enrollment_source VARCHAR(16) NOT NULL DEFAULT 'MOVERS',
  day_change_pct DECIMAL(10,4) NOT NULL,
  entry_price DECIMAL(18,6) NOT NULL,
  consecutive_days INT NULL,
  cumulative_change_pct DECIMAL(10,4) NULL,
  d1_morning DECIMAL(18,6) NULL, d1_midday DECIMAL(18,6) NULL, d1_close DECIMAL(18,6) NULL,
  d2_morning DECIMAL(18,6) NULL, d2_midday DECIMAL(18,6) NULL, d2_close DECIMAL(18,6) NULL,
  d3_morning DECIMAL(18,6) NULL, d3_midday DECIMAL(18,6) NULL, d3_close DECIMAL(18,6) NULL,
  d4_morning DECIMAL(18,6) NULL, d4_midday DECIMAL(18,6) NULL, d4_close DECIMAL(18,6) NULL,
  d5_morning DECIMAL(18,6) NULL, d5_midday DECIMAL(18,6) NULL, d5_close DECIMAL(18,6) NULL,
  d6_morning DECIMAL(18,6) NULL, d6_midday DECIMAL(18,6) NULL, d6_close DECIMAL(18,6) NULL,
  d7_morning DECIMAL(18,6) NULL, d7_midday DECIMAL(18,6) NULL, d7_close DECIMAL(18,6) NULL,
  d8_morning DECIMAL(18,6) NULL, d8_midday DECIMAL(18,6) NULL, d8_close DECIMAL(18,6) NULL,
  d9_morning DECIMAL(18,6) NULL, d9_midday DECIMAL(18,6) NULL, d9_close DECIMAL(18,6) NULL,
  d10_morning DECIMAL(18,6) NULL, d10_midday DECIMAL(18,6) NULL, d10_close DECIMAL(18,6) NULL,
  final_pnl_usd DECIMAL(18,6) NULL,
  final_pnl_pct DECIMAL(18,6) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY UX_reversal_cohort_symbol (cohort_date, symbol),
  INDEX IX_reversal_status (status),
  INDEX IX_reversal_cohort (cohort_date)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS surveillance_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at DATETIME(6) NULL,
  status VARCHAR(16) NOT NULL,
  stats_json LONGTEXT NULL,
  error_message LONGTEXT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS surveillance_failures (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entry_id INT NOT NULL,
  symbol VARCHAR(16) NOT NULL,
  field_name VARCHAR(32) NOT NULL,
  error_message TEXT NULL,
  retry_count INT DEFAULT 0,
  last_attempt DATETIME DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(16) DEFAULT 'PENDING',
  UNIQUE KEY UX_fail_entry_field (entry_id, field_name),
  INDEX IX_fail_entry (entry_id),
  CONSTRAINT FK_fail_reversal FOREIGN KEY (entry_id) REFERENCES reversal_entries(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS paper_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL DEFAULT 'Default',
  initial_cash DECIMAL(18,6) NOT NULL DEFAULT 100000,
  cash DECIMAL(18,6) NOT NULL DEFAULT 100000,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY UX_paper_account_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS paper_trades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NULL,
  symbol VARCHAR(16) NOT NULL,
  quantity DECIMAL(18,6) NOT NULL DEFAULT 0,
  buy_price DECIMAL(18,6) NOT NULL,
  buy_date DATE NOT NULL,
  sell_date DATE NULL,
  sell_price DECIMAL(18,6) NULL,
  investment_usd DECIMAL(18,6) NOT NULL DEFAULT 100,
  pnl_usd DECIMAL(18,6) NULL,
  pnl_pct DECIMAL(18,6) NULL,
  strategy VARCHAR(64) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  notes TEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  INDEX IX_paper_trades_account (account_id),
  INDEX IX_paper_trades_status (status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS paper_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NOT NULL,
  symbol VARCHAR(16) NOT NULL,
  side VARCHAR(8) NOT NULL,
  order_type VARCHAR(16) NOT NULL,
  quantity DECIMAL(18,6) NULL,
  investment_usd DECIMAL(18,6) NULL,
  limit_price DECIMAL(18,6) NULL,
  stop_price DECIMAL(18,6) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  filled_price DECIMAL(18,6) NULL,
  filled_at DATETIME(6) NULL,
  trade_id INT NULL,
  rejection_reason VARCHAR(255) NULL,
  notes TEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  INDEX IX_paper_orders_account (account_id),
  INDEX IX_paper_orders_status (status),
  INDEX IX_paper_orders_symbol (symbol)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS paper_equity_snapshots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NOT NULL,
  snapshot_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  cash DECIMAL(18,6) NOT NULL,
  positions_value DECIMAL(18,6) NOT NULL,
  equity DECIMAL(18,6) NOT NULL,
  INDEX IX_paper_equity_account_time (account_id, snapshot_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS paper_strategies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NULL,
  name VARCHAR(128) NOT NULL,
  strategy_type VARCHAR(32) NOT NULL DEFAULT 'TRADING',
  leverage INT NOT NULL DEFAULT 1,
  enabled TINYINT NOT NULL DEFAULT 1,
  config_json LONGTEXT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY UX_strategy_name (name),
  INDEX IX_strategy_enabled (enabled)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS paper_signals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  strategy_id INT NOT NULL,
  reversal_entry_id INT NULL,
  symbol VARCHAR(16) NOT NULL,
  direction VARCHAR(8) NOT NULL DEFAULT 'LONG',
  generated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  entry_price DECIMAL(18,6) NULL,
  entry_at DATETIME(6) NULL,
  exit_price DECIMAL(18,6) NULL,
  exit_at DATETIME(6) NULL,
  exit_reason VARCHAR(32) NULL,
  investment_usd DECIMAL(18,6) NOT NULL DEFAULT 1000,
  leverage INT NOT NULL DEFAULT 1,
  effective_exposure DECIMAL(18,6) NULL,
  max_price DECIMAL(18,6) NULL,
  min_price DECIMAL(18,6) NULL,
  max_pnl_pct DECIMAL(10,4) NULL,
  min_pnl_pct DECIMAL(10,4) NULL,
  pnl_usd DECIMAL(18,6) NULL,
  pnl_pct DECIMAL(18,6) NULL,
  holding_minutes INT NULL,
  trailing_stop_price DECIMAL(18,6) NULL,
  trailing_active TINYINT NOT NULL DEFAULT 0,
  INDEX IX_signal_strategy (strategy_id),
  INDEX IX_signal_status (status),
  INDEX IX_signal_symbol (symbol),
  INDEX IX_signal_reversal (reversal_entry_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS paper_position_prices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  signal_id INT NOT NULL,
  price DECIMAL(18,6) NOT NULL,
  fetched_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  INDEX IX_pos_price_signal (signal_id, fetched_at),
  CONSTRAINT FK_pos_price_signal
    FOREIGN KEY (signal_id) REFERENCES paper_signals(id)
    ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT IGNORE INTO paper_accounts (name, initial_cash, cash)
VALUES ('Default', 100000, 100000);
