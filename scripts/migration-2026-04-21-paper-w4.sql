-- Migration: 2026-04-21 — Paper Trading W4 (risk model: slippage, commission, whitelist, fractional, borrow cost)
-- Idempotent via INFORMATION_SCHEMA gates. Additive only; no destructive DDL.
--
-- Changes:
--   A. paper_trades.commission_usd — per-fill commission debited at open/close.
--   B. paper_trades.slippage_usd   — per-fill slippage cost (price delta × qty).
--   C. tradable_symbols            — whitelist of symbols the API will accept.
--   D. app_settings                — seed keys for risk model (slippage bps,
--      commission schedule, fractional toggle, default borrow rate).
--
-- Apply locally:
--   node -e "const m=require('mysql2/promise');const fs=require('fs');(async()=>{const c=await m.createConnection({host:'localhost',port:3319,user:'root',password:'trading123',database:'trading',multipleStatements:true});await c.query(fs.readFileSync('scripts/migration-2026-04-21-paper-w4.sql','utf8'));await c.end();})()"
--
-- Apply to Railway prod:
--   railway run --service MySQL mysql < scripts/migration-2026-04-21-paper-w4.sql

-- ── A. paper_trades.commission_usd ────────────────────────────────────────
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='commission_usd');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN commission_usd DECIMAL(18,6) NOT NULL DEFAULT 0', 'SELECT ''paper_trades.commission_usd present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── B. paper_trades.slippage_usd ──────────────────────────────────────────
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='slippage_usd');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN slippage_usd DECIMAL(18,6) NOT NULL DEFAULT 0', 'SELECT ''paper_trades.slippage_usd present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── C. tradable_symbols whitelist table ───────────────────────────────────
CREATE TABLE IF NOT EXISTS tradable_symbols (
  symbol VARCHAR(16) NOT NULL PRIMARY KEY,
  exchange VARCHAR(16) NULL,
  asset_class VARCHAR(16) NOT NULL DEFAULT 'EQUITY',
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  INDEX IX_tradable_symbols_active (active),
  INDEX IX_tradable_symbols_class_active (asset_class, active)
) ENGINE=InnoDB;

-- ── D. app_settings seed rows for risk model ─────────────────────────────
-- Each row is key → JSON value. W4 uses individual keys (one per param) so
-- the UI can PATCH them atomically. Existing `defaults` key from W0 stays.
-- Defaults:
--   risk.slippage_bps            = 5.0    (market orders only; LIMIT = 0)
--   risk.commission_per_share    = 0.005  (Alpaca-like)
--   risk.commission_min_per_leg  = 1.0
--   risk.allow_fractional_shares = true
--   risk.default_borrow_rate_pct = 2.5    (annualized % — typical large-cap)
INSERT INTO app_settings (`key`, `value`) VALUES ('risk.slippage_bps', '5')
  ON DUPLICATE KEY UPDATE `key` = `key`;
INSERT INTO app_settings (`key`, `value`) VALUES ('risk.commission_per_share', '0.005')
  ON DUPLICATE KEY UPDATE `key` = `key`;
INSERT INTO app_settings (`key`, `value`) VALUES ('risk.commission_min_per_leg', '1.0')
  ON DUPLICATE KEY UPDATE `key` = `key`;
INSERT INTO app_settings (`key`, `value`) VALUES ('risk.allow_fractional_shares', 'true')
  ON DUPLICATE KEY UPDATE `key` = `key`;
INSERT INTO app_settings (`key`, `value`) VALUES ('risk.default_borrow_rate_pct', '2.5')
  ON DUPLICATE KEY UPDATE `key` = `key`;

SELECT 'migration-2026-04-21-paper-w4 applied' AS status;
