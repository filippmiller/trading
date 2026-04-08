-- Trading Surveillance Schema
-- Auto-created on first container start

CREATE TABLE IF NOT EXISTS reversal_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cohort_date DATE NOT NULL,
  symbol VARCHAR(16) NOT NULL,
  direction VARCHAR(8) NOT NULL,
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

CREATE TABLE IF NOT EXISTS paper_trades (
  id INT AUTO_INCREMENT PRIMARY KEY,
  symbol VARCHAR(16) NOT NULL,
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
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
