const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DB
  });

  const [cov] = await c.execute(`
    SELECT COUNT(*) as total,
      SUM(d1_close IS NOT NULL AND d2_close IS NOT NULL AND d3_close IS NOT NULL) as has_3d,
      SUM(d1_close IS NOT NULL AND d2_close IS NOT NULL AND d3_close IS NOT NULL AND d4_close IS NOT NULL) as has_4d,
      SUM(d5_close IS NOT NULL) as has_5d,
      MIN(cohort_date) as earliest, MAX(cohort_date) as latest
    FROM reversal_entries
  `);
  console.log('COVERAGE:', JSON.stringify(cov));

  const [rows] = await c.execute(`
    SELECT id, symbol, cohort_date, direction, entry_price,
           d1_close, d2_close, d3_close, d4_close, d5_close,
           d6_close, d7_close, d8_close, d9_close, d10_close,
           day_change_pct
    FROM reversal_entries
    WHERE d1_close IS NOT NULL AND d2_close IS NOT NULL
          AND d3_close IS NOT NULL AND d4_close IS NOT NULL
    ORDER BY cohort_date DESC
  `);

  let streak3_reversed = 0;
  let streak3_continued = 0;
  let streak4 = 0;
  let streak5 = 0;
  let streak3_reversed_list = [];
  let streak3_continued_list = [];
  let streak4_list = [];
  let streak5_list = [];

  for (const r of rows) {
    const ep = Number(r.entry_price);
    const d1 = Number(r.d1_close);
    const d2 = Number(r.d2_close);
    const d3 = Number(r.d3_close);
    const d4 = Number(r.d4_close);
    const d5 = r.d5_close ? Number(r.d5_close) : null;

    const ret1 = (d1 - ep) / ep;
    const ret2 = (d2 - d1) / d1;
    const ret3 = (d3 - d2) / d2;
    const ret4 = (d4 - d3) / d3;

    const dir1 = ret1 > 0 ? 'UP' : 'DOWN';
    const dir2 = ret2 > 0 ? 'UP' : 'DOWN';
    const dir3 = ret3 > 0 ? 'UP' : 'DOWN';
    const dir4 = ret4 > 0 ? 'UP' : 'DOWN';

    if (dir1 === dir2 && dir2 === dir3) {
      const trendDir = dir1;
      const d4pct = (ret4 * 100).toFixed(2);
      const cumPct = ((d3 - ep) / ep * 100).toFixed(2);
      const info = {
        sym: r.symbol,
        cohort: r.cohort_date.toISOString().split('T')[0],
        trend: trendDir,
        cumPct,
        d4pct,
        d4dir: dir4,
        origDir: r.direction
      };

      if (dir4 !== trendDir) {
        streak3_reversed++;
        streak3_reversed_list.push(info);
      } else {
        streak3_continued++;
        streak3_continued_list.push(info);
        streak4++;
        streak4_list.push(info);

        if (d5 !== null) {
          const ret5 = (d5 - d4) / d4;
          const dir5 = ret5 > 0 ? 'UP' : 'DOWN';
          if (dir5 === trendDir) {
            streak5++;
            streak5_list.push({ ...info, d5pct: (ret5 * 100).toFixed(2) });
          }
        }
      }
    }
  }

  const total3 = streak3_reversed + streak3_continued;
  console.log('\n============================================');
  console.log('  TREND PERSISTENCE ANALYSIS');
  console.log('  Data: ' + rows.length + ' entries with 4+ days of price data');
  console.log('============================================\n');

  console.log('--- 3-DAY STREAKS (same direction d1→d2→d3) ---');
  console.log('Total found:', total3);
  console.log('  Reversed on day 4:', streak3_reversed, '(' + (total3 ? (streak3_reversed / total3 * 100).toFixed(1) : 0) + '%)');
  console.log('  Continued on day 4:', streak3_continued, '(' + (total3 ? (streak3_continued / total3 * 100).toFixed(1) : 0) + '%)');
  console.log('  4-day streaks:', streak4);
  console.log('  5-day streaks:', streak5);

  // By direction
  const upR = streak3_reversed_list.filter(r => r.trend === 'UP').length;
  const upC = streak3_continued_list.filter(r => r.trend === 'UP').length;
  const dnR = streak3_reversed_list.filter(r => r.trend === 'DOWN').length;
  const dnC = streak3_continued_list.filter(r => r.trend === 'DOWN').length;

  console.log('\n--- BY TREND DIRECTION ---');
  console.log('UP streaks (3d): ' + (upR + upC) + ' total → reversed: ' + upR + ' (' + (upR + upC > 0 ? (upR / (upR + upC) * 100).toFixed(1) : 0) + '%) | continued: ' + upC);
  console.log('DOWN streaks (3d): ' + (dnR + dnC) + ' total → reversed: ' + dnR + ' (' + (dnR + dnC > 0 ? (dnR / (dnR + dnC) * 100).toFixed(1) : 0) + '%) | continued: ' + dnC);

  // By original enrollment direction (LONG=was a loser, SHORT=was a gainer)
  const longR = streak3_reversed_list.filter(r => r.origDir === 'LONG').length;
  const longC = streak3_continued_list.filter(r => r.origDir === 'LONG').length;
  const shortR = streak3_reversed_list.filter(r => r.origDir === 'SHORT').length;
  const shortC = streak3_continued_list.filter(r => r.origDir === 'SHORT').length;

  console.log('\n--- BY ENROLLMENT TYPE ---');
  console.log('LONG (was top loser): ' + (longR + longC) + ' with 3d streak → reversed d4: ' + longR + ' (' + (longR + longC > 0 ? (longR / (longR + longC) * 100).toFixed(1) : 0) + '%)');
  console.log('SHORT (was top gainer): ' + (shortR + shortC) + ' with 3d streak → reversed d4: ' + shortR + ' (' + (shortR + shortC > 0 ? (shortR / (shortR + shortC) * 100).toFixed(1) : 0) + '%)');

  console.log('\n--- REVERSED ON DAY 4 (recent examples) ---');
  console.log('Symbol     Cohort       Trend  3d-Cumul    Day4');
  streak3_reversed_list.slice(0, 20).forEach(r =>
    console.log(r.sym.padEnd(10), r.cohort, r.trend.padEnd(5), (r.cumPct + '%').padStart(8), (r.d4pct + '%').padStart(8))
  );

  console.log('\n--- CONTINUED ON DAY 4 (recent examples) ---');
  console.log('Symbol     Cohort       Trend  3d-Cumul    Day4');
  streak3_continued_list.slice(0, 20).forEach(r =>
    console.log(r.sym.padEnd(10), r.cohort, r.trend.padEnd(5), (r.cumPct + '%').padStart(8), (r.d4pct + '%').padStart(8))
  );

  if (streak5_list.length > 0) {
    console.log('\n--- 5-DAY STREAKS (all) ---');
    console.log('Symbol     Cohort       Trend  3d-Cumul    Day5');
    streak5_list.forEach(r =>
      console.log(r.sym.padEnd(10), r.cohort, r.trend.padEnd(5), (r.cumPct + '%').padStart(8), (r.d5pct + '%').padStart(8))
    );
  }

  // Average magnitude
  if (streak3_reversed_list.length) {
    const avgRevMag = streak3_reversed_list.reduce((s, r) => s + Math.abs(Number(r.d4pct)), 0) / streak3_reversed_list.length;
    const avgContMag = streak3_continued_list.length > 0 ? streak3_continued_list.reduce((s, r) => s + Math.abs(Number(r.d4pct)), 0) / streak3_continued_list.length : 0;
    console.log('\n--- DAY 4 MAGNITUDE ---');
    console.log('Avg reversal magnitude on d4:', avgRevMag.toFixed(2) + '%');
    console.log('Avg continuation magnitude on d4:', avgContMag.toFixed(2) + '%');
  }

  await c.end();
})();
