import fs from "node:fs";
import path from "node:path";

import mysql from "mysql2/promise";

const POSITION_USD = 1000;
const HOLD_DAYS = [1, 2, 3, 4, 5] as const;
const TOP_N = 10;
const COHORT_DAYS = 10;
const TRADE_DIRECTION = (process.argv[2]?.toUpperCase() === "SHORT" ? "SHORT" : "LONG") as "LONG" | "SHORT";
const OUTPUT_HTML = process.argv.includes("--html");

type Row = mysql.RowDataPacket & {
  id: number;
  symbol: string;
  cohort_date: Date | string;
  day_change_pct: string | number;
  entry_price: string | number;
  d1_close: string | number | null;
  d2_close: string | number | null;
  d3_close: string | number | null;
  d4_close: string | number | null;
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

function dateStr(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function num(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function pnlUsd(entry: number, exit: number): number {
  return (pnlPct(entry, exit) / 100) * POSITION_USD;
}

function pnlPct(entry: number, exit: number): number {
  const rawPct = ((exit - entry) / entry) * 100;
  return TRADE_DIRECTION === "SHORT" ? -rawPct : rawPct;
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

function fmtPnlCell(usd: number, pct: number): string {
  return colored(usd, `${fmtUsd(usd)} / ${fmtPct(pct)}`);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main() {
  loadEnvLocal();
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in env or .env.local");
  }

  const url = new URL(process.env.DATABASE_URL);
  const pool = mysql.createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    timezone: "Z",
  });

  const [dateRows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT cohort_date
       FROM reversal_entries
      WHERE day_change_pct > 0
        AND entry_price > 0
        AND (enrollment_source = 'MOVERS' OR enrollment_source IS NULL)
      GROUP BY cohort_date
      ORDER BY cohort_date DESC
      LIMIT 40`,
  );

  const complete: Array<{ date: string; rows: Row[] }> = [];
  const latest: Array<{ date: string; rows: Row[] }> = [];

  for (const dateRow of dateRows) {
    const cohortDate = dateStr(dateRow.cohort_date as Date | string);
    const [rows] = await pool.execute<Row[]>(
      `SELECT id, symbol, cohort_date, day_change_pct, entry_price,
              d1_close, d2_close, d3_close, d4_close, d5_close
         FROM reversal_entries
        WHERE cohort_date = ?
          AND day_change_pct > 0
          AND entry_price > 0
          AND (enrollment_source = 'MOVERS' OR enrollment_source IS NULL)
        ORDER BY day_change_pct DESC, id ASC
        LIMIT ${TOP_N}`,
      [cohortDate],
    );
    if (latest.length < COHORT_DAYS) latest.push({ date: cohortDate, rows });
    if (rows.length === TOP_N && rows.every((row) => HOLD_DAYS.every((d) => row[`d${d}_close`] != null))) {
      complete.push({ date: cohortDate, rows });
      if (complete.length === COHORT_DAYS) break;
    }
  }

  const selected = complete;
  const allRows = selected.flatMap((group) => group.rows.map((row) => ({ date: group.date, row })));

  if (OUTPUT_HTML) {
    console.log(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Top gainers ${TRADE_DIRECTION.toLowerCase()} hold grid</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial, sans-serif; margin: 24px; color: #111827; }
  h1 { margin: 0 0 10px; font-size: 28px; }
  h2 { margin-top: 28px; font-size: 20px; }
  p, li { font-size: 14px; line-height: 1.45; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 24px; font-size: 13px; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 8px 10px; text-align: right; vertical-align: top; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th:nth-child(2), td:nth-child(2) { text-align: left; }
  thead th { background: #f8fafc; font-weight: 700; position: sticky; top: 0; }
  .pos { color: #15803d; font-weight: 650; }
  .neg { color: #b91c1c; font-weight: 650; }
  .neu { color: #52525b; }
  .meta { margin: 2px 0; }
</style>
</head>
<body>`);
  }

  if (OUTPUT_HTML) {
    console.log(`<h1>Top gainers hold grid</h1>`);
    console.log(`<p class="meta">Dataset: last ${COHORT_DAYS} fully matured MOVERS cohort dates with top ${TOP_N} gainers each.</p>`);
    console.log(`<p class="meta">Trade: ${TRADE_DIRECTION === "SHORT" ? "short/sell" : "buy"} close on cohort date, $${POSITION_USD} each, 1x leverage, no costs/slippage.</p>`);
    console.log(`<p class="meta">Cohort dates: ${selected.map((group) => textCell(group.date)).reverse().join(", ")}</p>`);
  } else {
    console.log(`# Top gainers hold grid`);
    console.log(`Dataset: last ${COHORT_DAYS} fully matured MOVERS cohort dates with top ${TOP_N} gainers each.`);
    console.log(`Trade: ${TRADE_DIRECTION === "SHORT" ? "short/sell" : "buy"} close on cohort date, $${POSITION_USD} each, 1x leverage, no costs/slippage.`);
    console.log(`Cohort dates: ${selected.map((group) => group.date).reverse().join(", ")}`);
    console.log("");
  }

  console.log(OUTPUT_HTML ? `<h2>Completeness check for latest ${COHORT_DAYS} available cohort dates</h2><ul>` : `## Completeness check for latest ${COHORT_DAYS} available cohort dates`);
  for (const group of latest) {
    const fullD5 = group.rows.filter((row) => HOLD_DAYS.every((d) => row[`d${d}_close`] != null)).length;
    console.log(OUTPUT_HTML ? `<li>${textCell(group.date)}: ${group.rows.length}/${TOP_N} top gainers, ${fullD5}/${TOP_N} have d1-d5 close</li>` : `- ${group.date}: ${group.rows.length}/${TOP_N} top gainers, ${fullD5}/${TOP_N} have d1-d5 close`);
  }
  if (OUTPUT_HTML) console.log(`</ul>`);
  console.log("");

  console.log(OUTPUT_HTML ? `<h2>Aggregate</h2>` : `## Aggregate`);
  if (OUTPUT_HTML) {
    console.log(`<table><thead><tr><th>Hold</th><th>Trades</th><th>Wins</th><th>Win rate</th><th>Total PnL</th><th>Avg/trade</th><th>Median/trade</th><th>Total return</th></tr></thead><tbody>`);
  } else {
    console.log(`| Hold | Trades | Wins | Win rate | Total PnL | Avg/trade | Median/trade | Total return on deployed |`);
    console.log(`|---:|---:|---:|---:|---:|---:|---:|---:|`);
  }
  for (const d of HOLD_DAYS) {
    const pnls = allRows.map(({ row }) => pnlUsd(num(row.entry_price), num(row[`d${d}_close`] as string | number)));
    const total = pnls.reduce((sum, value) => sum + value, 0);
    const wins = pnls.filter((value) => value > 0).length;
    const deployed = pnls.length * POSITION_USD;
    const cells = [
      `${d}d`,
      String(pnls.length),
      String(wins),
      `${((wins / pnls.length) * 100).toFixed(1)}%`,
      fmtPnlCell(total, (total / deployed) * 100),
      fmtPnlCell(total / pnls.length, (total / deployed) * 100),
      colored(median(pnls), fmtUsd(median(pnls))),
      colored(total, fmtPct((total / deployed) * 100)),
    ];
    console.log(OUTPUT_HTML ? `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>` : `| ${cells.join(" | ")} |`);
  }
  if (OUTPUT_HTML) console.log(`</tbody></table>`);
  console.log("");

  console.log(OUTPUT_HTML ? `<h2>Detail</h2>` : `## Detail`);
  if (OUTPUT_HTML) {
    console.log(`<table><thead><tr><th>Cohort</th><th>Symbol</th><th>Trigger %</th><th>Entry close</th><th>d1 PnL</th><th>d2 PnL</th><th>d3 PnL</th><th>d4 PnL</th><th>d5 PnL</th></tr></thead><tbody>`);
  } else {
    console.log(`| Cohort | Symbol | Trigger % | Entry close | d1 PnL | d2 PnL | d3 PnL | d4 PnL | d5 PnL |`);
    console.log(`|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
  }
  for (const group of selected.slice().reverse()) {
    for (const row of group.rows) {
      const entry = num(row.entry_price);
      const pnls = HOLD_DAYS.map((d) => {
        const exit = num(row[`d${d}_close`] as string | number);
        return fmtPnlCell(pnlUsd(entry, exit), pnlPct(entry, exit));
      });
      const cells = [textCell(group.date), textCell(row.symbol), fmtPct(num(row.day_change_pct)), entry.toFixed(2), ...pnls];
      console.log(OUTPUT_HTML ? `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>` : `| ${cells.join(" | ")} |`);
    }
  }
  if (OUTPUT_HTML) console.log(`</tbody></table></body></html>`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
