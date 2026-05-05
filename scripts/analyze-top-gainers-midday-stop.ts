import fs from "node:fs";
import path from "node:path";

import mysql from "mysql2/promise";

const POSITION_USD = 1000;
const TOP_N = 10;
const COHORT_DATES = ["2026-04-23", "2026-04-24"];
const STOP_PCT = -2;
const FINAL_HOLD_DAY = 5;
const OUTPUT_HTML = process.argv.includes("--html");

type Row = mysql.RowDataPacket & {
  symbol: string;
  cohort_date: Date | string;
  day_change_pct: string | number;
  entry_price: string | number;
  d1_morning: string | number | null;
  d1_midday: string | number | null;
  d1_close: string | number | null;
  d5_close: string | number | null;
};

function loadEnvLocal() {
  if (process.env.DATABASE_URL) return;
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function num(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function pct(entry: number, exit: number): number {
  return ((exit - entry) / entry) * 100;
}

function usd(pctValue: number): number {
  return (pctValue / 100) * POSITION_USD;
}

function fmtUsd(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function fmtPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function colored(value: number, text: string): string {
  if (!OUTPUT_HTML) return text;
  const cls = value > 0 ? "pos" : value < 0 ? "neg" : "neu";
  return `<span class="${cls}">${text}</span>`;
}

function textCell(value: string): string {
  if (!OUTPUT_HTML) return value;
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

function cell(pctValue: number): string {
  return colored(pctValue, `${fmtUsd(usd(pctValue))} / ${fmtPct(pctValue)}`);
}

async function main() {
  loadEnvLocal();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in env or .env.local");

  const url = new URL(process.env.DATABASE_URL);
  const pool = mysql.createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    timezone: "Z",
  });

  const allRows: Array<Row & { cohort: string }> = [];
  for (const cohortDate of COHORT_DATES) {
    const [rows] = await pool.execute<Row[]>(
      `SELECT symbol, cohort_date, day_change_pct, entry_price,
              d1_morning, d1_midday, d1_close, d5_close
         FROM reversal_entries
        WHERE cohort_date = ?
          AND day_change_pct > 0
          AND entry_price > 0
          AND (enrollment_source = 'MOVERS' OR enrollment_source IS NULL)
        ORDER BY day_change_pct DESC, id ASC
        LIMIT ${TOP_N}`,
      [cohortDate],
    );
    allRows.push(...rows.map((row) => Object.assign(row, { cohort: cohortDate })));
  }

  if (OUTPUT_HTML) {
    console.log(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Top gainers midday stop sample</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial, sans-serif; margin: 24px; color: #111827; }
  h1 { margin: 0 0 10px; font-size: 28px; }
  h2 { margin-top: 28px; font-size: 20px; }
  p { font-size: 14px; line-height: 1.45; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 24px; font-size: 13px; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 8px 10px; text-align: right; vertical-align: top; white-space: nowrap; }
  th:first-child, td:first-child, th:nth-child(2), td:nth-child(2), th:nth-child(7), td:nth-child(7) { text-align: left; }
  thead th { background: #f8fafc; font-weight: 700; position: sticky; top: 0; }
  .pos { color: #15803d; font-weight: 650; }
  .neg { color: #b91c1c; font-weight: 650; }
  .neu { color: #52525b; }
</style>
</head>
<body>
<h1>Top gainers: d1 midday -2% stop sample</h1>
<p>Dates: ${COHORT_DATES.join(", ")}; top ${TOP_N} gainers per day.</p>
<p>Trade: LONG at cohort close, $${POSITION_USD} each, 1x, no costs/slippage.</p>
<p>Rule: if d1_midday PnL <= ${STOP_PCT}%, exit at d1_midday. Otherwise hold to d${FINAL_HOLD_DAY}_close.</p>
<p>In other words: we buy the strongest gainers at the close, look at them at midday on the next trading day, cut the ones already moving against us by more than 2%, and only let the survivors continue.</p>`);
  } else {
    console.log("# Top gainers: d1 midday -2% stop sample");
    console.log(`Dates: ${COHORT_DATES.join(", ")}; top ${TOP_N} gainers per day.`);
    console.log(`Trade: LONG at cohort close, $${POSITION_USD} each, 1x, no costs/slippage.`);
    console.log(`Rule: if d1_midday PnL <= ${STOP_PCT}%, exit at d1_midday. Otherwise hold to d${FINAL_HOLD_DAY}_close.`);
    console.log("");
    console.log("In other words: we buy the strongest gainers at the close, look at them at midday on the next trading day, cut the ones already moving against us by more than 2%, and only let the survivors continue.");
    console.log("");
  }

  let baselineTotal = 0;
  let stoppedTotal = 0;
  let stoppedCount = 0;
  let evaluatedCount = 0;
  let skippedCount = 0;

  if (OUTPUT_HTML) {
    console.log(`<table><thead><tr><th>Cohort</th><th>Symbol</th><th>Trigger %</th><th>Entry</th><th>d1 morning</th><th>d1 midday check</th><th>Decision</th><th>Exit used</th><th>Stop-rule PnL</th><th>Baseline d5 PnL</th><th>Delta vs d5</th></tr></thead><tbody>`);
  } else {
    console.log("| Cohort | Symbol | Trigger % | Entry | d1 morning | d1 midday check | Decision | Exit used | Stop-rule PnL | Baseline d5 PnL | Delta vs d5 |");
    console.log("|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|");
  }

  for (const row of allRows) {
    const entry = num(row.entry_price);
    const morningPct = row.d1_morning == null ? null : pct(entry, num(row.d1_morning));
    const middayPct = row.d1_midday == null ? null : pct(entry, num(row.d1_midday));
    const d5Pct = row.d5_close == null ? null : pct(entry, num(row.d5_close));
    if (middayPct == null || d5Pct == null) {
      skippedCount++;
      continue;
    }

    const stopped = middayPct <= STOP_PCT;
    const finalPct = stopped ? middayPct : d5Pct;
    evaluatedCount++;
    baselineTotal += usd(d5Pct);
    stoppedTotal += usd(finalPct);
    if (stopped) stoppedCount++;

    const cells = [
      textCell(row.cohort),
      textCell(row.symbol),
      fmtPct(num(row.day_change_pct)),
      entry.toFixed(2),
      morningPct == null ? "-" : cell(morningPct),
      cell(middayPct),
      stopped ? "STOP at d1 midday" : "HOLD to d5 close",
      stopped ? num(row.d1_midday!).toFixed(2) : num(row.d5_close!).toFixed(2),
      cell(finalPct),
      cell(d5Pct),
      colored(usd(finalPct) - usd(d5Pct), fmtUsd(usd(finalPct) - usd(d5Pct))),
    ];
    console.log(OUTPUT_HTML ? `<tr>${cells.map((entry) => `<td>${entry}</td>`).join("")}</tr>` : `| ${cells.join(" | ")} |`);
  }
  if (OUTPUT_HTML) console.log(`</tbody></table>`);

  const deployed = evaluatedCount * POSITION_USD;
  const baselineReturn = deployed > 0 ? (baselineTotal / deployed) * 100 : 0;
  const stoppedReturn = deployed > 0 ? (stoppedTotal / deployed) * 100 : 0;
  const summaryCells = [
    String(evaluatedCount),
    String(stoppedCount),
    String(skippedCount),
    colored(baselineTotal, `${fmtUsd(baselineTotal)} / ${fmtPct(baselineReturn)}`),
    colored(stoppedTotal, `${fmtUsd(stoppedTotal)} / ${fmtPct(stoppedReturn)}`),
    colored(stoppedTotal - baselineTotal, fmtUsd(stoppedTotal - baselineTotal)),
    colored(stoppedTotal, fmtPct(stoppedReturn)),
  ];
  console.log(OUTPUT_HTML ? "<h2>Summary</h2>" : "\n## Summary");
  if (OUTPUT_HTML) {
    console.log(`<table><thead><tr><th>Evaluated trades</th><th>Stopped</th><th>Skipped incomplete</th><th>Baseline d5 PnL</th><th>Stop-rule PnL</th><th>Delta</th><th>Stop-rule return</th></tr></thead><tbody><tr>${summaryCells.map((entry) => `<td>${entry}</td>`).join("")}</tr></tbody></table></body></html>`);
  } else {
    console.log("| Evaluated trades | Stopped | Skipped incomplete | Baseline d5 PnL | Stop-rule PnL | Delta | Stop-rule return |");
    console.log("|---:|---:|---:|---:|---:|---:|---:|");
    console.log(`| ${summaryCells.join(" | ")} |`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
