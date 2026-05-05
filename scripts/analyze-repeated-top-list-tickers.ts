import fs from "node:fs";
import path from "node:path";

import mysql from "mysql2/promise";

import {
  computePnlPath,
  detectRepeatedTopListCandidates,
  firstReversalLabel,
  tradeSideForContrarian,
  type Direction,
  type TradeSide as TradeSideType,
} from "../src/lib/market-data/research";

const POSITION_USD = 1000;
const OUTPUT_HTML = process.argv.includes("--html");
const DAY_COLS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

type Side = Direction;
type TradeSide = TradeSideType;

type EntryRow = mysql.RowDataPacket & {
  id: number;
  symbol: string;
  cohort_date: Date | string;
  day_change_pct: string | number;
  entry_price: string | number;
  enrollment_source: string | null;
  d1_close: string | number | null;
  d2_close: string | number | null;
  d3_close: string | number | null;
  d4_close: string | number | null;
  d5_close: string | number | null;
  d6_close: string | number | null;
  d7_close: string | number | null;
  d8_close: string | number | null;
  d9_close: string | number | null;
  d10_close: string | number | null;
};

type Candidate = EntryRow & {
  side: Side;
  tradeSide: TradeSide;
  runLength: number;
  sequenceDates: string[];
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

function sideFor(row: EntryRow): Side {
  return num(row.day_change_pct) > 0 ? "UP" : "DOWN";
}

function tradeSideFor(side: Side): TradeSide {
  return tradeSideForContrarian(side);
}

function rawPct(entry: number, exit: number): number {
  return ((exit - entry) / entry) * 100;
}

function usd(pct: number): number {
  return (pct / 100) * POSITION_USD;
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

function priceCell(candidate: Candidate, day: number): string {
  const raw = candidate[`d${day}_close` as keyof EntryRow] as string | number | null;
  if (raw == null) return "-";
  const entry = num(candidate.entry_price);
  const exit = num(raw);
  const [point] = computePnlPath({
    direction: candidate.side,
    entryPrice: entry,
    investmentUsd: POSITION_USD,
    exits: [{ label: `d${day}`, price: exit }],
  });
  const stockMove = rawPct(entry, exit);
  const reversalMark = point.isReversal ? " reversal" : " continuation";
  return `${exit.toFixed(2)}<br/>${colored(point.tradePnlPct, `${fmtUsd(point.tradePnlUsd)} / ${fmtPct(point.tradePnlPct)}`)}<br/><small>${fmtPct(stockMove)}${reversalMark}</small>`;
}

function h(level: 1 | 2, text: string) {
  console.log(OUTPUT_HTML ? `<h${level}>${text}</h${level}>` : `${"#".repeat(level)} ${text}`);
}

function table(headers: string[], rows: string[][]) {
  if (OUTPUT_HTML) {
    console.log(`<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>`);
    for (const row of rows) console.log(`<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`);
    console.log("</tbody></table>");
    return;
  }
  console.log(`| ${headers.join(" | ")} |`);
  console.log(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) console.log(`| ${row.join(" | ")} |`);
}

function buildCandidates(entries: EntryRow[], cohortDates: string[]): Candidate[] {
  return detectRepeatedTopListCandidates(
    entries.map((entry) => ({
      ...entry,
      date: dateStr(entry.cohort_date),
      direction: sideFor(entry),
    })),
    cohortDates,
    3,
  )
    .map(({ entry, runLength, sequenceDates }) => {
      const side = entry.direction;
      return Object.assign(entry, {
        side,
        tradeSide: tradeSideFor(side),
        runLength,
        sequenceDates,
      }) as Candidate;
    })
    .sort((a, b) => dateStr(a.cohort_date).localeCompare(dateStr(b.cohort_date)) || a.symbol.localeCompare(b.symbol));
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

  const [entries] = await pool.execute<EntryRow[]>(
    `SELECT id, symbol, cohort_date, day_change_pct, entry_price, enrollment_source,
            d1_close, d2_close, d3_close, d4_close, d5_close,
            d6_close, d7_close, d8_close, d9_close, d10_close
       FROM reversal_entries
      WHERE entry_price > 0
        AND (enrollment_source = 'MOVERS' OR enrollment_source IS NULL)
      ORDER BY cohort_date ASC, id ASC`,
  );

  const cohortDates = [...new Set(entries.map((row) => dateStr(row.cohort_date)))].sort();
  const candidates = buildCandidates(entries, cohortDates);

  if (OUTPUT_HTML) {
    console.log(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Repeated top-list tickers</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial, sans-serif; margin: 24px; color: #111827; }
  h1 { margin: 0 0 10px; font-size: 28px; }
  h2 { margin-top: 28px; font-size: 20px; }
  p { font-size: 14px; line-height: 1.45; max-width: 1100px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 28px; font-size: 12px; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 8px 9px; text-align: right; vertical-align: top; white-space: nowrap; }
  th:first-child, td:first-child, th:nth-child(2), td:nth-child(2), th:nth-child(6), td:nth-child(6) { text-align: left; }
  thead th { background: #f8fafc; font-weight: 700; position: sticky; top: 0; }
  .pos { color: #15803d; font-weight: 650; }
  .neg { color: #b91c1c; font-weight: 650; }
  .neu { color: #52525b; }
  small { color: #6b7280; font-size: 10px; }
</style></head><body>`);
  }

  h(1, "Repeated top-list tickers");
  console.log(OUTPUT_HTML
    ? `<p>These are the actual tickers that appeared in our own daily top gainers or top losers list for 3+ consecutive cohort dates. UP runs are tested as SHORT at the last run day close. DOWN runs are tested as LONG at the last run day close. Each dN cell shows exit close, trade PnL, and underlying stock move from entry.</p>`
    : "These are actual tickers that appeared in our own daily top gainers or top losers list for 3+ consecutive cohort dates.");

  const summaryRows = candidates.map((candidate) => {
    const firstReversal = firstReversalLabel(computePnlPath({
      direction: candidate.side,
      entryPrice: num(candidate.entry_price),
      investmentUsd: POSITION_USD,
      exits: DAY_COLS.map((day) => {
        const raw = candidate[`d${day}_close` as keyof EntryRow] as string | number | null;
        return { label: `d${day}`, price: raw == null ? null : num(raw) };
      }),
    }));
    return [
      textCell(dateStr(candidate.cohort_date)),
      textCell(candidate.symbol),
      candidate.side === "UP" ? "Repeated top gainers" : "Repeated top losers",
      String(candidate.runLength),
      candidate.side === "UP" ? "SHORT" : "LONG",
      OUTPUT_HTML ? candidate.sequenceDates.map(textCell).join(", ") : candidate.sequenceDates.join(", "),
      fmtPct(num(candidate.day_change_pct)),
      num(candidate.entry_price).toFixed(2),
      firstReversal ?? "none in d1-d10",
    ];
  });
  h(2, "Ticker list");
  table(["Entry date", "Ticker", "Vector", "Days in list", "Trade", "Consecutive list dates", "Last-day move", "Entry close", "First reversal close"], summaryRows);

  const detailRows = candidates.map((candidate) => [
    textCell(dateStr(candidate.cohort_date)),
    textCell(candidate.symbol),
    candidate.side,
    String(candidate.runLength),
    candidate.side === "UP" ? "SHORT" : "LONG",
    num(candidate.entry_price).toFixed(2),
    ...DAY_COLS.map((day) => priceCell(candidate, day)),
  ]);
  h(2, "Forward closes and reversal path");
  table(["Entry date", "Ticker", "Vector", "Days", "Trade", "Entry", ...DAY_COLS.map((day) => `d${day} close`)], detailRows);

  if (OUTPUT_HTML) console.log("</body></html>");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
