-- Setup 3 TREND-based strategies (scan enrollment source, not top movers)
-- Each gets a $5,000 account, $100 per trade at 5x leverage ($500 effective)

-- ─── Strategy 1: 3-Day Slide Bounce ─────────────────────────────────────────
-- LONG on trend-sourced stocks that slid 3+ days (cumulative ≥3% drop)
-- Our analysis: 3 consecutive DOWN days showed 67.7% reversal rate
-- After d1/d2 confirmation this should exceed 70%
INSERT INTO paper_accounts (name, initial_cash, cash) VALUES ('Strategy: 3-Day Slide Bounce', 5000, 5000);
SET @acct1 = LAST_INSERT_ID();
INSERT INTO paper_strategies (account_id, name, strategy_type, leverage, enabled, config_json) VALUES (
  @acct1, '3-Day Slide Bounce', 'CONFIRMATION', 5, 1,
  '{"entry":{"direction":"LONG","enrollment_source":"TREND","min_consecutive_days":3,"max_consecutive_days":4,"confirmation_days":2,"d1_must_be_favorable":true,"d2_must_be_favorable":true,"min_price":5},"sizing":{"type":"fixed","amount_usd":100,"max_concurrent":15,"max_new_per_day":10},"exits":{"trailing_stop_pct":3,"trailing_activates_at_profit_pct":1,"hard_stop_pct":-3,"time_exit_days":5}}'
);

-- ─── Strategy 2: 4+ Day UP Fade ─────────────────────────────────────────────
-- SHORT on trend-sourced stocks that rose 4+ days (parabolic)
-- Our analysis: 4+ UP day SHORT entries showed 70-83% reversal rate
INSERT INTO paper_accounts (name, initial_cash, cash) VALUES ('Strategy: 4-Day UP Fade', 5000, 5000);
SET @acct2 = LAST_INSERT_ID();
INSERT INTO paper_strategies (account_id, name, strategy_type, leverage, enabled, config_json) VALUES (
  @acct2, '4-Day UP Fade', 'CONFIRMATION', 5, 1,
  '{"entry":{"direction":"SHORT","enrollment_source":"TREND","min_consecutive_days":4,"confirmation_days":2,"d1_must_be_favorable":true,"d2_must_be_favorable":true,"min_price":5},"sizing":{"type":"fixed","amount_usd":100,"max_concurrent":10,"max_new_per_day":5},"exits":{"trailing_stop_pct":3,"trailing_activates_at_profit_pct":1,"hard_stop_pct":-3,"time_exit_days":4}}'
);

-- ─── Strategy 3: Extreme Streak Reversal ────────────────────────────────────
-- Bi-directional: captures any 5+ consecutive day streak on TREND-sourced stocks
-- Direction is set by the reversal entry (LONG for DOWN streaks, SHORT for UP streaks)
-- Our analysis: 5 UP streaks showed 83.3% reversal, extreme streaks mean reversion is strong
-- No direction filter → accepts either direction from TREND source
INSERT INTO paper_accounts (name, initial_cash, cash) VALUES ('Strategy: Extreme Streak Reversal', 5000, 5000);
SET @acct3 = LAST_INSERT_ID();
INSERT INTO paper_strategies (account_id, name, strategy_type, leverage, enabled, config_json) VALUES (
  @acct3, 'Extreme Streak Reversal', 'CONFIRMATION', 5, 1,
  '{"entry":{"enrollment_source":"TREND","min_consecutive_days":5,"confirmation_days":1,"d1_must_be_favorable":true,"min_price":5},"sizing":{"type":"fixed","amount_usd":100,"max_concurrent":10,"max_new_per_day":5},"exits":{"trailing_stop_pct":4,"trailing_activates_at_profit_pct":2,"hard_stop_pct":-4,"time_exit_days":5}}'
);
