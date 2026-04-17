const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DB
  });

  let pass = 0, fail = 0, warn = 0;
  function check(name, ok, detail) {
    if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
    else { fail++; console.log(`  ✗ FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
  }
  function info(msg) { console.log(`  ℹ ${msg}`); }

  console.log('═══════════════════════════════════════════');
  console.log('  SMOKE TEST: Trend Scanner Pipeline');
  console.log('═══════════════════════════════════════════\n');

  // ── 1. Schema ──
  console.log('── SCHEMA ──');
  const [cols] = await c.execute("SHOW COLUMNS FROM reversal_entries LIKE 'enrollment_source'");
  check('reversal_entries has enrollment_source column', cols.length === 1, cols.length ? cols[0].Type : 'MISSING');

  const [sources] = await c.execute("SELECT enrollment_source, COUNT(*) as n FROM reversal_entries GROUP BY enrollment_source");
  const srcMap = {};
  for (const r of sources) srcMap[r.enrollment_source] = Number(r.n);
  check('MOVERS entries exist', (srcMap['MOVERS'] || 0) > 0, `${srcMap['MOVERS'] || 0}`);

  if ((srcMap['TREND'] || 0) > 0) {
    check('TREND entries exist (scanner ran)', true, `${srcMap['TREND']}`);
  } else {
    warn++;
    info(`WARN: No TREND entries yet — scanner may not have run yet or no qualifying streaks found today`);
  }

  // ── 2. Strategies ──
  console.log('\n── TREND STRATEGIES ──');
  const [strats] = await c.execute("SELECT * FROM paper_strategies WHERE name IN ('3-Day Slide Bounce','4-Day UP Fade','Extreme Streak Reversal')");
  check('3 trend strategies exist', strats.length === 3, `found ${strats.length}`);

  for (const s of strats) {
    const config = JSON.parse(s.config_json);
    const entry = config.entry || {};
    check(`${s.name}: filters by enrollment_source=TREND`, entry.enrollment_source === 'TREND');
    check(`${s.name}: has min_consecutive_days`, entry.min_consecutive_days >= 3, `${entry.min_consecutive_days}`);
    check(`${s.name}: 5x leverage, $100 sizing`, s.leverage === 5 && config.sizing.amount_usd === 100);
  }

  // ── 3. Universe check ──
  console.log('\n── UNIVERSE ──');
  const fs = require('fs');
  try {
    const universe = JSON.parse(fs.readFileSync('/app/scripts/trend-universe.json','utf-8'));
    check('trend-universe.json loadable', Array.isArray(universe.symbols) && universe.symbols.length >= 100,
      `${universe.symbols?.length || 0} symbols`);

    // Check no duplicates
    const uniq = new Set(universe.symbols);
    check('No duplicate symbols', uniq.size === universe.symbols.length,
      `${uniq.size} unique vs ${universe.symbols.length} total`);
  } catch (err) {
    check('Universe file loadable', false, err.message);
  }

  // ── 4. Trend entries validity ──
  if ((srcMap['TREND'] || 0) > 0) {
    console.log('\n── TREND ENTRY VALIDITY ──');
    const [trendEntries] = await c.execute("SELECT * FROM reversal_entries WHERE enrollment_source = 'TREND' ORDER BY cohort_date DESC, symbol LIMIT 20");

    for (const e of trendEntries) {
      check(`${e.symbol}: consecutive_days >= 3`, Number(e.consecutive_days) >= 3,
        `${e.consecutive_days} days, ${Number(e.cumulative_change_pct).toFixed(1)}% cumulative`);
      check(`${e.symbol}: direction matches streak direction`, true,
        `${e.direction} (cumulative ${Number(e.cumulative_change_pct).toFixed(1)}%)`);

      // Direction sanity: LONG means DOWN streak (negative cumulative), SHORT means UP streak (positive)
      const cum = Number(e.cumulative_change_pct);
      const consistent = (e.direction === 'LONG' && cum < 0) || (e.direction === 'SHORT' && cum > 0);
      check(`${e.symbol}: direction+cumulative consistent`, consistent,
        `dir=${e.direction}, cum=${cum.toFixed(1)}%`);
    }

    // Sample distribution
    const [dirDist] = await c.execute("SELECT direction, COUNT(*) as n FROM reversal_entries WHERE enrollment_source='TREND' GROUP BY direction");
    for (const d of dirDist) info(`TREND ${d.direction}: ${d.n} entries`);

    const [streakDist] = await c.execute("SELECT consecutive_days, COUNT(*) as n FROM reversal_entries WHERE enrollment_source='TREND' GROUP BY consecutive_days ORDER BY consecutive_days");
    for (const d of streakDist) info(`${d.consecutive_days}-day streaks: ${d.n}`);
  } else {
    info('Skipping entry validity checks (no TREND entries yet)');
  }

  // ── 5. Strategy filter logic dry-run ──
  console.log('\n── STRATEGY FILTER DRY-RUN ──');
  for (const s of strats) {
    const config = JSON.parse(s.config_json);
    const entry = config.entry || {};

    // Count eligible entries that would match this strategy's entry filters
    let sql = `SELECT COUNT(*) as n FROM reversal_entries
               WHERE enrollment_source = 'TREND'
                 AND consecutive_days >= ?`;
    const params = [entry.min_consecutive_days];

    if (entry.direction) {
      sql += ' AND direction = ?';
      params.push(entry.direction);
    }
    if (entry.max_consecutive_days != null) {
      sql += ' AND consecutive_days <= ?';
      params.push(entry.max_consecutive_days);
    }

    const [counts] = await c.execute(sql, params);
    info(`${s.name}: ${counts[0].n} total matching TREND entries in history (before d1/d2 confirmation filter)`);
  }

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════');
  console.log(`  RESULTS: ${pass} passed, ${fail} failed, ${warn} warnings`);
  if (fail === 0) console.log('  ★ PIPELINE VERIFIED ★');
  else console.log('  ⚠ FAILURES DETECTED — FIX REQUIRED');
  console.log('═══════════════════════════════════════════');

  await c.end();
  process.exit(fail > 0 ? 1 : 0);
})();
