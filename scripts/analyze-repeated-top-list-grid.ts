import fs from "node:fs";
import path from "node:path";

import mysql from "mysql2/promise";

import {
  computePnlPath,
  detectRepeatedTopListCandidates,
  tradeSideForContrarian,
  type Direction,
} from "@/lib/market-data/research";

const POSITION_USD = 1000;
const STREAK_BUCKETS = [3, 4, 5] as const;
const EXIT_BARS = ["morning", "midday", "close"] as const;
const OUTPUT_HTML = process.argv.includes("--html");

type Bucket = 3 | 4 | 5;

type EntryRow = mysql.RowDataPacket & {
  id: number;
  symbol: string;
  cohort_date: Date | string;
  day_change_pct: string | number;
  entry_price: string | number;
  consecutive_days: string | number | null;
  enrollment_source: string | null;
  d1_morning: string | number | null;
  d1_midday: string | number | null;
  d1_close: string | number | null;
};

type CandidateRow = EntryRow & {
  direction: Direction;
  bucket: Bucket;
  repeated_count?: number;
  sequence_dates?: string[];
};

type RepeatedCandidateInput = EntryRow & {
  date: string;
  direction: Direction;
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

function directionFor(row: EntryRow): Direction {
  return num(row.day_change_pct) > 0 ? "UP" : "DOWN";
}

function bucketFor(count: number): Bucket | null {
  if (count === 3) return 3;
  if (count === 4) return 4;
  if (count >= 5) return 5;
  return null;
}

function usd(pct: number): number {
  return (pct / 100) * POSITION_USD;
}

function pnlPoint(direction: Direction, entry: number, label: string, exit: number) {
  return computePnlPath({
    direction,
    entryPrice: entry,
    investmentUsd: POSITION_USD,
    exits: [{ label, price: exit }],
  })[0];
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

function pnlCell(pct: number): string {
  return colored(pct, `${fmtUsd(usd(pct))} / ${fmtPct(pct)}`);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function h(level: 1 | 2 | 3, text: string) {
  console.log(OUTPUT_HTML ? `<h${level}>${text}</h${level}>` : `${"#".repeat(level)} ${text}`);
}

function table(headers: string[], rows: string[][]) {
  if (OUTPUT_HTML) {
    console.log(`<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>`);
    for (const row of rows) console.log(`<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`);
    console.log("</tbody></table>");
    return;
  }
  console.log(`| ${headers.join(" | ")} |`);
  console.log(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) console.log(`| ${row.join(" | ")} |`);
}

function sequenceHtml(dates: string[] | undefined): string {
  if (!dates?.length) return "";
  return OUTPUT_HTML ? dates.map(textCell).join("<br/>") : dates.join(", ");
}

function buildPriceStreakCandidates(entries: EntryRow[]): CandidateRow[] {
  return entries
    .map((row) => {
      const count = Math.abs(Number(row.consecutive_days ?? 0));
      const bucket = bucketFor(count);
      if (!bucket) return null;
      return Object.assign(row, { direction: directionFor(row), bucket }) as CandidateRow;
    })
    .filter((row): row is CandidateRow => row != null);
}

function buildRepeatedTopListCandidates(entries: EntryRow[], cohortDates: string[]): CandidateRow[] {
  const inputs: RepeatedCandidateInput[] = entries.map((row) => Object.assign(row, {
    date: dateStr(row.cohort_date),
    direction: directionFor(row),
  }));

  return detectRepeatedTopListCandidates(inputs, cohortDates).map((candidate) => {
    const bucket = bucketFor(candidate.runLength);
    if (!bucket) throw new Error(`Unexpected repeated top-list run length: ${candidate.runLength}`);
    return Object.assign(candidate.entry, {
      bucket,
      repeated_count: candidate.runLength,
      sequence_dates: candidate.sequenceDates,
    }) as CandidateRow;
  });
}

function renderScenario(title: string, description: string, candidates: CandidateRow[]) {
  h(2, title);
  console.log(OUTPUT_HTML ? `<p>${description}</p>` : description);

  for (const direction of ["UP", "DOWN"] as const) {
    const tradeSide = tradeSideForContrarian(direction);
    h(3, `${direction} vector: ${tradeSide} at candidate close, exit next day`);
    const directionRows = candidates.filter((row) => row.direction === direction);

    const summary: string[][] = [];
    for (const bucket of STREAK_BUCKETS) {
      const bucketRows = directionRows.filter((row) => row.bucket === bucket);
      for (const exitBar of EXIT_BARS) {
        const pnls = bucketRows
          .filter((row) => row[`d1_${exitBar}`] != null)
          .map((row) => pnlPoint(
            direction,
            num(row.entry_price),
            exitBar,
            num(row[`d1_${exitBar}`] as string | number),
          ));
        const total = pnls.reduce((sum, point) => sum + point.tradePnlUsd, 0);
        const pctPnls = pnls.map((point) => point.tradePnlPct);
        const wins = pnls.filter((point) => point.tradePnlPct > 0).length;
        const deployed = pnls.length * POSITION_USD;
        summary.push([
          bucket === 5 ? "5+" : String(bucket),
          exitBar,
          String(pnls.length),
          pnls.length ? `${((wins / pnls.length) * 100).toFixed(1)}%` : "-",
          colored(total, pnls.length ? `${fmtUsd(total)} / ${fmtPct((total / deployed) * 100)}` : "-"),
          colored(median(pctPnls), fmtPct(median(pctPnls))),
        ]);
      }
    }
    table(["Streak", "Exit next day", "Trades", "Win rate", "Total PnL", "Median %"], summary);

    const bestRows = STREAK_BUCKETS.map((bucket) => {
      const bucketRows = directionRows.filter((row) => row.bucket === bucket);
      const best = EXIT_BARS.map((exitBar) => {
        const total = bucketRows.reduce((sum, row) => {
          const exit = row[`d1_${exitBar}`];
          return exit == null
            ? sum
            : sum + pnlPoint(direction, num(row.entry_price), exitBar, num(exit as string | number)).tradePnlUsd;
        }, 0);
        return { exitBar, total };
      }).sort((a, b) => b.total - a.total)[0];
      return [bucket === 5 ? "5+" : String(bucket), best.exitBar, String(bucketRows.length), colored(best.total, fmtUsd(best.total))];
    });
    table(["Streak", "Best exit", "Candidates", "Total PnL"], bestRows);

    const detailRows = directionRows.map((row) => {
      const entry = num(row.entry_price);
      return [
        textCell(dateStr(row.cohort_date)),
        textCell(row.symbol),
        row.bucket === 5 ? `${row.repeated_count ?? row.consecutive_days ?? "5+"}d` : `${row.repeated_count ?? row.consecutive_days ?? row.bucket}d`,
        fmtPct(num(row.day_change_pct)),
        textCell(row.enrollment_source ?? ""),
        entry.toFixed(2),
        pnlCell(pnlPoint(direction, entry, "morning", num(row.d1_morning as string | number)).tradePnlPct),
        pnlCell(pnlPoint(direction, entry, "midday", num(row.d1_midday as string | number)).tradePnlPct),
        pnlCell(pnlPoint(direction, entry, "close", num(row.d1_close as string | number)).tradePnlPct),
        sequenceHtml(row.sequence_dates),
      ];
    });
    table(["Candidate date", "Ticker", "Run", "Candidate day %", "Source", "Entry close", "d1 morning", "d1 midday", "d1 close", "Sequence dates"], detailRows);
  }
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
    `SELECT id, symbol, cohort_date, day_change_pct, entry_price, consecutive_days,
            enrollment_source, d1_morning, d1_midday, d1_close
       FROM reversal_entries
      WHERE entry_price > 0
        AND d1_morning IS NOT NULL
        AND d1_midday IS NOT NULL
        AND d1_close IS NOT NULL
      ORDER BY cohort_date ASC, id ASC`,
  );

  const [allMoverDateRows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT DISTINCT cohort_date
       FROM reversal_entries
      WHERE entry_price > 0
        AND (enrollment_source = 'MOVERS' OR enrollment_source IS NULL)
      ORDER BY cohort_date ASC`,
  );
  const [allMoverRows] = await pool.execute<EntryRow[]>(
    `SELECT id, symbol, cohort_date, day_change_pct, entry_price, consecutive_days,
            enrollment_source, d1_morning, d1_midday, d1_close
       FROM reversal_entries
      WHERE entry_price > 0
        AND (enrollment_source = 'MOVERS' OR enrollment_source IS NULL)
      ORDER BY cohort_date ASC, id ASC`,
  );

  const reportableEntryIds = new Set(entries.map((row) => row.id));
  const cohortDates = allMoverDateRows.map((row) => dateStr(row.cohort_date as Date | string));
  const priceCandidates = buildPriceStreakCandidates(entries);
  const repeatedCandidates = buildRepeatedTopListCandidates(allMoverRows, cohortDates)
    .filter((candidate) => reportableEntryIds.has(candidate.id));

  if (OUTPUT_HTML) {
    console.log(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Price streak and repeated top-list grid</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial, sans-serif; margin: 24px; color: #111827; }
  h1 { margin: 0 0 10px; font-size: 28px; }
  h2 { margin-top: 30px; font-size: 21px; }
  h3 { margin-top: 22px; font-size: 16px; }
  p { font-size: 14px; line-height: 1.45; max-width: 1100px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 24px; font-size: 13px; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 8px 10px; text-align: right; vertical-align: top; white-space: nowrap; }
  th:first-child, td:first-child, th:nth-child(2), td:nth-child(2), th:last-child, td:last-child { text-align: left; }
  td:last-child { white-space: normal; min-width: 160px; }
  thead th { background: #f8fafc; font-weight: 700; position: sticky; top: 0; }
  .pos { color: #15803d; font-weight: 650; }
  .neg { color: #b91c1c; font-weight: 650; }
  .neu { color: #52525b; }
</style></head><body>`);
  }

  h(1, "Price streak and repeated top-list grid");
  console.log(OUTPUT_HTML
    ? `<p>Contrarian test. UP candidates are shorted at candidate-day close and covered next day. DOWN candidates are bought at candidate-day close and sold next day. Position $${POSITION_USD}, 1x, no costs/slippage/borrow.</p>`
    : `Contrarian test. UP candidates are shorted at candidate-day close and covered next day. DOWN candidates are bought at candidate-day close and sold next day. Position $${POSITION_USD}, 1x, no costs/slippage/borrow.`);

  renderScenario(
    "Price Streak Report",
    "`consecutive_days` from the feed: price moved in the same direction for N trading closes through the candidate date. This does not require repeated top-list appearances.",
    priceCandidates,
  );

  renderScenario(
    "Repeated Top List Report",
    "Ticker appeared in our own daily top gainers or top losers list on consecutive cohort dates. Sequence dates are shown in the detail table.",
    repeatedCandidates,
  );

  if (OUTPUT_HTML) console.log("</body></html>");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
