const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DB
  });

  const [allRows] = await c.execute(`
    SELECT id, symbol, cohort_date, direction, entry_price, day_change_pct,
           consecutive_days, cumulative_change_pct,
           d1_morning, d1_midday, d1_close,
           d2_morning, d2_midday, d2_close,
           d3_morning, d3_midday, d3_close,
           d4_morning, d4_midday, d4_close,
           d5_morning, d5_midday, d5_close,
           d6_morning, d6_midday, d6_close,
           d7_morning, d7_midday, d7_close,
           d8_morning, d8_midday, d8_close,
           d9_morning, d9_midday, d9_close,
           d10_morning, d10_midday, d10_close
    FROM reversal_entries
    ORDER BY cohort_date DESC
  `);

  // Helper: get close price for day N
  function dClose(r, n) {
    const v = r[`d${n}_close`];
    return v != null ? Number(v) : null;
  }
  function dMorning(r, n) {
    const v = r[`d${n}_morning`];
    return v != null ? Number(v) : null;
  }
  function dMidday(r, n) {
    const v = r[`d${n}_midday`];
    return v != null ? Number(v) : null;
  }

  // Helper: return pct change
  function pct(from, to) {
    if (!from || !to || from === 0) return null;
    return ((to - from) / from) * 100;
  }

  // Helper: stat summary
  function stat(label, hits, total, extras) {
    if (total === 0) return null;
    const rate = (hits / total * 100).toFixed(1);
    const flag = hits / total >= 0.70 ? ' ★★★' : hits / total >= 0.60 ? ' ★★' : hits / total >= 0.55 ? ' ★' : '';
    const result = { label, hits, total, rate: rate + '%' + flag };
    if (extras) Object.assign(result, extras);
    return result;
  }

  const OUT = [];
  function section(title) { OUT.push('\n' + '='.repeat(70)); OUT.push('  ' + title); OUT.push('='.repeat(70)); }
  function subsection(title) { OUT.push('\n--- ' + title + ' ---'); }
  function row(text) { OUT.push(text); }
  function table(headers, rows) {
    if (rows.length === 0) { OUT.push('  (no data)'); return; }
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length)));
    const hline = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
    OUT.push(hline);
    OUT.push(widths.map(w => '-'.repeat(w)).join('  '));
    for (const r of rows) {
      OUT.push(r.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  '));
    }
  }

  const entries = allRows.map(r => ({
    ...r,
    ep: Number(r.entry_price),
    changePct: Number(r.day_change_pct),
    dir: r.direction, // LONG = was loser, SHORT = was gainer
  }));

  // ════════════════════════════════════════════════════════════════════════
  // CATEGORY 1: Day-by-Day Reversal Timing
  // ════════════════════════════════════════════════════════════════════════
  section('CATEGORY 1: DAY-BY-DAY REVERSAL FROM ENTRY PRICE');
  subsection('Q1-Q2: What % are UP/DOWN from entry by day N?');

  const cat1headers = ['Day', 'Losers UP', 'Losers N', 'Losers %', '', 'Gainers DOWN', 'Gainers N', 'Gainers %'];
  const cat1rows = [];

  for (let d = 1; d <= 10; d++) {
    const losers = entries.filter(e => e.dir === 'LONG' && dClose(e, d) != null);
    const losersUp = losers.filter(e => dClose(e, d) > e.ep);
    const gainers = entries.filter(e => e.dir === 'SHORT' && dClose(e, d) != null);
    const gainersDown = gainers.filter(e => dClose(e, d) < e.ep);

    const lPct = losers.length ? (losersUp.length / losers.length * 100).toFixed(1) : '-';
    const gPct = gainers.length ? (gainersDown.length / gainers.length * 100).toFixed(1) : '-';
    const lFlag = losers.length && losersUp.length / losers.length >= 0.70 ? ' ★★★' : losers.length && losersUp.length / losers.length >= 0.60 ? ' ★★' : '';
    const gFlag = gainers.length && gainersDown.length / gainers.length >= 0.70 ? ' ★★★' : gainers.length && gainersDown.length / gainers.length >= 0.60 ? ' ★★' : '';

    cat1rows.push(['d' + d, losersUp.length, losers.length, lPct + '%' + lFlag, '|', gainersDown.length, gainers.length, gPct + '%' + gFlag]);
  }
  table(cat1headers, cat1rows);

  subsection('Q3: Day-over-day direction change rate');
  const cat1bHeaders = ['Transition', 'Changed', 'Total', 'Change %', '', 'Avg reversal mag', 'Avg continuation mag'];
  const cat1bRows = [];

  for (let d = 1; d <= 9; d++) {
    const withBoth = entries.filter(e => dClose(e, d) != null && dClose(e, d + 1) != null && (d === 1 ? true : dClose(e, d - 1) != null));
    let changed = 0, total = 0, revMags = [], contMags = [];
    for (const e of withBoth) {
      const prev = d === 1 ? e.ep : dClose(e, d - 1);
      const curr = dClose(e, d);
      const next = dClose(e, d + 1);
      const dir1 = curr > prev ? 'UP' : 'DOWN';
      const dir2 = next > curr ? 'UP' : 'DOWN';
      total++;
      const mag = Math.abs(pct(curr, next));
      if (dir1 !== dir2) { changed++; revMags.push(mag); }
      else { contMags.push(mag); }
    }
    const avgRev = revMags.length ? (revMags.reduce((a, b) => a + b, 0) / revMags.length).toFixed(2) + '%' : '-';
    const avgCont = contMags.length ? (contMags.reduce((a, b) => a + b, 0) / contMags.length).toFixed(2) + '%' : '-';
    const flag = total && changed / total >= 0.60 ? ' ★★' : '';
    cat1bRows.push(['d' + d + '→d' + (d + 1), changed, total, (total ? (changed / total * 100).toFixed(1) : '-') + '%' + flag, '|', avgRev, avgCont]);
  }
  table(cat1bHeaders, cat1bRows);

  // ════════════════════════════════════════════════════════════════════════
  // CATEGORY 2: Event Magnitude as Predictor
  // ════════════════════════════════════════════════════════════════════════
  section('CATEGORY 2: EVENT MAGNITUDE AS PREDICTOR');

  const magBuckets = [
    { label: '3-5%', min: 3, max: 5 },
    { label: '5-8%', min: 5, max: 8 },
    { label: '8-12%', min: 8, max: 12 },
    { label: '12-20%', min: 12, max: 20 },
    { label: '20%+', min: 20, max: 999 },
  ];

  for (const type of ['LONG', 'SHORT']) {
    const typeLabel = type === 'LONG' ? 'TOP LOSERS (dropped X%)' : 'TOP GAINERS (rose X%)';
    subsection('Q4-Q6: ' + typeLabel + ' — reversal rate by magnitude bucket');

    const magHeaders = ['Magnitude', 'N', 'd1 rev%', 'd2 rev%', 'd3 rev%', 'd4 rev%', 'd5 rev%', 'd7 rev%', 'd10 rev%'];
    const magRows = [];

    for (const bucket of magBuckets) {
      const filtered = entries.filter(e => {
        const absPct = Math.abs(e.changePct);
        return e.dir === type && absPct >= bucket.min && absPct < bucket.max;
      });

      const cols = [bucket.label, filtered.length];
      for (const d of [1, 2, 3, 4, 5, 7, 10]) {
        const withData = filtered.filter(e => dClose(e, d) != null);
        const reversed = withData.filter(e => {
          if (type === 'LONG') return dClose(e, d) > e.ep; // loser bounced up
          return dClose(e, d) < e.ep; // gainer pulled back down
        });
        const rate = withData.length ? (reversed.length / withData.length * 100).toFixed(1) : '-';
        const flag = withData.length >= 5 && reversed.length / withData.length >= 0.70 ? '★★★' : withData.length >= 5 && reversed.length / withData.length >= 0.60 ? '★★' : '';
        cols.push(rate + '%' + flag);
      }
      magRows.push(cols);
    }
    table(magHeaders, magRows);
  }

  // ════════════════════════════════════════════════════════════════════════
  // CATEGORY 3: Day 1 Pattern as Signal
  // ════════════════════════════════════════════════════════════════════════
  section('CATEGORY 3: DAY 1 PATTERN AS PREDICTOR');

  for (const type of ['LONG', 'SHORT']) {
    const typeLabel = type === 'LONG' ? 'TOP LOSERS' : 'TOP GAINERS';
    subsection('Q7-Q10: ' + typeLabel + ' — day 1 outcome predicts future');

    const withD1 = entries.filter(e => e.dir === type && dClose(e, 1) != null);
    const d1Bounced = withD1.filter(e => type === 'LONG' ? dClose(e, 1) > e.ep : dClose(e, 1) < e.ep);
    const d1Continued = withD1.filter(e => type === 'LONG' ? dClose(e, 1) <= e.ep : dClose(e, 1) >= e.ep);

    row('Day 1 reversed (favorable): ' + d1Bounced.length + '/' + withD1.length + ' (' + (withD1.length ? (d1Bounced.length / withD1.length * 100).toFixed(1) : '-') + '%)');
    row('Day 1 continued (unfavorable): ' + d1Continued.length + '/' + withD1.length + ' (' + (withD1.length ? (d1Continued.length / withD1.length * 100).toFixed(1) : '-') + '%)');

    const scenHeaders = ['Scenario', 'N', 'd2 fav%', 'd3 fav%', 'd4 fav%', 'd5 fav%'];
    const scenRows = [];

    for (const scenario of [
      { label: 'D1 reversed → still fav by dN?', set: d1Bounced },
      { label: 'D1 continued → reverses by dN?', set: d1Continued },
    ]) {
      const cols = [scenario.label, scenario.set.length];
      for (const d of [2, 3, 4, 5]) {
        const withData = scenario.set.filter(e => dClose(e, d) != null);
        const favorable = withData.filter(e => type === 'LONG' ? dClose(e, d) > e.ep : dClose(e, d) < e.ep);
        const rate = withData.length ? (favorable.length / withData.length * 100).toFixed(1) : '-';
        const flag = withData.length >= 5 && favorable.length / withData.length >= 0.70 ? '★★★' : withData.length >= 5 && favorable.length / withData.length >= 0.60 ? '★★' : '';
        cols.push(rate + '%' + flag);
      }
      scenRows.push(cols);
    }
    table(scenHeaders, scenRows);

    // Day-over-day after d1 continued
    subsection(typeLabel + ': If d1 unfavorable, day-over-day bounce rate');
    const dodHeaders = ['From→To', 'Bounced', 'Total', 'Bounce %'];
    const dodRows = [];
    for (let d = 1; d <= 5; d++) {
      const prev = d;
      const next = d + 1;
      const withBoth = d1Continued.filter(e => dClose(e, prev) != null && dClose(e, next) != null);
      const bounced = withBoth.filter(e => {
        const dir = dClose(e, next) > dClose(e, prev) ? 'UP' : 'DOWN';
        return type === 'LONG' ? dir === 'UP' : dir === 'DOWN';
      });
      const rate = withBoth.length ? (bounced.length / withBoth.length * 100).toFixed(1) : '-';
      const flag = withBoth.length >= 5 && bounced.length / withBoth.length >= 0.70 ? '★★★' : withBoth.length >= 5 && bounced.length / withBoth.length >= 0.60 ? '★★' : '';
      dodRows.push(['d' + prev + '→d' + next, bounced.length, withBoth.length, rate + '%' + flag]);
    }
    table(dodHeaders, dodRows);
  }

  // ════════════════════════════════════════════════════════════════════════
  // CATEGORY 4: Consecutive Day Patterns
  // ════════════════════════════════════════════════════════════════════════
  section('CATEGORY 4: CONSECUTIVE DAY STREAKS → NEXT DAY REVERSAL');

  for (const streakDir of ['UP', 'DOWN']) {
    subsection('After N consecutive ' + streakDir + ' days → reversal probability');

    const consHeaders = ['Streak', 'Reversed', 'Total', 'Reversal %', 'Avg reversal mag', 'Avg loss if no rev'];
    const consRows = [];

    for (let streak = 2; streak <= 5; streak++) {
      let reversed = 0, total = 0, revMags = [], lossMags = [];

      for (const e of entries) {
        // Need close prices for days 1..streak+1
        let hasAll = true;
        for (let d = 1; d <= streak + 1; d++) {
          if (dClose(e, d) == null) { hasAll = false; break; }
        }
        if (!hasAll) continue;

        // Check streak: all days 1..streak same direction
        let allSame = true;
        for (let d = 1; d <= streak; d++) {
          const prev = d === 1 ? e.ep : dClose(e, d - 1);
          const curr = dClose(e, d);
          const dir = curr > prev ? 'UP' : 'DOWN';
          if (dir !== streakDir) { allSame = false; break; }
        }
        if (!allSame) continue;

        total++;
        const lastClose = dClose(e, streak);
        const nextClose = dClose(e, streak + 1);
        const nextDir = nextClose > lastClose ? 'UP' : 'DOWN';
        const mag = Math.abs(pct(lastClose, nextClose));

        if (nextDir !== streakDir) {
          reversed++;
          revMags.push(mag);
        } else {
          lossMags.push(mag);
        }
      }

      const rate = total ? (reversed / total * 100).toFixed(1) : '-';
      const flag = total >= 5 && reversed / total >= 0.70 ? ' ★★★' : total >= 5 && reversed / total >= 0.60 ? ' ★★' : '';
      const avgRev = revMags.length ? (revMags.reduce((a, b) => a + b, 0) / revMags.length).toFixed(2) + '%' : '-';
      const avgLoss = lossMags.length ? (lossMags.reduce((a, b) => a + b, 0) / lossMags.length).toFixed(2) + '%' : '-';
      consRows.push([streak + ' ' + streakDir, reversed, total, rate + '%' + flag, avgRev, avgLoss]);
    }
    table(consHeaders, consRows);
  }

  // Also by type (LONG/SHORT)
  for (const type of ['LONG', 'SHORT']) {
    for (const streakDir of ['UP', 'DOWN']) {
      subsection(type + ' entries: After N consecutive ' + streakDir + ' days');
      const rows2 = [];
      for (let streak = 2; streak <= 4; streak++) {
        let reversed = 0, total = 0;
        for (const e of entries.filter(x => x.dir === type)) {
          let hasAll = true;
          for (let d = 1; d <= streak + 1; d++) { if (dClose(e, d) == null) { hasAll = false; break; } }
          if (!hasAll) continue;
          let allSame = true;
          for (let d = 1; d <= streak; d++) {
            const prev = d === 1 ? e.ep : dClose(e, d - 1);
            const dir = dClose(e, d) > prev ? 'UP' : 'DOWN';
            if (dir !== streakDir) { allSame = false; break; }
          }
          if (!allSame) continue;
          total++;
          const nextDir = dClose(e, streak + 1) > dClose(e, streak) ? 'UP' : 'DOWN';
          if (nextDir !== streakDir) reversed++;
        }
        const rate = total ? (reversed / total * 100).toFixed(1) : '-';
        const flag = total >= 5 && reversed / total >= 0.70 ? ' ★★★' : total >= 5 && reversed / total >= 0.60 ? ' ★★' : '';
        rows2.push([streak + ' ' + streakDir, reversed, total, rate + '%' + flag]);
      }
      table(['Streak', 'Reversed', 'Total', 'Reversal %'], rows2);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // CATEGORY 5: Entry/Exit Optimization Matrix
  // ════════════════════════════════════════════════════════════════════════
  section('CATEGORY 5: ENTRY/EXIT MATRIX — WIN RATE & AVG RETURN');

  for (const type of ['LONG', 'SHORT']) {
    subsection('Q14-Q15: ' + type + ' — buy at entry close, sell at dN close');

    const matHeaders = ['Exit Day', 'Wins', 'Total', 'Win %', 'Avg Win', 'Avg Loss', 'Avg Return', 'Expectancy'];
    const matRows = [];

    for (let exitDay = 1; exitDay <= 10; exitDay++) {
      const withData = entries.filter(e => e.dir === type && dClose(e, exitDay) != null);
      let wins = 0, losses = 0, winSum = 0, lossSum = 0, totalReturn = 0;

      for (const e of withData) {
        const ret = pct(e.ep, dClose(e, exitDay));
        // For LONG entries (losers), we BUY expecting bounce → profit if UP
        // For SHORT entries (gainers), we SHORT expecting drop → profit if DOWN
        const profit = type === 'LONG' ? ret : -ret;

        totalReturn += profit;
        if (profit > 0) { wins++; winSum += profit; }
        else { losses++; lossSum += Math.abs(profit); }
      }

      const winRate = withData.length ? (wins / withData.length * 100).toFixed(1) : '-';
      const avgWin = wins ? (winSum / wins).toFixed(2) + '%' : '-';
      const avgLoss = losses ? (lossSum / losses).toFixed(2) + '%' : '-';
      const avgRet = withData.length ? (totalReturn / withData.length).toFixed(2) + '%' : '-';
      const expectancy = withData.length ? ((wins / withData.length) * (wins ? winSum / wins : 0) - (losses / withData.length) * (losses ? lossSum / losses : 0)).toFixed(2) + '%' : '-';
      const flag = withData.length >= 10 && wins / withData.length >= 0.70 ? ' ★★★' : withData.length >= 10 && wins / withData.length >= 0.60 ? ' ★★' : '';

      matRows.push(['d' + exitDay, wins, withData.length, winRate + '%' + flag, avgWin, avgLoss, avgRet, expectancy]);
    }
    table(matHeaders, matRows);
  }

  // Morning vs close entry
  subsection('Q16: Morning vs Close entry — does intraday timing matter?');
  for (const type of ['LONG', 'SHORT']) {
    const timingRows = [];
    for (let exitDay = 2; exitDay <= 5; exitDay++) {
      // Buy at d1 morning, sell at dN close
      const mornEntry = entries.filter(e => e.dir === type && dMorning(e, 1) != null && dClose(e, exitDay) != null);
      let mWins = 0;
      for (const e of mornEntry) {
        const profit = type === 'LONG' ? pct(dMorning(e, 1), dClose(e, exitDay)) : -pct(dMorning(e, 1), dClose(e, exitDay));
        if (profit > 0) mWins++;
      }
      // Buy at d1 close, sell at dN close
      const closeEntry = entries.filter(e => e.dir === type && dClose(e, 1) != null && dClose(e, exitDay) != null);
      let cWins = 0;
      for (const e of closeEntry) {
        const profit = type === 'LONG' ? pct(dClose(e, 1), dClose(e, exitDay)) : -pct(dClose(e, 1), dClose(e, exitDay));
        if (profit > 0) cWins++;
      }

      const mRate = mornEntry.length ? (mWins / mornEntry.length * 100).toFixed(1) : '-';
      const cRate = closeEntry.length ? (cWins / closeEntry.length * 100).toFixed(1) : '-';
      const mFlag = mornEntry.length >= 10 && mWins / mornEntry.length >= 0.60 ? '★★' : '';
      const cFlag = closeEntry.length >= 10 && cWins / closeEntry.length >= 0.60 ? '★★' : '';
      timingRows.push([type, 'exit d' + exitDay, 'd1 morn: ' + mRate + '%' + mFlag + ' (n=' + mornEntry.length + ')', 'd1 close: ' + cRate + '%' + cFlag + ' (n=' + closeEntry.length + ')']);
    }
    table(['Type', 'Exit', 'Morning Entry', 'Close Entry'], timingRows);
  }

  // ════════════════════════════════════════════════════════════════════════
  // CATEGORY 6: COMBINED FILTER STACKING — HUNTING FOR >70%
  // ════════════════════════════════════════════════════════════════════════
  section('CATEGORY 6: COMBINED FILTERS — HUNTING FOR >70% EDGES');

  const edgeResults = [];

  // Test every combination of: type × magnitude × d1 pattern × exit day
  const magFilters = [
    { label: 'any', test: () => true },
    { label: '>5%', test: (e) => Math.abs(e.changePct) > 5 },
    { label: '>8%', test: (e) => Math.abs(e.changePct) > 8 },
    { label: '>10%', test: (e) => Math.abs(e.changePct) > 10 },
    { label: '>15%', test: (e) => Math.abs(e.changePct) > 15 },
    { label: '3-7%', test: (e) => Math.abs(e.changePct) >= 3 && Math.abs(e.changePct) < 7 },
    { label: '7-15%', test: (e) => Math.abs(e.changePct) >= 7 && Math.abs(e.changePct) < 15 },
  ];

  const d1Filters = [
    { label: 'any_d1', test: () => true, needsD1: false },
    { label: 'd1_favorable', test: (e, type) => {
      if (dClose(e, 1) == null) return false;
      return type === 'LONG' ? dClose(e, 1) > e.ep : dClose(e, 1) < e.ep;
    }, needsD1: true },
    { label: 'd1_unfavorable', test: (e, type) => {
      if (dClose(e, 1) == null) return false;
      return type === 'LONG' ? dClose(e, 1) <= e.ep : dClose(e, 1) >= e.ep;
    }, needsD1: true },
    { label: 'd1_fav_>2%', test: (e, type) => {
      if (dClose(e, 1) == null) return false;
      const ret = pct(e.ep, dClose(e, 1));
      return type === 'LONG' ? ret > 2 : ret < -2;
    }, needsD1: true },
    { label: 'd1_unfav_>2%', test: (e, type) => {
      if (dClose(e, 1) == null) return false;
      const ret = pct(e.ep, dClose(e, 1));
      return type === 'LONG' ? ret < -2 : ret > 2;
    }, needsD1: true },
  ];

  const d2Filters = [
    { label: 'any_d2', test: () => true, needsD2: false },
    { label: 'd2_favorable', test: (e, type) => {
      if (dClose(e, 1) == null || dClose(e, 2) == null) return false;
      const dir = dClose(e, 2) > dClose(e, 1) ? 'UP' : 'DOWN';
      return type === 'LONG' ? dir === 'UP' : dir === 'DOWN';
    }, needsD2: true },
    { label: 'd2_unfavorable', test: (e, type) => {
      if (dClose(e, 1) == null || dClose(e, 2) == null) return false;
      const dir = dClose(e, 2) > dClose(e, 1) ? 'UP' : 'DOWN';
      return type === 'LONG' ? dir === 'DOWN' : dir === 'UP';
    }, needsD2: true },
  ];

  // Entry points: event close, d1 morning, d1 close, d2 morning, d2 close
  const entryPoints = [
    { label: 'entry@event', price: (e) => e.ep },
    { label: 'entry@d1morn', price: (e) => dMorning(e, 1) },
    { label: 'entry@d1close', price: (e) => dClose(e, 1) },
    { label: 'entry@d2close', price: (e) => dClose(e, 2) },
  ];

  for (const type of ['LONG', 'SHORT']) {
    for (const mag of magFilters) {
      for (const d1f of d1Filters) {
        for (const d2f of d2Filters) {
          for (const entry of entryPoints) {
            for (let exitDay = 1; exitDay <= 10; exitDay++) {
              // Skip impossible combos
              if (entry.label === 'entry@d1close' && exitDay <= 1) continue;
              if (entry.label === 'entry@d2close' && exitDay <= 2) continue;
              if (d1f.needsD1 && entry.label === 'entry@event' && exitDay < 1) continue;

              const pool = entries.filter(e => {
                if (e.dir !== type) return false;
                if (!mag.test(e)) return false;
                if (d1f.needsD1 && !d1f.test(e, type)) return false;
                if (d2f.needsD2 && !d2f.test(e, type)) return false;
                const ep = entry.price(e);
                if (ep == null) return false;
                if (dClose(e, exitDay) == null) return false;
                return true;
              });

              if (pool.length < 8) continue; // Need minimum sample size

              let wins = 0, totalRet = 0, winRets = [], lossRets = [];
              for (const e of pool) {
                const ep = entry.price(e);
                const exitP = dClose(e, exitDay);
                const ret = pct(ep, exitP);
                const profit = type === 'LONG' ? ret : -ret;
                totalRet += profit;
                if (profit > 0) { wins++; winRets.push(profit); }
                else { lossRets.push(profit); }
              }

              const winRate = wins / pool.length;
              const avgRet = totalRet / pool.length;
              const avgWin = winRets.length ? winRets.reduce((a, b) => a + b, 0) / winRets.length : 0;
              const avgLoss = lossRets.length ? Math.abs(lossRets.reduce((a, b) => a + b, 0) / lossRets.length) : 0;
              const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

              edgeResults.push({
                type, mag: mag.label, d1: d1f.label, d2: d2f.label,
                entry: entry.label, exitDay: 'd' + exitDay,
                n: pool.length, winRate, avgRet, avgWin, avgLoss, expectancy
              });
            }
          }
        }
      }
    }
  }

  // Sort by win rate, show top results
  edgeResults.sort((a, b) => b.winRate - a.winRate);

  subsection('TOP 50 HIGHEST WIN-RATE SCENARIOS (min 8 samples)');
  const topHeaders = ['#', 'Type', 'Magnitude', 'D1 Filter', 'D2 Filter', 'Entry', 'Exit', 'N', 'Win%', 'AvgRet', 'AvgWin', 'AvgLoss', 'Expect'];
  const topRows = [];

  for (let i = 0; i < Math.min(50, edgeResults.length); i++) {
    const r = edgeResults[i];
    if (r.winRate < 0.55) break;
    const flag = r.winRate >= 0.70 ? '★★★' : r.winRate >= 0.60 ? '★★' : '★';
    topRows.push([
      i + 1, r.type, r.mag, r.d1, r.d2, r.entry, r.exitDay, r.n,
      (r.winRate * 100).toFixed(1) + '%' + flag,
      r.avgRet.toFixed(2) + '%',
      r.avgWin.toFixed(2) + '%',
      r.avgLoss.toFixed(2) + '%',
      r.expectancy.toFixed(2) + '%',
    ]);
  }
  table(topHeaders, topRows);

  // Sort by expectancy (risk-adjusted returns)
  edgeResults.sort((a, b) => b.expectancy - a.expectancy);
  subsection('TOP 30 BY EXPECTANCY (best risk-adjusted)');
  const expRows = [];
  for (let i = 0; i < Math.min(30, edgeResults.length); i++) {
    const r = edgeResults[i];
    if (r.expectancy <= 0) break;
    expRows.push([
      i + 1, r.type, r.mag, r.d1, r.d2, r.entry, r.exitDay, r.n,
      (r.winRate * 100).toFixed(1) + '%',
      r.avgRet.toFixed(2) + '%',
      r.avgWin.toFixed(2) + '%',
      r.avgLoss.toFixed(2) + '%',
      r.expectancy.toFixed(2) + '%',
    ]);
  }
  table(topHeaders, expRows);

  // ════════════════════════════════════════════════════════════════════════
  // CATEGORY 7: Risk Profile for Top Scenarios
  // ════════════════════════════════════════════════════════════════════════
  section('CATEGORY 7: RISK PROFILE — MAX DRAWDOWN BEFORE WIN');

  // For the top 10 win-rate scenarios, compute max adverse excursion
  edgeResults.sort((a, b) => b.winRate - a.winRate);
  const topEdges = edgeResults.filter(r => r.winRate >= 0.60 && r.n >= 8).slice(0, 10);

  for (const edge of topEdges) {
    subsection(edge.type + ' | ' + edge.mag + ' | ' + edge.d1 + ' | ' + edge.d2 + ' | ' + edge.entry + ' → ' + edge.exitDay + ' (n=' + edge.n + ', win=' + (edge.winRate * 100).toFixed(1) + '%)');

    const pool = entries.filter(e => {
      if (e.dir !== edge.type) return false;
      const magF = magFilters.find(f => f.label === edge.mag);
      const d1F = d1Filters.find(f => f.label === edge.d1);
      const d2F = d2Filters.find(f => f.label === edge.d2);
      const entryF = entryPoints.find(f => f.label === edge.entry);
      if (!magF.test(e)) return false;
      if (d1F.needsD1 && !d1F.test(e, edge.type)) return false;
      if (d2F.needsD2 && !d2F.test(e, edge.type)) return false;
      const exitDayNum = Number(edge.exitDay.replace('d', ''));
      if (entryF.price(e) == null || dClose(e, exitDayNum) == null) return false;
      return true;
    });

    let maxDrawdowns = [];
    let maxRunups = [];

    for (const e of pool) {
      const entryF = entryPoints.find(f => f.label === edge.entry);
      const ep = entryF.price(e);
      const exitDayNum = Number(edge.exitDay.replace('d', ''));

      // Track all intermediate prices
      let minSeen = ep, maxSeen = ep;
      for (let d = 1; d <= exitDayNum; d++) {
        for (const fn of [dMorning, dMidday, dClose]) {
          const p = fn(e, d);
          if (p != null) {
            if (p < minSeen) minSeen = p;
            if (p > maxSeen) maxSeen = p;
          }
        }
      }
      const drawdown = pct(ep, minSeen); // negative = drawdown
      const runup = pct(ep, maxSeen);
      const adverseExcursion = edge.type === 'LONG' ? drawdown : -runup;
      const favorableExcursion = edge.type === 'LONG' ? runup : -drawdown;

      maxDrawdowns.push(adverseExcursion);
      maxRunups.push(favorableExcursion);
    }

    maxDrawdowns.sort((a, b) => a - b);
    maxRunups.sort((a, b) => b - a);

    const avgDD = maxDrawdowns.reduce((a, b) => a + b, 0) / maxDrawdowns.length;
    const worstDD = maxDrawdowns[0];
    const p10DD = maxDrawdowns[Math.floor(maxDrawdowns.length * 0.1)];
    const medDD = maxDrawdowns[Math.floor(maxDrawdowns.length * 0.5)];
    const avgRU = maxRunups.reduce((a, b) => a + b, 0) / maxRunups.length;
    const bestRU = maxRunups[0];

    row('Max Adverse Excursion (drawdown before exit):');
    row('  Worst: ' + worstDD.toFixed(2) + '%  |  P10: ' + p10DD.toFixed(2) + '%  |  Median: ' + medDD.toFixed(2) + '%  |  Avg: ' + avgDD.toFixed(2) + '%');
    row('Max Favorable Excursion (best point before exit):');
    row('  Best: ' + bestRU.toFixed(2) + '%  |  Avg: ' + avgRU.toFixed(2) + '%');
    row('Suggested stop-loss (below P10 adverse): ' + (p10DD - 1).toFixed(1) + '%');
  }

  // ════════════════════════════════════════════════════════════════════════
  // FINAL SUMMARY: ALL >70% SCENARIOS
  // ════════════════════════════════════════════════════════════════════════
  section('FINAL SUMMARY: ALL SCENARIOS WITH >70% WIN RATE');

  const over70 = edgeResults.filter(r => r.winRate >= 0.70 && r.n >= 8);
  over70.sort((a, b) => b.n - a.n); // Sort by sample size (more reliable first)

  if (over70.length === 0) {
    row('No scenarios found with ≥70% win rate and ≥8 samples.');
    row('Showing best scenarios with ≥65%:');
    const over65 = edgeResults.filter(r => r.winRate >= 0.65 && r.n >= 8);
    over65.sort((a, b) => b.n - a.n);
    const rows65 = over65.slice(0, 20).map((r, i) => [
      i + 1, r.type, r.mag, r.d1, r.d2, r.entry, r.exitDay, r.n,
      (r.winRate * 100).toFixed(1) + '%',
      r.avgRet.toFixed(2) + '%',
      r.expectancy.toFixed(2) + '%',
    ]);
    table(['#', 'Type', 'Mag', 'D1', 'D2', 'Entry', 'Exit', 'N', 'Win%', 'AvgRet', 'Expect'], rows65);
  } else {
    const rows70 = over70.map((r, i) => [
      i + 1, r.type, r.mag, r.d1, r.d2, r.entry, r.exitDay, r.n,
      (r.winRate * 100).toFixed(1) + '% ★★★',
      r.avgRet.toFixed(2) + '%',
      r.avgWin.toFixed(2) + '%',
      r.avgLoss.toFixed(2) + '%',
      r.expectancy.toFixed(2) + '%',
    ]);
    table(['#', 'Type', 'Mag', 'D1', 'D2', 'Entry', 'Exit', 'N', 'Win%', 'AvgRet', 'AvgWin', 'AvgLoss', 'Expect'], rows70);
  }

  // Data summary
  section('DATA SUMMARY');
  row('Total entries analyzed: ' + entries.length);
  row('Date range: ' + entries[entries.length - 1]?.cohort_date?.toISOString().split('T')[0] + ' to ' + entries[0]?.cohort_date?.toISOString().split('T')[0]);
  row('LONG (top losers): ' + entries.filter(e => e.dir === 'LONG').length);
  row('SHORT (top gainers): ' + entries.filter(e => e.dir === 'SHORT').length);
  row('Entries with d1-d4 close: ' + entries.filter(e => dClose(e, 4) != null).length);
  row('Entries with d1-d10 close: ' + entries.filter(e => dClose(e, 10) != null).length);
  row('Total scenarios tested: ' + edgeResults.length);
  row('Scenarios with ≥70% win rate (n≥8): ' + edgeResults.filter(r => r.winRate >= 0.70 && r.n >= 8).length);
  row('Scenarios with ≥65% win rate (n≥8): ' + edgeResults.filter(r => r.winRate >= 0.65 && r.n >= 8).length);
  row('Scenarios with ≥60% win rate (n≥8): ' + edgeResults.filter(r => r.winRate >= 0.60 && r.n >= 8).length);

  // Print everything
  console.log(OUT.join('\n'));

  await c.end();
})();
