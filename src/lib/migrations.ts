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
  `CREATE TABLE IF NOT EXISTS app_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'admin',
    is_active TINYINT NOT NULL DEFAULT 1,
    last_login_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY UX_app_users_email (email)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS reversal_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cohort_date DATE NOT NULL,
    symbol VARCHAR(16) NOT NULL,
    direction VARCHAR(8) NOT NULL,
    enrollment_source VARCHAR(16) NOT NULL DEFAULT 'MOVERS',
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
  // ── Paper Trading Simulator ─────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS paper_accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL DEFAULT 'Default',
    initial_cash DECIMAL(18,6) NOT NULL DEFAULT 100000,
    cash DECIMAL(18,6) NOT NULL DEFAULT 100000,
    reserved_cash DECIMAL(18,6) NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE KEY UX_paper_account_name (name)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS paper_trades (
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
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS paper_orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL,
    symbol VARCHAR(16) NOT NULL,
    side VARCHAR(8) NOT NULL, -- 'BUY' or 'SELL'
    order_type VARCHAR(16) NOT NULL, -- 'MARKET', 'LIMIT', 'STOP'
    quantity DECIMAL(18,6) NULL, -- for sell orders tied to an existing trade
    investment_usd DECIMAL(18,6) NULL, -- for buy orders (dollar-based sizing)
    limit_price DECIMAL(18,6) NULL,
    stop_price DECIMAL(18,6) NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'FILLED', 'CANCELLED', 'REJECTED'
    filled_price DECIMAL(18,6) NULL,
    filled_at DATETIME(6) NULL,
    trade_id INT NULL, -- linked paper_trade on fill
    rejection_reason VARCHAR(255) NULL,
    reserved_amount DECIMAL(18,6) NOT NULL DEFAULT 0, -- cash held against this order while PENDING
    notes TEXT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX IX_paper_orders_account (account_id),
    INDEX IX_paper_orders_status (status),
    INDEX IX_paper_orders_symbol (symbol)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS paper_equity_snapshots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL,
    snapshot_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    cash DECIMAL(18,6) NOT NULL,
    positions_value DECIMAL(18,6) NOT NULL,
    equity DECIMAL(18,6) NOT NULL,
    INDEX IX_paper_equity_account_time (account_id, snapshot_at)
  ) ENGINE=InnoDB;`,
  // ── Scenario Engine ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS paper_strategies (
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
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS paper_signals (
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
    INDEX IX_signal_reversal (reversal_entry_id),
    UNIQUE KEY UX_signal_strat_entry (strategy_id, reversal_entry_id)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS paper_position_prices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    signal_id INT NOT NULL,
    price DECIMAL(18,6) NOT NULL,
    fetched_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX IX_pos_price_signal (signal_id, fetched_at)
  ) ENGINE=InnoDB;`,
  `CREATE TABLE IF NOT EXISTS paper_scenarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    description TEXT NULL,
    filters_json LONGTEXT NOT NULL,
    trade_json LONGTEXT NOT NULL,
    costs_json LONGTEXT NOT NULL,
    last_result_summary_json LONGTEXT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY UX_scenario_name (name)
  ) ENGINE=InnoDB;`,
];

const ALLOWED_TABLES = new Set([
  "strategy_runs",
  "run_metrics",
  "reversal_entries",
  "paper_trades",
  "paper_signals",
  "paper_accounts",
  "paper_orders",
  "paper_equity_snapshots",
]);

/** Shape of row returned from INFORMATION_SCHEMA.STATISTICS for index checks. */
type IndexRow = { INDEX_NAME: string };
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

// Memoize the schema-migration promise at module scope so concurrent API
// requests await the same one-shot run instead of each issuing its own
// flight of CREATE TABLE / ALTER TABLE statements. Those DDL statements
// acquire MySQL metadata locks that serialize with the cron's INSERT/UPDATE
// traffic — under load this produced lock contention that could delay
// monitor ticks. The first request triggers it; all subsequent callers are
// a no-op await against a resolved promise.
let schemaReadyPromise: Promise<void> | null = null;

export async function ensureSchema(): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = runSchemaMigrations().catch((err) => {
      // If the migration fails, allow a retry on the next call rather than
      // trapping the whole process in a rejected-promise state.
      schemaReadyPromise = null;
      throw err;
    });
  }
  return schemaReadyPromise;
}

async function runSchemaMigrations() {
  const pool = await getPool();
  for (const statement of schemaStatements) {
    await pool.execute(statement);
  }
  await ensureColumn("strategy_runs", "preset_name", "VARCHAR(64) NULL");
  await ensureColumn("reversal_entries", "enrollment_source", "VARCHAR(16) NOT NULL DEFAULT 'MOVERS'");
  await ensureColumn("reversal_entries", "consecutive_days", "INT NULL");
  await ensureColumn("reversal_entries", "cumulative_change_pct", "DECIMAL(10,4) NULL");
  await ensureColumn("paper_signals", "direction", "VARCHAR(8) NOT NULL DEFAULT 'LONG'");
  // Old surveillance runs could write duplicate (entry_id, field_name) rows.
  // Deduplicate first so the unique key can be added safely on existing data.
  await pool.execute(`
    DELETE older
    FROM surveillance_failures AS older
    INNER JOIN surveillance_failures AS newer
      ON older.entry_id = newer.entry_id
     AND older.field_name = newer.field_name
     AND older.id < newer.id
  `);
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
  // Add account_id and quantity to existing paper_trades rows (created before the simulator)
  await ensureColumn("paper_trades", "account_id", "INT NULL");
  await ensureColumn("paper_trades", "quantity", "DECIMAL(18,6) NOT NULL DEFAULT 0");

  // W1 (2026-04-21) — cash reservation for PENDING LIMIT/STOP BUYs. When an
  // order is submitted it atomically debits `cash` into `reserved_cash`; on
  // fill / cancel / reject that amount is released. This is what prevents the
  // classic overdraft race where a user queues 20 x $10k LIMIT BUYs on a
  // $100k account, every symbol triggers, and the naive `cash >= investment`
  // check passes for all 20.
  await ensureColumn("paper_accounts", "reserved_cash", "DECIMAL(18,6) NOT NULL DEFAULT 0");
  await ensureColumn("paper_orders", "reserved_amount", "DECIMAL(18,6) NOT NULL DEFAULT 0");

  // W2 (2026-04-21) — data integrity.
  //
  // 1. paper_equity_snapshots gains `reserved_cash` and `realized_pnl` so an
  //    equity-curve chart can plot unreserved cash + reservations + unrealized
  //    + realized separately without re-aggregating paper_trades per point.
  // 2. paper_trades gains `strategy_id` — real FK to paper_strategies. The
  //    existing `strategy` VARCHAR(64) stays as a denormalized label (shown
  //    as "MANUAL BUY" / "MANUAL SELL" for user-placed trades). We do NOT
  //    reverse-parse historical "MARKET BUY" strings into strategy_id —
  //    those rows stay NULL.
  await ensureColumn("paper_equity_snapshots", "reserved_cash", "DECIMAL(18,6) NOT NULL DEFAULT 0");
  await ensureColumn("paper_equity_snapshots", "realized_pnl", "DECIMAL(18,6) NOT NULL DEFAULT 0");
  await ensureColumn("paper_trades", "strategy_id", "INT NULL");
  // Index + FK are additive and idempotent via errno checks (1061 = dup key,
  // 1826/1022 = FK already exists on some MySQL versions).
  try {
    await pool.execute("ALTER TABLE paper_trades ADD INDEX IX_paper_trades_strategy (strategy_id)");
  } catch (err: unknown) {
    if ((err as { errno?: number }).errno !== 1061) throw err;
  }
  // ON DELETE SET NULL (codex F5): preserves the trade row + denormalized
  // `strategy` VARCHAR label when a strategy is deleted, BUT the exact FK
  // is lost. That's the accepted trade-off to allow strategies to be
  // garbage-collected without rewriting historical trade rows. If stricter
  // audit attribution is needed, switch to RESTRICT and retire strategies
  // via `enabled=0` rather than DELETE.
  try {
    await pool.execute(
      "ALTER TABLE paper_trades ADD CONSTRAINT FK_paper_trades_strategy FOREIGN KEY (strategy_id) REFERENCES paper_strategies(id) ON DELETE SET NULL"
    );
  } catch (err: unknown) {
    const errno = (err as { errno?: number }).errno;
    // 1826 = dup FK, 1022 = dup key, 3780 = FK incompat. Ignore first two.
    if (errno !== 1826 && errno !== 1022) throw err;
  }

  // W3 (2026-04-21) — shorts, protective exits, partial close, order modify.
  //
  // 1. paper_trades gains `side` (LONG/SHORT), exit bracket columns
  //    (stop_loss_price, take_profit_price, trailing_*, time_exit_date),
  //    P&L watermarks, partial-close tracking (closed_quantity), borrow-rate
  //    placeholder (real modeling deferred to W4), and `exit_reason` for
  //    post-hoc analytics (HARD_STOP / TAKE_PROFIT / TRAILING_STOP / TIME_EXIT).
  // 2. paper_accounts gains `reserved_short_margin` — a SEPARATE bucket from
  //    `reserved_cash`. Rationale: `reserved_cash` already has an invariant
  //    tied to `paper_orders.reserved_amount`. Mixing shorts in the same
  //    column would require a discriminator and fight the W2 reconciliation
  //    view. Dedicated column keeps semantics crisp:
  //      equity = cash + reserved_cash + reserved_short_margin + open positions
  // 3. paper_orders gains `reserved_short_margin` — per-order short-margin hold
  //    so PATCH (order modify) and cancel can refund atomically.
  //
  // All columns nullable or have defaults so existing rows work unchanged.
  await ensureColumn("paper_trades", "side", "VARCHAR(8) NOT NULL DEFAULT 'LONG'");
  await ensureColumn("paper_trades", "stop_loss_price", "DECIMAL(18,6) NULL");
  await ensureColumn("paper_trades", "take_profit_price", "DECIMAL(18,6) NULL");
  await ensureColumn("paper_trades", "trailing_stop_pct", "DECIMAL(10,4) NULL");
  await ensureColumn("paper_trades", "trailing_activates_at_profit_pct", "DECIMAL(10,4) NULL");
  await ensureColumn("paper_trades", "trailing_stop_price", "DECIMAL(18,6) NULL");
  await ensureColumn("paper_trades", "trailing_active", "TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("paper_trades", "time_exit_date", "DATE NULL");
  await ensureColumn("paper_trades", "max_pnl_pct", "DECIMAL(10,4) NULL");
  await ensureColumn("paper_trades", "min_pnl_pct", "DECIMAL(10,4) NULL");
  await ensureColumn("paper_trades", "borrow_daily_rate_pct", "DECIMAL(10,6) NOT NULL DEFAULT 0");
  await ensureColumn("paper_trades", "closed_quantity", "DECIMAL(18,6) NOT NULL DEFAULT 0");
  await ensureColumn("paper_trades", "exit_reason", "VARCHAR(32) NULL");
  await ensureColumn("paper_accounts", "reserved_short_margin", "DECIMAL(18,6) NOT NULL DEFAULT 0");
  await ensureColumn("paper_orders", "reserved_short_margin", "DECIMAL(18,6) NOT NULL DEFAULT 0");
  await ensureColumn("paper_equity_snapshots", "reserved_short_margin", "DECIMAL(18,6) NOT NULL DEFAULT 0");
  // `position_side` distinguishes LONG vs SHORT orders.
  //   side='BUY'  + position_side='LONG'  → open LONG
  //   side='SELL' + position_side='LONG'  → close LONG
  //   side='SELL' + position_side='SHORT' → open SHORT
  //   side='BUY'  + position_side='SHORT' → close SHORT (buy to cover)
  await ensureColumn("paper_orders", "position_side", "VARCHAR(8) NOT NULL DEFAULT 'LONG'");
  // Optional bracket fields captured on open-order submit. Persisted on the
  // `paper_trades` row at fill time (absolute prices derived from fill price).
  await ensureColumn("paper_orders", "bracket_stop_loss_pct", "DECIMAL(10,4) NULL");
  await ensureColumn("paper_orders", "bracket_take_profit_pct", "DECIMAL(10,4) NULL");
  await ensureColumn("paper_orders", "bracket_trailing_pct", "DECIMAL(10,4) NULL");
  await ensureColumn("paper_orders", "bracket_trailing_activates_pct", "DECIMAL(10,4) NULL");
  await ensureColumn("paper_orders", "bracket_time_exit_days", "INT NULL");
  // Partial-close quantity on SELL/BUY-to-COVER orders. NULL = close remaining.
  await ensureColumn("paper_orders", "close_quantity", "DECIMAL(18,6) NULL");
  // Index the exit scanner reads: (status, time_exit_date) — lets the W3
  // cron's monitorPaperTrades scan skip the OPEN-trades-table scan on every
  // tick by going straight to the short prefix of rows that are actually at
  // or near their time-exit deadline.
  const [idxRows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'paper_trades'
        AND INDEX_NAME   = 'IX_paper_trades_status_timeexit'`
  );
  if ((idxRows as IndexRow[]).length === 0) {
    try {
      await pool.execute("ALTER TABLE paper_trades ADD INDEX IX_paper_trades_status_timeexit (status, time_exit_date)");
    } catch (err: unknown) {
      if ((err as { errno?: number }).errno !== 1061) throw err;
    }
  }

  // W4 (2026-04-21) — risk model: slippage, commission, whitelist, fractional, borrow.
  //
  // 1. paper_trades gains `commission_usd` and `slippage_usd` — per-fill
  //    accounting so KPIs can show economic cost separately from P&L.
  //    Both nullable-safe via DEFAULT 0.
  // 2. tradable_symbols — whitelist table. API rejects orders for symbols not
  //    present (active=1 AND asset_class='EQUITY'). Seed is loaded via
  //    `scripts/sync-tradable-symbols.ts` — the table-creation itself stays
  //    in ensureSchema so the schema is valid even on a fresh install.
  // 3. app_settings seed rows — one key per risk param so the UI can PATCH
  //    individual fields.
  await ensureColumn("paper_trades", "commission_usd", "DECIMAL(18,6) NOT NULL DEFAULT 0");
  await ensureColumn("paper_trades", "slippage_usd", "DECIMAL(18,6) NOT NULL DEFAULT 0");
  await pool.execute(`CREATE TABLE IF NOT EXISTS tradable_symbols (
    symbol VARCHAR(16) NOT NULL PRIMARY KEY,
    exchange VARCHAR(16) NULL,
    asset_class VARCHAR(16) NOT NULL DEFAULT 'EQUITY',
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    INDEX IX_tradable_symbols_active (active),
    INDEX IX_tradable_symbols_class_active (asset_class, active)
  ) ENGINE=InnoDB`);
  // Seed risk params with INSERT IGNORE semantics so re-running is a no-op.
  const riskSeed: Array<[string, string]> = [
    ["risk.slippage_bps", "5"],
    ["risk.commission_per_share", "0.005"],
    ["risk.commission_min_per_leg", "1.0"],
    ["risk.allow_fractional_shares", "true"],
    ["risk.default_borrow_rate_pct", "2.5"],
  ];
  for (const [k, v] of riskSeed) {
    await pool.execute(
      "INSERT IGNORE INTO app_settings (`key`, `value`) VALUES (?, ?)",
      [k, v]
    );
  }

  // 2026-04-22 — backfill tradable_symbols from reversal_entries so the
  // /reversal → /paper batch flow no longer rejects symbols that were
  // legitimately enrolled by Yahoo Movers / TREND scan but happened to be
  // outside the 232-row curated CSV seed. `INSERT IGNORE` on the symbol
  // primary key means this is a one-shot data fix: first boot after the
  // migration ships inserts the delta, subsequent boots are ~no-op.
  // Lazy-insert in surveillance-cron.ts keeps it in sync going forward.
  try {
    await pool.execute(
      `INSERT IGNORE INTO tradable_symbols (symbol, exchange, asset_class, active)
       SELECT DISTINCT symbol, NULL, 'EQUITY', 1 FROM reversal_entries`
    );
  } catch (err) {
    // Best-effort — the schema is still valid without this data fix. Log
    // it but don't trap the migration in a reject state.
    console.warn(
      "[migrations] reversal_entries → tradable_symbols backfill failed:",
      err instanceof Error ? err.message : String(err)
    );
  }

  // W5 (2026-04-21) — UX guardrails + multi-account.
  //
  // 1. paper_orders.client_request_id: client-generated idempotency key. A
  //    POST /api/paper/order that carries the same id twice is a no-op — the
  //    second call returns the existing row instead of inserting a duplicate.
  //    Protects the engine from the "Buy button mashed twice" footgun.
  // 2. COMPOSITE UNIQUE INDEX on (account_id, client_request_id): enforces
  //    dedup SCOPED per account. Hotfix 2026-04-22 fix — the original W5
  //    index was on client_request_id alone, which leaked across accounts
  //    (Bob's POST on account #2 with the same id as Alice's on account #1
  //    returned Alice's order row). InnoDB still allows multiple NULLs in
  //    a UNIQUE index, so rows without an id stay unconstrained.
  await ensureColumn("paper_orders", "client_request_id", "VARCHAR(64) NULL");

  // Drop the legacy global index if a pre-hotfix DB has it. Idempotent —
  // skip when absent so re-running ensureSchema stays a no-op.
  const [oldIdxRows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'paper_orders'
        AND INDEX_NAME   = 'idx_paper_orders_client_request_id'`
  );
  if ((oldIdxRows as IndexRow[]).length > 0) {
    try {
      await pool.execute("ALTER TABLE paper_orders DROP INDEX idx_paper_orders_client_request_id");
    } catch (err: unknown) {
      // errno 1091 = index doesn't exist (race with parallel deploy). Swallow.
      if ((err as { errno?: number }).errno !== 1091) throw err;
    }
  }

  // Add the composite (account_id, client_request_id) unique index. Gate
  // on INFORMATION_SCHEMA to stay idempotent on re-run.
  const [newIdxRows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'paper_orders'
        AND INDEX_NAME   = 'idx_paper_orders_acct_crid'`
  );
  if ((newIdxRows as IndexRow[]).length === 0) {
    try {
      await pool.execute("ALTER TABLE paper_orders ADD UNIQUE INDEX idx_paper_orders_acct_crid (account_id, client_request_id)");
    } catch (err: unknown) {
      // errno 1061 = duplicate key name (race with parallel deploy).
      if ((err as { errno?: number }).errno !== 1061) throw err;
    }
  }

  // Seed default paper account
  await pool.execute(
    "INSERT IGNORE INTO paper_accounts (name, initial_cash, cash) VALUES ('Default', 100000, 100000)"
  );
  // Backfill account_id on existing trades
  const [defaultAccount] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT id FROM paper_accounts WHERE name = 'Default' LIMIT 1"
  );
  if (defaultAccount.length > 0) {
    await pool.execute(
      "UPDATE paper_trades SET account_id = ? WHERE account_id IS NULL",
      [defaultAccount[0].id]
    );
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
