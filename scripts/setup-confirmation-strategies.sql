-- Setup 5 confirmation-based strategies (from statistical analysis 2026-04-16)
-- Each gets a $5,000 account, $100 per trade at 5x leverage ($500 effective)

-- ─── Strategy 1: Double Confirm Bounce ──────────────────────────────────────
-- LONG losers that dropped >5%, bounced >2% on d1, d2 also up
-- Analysis: 93.5% win rate, +7.7% avg return (n=20-37)
INSERT INTO paper_accounts (name, initial_cash, cash) VALUES ('Strategy: Double Confirm Bounce', 5000, 5000);
SET @acct1 = LAST_INSERT_ID();
INSERT INTO paper_strategies (account_id, name, strategy_type, leverage, enabled, config_json) VALUES (
  @acct1, 'Double Confirm Bounce', 'CONFIRMATION', 5, 1,
  '{"entry":{"direction":"LONG","confirmation_days":2,"d1_must_be_favorable":true,"d2_must_be_favorable":true,"min_d1_move_pct":2,"min_drop_pct":-5,"max_drop_pct":-30,"min_price":5},"sizing":{"type":"fixed","amount_usd":100,"max_concurrent":10,"max_new_per_day":5},"exits":{"trailing_stop_pct":3,"trailing_activates_at_profit_pct":1,"hard_stop_pct":-2,"time_exit_days":5}}'
);

-- ─── Strategy 2: Big Drop Confirmed ─────────────────────────────────────────
-- LONG losers that dropped 8-12%, bounced on d1 AND d2
-- Analysis: 100% win rate, +11.7% avg return (n=11), max drawdown -3.1%
INSERT INTO paper_accounts (name, initial_cash, cash) VALUES ('Strategy: Big Drop Confirmed', 5000, 5000);
SET @acct2 = LAST_INSERT_ID();
INSERT INTO paper_strategies (account_id, name, strategy_type, leverage, enabled, config_json) VALUES (
  @acct2, 'Big Drop Confirmed', 'CONFIRMATION', 5, 1,
  '{"entry":{"direction":"LONG","confirmation_days":2,"d1_must_be_favorable":true,"d2_must_be_favorable":true,"min_drop_pct":-8,"max_drop_pct":-20,"min_price":5},"sizing":{"type":"fixed","amount_usd":100,"max_concurrent":10,"max_new_per_day":5},"exits":{"trailing_stop_pct":5,"trailing_activates_at_profit_pct":2,"hard_stop_pct":-3,"time_exit_days":5}}'
);

-- ─── Strategy 3: Gainer Fade Confirmed ──────────────────────────────────────
-- SHORT gainers that rose >5%, pulled back d1 AND d2
-- Analysis: 92.5% win rate, +5.75% avg return (n=40)
INSERT INTO paper_accounts (name, initial_cash, cash) VALUES ('Strategy: Gainer Fade Confirmed', 5000, 5000);
SET @acct3 = LAST_INSERT_ID();
INSERT INTO paper_strategies (account_id, name, strategy_type, leverage, enabled, config_json) VALUES (
  @acct3, 'Gainer Fade Confirmed', 'CONFIRMATION', 5, 1,
  '{"entry":{"direction":"SHORT","confirmation_days":2,"d1_must_be_favorable":true,"d2_must_be_favorable":true,"min_rise_pct":5,"max_rise_pct":30,"min_price":5},"sizing":{"type":"fixed","amount_usd":100,"max_concurrent":10,"max_new_per_day":5},"exits":{"trailing_stop_pct":3,"trailing_activates_at_profit_pct":1,"hard_stop_pct":-2,"time_exit_days":3}}'
);

-- ─── Strategy 4: Washout Recovery ───────────────────────────────────────────
-- LONG losers that dropped >8%, d1 UNFAVORABLE, d2 UNFAVORABLE → buy the deep dip
-- Analysis: 73-77% win rate, +9.9-15% avg return (n=8-17)
INSERT INTO paper_accounts (name, initial_cash, cash) VALUES ('Strategy: Washout Recovery', 5000, 5000);
SET @acct4 = LAST_INSERT_ID();
INSERT INTO paper_strategies (account_id, name, strategy_type, leverage, enabled, config_json) VALUES (
  @acct4, 'Washout Recovery', 'CONFIRMATION', 5, 1,
  '{"entry":{"direction":"LONG","confirmation_days":2,"d1_must_be_unfavorable":true,"d2_must_be_unfavorable":true,"min_drop_pct":-8,"max_drop_pct":-30,"min_price":5},"sizing":{"type":"fixed","amount_usd":100,"max_concurrent":10,"max_new_per_day":5},"exits":{"trailing_stop_pct":5,"trailing_activates_at_profit_pct":3,"hard_stop_pct":-5,"time_exit_days":8}}'
);

-- ─── Strategy 5: Momentum Scalp ────────────────────────────────────────────
-- LONG losers dropped >5%, strong d1 bounce >2%, d2 continues → quick take-profit
-- Analysis: ~100% win rate to d3, tight take-profit scalp
INSERT INTO paper_accounts (name, initial_cash, cash) VALUES ('Strategy: Momentum Scalp', 5000, 5000);
SET @acct5 = LAST_INSERT_ID();
INSERT INTO paper_strategies (account_id, name, strategy_type, leverage, enabled, config_json) VALUES (
  @acct5, 'Momentum Scalp', 'CONFIRMATION', 5, 1,
  '{"entry":{"direction":"LONG","confirmation_days":2,"d1_must_be_favorable":true,"d2_must_be_favorable":true,"min_d1_move_pct":2,"min_drop_pct":-5,"max_drop_pct":-30,"min_price":5},"sizing":{"type":"fixed","amount_usd":100,"max_concurrent":10,"max_new_per_day":5},"exits":{"take_profit_pct":3,"hard_stop_pct":-2,"time_exit_days":3}}'
);
