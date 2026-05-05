import fs from "node:fs";
import path from "node:path";

import mysql from "mysql2/promise";

import {
  computePnlPath,
  detectPriceStreak,
  tradeSideForContrarian,
  type Direction,
  type TradeSide as ResearchTradeSide,
} from "../src/lib/market-data/research";

const POSITION_USD = 1000;
const STREAK_BUCKETS = [3, 4, 5] as const;
const EXIT_BARS = ["morning", "midday", "close"] as const;
const OUTPUT_HTML = process.argv.includes("--html");

type Side = Direction;
type TradeSide = ResearchTradeSide;
type ExitBar = (typeof EXIT_BARS)[number];

type EntryRow = mysql.RowDataPacket & {
  id: number;
  symbol: string;
  cohort_date: Date | string;
  day_change_pct: string | number;
  entry_price: string | number;
  enrollment_source: string | null;
  d1_morning: string | number;
  d1_midday: string | number;
  d1_close: string | number;
};

type PriceRow = mysql.RowDataPacket & {
  date: Date | string;
  close: string | number;
};

type AnalyzedRow = EntryRow & {
  computed_streak: number;
  bucket: 3 | 4 | 5;
  streak_side: Side;
  evidence: Array<{ date: string; close: number; movePct: number | null }>;
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

function usd(pct: number): number {
  return (pct / 100) * POSITION_USD;
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

function bucketFor(streak: number): 3 | 4 | 5 | null {
  if (streak === 3) return 3;
  if (streak === 4) return 4;
  if (streak >= 5) return 5;
  return null;
}

function detectVerifiedStreak(prices: PriceRow[], side: Side): { streak: number; evidence: AnalyzedRow["evidence"] } | null {
  const streak = detectPriceStreak(prices.map((row) => ({ date: dateStr(row.date), close: num(row.close) })));
  if (!streak || streak.direction !== side) return null;
  return { streak: streak.length, evidence: streak.evidence };
}

function exitPrice(row: EntryRow, exitBar: ExitBar): number {
  return num(row[`d1_${exitBar}`]);
}

function pnlPoint(row: EntryRow, side: Side, exitBar: ExitBar) {
  const [point] = computePnlPath({
    direction: side,
    entryPrice: num(row.entry_price),
    investmentUsd: POSITION_USD,
    exits: [{ label: `d1 ${exitBar}`, price: exitPrice(row, exitBar) }],
  });
  return point;
}

function tradePct(row: EntryRow, side: Side, exitBar: ExitBar): number {
  return pnlPoint(row, side, exitBar).tradePnlPct;
}

function evidenceHtml(evidence: AnalyzedRow["evidence"]): string {
  const parts = evidence.map((item) => {
    const move = item.movePct == null ? "" : ` (${fmtPct(item.movePct)})`;
    return `${textCell(item.date)}: ${item.close.toFixed(2)}${move}`;
  });
  return OUTPUT_HTML ? parts.join("<br/>") : parts.join("; ");
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

function h(level: 1 | 2 | 3, text: string) {
  console.log(OUTPUT_HTML ? `<h${level}>${text}</h${level}>` : `${"#".repeat(level)} ${text}`);
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
            d1_morning, d1_midday, d1_close
       FROM reversal_entries
      WHERE entry_price > 0
        AND d1_morning IS NOT NULL
        AND d1_midday IS NOT NULL
        AND d1_close IS NOT NULL
      ORDER BY cohort_date ASC, id ASC`,
  );

  const symbols = [...new Set(entries.map((entry) => entry.symbol))].sort();
  const pricesBySymbol = new Map<string, PriceRow[]>();
  for (let i = 0; i < symbols.length; i += 100) {
    const chunk = symbols.slice(i, i + 100);
    const [priceRows] = await pool.execute<(PriceRow & { symbol: string })[]>(
      `SELECT symbol, date, close
         FROM prices_daily
        WHERE symbol IN (${chunk.map(() => "?").join(",")})
        ORDER BY symbol ASC, date ASC`,
      chunk,
    );
    for (const row of priceRows) {
      const list = pricesBySymbol.get(row.symbol) ?? [];
      list.push(row);
      pricesBySymbol.set(row.symbol, list);
    }
  }

  const analyzed: AnalyzedRow[] = [];
  for (const entry of entries) {
    const side: Side = num(entry.day_change_pct) >= 0 ? "UP" : "DOWN";
    const allPrices = pricesBySymbol.get(entry.symbol) ?? [];
    const cohort = dateStr(entry.cohort_date);
    const idx = allPrices.findIndex((price) => dateStr(price.date) === cohort);
    if (idx < 1) continue;
    const prices = allPrices.slice(Math.max(0, idx - 7), idx + 1);
    const result = detectVerifiedStreak(prices, side);
    if (!result) continue;
    const bucket = bucketFor(result.streak);
    if (!bucket) continue;
    analyzed.push(Object.assign(entry, {
      computed_streak: result.streak,
      bucket,
      streak_side: side,
      evidence: result.evidence,
    }));
  }

  if (OUTPUT_HTML) {
    console.log(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Verified price-streak reversal grid</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial, sans-serif; margin: 24px; color: #111827; }
  h1 { margin: 0 0 10px; font-size: 28px; }
  h2 { margin-top: 28px; font-size: 20px; }
  h3 { margin-top: 20px; font-size: 16px; }
  p { font-size: 14px; line-height: 1.45; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 24px; font-size: 13px; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 8px 10px; text-align: right; vertical-align: top; white-space: nowrap; }
  th:first-child, td:first-child, th:nth-child(2), td:nth-child(2), th:last-child, td:last-child { text-align: left; }
  td:last-child { white-space: normal; min-width: 280px; }
  thead th { background: #f8fafc; font-weight: 700; position: sticky; top: 0; }
  .pos { color: #15803d; font-weight: 650; }
  .neg { color: #b91c1c; font-weight: 650; }
  .neu { color: #52525b; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-weight: 700; }
</style></head><body>`);
  }

  h(1, "Verified price-streak reversal grid");
  console.log(OUTPUT_HTML
    ? `<p>Candidate streaks are recomputed from <code>prices_daily.close</code> on consecutive trading dates ending at the signal date. Bucket 5 means 5 or more consecutive closes in the same vector. Position $${POSITION_USD}, 1x, no costs/slippage/borrow.</p>`
    : `Candidate streaks are recomputed from prices_daily.close on consecutive trading dates ending at the signal date. Bucket 5 means 5 or more consecutive closes in the same vector. Position $${POSITION_USD}, 1x, no costs/slippage/borrow.`);

  const scenarios = [
    {
      title: "Vector UP candidates: SHORT at signal close, cover next day",
      side: "UP" as const,
    },
    {
      title: "Vector DOWN candidates: LONG at signal close, sell next day",
      side: "DOWN" as const,
    },
  ];

  for (const scenario of scenarios) {
    h(2, scenario.title);
    const tradeSide: TradeSide = tradeSideForContrarian(scenario.side);
    const sideRows = analyzed.filter((row) => row.streak_side === scenario.side);
    const summary: string[][] = [];
    for (const bucket of STREAK_BUCKETS) {
      const bucketRows = sideRows.filter((row) => row.bucket === bucket);
      for (const exitBar of EXIT_BARS) {
        const pnls = bucketRows.map((row) => tradePct(row, scenario.side, exitBar));
        const total = pnls.reduce((sum, pct) => sum + usd(pct), 0);
        const wins = pnls.filter((pct) => pct > 0).length;
        const deployed = pnls.length * POSITION_USD;
        summary.push([
          bucket === 5 ? "5+" : String(bucket),
          exitBar,
          String(pnls.length),
          pnls.length ? `${((wins / pnls.length) * 100).toFixed(1)}%` : "-",
          colored(total, pnls.length ? `${fmtUsd(total)} / ${fmtPct((total / deployed) * 100)}` : "-"),
          colored(median(pnls), fmtPct(median(pnls))),
        ]);
      }
    }
    table(["Candidate", "Exit next day", "Trades", "Win rate", "Total PnL", "Median %"], summary);

    h(3, "Best exit by streak");
    const bestRows = STREAK_BUCKETS.map((bucket) => {
      const bucketRows = sideRows.filter((row) => row.bucket === bucket);
      const best = EXIT_BARS.map((exitBar) => {
        const total = bucketRows.reduce((sum, row) => sum + usd(tradePct(row, scenario.side, exitBar)), 0);
        return { exitBar, total };
      }).sort((a, b) => b.total - a.total)[0];
      return [bucket === 5 ? "5+" : String(bucket), best.exitBar, String(bucketRows.length), colored(best.total, fmtUsd(best.total))];
    });
    table(["Candidate", "Best exit", "Trades", "Total PnL"], bestRows);

    h(3, "Details with verified streak dates");
    const detailRows = sideRows.map((row) => {
      const entry = num(row.entry_price);
      return [
        textCell(dateStr(row.cohort_date)),
        textCell(row.symbol),
        OUTPUT_HTML ? `<span class="badge">${row.computed_streak}d</span>` : `${row.computed_streak}d`,
        row.streak_side,
        tradeSide,
        fmtPct(num(row.day_change_pct)),
        textCell(row.enrollment_source ?? ""),
        entry.toFixed(2),
        pnlCell(tradePct(row, scenario.side, "morning")),
        pnlCell(tradePct(row, scenario.side, "midday")),
        pnlCell(tradePct(row, scenario.side, "close")),
        evidenceHtml(row.evidence),
      ];
    });
    table(["Candidate date", "Ticker", "Candidate", "Vector", "Trade", "Signal day %", "Source", "Entry close", "d1 morning", "d1 midday", "d1 close", "Close-streak evidence"], detailRows);
  }

  if (OUTPUT_HTML) console.log("</body></html>");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
