/**
 * HTTPS-driven variant of backfill-prices-daily.ts.
 *
 * The direct-MySQL variant (./backfill-prices-daily.ts) times out connecting
 * to Railway's MySQL public proxy from a laptop (TLS handshake fails via the
 * switchback.proxy.rlwy.net). This variant hits the prod API instead:
 *
 *   GET  /api/reversal            → pull the enrolled symbol list from prod
 *   POST /api/data/refresh?symbol → trigger refreshSymbolData inside Railway
 *
 * The Railway-internal MySQL connection (mysql.railway.internal) just works
 * from inside the app container, so the server does the DB write and we
 * just orchestrate.
 *
 * Concurrency: 4 parallel requests. Per-call latency varies 7–60 s
 * (Stooq hits = fast, Yahoo fallback = slow), so sequential would be ~hours.
 * Concurrency=4 keeps us around 20–30 min total for 556 symbols without
 * tripping upstream rate-limits.
 *
 * Usage:
 *   TRADING_COOKIES=/path/to/cookies.txt npx tsx scripts/backfill-prices-daily-via-api.ts
 *
 *   or, if cookies.txt already at /tmp/trading-cookies.txt, just:
 *   npx tsx scripts/backfill-prices-daily-via-api.ts
 *
 * Re-login (one-shot to refresh the cookie jar):
 *   curl -c /tmp/trading-cookies.txt -X POST \\
 *     https://trading-production-06fe.up.railway.app/api/auth/login \\
 *     -H "Content-Type: application/json" \\
 *     -d '{"email":"...","password":"..."}'
 */

import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.TRADING_BASE_URL ?? "https://trading-production-06fe.up.railway.app";
const COOKIE_PATH = process.env.TRADING_COOKIES ?? "/tmp/trading-cookies.txt";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
const PER_CALL_TIMEOUT_MS = 90_000;

function parseCookieJar(p: string): string {
  // Netscape cookie jar from `curl -c`. Tab-separated. Real comment lines
  // start with "#" but curl prefixes HttpOnly entries with "#HttpOnly_" —
  // those are data lines, not comments, so we accept them after stripping
  // the prefix from the domain field.
  if (!fs.existsSync(p)) throw new Error(`Cookie jar not found at ${p}`);
  const raw = fs.readFileSync(p, "utf8");
  const pairs: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    if (!rawLine) continue;
    let line = rawLine;
    if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
    else if (line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length >= 7) {
      const name = parts[5];
      const value = parts[6];
      if (name && value) pairs.push(`${name}=${value}`);
    }
  }
  if (pairs.length === 0) throw new Error(`No cookies parsed from ${p}`);
  return pairs.join("; ");
}

type SymbolRow = { symbol: string };

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getEnrolledSymbols(cookie: string): Promise<string[]> {
  // /api/reversal returns { cohorts: { [date]: entries[] } } — pull distinct symbols.
  const res = await fetchWithTimeout(`${BASE_URL}/api/reversal`, {
    headers: { Cookie: cookie },
  }, 30_000);
  if (!res.ok) throw new Error(`GET /api/reversal → HTTP ${res.status}`);
  const data = await res.json();
  const cohorts = data?.cohorts ?? data?.entries ?? {};
  const set = new Set<string>();
  const collect = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const e of arr as SymbolRow[]) if (e?.symbol) set.add(String(e.symbol));
  };
  if (Array.isArray(cohorts)) collect(cohorts);
  else for (const v of Object.values(cohorts)) collect(v);
  return Array.from(set).sort();
}

async function refreshOne(symbol: string, cookie: string): Promise<{ symbol: string; ok: boolean; inserted: number; total: number; error?: string; ms: number }> {
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      `${BASE_URL}/api/data/refresh?symbol=${encodeURIComponent(symbol)}`,
      { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie } },
      PER_CALL_TIMEOUT_MS,
    );
    const ms = Date.now() - started;
    if (!res.ok) return { symbol, ok: false, inserted: 0, total: 0, ms, error: `HTTP ${res.status}` };
    const json = await res.json();
    return { symbol, ok: true, inserted: Number(json.inserted ?? 0), total: Number(json.total ?? 0), ms };
  } catch (err) {
    return { symbol, ok: false, inserted: 0, total: 0, ms: Date.now() - started, error: (err as Error).message ?? String(err) };
  }
}

async function main() {
  const cookie = parseCookieJar(COOKIE_PATH);

  console.log(`[backfill-api] base=${BASE_URL} concurrency=${CONCURRENCY}`);
  const symbols = await getEnrolledSymbols(cookie);
  console.log(`[backfill-api] ${symbols.length} distinct symbols from /api/reversal`);

  if (symbols.length === 0) {
    console.log("[backfill-api] nothing to do.");
    return;
  }

  const results: Array<Awaited<ReturnType<typeof refreshOne>>> = [];
  let idx = 0;
  const start = Date.now();
  let done = 0;

  const workers: Promise<void>[] = [];
  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push((async () => {
      while (true) {
        const i = idx++;
        if (i >= symbols.length) return;
        const r = await refreshOne(symbols[i], cookie);
        results.push(r);
        done++;
        const progress = `[${done}/${symbols.length}]`;
        const elapsed = (Date.now() - start) / 1000;
        const rate = (done / elapsed).toFixed(2);
        const etaSec = Math.round(((symbols.length - done) / (done / elapsed)) || 0);
        const etaMin = (etaSec / 60).toFixed(1);
        if (r.ok) {
          console.log(
            `${progress} ${r.symbol.padEnd(6)} ok · ${r.inserted.toString().padStart(3)}/${r.total} rows · ${r.ms}ms · ${rate}/s · eta ${etaMin}m`,
          );
        } else {
          console.warn(`${progress} ${r.symbol.padEnd(6)} FAIL · ${r.error}`);
        }
      }
    })());
  }
  await Promise.all(workers);

  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  const totalInserted = ok.reduce((s, r) => s + r.inserted, 0);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log("");
  console.log(`[backfill-api] done in ${elapsed}s`);
  console.log(`[backfill-api] ok=${ok.length}, failed=${fail.length}, rows upserted=${totalInserted}`);
  if (fail.length > 0) {
    console.log(`[backfill-api] failures:`);
    for (const f of fail) console.log(`  ${f.symbol}: ${f.error}`);
  }

  // Save a JSON summary for follow-up.
  const summaryPath = path.resolve(process.cwd(), `backfill-summary-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify({ elapsed, ok: ok.length, failed: fail.length, totalInserted, failures: fail }, null, 2));
  console.log(`[backfill-api] summary written to ${summaryPath}`);

  process.exit(fail.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill-api] fatal:", err);
  process.exit(1);
});
