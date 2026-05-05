import type mysql from "mysql2/promise";

export const marketDataArchiveSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS market_universe (
    symbol VARCHAR(16) NOT NULL,
    source VARCHAR(32) NOT NULL,
    name VARCHAR(255) NULL,
    exchange VARCHAR(32) NULL,
    asset_type VARCHAR(32) NOT NULL DEFAULT 'EQUITY',
    active TINYINT(1) NOT NULL DEFAULT 1,
    cik VARCHAR(32) NULL,
    first_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    raw_json LONGTEXT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (symbol, source),
    INDEX IX_market_universe_active (active),
    INDEX IX_market_universe_source_active (source, active),
    INDEX IX_market_universe_exchange (exchange),
    INDEX IX_market_universe_asset_active (asset_type, active)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS market_bars (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(16) NOT NULL,
    ts DATETIME(6) NOT NULL,
    timeframe VARCHAR(8) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    open DECIMAL(18,6) NOT NULL,
    high DECIMAL(18,6) NOT NULL,
    low DECIMAL(18,6) NOT NULL,
    close DECIMAL(18,6) NOT NULL,
    volume BIGINT NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY UX_market_bars_symbol_tf_ts_provider (symbol, timeframe, ts, provider),
    INDEX IX_market_bars_ts_tf (ts, timeframe),
    INDEX IX_market_bars_symbol_tf (symbol, timeframe)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS market_data_runs (
    id CHAR(36) NOT NULL PRIMARY KEY,
    kind VARCHAR(64) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    status VARCHAR(16) NOT NULL,
    params_json LONGTEXT NOT NULL,
    summary_json LONGTEXT NULL,
    started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    finished_at DATETIME(6) NULL,
    error_message LONGTEXT NULL,
    INDEX IX_market_data_runs_kind_started (kind, started_at),
    INDEX IX_market_data_runs_status (status)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS market_streak_signals (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(16) NOT NULL,
    signal_date DATE NOT NULL,
    timeframe VARCHAR(8) NOT NULL DEFAULT '1d',
    direction VARCHAR(8) NOT NULL,
    streak_len INT NOT NULL,
    entry_price DECIMAL(18,6) NOT NULL,
    universe_tags LONGTEXT NULL,
    provider VARCHAR(32) NOT NULL,
    source VARCHAR(32) NOT NULL,
    signal_json LONGTEXT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY UX_market_streak_signal (symbol, signal_date, timeframe, direction, streak_len, provider, source),
    INDEX IX_market_streak_date_dir (signal_date, direction),
    INDEX IX_market_streak_symbol (symbol)
  ) ENGINE=InnoDB;`,
];

export async function ensureMarketDataArchiveSchema(pool: mysql.Pool) {
  for (const statement of marketDataArchiveSchemaStatements) {
    await pool.execute(statement);
  }
}
