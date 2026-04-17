# План: Перенос MOVERS enrollment с 09:45 AM → 16:05 ET (post-close)

**Контекст:** обнаружили что текущая логика enrolls акции в 09:45 AM (первые 15 мин торгов) — это не "дневные movers", а "overnight gap + early morning movers". Часто это продолжение вчерашнего движения (gap-and-go from overnight news), что засоряет сигнал.

**Цель:** enroll после close, entry = close day's price, day_change_pct = реальное дневное движение (close-to-close).

---

## 1. Что меняется в коде

### 1a. Cron schedule (`scripts/surveillance-cron.ts`)

**Сейчас:**
```
09:45 — runFullSync() = jobEnrollMovers + jobSyncPrices
12:35 — jobSyncPrices
16:05 — jobSyncPrices
16:15 — jobScanTrends
16:30 — jobExecuteConfirmationStrategies
18:00 — jobSyncPrices (catchup)
```

**Станет:**
```
09:45 — jobSyncPrices (fills d_morning для предыдущих cohorts)
12:35 — jobSyncPrices (d_midday)
16:05 — jobSyncPrices (d_close) + jobEnrollMovers ← ENROLLMENT ЗДЕСЬ
16:15 — jobScanTrends
16:30 — jobExecuteConfirmationStrategies
18:00 — jobSyncPrices (catchup)
```

Порядок в 16:05: сначала sync (заполняем d_close для вчерашних cohorts), потом enroll (создаём новый cohort для сегодняшнего close).

### 1b. `jobEnrollMovers()` logic

- Удалить pre-market guard (строки 538-541) — уже не нужен
- Добавить post-close guard: `if (curMinutes < 16 * 60) skip` (не enrollить до close)
- Yahoo `day_gainers` / `day_losers` at 16:05 ET возвращает full-day top movers — именно что нам нужно
- `entry_price = mover.regularMarketPrice` (= today's close)
- `day_change_pct = mover.regularMarketChangePercent` (= today's full-day change close-to-close)
- `cohort_date = todayET()` (не меняется)

### 1c. `jobExecuteStrategies` timing

Сейчас fires at 09:50. С новой логикой:
- Yesterday's 16:05 enrollment → cohort_date = yesterday
- Today 09:50 strategy tick → looks for entries with `cohort_date >= today - 7 days`. Yesterday's cohort matches. ✓
- entry_price = yesterday's close. Реальная покупка = today's open (может быть gap).

**Это gap risk нужно учитывать в стратегиях** — см. раздел 4.

### 1d. `jobSyncPrices` d-column iteration

Loop уже правильный: `cursor = cohortStr; cursor = addCalendarDaysET(cursor, 1)` — т.е. d1 = следующий trading day после cohort. Для post-close enrollment это Tuesday после Monday-close cohort. ✓ Не меняется.

---

## 2. Что делать со старыми данными (520 existing MOVERS entries)

**3 варианта, требуется выбор:**

### Option A: Keep as-is
- Старые entries остаются с 09:45 AM semantics
- Новые — с post-close semantics
- **Плюсы:** ноль работы
- **Минусы:** backtest на mixed data искажён. Старые 09:45 entries имеют другой распределение day_change_pct чем новые close entries.

### Option B: Backfill (РЕКОМЕНДУЮ)
- Script `scripts/backfill-movers-post-close.ts`:
  - Для каждой entry с `enrollment_source='MOVERS'` and `cohort_date < TODAY`:
    - Fetch daily bar Yahoo для `symbol` и `cohort_date`
    - `close_price = bar.close`, `open_price = bar.open`, `prev_close = previous bar.close`
    - UPDATE entry_price = close_price
    - UPDATE day_change_pct = (close_price - prev_close) / prev_close * 100
  - d1-d10 columns **не трогаем** — они уже правильные (следующий trading day после cohort)
- **Плюсы:** все historical data имеют одинаковую семантику, backtest чистый
- **Минусы:** ~520 Yahoo fetches, ~5 мин работы; риск несоответствия Yahoo historical vs Yahoo live screener data

### Option C: New enrollment_source tag
- Rename existing `enrollment_source='MOVERS'` → `MOVERS_AM`
- Новый post-close: `enrollment_source='MOVERS'` (takes over)
- Strategies filter by source
- **Плюсы:** ясное разделение старых vs новых
- **Минусы:** усложняет UI/queries, мешает cross-period analysis

**Рекомендация:** **Option B** — один-time script, чистая semantics вперёд.

---

## 3. Migration steps (порядок)

1. **Code change PR**:
   - `scripts/surveillance-cron.ts`: перенести jobEnrollMovers, убрать pre-market guard, добавить post-close guard
   - `scripts/backfill-movers-post-close.ts`: new file для Option B backfill
2. **Typecheck + lint**
3. **Commit + push + merge** (feature branch → master)
4. **Run backfill script** против prod DB через tunnel:
   - `npx tsx scripts/backfill-movers-post-close.ts`
   - Verify: 520 entries updated, entry_price changed, day_change_pct recomputed
5. **Redeploy cron** на VPS:
   - `scp scripts/surveillance-cron.ts root@...`
   - `docker compose up -d --build surveillance-cron`
6. **Verify** в первом 16:05 tick: Discord alert «enrolled 20 post-close movers», entry_price матчит Yahoo's close для тех symbols
7. **Re-run backtest** после backfill — cross-check результаты, особенно distributions для `day_change_pct`

---

## 4. Impact на стратегии

### Gap risk
- entry_price = yesterday's close — это "theoretical buy at close"
- Real execution = today's open → может быть overnight gap
- Для backtest можно accept gap slippage как реалистичный (всегда будет в real trading)
- Для strategy tuning: tighter hard_stop учитывает gap risk

### Сравнение edge до vs после
- day_change_pct до: overnight + первые 15 мин
- day_change_pct после: полный open-to-close
- Это **разные** распределения — статистика из /research (60% continuation etc) может измениться
- **Нужно: пересчитать все аналитические таблицы** (streak analysis, d1-d5 horizon) после backfill

### Existing paper_signals
- Те 84 open live signals сейчас: entry_price = 09:45 AM price (old semantics)
- После migration: новые signals будут с post-close semantics
- Старые останутся жить per их exit rules — не трогаем
- В будущем: все new signals consistent

---

## 5. Effort + риски

| Этап | Время |
|---|---|
| Code change (cron schedule + jobEnrollMovers) | 30-45 мин |
| Backfill script (Option B) | 30-45 мин |
| Deploy + verify first 16:05 run | 30 мин |
| Re-run backtest + /research analysis | 30 мин |
| **Total** | **~2.5 часа** |

**Риски:**
- Yahoo historical daily bars могут не совпадать с live screener data (discrepancies на split/dividend days) — accept or manually fix outliers
- 520 Yahoo fetches в backfill — rate limit; использовать fetchWithTimeout + sleep между calls
- **Breaking semantics** — backtest до и после migration показывает разные числа; документировать cutoff date
- Backfill ↔ live cron могут race если cron runs во время backfill. Решение: pause cron container во время backfill, потом resume

---

## 6. Definition of done

- [ ] Cron перенесён, 16:05 ET tick enrolls MOVERS (Discord alert fires)
- [ ] Backfill script выполнен, все 520 entries имеют post-close semantics
- [ ] `SELECT day_change_pct FROM reversal_entries WHERE enrollment_source='MOVERS'` distribution выглядит чище (нет outlier'ов overnight-gap-only)
- [ ] Re-run /research с presets показывает обновлённые edge numbers
- [ ] Отчёт: "было vs стало" для 4 presets (Baseline UP, Monster Rider, Dip Bounce, Gainer Fade)

---

**Pre-requisite для этого плана:** топ-5 из `2026-04-18-top5-plan.md` (особенно Discord alerts — чтобы при deploy узнать о проблемах).
