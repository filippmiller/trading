# Voice-Driven Strategy Simulator (2026-02-04)

## Summary
MVP Next.js (App Router) app for SPY daily backtesting with MySQL, voice/text-to-StrategySpec parsing, and a scenarios tab library. Data refresh pulls 6 months of daily bars from Stooq server-side.

## Architecture
- Web: Next.js App Router + TypeScript
- UI: Tailwind + shadcn/ui-style components
- API: Next.js route handlers
- DB: MySQL (Railway)
- LLM: OpenAI (transcribe + parse)

Key modules:
- `src/lib/db.ts` MySQL connection
- `src/lib/migrations.ts` idempotent schema + defaults
- `src/lib/strategy.ts` Zod StrategySpec schema + clamps
- `src/lib/backtest.ts` backtest engine
- `src/lib/scenarios.ts` curated preset definitions

## StrategySpec (JSON)
Common fields:
- `template`: `streak_fade` | `streak_follow` | `sar_fade_flip` | `gap_fade`
- `symbol`: `SPY`
- `lookback_days`: `20..260`
- `capital_base_usd`: number
- `leverage`: `1..10`
- `costs`: `{ commission_per_side_usd, slippage_bps, margin_interest_apr }`
- `regime_filter` (optional): `{ type: "ma", length: 200, allow_fade_only_if }`
- `martingale_lite` (optional): `{ base_capital_usd, leverage, max_steps, step_multiplier, max_exposure_usd, max_daily_loss_usd }`

Template-specific:
- `streak_fade` / `streak_follow`
  - `enter_on`: `"close"`
  - `direction`: `"fade" | "follow"`
  - `streak_length`: `2..5`
  - `stop_loss_pct`, `take_profit_pct?`, `trailing_stop_pct?`
  - `hold_max_days`
- `sar_fade_flip`
  - Same as `streak_fade` plus `flip_on_stop=true`, `flip_max_times`
- `gap_fade`
  - `enter_on`: `"open"`
  - `gap_threshold_pct`
  - `direction`: `"fade"`
  - `stop_loss_pct`, `take_profit_pct?`, `trailing_stop_pct?`
  - `hold_max_days` (0 or 1)

Safety clamps:
- `leverage` max 10
- `martingale.max_steps` max 5
- `trailing_stop_pct` min 0.001

## Scenarios UI
- Tabs (Dashboard + `/scenarios`)
- Each tab shows RU + EN description, editable parameters, run buttons (30d/60d/6mo), live JSON preview, and copy button
- Presets are code-defined in `src/lib/scenarios.ts`

## Deploy on Railway
1. Create a Railway project with one Next.js service.
2. Add an MySQL database in Railway.
3. Set Railway Variables:
   - `DATABASE_URL` (or `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DB`, `MYSQL_PORT`)
   - `OPENAI_API_KEY`
   - (optional) `ANTHROPIC_API_KEY`
4. Deploy the repo. The app auto-creates tables on first use.

## Run Locally
1. Install dependencies:
   - `npm install`
2. Create `.env.local` (do not commit) with:
   - `DATABASE_URL=...` or MySQL parts
   - `OPENAI_API_KEY=...`
3. Start dev server:
   - `npm run dev`

## Smoke Tests
1. Refresh data:
   - `POST /api/data/refresh` then confirm `prices_daily` row count > 80
2. Run preset backtest:
   - Use Dashboard quick preset → run → verify `run_metrics` row and >= 1 trade
3. Voice parse:
   - `POST /api/voice/parse` with example text → valid StrategySpec JSON

## Example Voice Texts
- “За последние 30 дней: после 3 зелёных дней шорт на закрытии, стоп 0.5%, тейк 1%, плечо 10, позиция 500.”
- “Stop-and-reverse после 2 дней падения: лонг, трейлинг 0.3%, если стоп — переворот один раз.”

## Known Limitations
- Daily OHLC only (intraday path approximations)
- Conservative stop/take ordering
- Single-symbol (SPY) MVP

## Next Steps
- Add intraday data (1m/5m)
- Scheduled refresh (cron)
- Multi-ticker support
- Richer performance analytics (Sharpe, equity curve)
