# Trading System Features

## Overview

This application is no longer just a voice strategy simulator. It is a trading research and paper-execution workspace built around one core loop:

1. collect daily movers and surveillance data,
2. inspect 10-day follow-through,
3. research entry and exit behavior,
4. compare strategy variants,
5. route ideas into paper execution.

The main user-facing surface today is:
- `/` overview dashboard
- `/markets` quote and chart lookup
- `/reversal` mean-reversion surveillance
- `/strategies` strategy dashboard
- `/scenarios` scenario comparison tools
- `/research` scenario runner and Grid Sweep
- `/signals` market signal view
- `/prices` price surveillance
- `/voice` voice-assisted strategy parsing
- `/runs` saved simulation runs
- `/paper` paper trading
- `/settings` system diagnostics and controls

## Core Modules

### 1. Overview Dashboard

**Location:** `/`

The landing page summarizes the whole loop:
- active surveillance count
- completed scenarios / runs
- headline win-rate snapshot
- direct links into surveillance, strategies, and markets

It is meant to answer: "is the system alive, and where do I go next?"

### 2. Markets

**Location:** `/markets`

The markets page is the fast quote-and-chart surface.

Key capabilities:
- symbol lookup
- multiple date ranges
- live stat cards
- watchlist-style workflow
- market-phase-aware refresh behavior

This page fills the "Yahoo-like ticker page without ads" role inside the app.

### 3. Mean Reversion Surveillance

**Location:** `/reversal`

This is the surveillance matrix for daily movers and follow-through.

Key capabilities:
- grouped cohorts by date
- 10-day forward tracking
- dollar prices plus percentage follow-through
- support for `MOVERS` and `TREND` enrollment sources
- completed-trade PnL now reflected correctly after the April 19 cleanup

This page is the raw observation layer before strategy research.

### 4. Strategy Dashboard

**Location:** `/strategies`

This page tracks the live paper-strategy fleet.

Key capabilities:
- strategy-level account and equity views
- comparison across multiple templates / leverage tiers
- safer error handling after the tab-audit cleanup
- naming aligned with the actual purpose: dashboard, not scenario editor

### 5. Strategy Scenarios

**Location:** `/scenarios`

Scenario tools remain the quicker comparison surface for structured strategy variants.

Key capabilities:
- scenario cards
- preview / validation state
- parameter sweep support
- reusable ticker download affordance after the April 19 cleanup

### 6. Strategy Research

**Location:** `/research`

This is the deepest research tool in the product.

It includes two layers:

**Scenario Runner**
- filter by cohort date, direction, move size, streak, and enrollment source
- choose trade direction, leverage, exit logic, and cost assumptions
- inspect trades, summary stats, equity curve, histogram, and exit-reason breakdown
- save and reload named scenarios

**Grid Sweep**
- multi-dimensional strategy search over:
  - hold days
  - exit bar
  - entry delay
  - entry bar
  - stop loss
  - take profit
  - trailing stop
  - breakeven arm
- one-click presets for common sweeps
- sortable top-results table
- server-side 10,000-combination cap

This is the main research instrument for discovering edges without writing ad-hoc scripts.

### 7. Signals

**Location:** `/signals`

The signals page surfaces current strategy-trigger candidates without requiring a full historical run.

Use it to inspect what the present market would trigger under existing rules.

### 8. Price Surveillance

**Location:** `/prices`

This page is the operational surface for ticker-level price data availability and symbol onboarding.

It now uses the shared inline ticker downloader component introduced during the tab-audit cleanup.

### 9. Voice Intelligence

**Location:** `/voice`

The voice workflow still exists, but it is now one module inside the broader platform rather than the whole product.

Key capabilities:
- parse strategy ideas from voice or natural-language input
- refine specs conversationally
- bridge exploratory idea capture into more structured scenario and research flows

### 10. Simulation Runs

**Location:** `/runs`

This area stores and reviews generated runs.

Key capabilities:
- run history
- run detail pages
- critique endpoint support
- equity-curve and result inspection

### 11. Paper Trading

**Location:** `/paper`

The paper module is the execution sandbox.

Key capabilities:
- account snapshot
- pending orders
- fills and position history
- realized and unrealized PnL
- reset / control paths for simulator iteration

### 12. Settings

**Location:** `/settings`

Settings is the operational control and diagnostic surface.

After the April 19 cleanup it shows explicit error and retry states instead of failing silently when the tunnel or DB is unavailable.

## Operational Architecture

### Data collection

The system relies on:
- Yahoo data endpoints as primary market data sources
- VPS MySQL as the shared state store
- local web app access through SSH port-forwarding in development

### Enrollment semantics

Current `MOVERS` enrollment semantics are post-close:
- morning sync around `09:45 ET` fills prices and housekeeping
- post-close `16:05 ET` is the important enrollment window for full-day movers

This matters because older `09:45` semantics mixed overnight-gap behavior with true daily-mover behavior.

### Research vs execution

The intended workflow is:

1. observe cohorts on `/reversal`
2. test hypotheses on `/research`
3. inspect live strategy behavior on `/strategies`
4. watch fills and account state on `/paper`

## Recent Changes Worth Knowing

### Grid Sweep shipped

`/research` now supports true multi-axis grid search through `/api/research/grid`.

### Tab audit cleanup shipped

The UI now has:
- clearer error states
- corrected cron/status copy
- corrected completed-PnL handling
- reusable ticker download affordances
- cleaner page naming

## Known Gaps

- Public deployment is not configured
- Auth is still the major blocker before exposing the app publicly
- The DB tunnel remains a brittle local-dev dependency
- Build reliability still depends on Google Fonts availability unless fonts are vendored or replaced
