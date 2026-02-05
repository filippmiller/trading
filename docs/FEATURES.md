# Trading System Features Documentation

## Overview

This document covers the advanced trading analysis features added to the Voice Strategy Simulator. These features enhance the backtesting workflow with AI-powered insights, visualization tools, and a mean reversion study tracker.

---

## Table of Contents

1. [Strategy Refinement Chat](#1-strategy-refinement-chat)
2. [AI Post-Backtest Critique](#2-ai-post-backtest-critique)
3. [Equity Curve Visualization](#3-equity-curve-visualization)
4. [Parameter Sweep Heatmap](#4-parameter-sweep-heatmap)
5. [Live Signals Dashboard](#5-live-signals-dashboard)
6. [Mean Reversion Study](#6-mean-reversion-study)

---

## 1. Strategy Refinement Chat

**Location:** `/voice` page (inline chat panel)

### Purpose
Enables conversational refinement of trading strategies after voice input. Users can iteratively adjust strategy parameters through natural language.

### How It Works
1. After voice-parsing a strategy, a chat interface appears below the parsed spec
2. Type refinements like "increase stop loss to 5%" or "add RSI filter above 70"
3. The AI processes your request and returns an updated strategy specification
4. Changes are reflected in the editable spec panel

### API Endpoint
```
POST /api/voice/refine
Body: { spec: StrategySpec, message: string }
Response: { spec: StrategySpec, explanation: string }
```

### Technical Details
- Uses GPT-4o-mini for fast responses
- 30-second timeout with AbortController
- Preserves conversation context within session
- Component: `src/components/StrategyChat.tsx`

---

## 2. AI Post-Backtest Critique

**Location:** `/runs/[id]` page (run detail view)

### Purpose
Provides AI-generated analysis of backtest results, identifying strengths, weaknesses, and potential improvements.

### How It Works
1. Navigate to any completed backtest run
2. Click the "Get AI Critique" button
3. The AI analyzes:
   - Win rate and profit factor
   - Maximum drawdown patterns
   - Trade distribution
   - Risk/reward characteristics
4. Returns actionable suggestions for strategy improvement

### API Endpoint
```
POST /api/runs/[id]/critique
Body: { run: BacktestRun }
Response: { critique: string }
```

### Sample Critique Output
```
## Performance Analysis
- Win rate of 45% is below typical profitable threshold
- Profit factor of 1.2 suggests marginal edge

## Concerns
- Maximum drawdown of 15% occurred during volatile period
- Long trades underperforming shorts by 3:1 ratio

## Suggestions
1. Consider adding volatility filter to reduce drawdown
2. Tighten stop loss on long positions
3. Test with larger sample size for statistical significance
```

### Technical Details
- Component: `src/components/BacktestCritique.tsx`
- Caches critique to avoid redundant API calls
- Uses structured prompt for consistent output format

---

## 3. Equity Curve Visualization

**Location:** `/runs/[id]` page (below trade table)

### Purpose
Visualizes cumulative P&L over time with drawdown shading, helping identify performance patterns and risk periods.

### Features
- **Cumulative P&L Line:** Shows account growth over time
- **Drawdown Shading:** Red-shaded areas indicate drawdown periods
- **High Water Mark:** Dashed line showing peak equity
- **Hover Tooltips:** Display exact values at each point
- **Responsive Design:** Adapts to container width

### Technical Details
- Pure SVG implementation (no external charting library)
- Component: `src/components/charts/EquityCurve.tsx`
- Props:
  ```typescript
  interface EquityCurveProps {
    trades: Array<{
      exit_date: string;
      pnl: number;
    }>;
    height?: number;
  }
  ```

### Visual Elements
| Element | Color | Description |
|---------|-------|-------------|
| Equity Line | Blue (#3b82f6) | Cumulative P&L |
| Drawdown Fill | Red (opacity 0.2) | Area below high water mark |
| High Water Mark | Gray dashed | Peak equity reference |
| Zero Line | Gray | Break-even reference |

---

## 4. Parameter Sweep Heatmap

**Location:** `/scenarios` page (expandable section per scenario)

### Purpose
Optimizes strategy parameters by running multiple backtests across a range of stop loss and take profit values, visualizing results as a color-coded heatmap.

### How It Works
1. Expand a scenario card on the Scenarios page
2. Set stop loss range (e.g., 1% to 5%)
3. Set take profit range (e.g., 2% to 10%)
4. Define step size for granularity
5. Click "Run Sweep" to execute
6. View results as interactive heatmap

### Heatmap Interpretation
- **Green cells:** Profitable parameter combinations
- **Red cells:** Losing parameter combinations
- **Color intensity:** Magnitude of profit/loss
- **Hover:** Shows exact total P&L for each cell

### API Endpoint
```
POST /api/backtest/sweep
Body: {
  scenarioId: number,
  stopLossRange: [min, max, step],
  takeProfitRange: [min, max, step]
}
Response: {
  results: Array<{
    stopLoss: number,
    takeProfit: number,
    totalPnl: number,
    winRate: number,
    tradeCount: number
  }>
}
```

### Technical Details
- Component: `src/components/SweepSection.tsx`
- Heatmap: `src/components/charts/Heatmap.tsx`
- Validates ranges before execution
- Shows progress during sweep execution
- Maximum 100 combinations per sweep (10x10 grid)

---

## 5. Live Signals Dashboard

**Location:** `/signals` page

### Purpose
Scans all downloaded tickers against preset strategies to identify current entry signals without running full backtests.

### How It Works
1. Navigate to Signals page
2. Optionally filter by specific symbol
3. Click "Refresh Signals"
4. System scans latest price data against all strategies
5. Displays triggered signals with entry details

### Signal Display
Each signal shows:
- **Symbol:** Ticker that triggered
- **Strategy:** Which preset triggered it
- **Side:** LONG or SHORT
- **Entry Price:** Current/suggested entry
- **Stop Loss:** Calculated stop level
- **Take Profit:** Calculated target level

### API Endpoint
```
GET /api/signals?symbol=AAPL (optional filter)
Response: {
  signals: Array<{
    symbol: string,
    strategy: string,
    signal: { side, entry, stopLoss, takeProfit }
  }>,
  scannedAt: string
}
```

### Technical Details
- Signal detection logic: `src/lib/signals.ts`
- Extracts signal logic from backtest engine
- Race condition guard prevents duplicate refreshes
- Manual refresh only (no auto-polling)

### Important Notes
- Signals are informational only, not trading advice
- Based on end-of-day data, not real-time
- Requires price data to be downloaded first

---

## 6. Mean Reversion Study

**Location:** `/reversal` page

### Purpose
Tracks a mean reversion hypothesis: top daily gainers tend to fall, and top losers tend to rise over the following days. This feature enables systematic tracking and P&L calculation for this strategy.

### Hypothesis
> Stocks that move significantly in one direction tend to revert toward their mean over subsequent days.

### Workflow

#### Step 1: Configure Settings
Click "Settings" to configure:
| Setting | Default | Description |
|---------|---------|-------------|
| Position Size | $100 | USD per position |
| Commission | $1 | Per trade (entry + exit = $2 total) |
| Leverage Multiplier | 1x | Position sizing multiplier |
| Short Borrow Rate | 3% APR | Cost of borrowing shares |
| Leverage Interest | 8% APR | Margin interest rate |

#### Step 2: Fetch Market Movers
Click "Fetch Today's Movers" to retrieve:
- **Top 10 Losers:** Candidates for LONG positions (buy the dip)
- **Top 10 Gainers:** Candidates for SHORT positions (fade the rally)

Data sourced from Yahoo Finance screener API.

#### Step 3: Create Daily Cohort
1. Select up to 5 stocks from each list
2. Entry prices are captured automatically
3. Click "Create Today's Cohort"
4. Cohort is saved with today's date

#### Step 4: Track Measurements
Over the next 3 trading days, enter prices at 9 measurement points:

| Day | Morning | Midday | Close |
|-----|---------|--------|-------|
| D+1 | 9:30 AM | 12:00 PM | 4:00 PM |
| D+2 | 9:30 AM | 12:00 PM | 4:00 PM |
| D+3 | 9:30 AM | 12:00 PM | 4:00 PM |

#### Step 5: Analyze Results
The system calculates:
- **Gross P&L:** Based on price movement
- **Commissions:** Entry + exit costs
- **Borrow Costs:** For SHORT positions (prorated daily)
- **Leverage Interest:** If using margin
- **Net P&L:** Final profit/loss after all costs

### P&L Calculation Formula

```
For LONG positions:
  grossPnl = (exitPrice - entryPrice) / entryPrice * positionSize * leverage

For SHORT positions:
  grossPnl = (entryPrice - exitPrice) / entryPrice * positionSize * leverage
  borrowCost = positionSize * leverage * (borrowRate / 365) * holdingDays

Net P&L = grossPnl - commissions - borrowCost - leverageInterest
```

### Database Schema
```sql
CREATE TABLE reversal_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cohort_date DATE NOT NULL,
  symbol VARCHAR(16) NOT NULL,
  direction ENUM('LONG', 'SHORT') NOT NULL,
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
  final_pnl_pct DECIMAL(10,4) NULL,
  status ENUM('ACTIVE', 'COMPLETED') DEFAULT 'ACTIVE',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_cohort_symbol (cohort_date, symbol)
);
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/reversal` | List all cohorts |
| POST | `/api/reversal` | Create new cohort |
| PATCH | `/api/reversal/[id]` | Update measurement prices |
| DELETE | `/api/reversal/[id]` | Remove entry |
| GET | `/api/reversal/movers` | Fetch Yahoo Finance movers |
| GET | `/api/reversal/settings` | Get study settings |
| POST | `/api/reversal/settings` | Update study settings |

### Technical Details
- Types and calculations: `src/lib/reversal.ts`
- Page component: `src/app/reversal/page.tsx`
- Settings stored in `app_settings` table as JSON
- Yahoo Finance API with User-Agent header for reliability

---

## Architecture Overview

### File Structure
```
src/
├── app/
│   ├── api/
│   │   ├── backtest/
│   │   │   └── sweep/route.ts       # Parameter sweep API
│   │   ├── reversal/
│   │   │   ├── route.ts             # Cohort CRUD
│   │   │   ├── [id]/route.ts        # Entry updates
│   │   │   ├── movers/route.ts      # Yahoo Finance
│   │   │   └── settings/route.ts    # Study config
│   │   ├── runs/
│   │   │   └── [id]/critique/route.ts
│   │   ├── signals/route.ts
│   │   └── voice/
│   │       └── refine/route.ts
│   ├── reversal/page.tsx
│   └── signals/page.tsx
├── components/
│   ├── BacktestCritique.tsx
│   ├── StrategyChat.tsx
│   ├── SweepSection.tsx
│   └── charts/
│       ├── EquityCurve.tsx
│       └── Heatmap.tsx
└── lib/
    ├── reversal.ts                  # Types, schemas, P&L calc
    └── signals.ts                   # Signal detection logic
```

### Dependencies
- **OpenAI API:** GPT-4o-mini for AI features (critique, refinement)
- **Yahoo Finance API:** Market movers data
- **MySQL:** Data persistence
- **Zod:** Schema validation

### Environment Variables
```
OPENAI_API_KEY=sk-...          # Required for AI features
DATABASE_URL=mysql://...        # MySQL connection
```

---

## Troubleshooting

### AI Features Not Working
1. Verify `OPENAI_API_KEY` is set
2. Check API quota/billing status
3. Review server logs for timeout errors

### Yahoo Finance Movers Empty
1. API may be rate-limited; wait and retry
2. Check if market is open (US trading hours)
3. Verify network connectivity

### Heatmap Not Rendering
1. Ensure sweep completed successfully
2. Check for valid numeric ranges
3. Verify at least 2 values in each range

### Signals Not Appearing
1. Download price data first via Prices page
2. Ensure strategies are configured
3. Check that latest bar meets entry conditions

---

## Future Enhancements

Potential improvements for future development:

1. **Real-time Signals:** WebSocket-based live signal updates
2. **Multi-timeframe Analysis:** Support for intraday data
3. **Portfolio Tracking:** Track multiple concurrent positions
4. **Export/Import:** CSV export for cohort data
5. **Alerts:** Email/SMS notifications for signals
6. **Extended Movers:** Support for crypto, forex, futures

---

*Documentation last updated: February 2026*
