const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DB
  });

  const [rows] = await c.execute(`
    SELECT id, symbol, cohort_date, direction, entry_price,
           d1_close, d2_close, d3_close, d4_close, d5_close,
           day_change_pct
    FROM reversal_entries
    WHERE d1_close IS NOT NULL AND d2_close IS NOT NULL
    ORDER BY cohort_date DESC
  `);

  // Day 1 = direction from entry_price → d1_close (continuation or reversal of the event)
  // Day 2 = direction from d1_close → d2_close
  // Question: how many change direction on day 2?

  let total = 0;
  let d1_same_d2_reversed = 0;
  let d1_same_d2_continued = 0;
  let d1_reversed_d2_back = 0;    // reversed on d1, then back to original on d2
  let d1_reversed_d2_stayed = 0;  // reversed on d1, stayed reversed on d2

  let buckets = {
    // Original event was a DROP (LONG entries = top losers)
    LONG_d1up: 0, LONG_d1down: 0,
    LONG_d1up_d2up: 0, LONG_d1up_d2down: 0,
    LONG_d1down_d2up: 0, LONG_d1down_d2down: 0,
    // Original event was a RISE (SHORT entries = top gainers)
    SHORT_d1up: 0, SHORT_d1down: 0,
    SHORT_d1up_d2up: 0, SHORT_d1up_d2down: 0,
    SHORT_d1down_d2up: 0, SHORT_d1down_d2down: 0,
  };

  let examples_reversed = [];
  let examples_continued = [];

  for (const r of rows) {
    const ep = Number(r.entry_price);
    const d1 = Number(r.d1_close);
    const d2 = Number(r.d2_close);

    const ret1 = (d1 - ep) / ep;
    const ret2 = (d2 - d1) / d1;
    const dir1 = ret1 > 0 ? 'UP' : 'DOWN';
    const dir2 = ret2 > 0 ? 'UP' : 'DOWN';
    const origDir = r.direction; // LONG = was a loser (dropped), SHORT = was a gainer (rose)

    total++;

    const key = `${origDir}_d1${dir1.toLowerCase()}`;
    buckets[key]++;
    buckets[`${key}_d2${dir2.toLowerCase()}`]++;

    const info = {
      sym: r.symbol,
      cohort: r.cohort_date.toISOString().split('T')[0],
      origDir,
      eventPct: Number(r.day_change_pct).toFixed(1),
      d1pct: (ret1 * 100).toFixed(2),
      d2pct: (ret2 * 100).toFixed(2),
      dir1, dir2
    };

    if (dir1 === dir2) {
      examples_continued.push(info);
    } else {
      examples_reversed.push(info);
    }

    if (dir1 !== dir2) {
      if (dir1 === (origDir === 'LONG' ? 'DOWN' : 'UP')) {
        d1_same_d2_reversed++;
      } else {
        d1_reversed_d2_back++;
      }
    } else {
      if (dir1 === (origDir === 'LONG' ? 'DOWN' : 'UP')) {
        // d1 continued the drop/rise, d2 also continued
        d1_same_d2_continued++;
      } else {
        d1_reversed_d2_stayed++;
      }
    }
  }

  console.log('============================================');
  console.log('  DAY 2 DIRECTION CHANGE ANALYSIS');
  console.log('  Data: ' + total + ' entries with d1+d2 close prices');
  console.log('============================================\n');

  const changed = examples_reversed.length;
  const same = examples_continued.length;
  console.log('--- OVERALL: Did direction change on day 2? ---');
  console.log('Changed direction d1→d2:', changed, '(' + (changed / total * 100).toFixed(1) + '%)');
  console.log('Same direction d1→d2:   ', same, '(' + (same / total * 100).toFixed(1) + '%)');

  console.log('\n--- TOP LOSERS (LONG entries — stock dropped on event day) ---');
  const longTotal = buckets.LONG_d1up + buckets.LONG_d1down;
  console.log('Total:', longTotal);
  console.log('  Day 1 bounced UP:        ', buckets.LONG_d1up, '(' + (buckets.LONG_d1up / longTotal * 100).toFixed(1) + '%)');
  console.log('    → Day 2 continued UP:  ', buckets.LONG_d1up_d2up, '(' + (buckets.LONG_d1up > 0 ? (buckets.LONG_d1up_d2up / buckets.LONG_d1up * 100).toFixed(1) : 0) + '%)');
  console.log('    → Day 2 reversed DOWN: ', buckets.LONG_d1up_d2down, '(' + (buckets.LONG_d1up > 0 ? (buckets.LONG_d1up_d2down / buckets.LONG_d1up * 100).toFixed(1) : 0) + '%)');
  console.log('  Day 1 kept sliding DOWN: ', buckets.LONG_d1down, '(' + (buckets.LONG_d1down / longTotal * 100).toFixed(1) + '%)');
  console.log('    → Day 2 bounced UP:    ', buckets.LONG_d1down_d2up, '(' + (buckets.LONG_d1down > 0 ? (buckets.LONG_d1down_d2up / buckets.LONG_d1down * 100).toFixed(1) : 0) + '%)');
  console.log('    → Day 2 kept DOWN:     ', buckets.LONG_d1down_d2down, '(' + (buckets.LONG_d1down > 0 ? (buckets.LONG_d1down_d2down / buckets.LONG_d1down * 100).toFixed(1) : 0) + '%)');

  console.log('\n--- TOP GAINERS (SHORT entries — stock rose on event day) ---');
  const shortTotal = buckets.SHORT_d1up + buckets.SHORT_d1down;
  console.log('Total:', shortTotal);
  console.log('  Day 1 kept rising UP:    ', buckets.SHORT_d1up, '(' + (buckets.SHORT_d1up / shortTotal * 100).toFixed(1) + '%)');
  console.log('    → Day 2 continued UP:  ', buckets.SHORT_d1up_d2up, '(' + (buckets.SHORT_d1up > 0 ? (buckets.SHORT_d1up_d2up / buckets.SHORT_d1up * 100).toFixed(1) : 0) + '%)');
  console.log('    → Day 2 reversed DOWN: ', buckets.SHORT_d1up_d2down, '(' + (buckets.SHORT_d1up > 0 ? (buckets.SHORT_d1up_d2down / buckets.SHORT_d1up * 100).toFixed(1) : 0) + '%)');
  console.log('  Day 1 pulled back DOWN:  ', buckets.SHORT_d1down, '(' + (buckets.SHORT_d1down / shortTotal * 100).toFixed(1) + '%)');
  console.log('    → Day 2 continued DOWN:', buckets.SHORT_d1down_d2down, '(' + (buckets.SHORT_d1down > 0 ? (buckets.SHORT_d1down_d2down / buckets.SHORT_d1down * 100).toFixed(1) : 0) + '%)');
  console.log('    → Day 2 bounced UP:    ', buckets.SHORT_d1down_d2up, '(' + (buckets.SHORT_d1down > 0 ? (buckets.SHORT_d1down_d2up / buckets.SHORT_d1down * 100).toFixed(1) : 0) + '%)');

  // Average magnitudes
  const revMags = examples_reversed.map(r => Math.abs(Number(r.d2pct)));
  const contMags = examples_continued.map(r => Math.abs(Number(r.d2pct)));
  const avgRev = revMags.reduce((a, b) => a + b, 0) / revMags.length;
  const avgCont = contMags.reduce((a, b) => a + b, 0) / contMags.length;

  console.log('\n--- DAY 2 MAGNITUDE ---');
  console.log('Avg move when direction changed:', avgRev.toFixed(2) + '%');
  console.log('Avg move when direction held:   ', avgCont.toFixed(2) + '%');

  // Quick summary of d1 direction overall
  const d1up = buckets.LONG_d1up + buckets.SHORT_d1up;
  const d1down = buckets.LONG_d1down + buckets.SHORT_d1down;
  console.log('\n--- DAY 1 SUMMARY (for context) ---');
  console.log('Day 1 UP:  ', d1up, '(' + (d1up / total * 100).toFixed(1) + '%)');
  console.log('Day 1 DOWN:', d1down, '(' + (d1down / total * 100).toFixed(1) + '%)');

  // Examples
  console.log('\n--- DIRECTION CHANGED ON DAY 2 (recent) ---');
  console.log('Symbol     Cohort      Type   Event     Day1      Day2');
  examples_reversed.slice(0, 20).forEach(r =>
    console.log(r.sym.padEnd(10), r.cohort, r.origDir.padEnd(5), (r.eventPct + '%').padStart(7), (r.d1pct + '%').padStart(8), (r.d2pct + '%').padStart(8))
  );

  console.log('\n--- DIRECTION HELD ON DAY 2 (recent) ---');
  console.log('Symbol     Cohort      Type   Event     Day1      Day2');
  examples_continued.slice(0, 20).forEach(r =>
    console.log(r.sym.padEnd(10), r.cohort, r.origDir.padEnd(5), (r.eventPct + '%').padStart(7), (r.d1pct + '%').padStart(8), (r.d2pct + '%').padStart(8))
  );

  await c.end();
})();
