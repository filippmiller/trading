import { getPool, sql } from "@/lib/db";

const schemaSql = `
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='prices_daily' AND xtype='U')
BEGIN
  CREATE TABLE prices_daily (
    id INT IDENTITY(1,1) PRIMARY KEY,
    symbol VARCHAR(16) NOT NULL CONSTRAINT DF_prices_daily_symbol DEFAULT 'SPY',
    date DATE NOT NULL,
    open DECIMAL(18,6) NOT NULL,
    high DECIMAL(18,6) NOT NULL,
    low DECIMAL(18,6) NOT NULL,
    close DECIMAL(18,6) NOT NULL,
    volume BIGINT NOT NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_prices_daily_created DEFAULT SYSUTCDATETIME()
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='UX_prices_daily_symbol_date')
BEGIN
  CREATE UNIQUE INDEX UX_prices_daily_symbol_date ON prices_daily(symbol, date);
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='strategy_runs' AND xtype='U')
BEGIN
  CREATE TABLE strategy_runs (
    id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_strategy_runs_created DEFAULT SYSUTCDATETIME(),
    symbol VARCHAR(16) NOT NULL,
    lookback_days INT NOT NULL,
    spec_json NVARCHAR(MAX) NOT NULL,
    voice_text NVARCHAR(MAX) NULL,
    llm_provider VARCHAR(32) NULL,
    status VARCHAR(16) NOT NULL,
    error_message NVARCHAR(MAX) NULL,
    preset_name VARCHAR(64) NULL
  );
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='trades' AND xtype='U')
BEGIN
  CREATE TABLE trades (
    id INT IDENTITY(1,1) PRIMARY KEY,
    run_id UNIQUEIDENTIFIER NOT NULL,
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
    meta_json NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT * FROM sys.foreign_keys WHERE name='FK_trades_run')
BEGIN
  ALTER TABLE trades
  ADD CONSTRAINT FK_trades_run FOREIGN KEY (run_id) REFERENCES strategy_runs(id);
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='run_metrics' AND xtype='U')
BEGIN
  CREATE TABLE run_metrics (
    run_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    total_pnl_usd DECIMAL(18,6) NOT NULL,
    total_return_pct DECIMAL(18,6) NOT NULL,
    win_rate DECIMAL(18,6) NOT NULL,
    trades_count INT NOT NULL,
    max_drawdown_pct DECIMAL(18,6) NOT NULL,
    worst_losing_streak INT NOT NULL,
    max_martingale_step_reached INT NOT NULL,
    martingale_step_escalations INT NOT NULL,
    avg_trade_pct DECIMAL(18,6) NOT NULL,
    median_trade_pct DECIMAL(18,6) NOT NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_run_metrics_created DEFAULT SYSUTCDATETIME()
  );
END;

IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'martingale_step_escalations' AND Object_ID = Object_ID(N'run_metrics'))
BEGIN
  ALTER TABLE run_metrics ADD martingale_step_escalations INT NOT NULL DEFAULT 0;
END;

IF NOT EXISTS (SELECT * FROM sys.foreign_keys WHERE name='FK_metrics_run')
BEGIN
  ALTER TABLE run_metrics
  ADD CONSTRAINT FK_metrics_run FOREIGN KEY (run_id) REFERENCES strategy_runs(id);
END;

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='app_settings' AND xtype='U')
BEGIN
  CREATE TABLE app_settings (
    [key] VARCHAR(64) NOT NULL PRIMARY KEY,
    [value] NVARCHAR(MAX) NOT NULL,
    updated_at DATETIME2 NOT NULL CONSTRAINT DF_app_settings_updated DEFAULT SYSUTCDATETIME()
  );
END;

IF NOT EXISTS (SELECT * FROM sys.columns WHERE Name = N'preset_name' AND Object_ID = Object_ID(N'strategy_runs'))
BEGIN
  ALTER TABLE strategy_runs ADD preset_name VARCHAR(64) NULL;
END;
`;

export async function ensureSchema() {
  const pool = await getPool();
  await pool.request().query(schemaSql);
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
  const existing = await pool
    .request()
    .input("key", sql.VarChar(64), key)
    .query("SELECT [value] FROM app_settings WHERE [key] = @key");

  if (existing.recordset.length === 0) {
    await pool
      .request()
      .input("key", sql.VarChar(64), key)
      .input("value", sql.NVarChar(sql.MAX), JSON.stringify(defaults))
      .query("INSERT INTO app_settings ([key], [value]) VALUES (@key, @value)");
  }
}
