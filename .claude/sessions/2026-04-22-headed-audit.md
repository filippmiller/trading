# Headed Prod Audit — 2026-04-22

**Target:** `https://trading-production-06fe.up.railway.app`
**Master HEAD:** `652734b` (PR #34 merged — Codex 2nd-pass)
**Session kind:** Headed Playwright walkthrough of all 12 sidebar routes + targeted regression probes for PR #29 (matrix), PR #33 (auto-exit slippage), PR #34 (empty-cache refetch).
**Credentials:** `filippmiller@gmail.com` (env vars only — not logged).
**Scripts:** `scripts/prod-audit.mjs` (full walk), `scripts/prod-audit-matrix.mjs` (matrix-specific).
**Artifacts:** `audit/prod-audit/`, `audit/prod-audit-matrix/` (screenshots + report.json).

---

## 1. ✅ Clean

All 12 sidebar pages returned HTTP 200, rendered, and were free of RED-level errors.

| # | Page | HTTP | h1 | Screenshot |
|---|------|------|-----|-----|
| 1  | `/`          | 200 | "Mean reversion research, automation, and paper execution in one loop." | `audit/prod-audit/root.png` |
| 2  | `/markets`   | 200 | "Markets" | `audit/prod-audit/markets.png` |
| 3  | `/reversal`  | 200 | "Surveillance Command" | `audit/prod-audit/reversal.png` |
| 4  | `/strategies`| 200 | "Strategy Dashboard" | `audit/prod-audit/strategies.png` |
| 5  | `/scenarios` | 200 | (section heading rendered client-side) | `audit/prod-audit/scenarios.png` |
| 6  | `/research`  | 200 | "Strategy Research" | `audit/prod-audit/research.png` |
| 7  | `/signals`   | 200 | (client-rendered) | `audit/prod-audit/signals.png` |
| 8  | `/prices`    | 200 | (client-rendered) | `audit/prod-audit/prices.png` |
| 9  | `/voice`     | 200 | (client-rendered) | `audit/prod-audit/voice.png` |
| 10 | `/runs`      | 200 | (client-rendered) | `audit/prod-audit/runs.png` |
| 11 | `/paper`     | 200 | "Paper Trading Simulator" | `audit/prod-audit/paper.png` |
| 12 | `/settings`  | 200 | (client-rendered) | `audit/prod-audit/settings.png` |

Positive signals in second-pass matrix probe:
- `/reversal?view=matrix` rendered a real `<table>` with **986 rows** across cohort groups and **956 ticker buttons** → matrix data pipeline healthy end-to-end.
- Clicking the first ticker (`NVTS`) opened the price-chart popover and triggered exactly **one** `GET /api/prices?symbol=NVTS&limit=90` call that returned non-empty data.
- Re-opening the same ticker's popover triggered **zero** additional prices fetches — correct cache-hit behavior for a non-empty cache entry.

---

## 2. ⚠️ Findings

### Finding 1 — RESOLVED (test artifact confirmed)
**Page:** `/` (Overview)
**Steps (original observation):** Full-page nav `/` → networkidle → wait 1.5s → screenshot → navigate away.
**Got (original):** `console.error: "Dashboard stats error TypeError: Failed to fetch"` fires on `/` during the Promise.all in `src/app/page.tsx:48-51` (fetches `/api/reversal` + `/api/runs`).
**Diagnosis:** Fetch aborted mid-flight when the audit script navigated away from `/` before both Promise.all arms could settle.
**Verification (stay-put probe — `scripts/prod-audit-dashboard.mjs`):** Log in → land on `/` → sit for 10s → watch network + console.
```
requests-fired=2
reversal-done=200
runs-done=200
network-failed=0
dashboard-stats-errors=0
total-console-errors=0
```
Both fetches complete cleanly, zero console errors, zero network failures. Confirms this was a test artifact of the walker, not a user-facing defect.
**Status:** Closed. No production code change required.
**Screenshot:** `audit/prod-audit-dashboard/dashboard-after-stay.png`

### Finding 2 — YELLOW (known, previously documented)
**Page:** `/reversal?view=matrix`
**Got:** `pageerror: Minified React error #418`
**Screenshot:** `audit/prod-audit-matrix/matrix-view-full.png`
**Status:** Already catalogued in `.claude/sessions/2026-04-22-qa-findings.md` as "same as earlier local-dev sessions. Auto-recovers. Root cause: SSR vs client mismatch (matrix data fetch timing). Not a data bug. Priority: LOW."
**Severity:** YELLOW. Matrix fully functional despite the hydration warning (986 rows rendered, ticker-button click works, prices fetch works, popover renders).

---

## 3. ⚠️ Coverage gaps (honest record of what this audit did NOT verify)

- **PR #34 empty-response refetch** — probed re-open behavior for `NVTS` (non-empty response). Saw 0 re-fetches on the 2nd open, which is the expected cache-hit behavior. The fix targets the specific case where the 1st response is `[]` (e.g., a TREND ticker queried seconds before the async backfill writes to `prices_daily`). Prod data here did not produce an empty response on the ticker we sampled, so this probe cannot serve as evidence for that particular regression. The fix IS covered by the new unit test `does NOT cache empty responses — re-opens the popover triggers a fresh fetch` in `PriceChartPopover.test.tsx` (added in commit `d76d13f`).
- **PR #33 auto-exit slippage** — `/paper` trade history renders, but the current prod paper account has zero closed trades with `reason ∈ {HARD_STOP, TRAILING_STOP}` (script grep: `0` matching rows, `0` "slippage" headers). Fix IS covered by 10 unit tests in `src/lib/paper-exits.test.ts` (commit `02034c8`) that directly assert the pure helper `computeExitFillPrice` produces fillPrice < trigger for LONG stops / > trigger for SHORT stops / = trigger for TAKE_PROFIT.
- **PR #29 Finding #1 (TREND enrollment gets prices_daily within ~400ms)** — not probed. Would require monitoring the worker's backfill job for a fresh TREND enrollment, which is an orchestration-level test, not a UI probe. Not attempted here.
- **PR #29 Finding #2 (Best/Worst duplicate-symbol click)** — Best/Worst panel selectors were not refined to locate the specific duplicate-symbol case. Not probed.
- **Mutation cases deliberately skipped** (touch real prod state): placing an order, reset-modal flow, account creation. Not in-scope for a non-destructive headed audit.

---

## 4. 🔄 Rollback log

Everything mutating is reverted.

| # | Action | Where | Reverted | Proof |
|---|--------|-------|-----------|-------|
| 1 | Typed "AAPL" into `/paper` symbol filter | Probe D | N/A — filter input not rendered (no trades, no filter UI) | — |
| 2 | Clicked scenarios tab #2 (read-only view switch) | Probe E | Clicked tab #1 to return | `audit/prod-audit/probe-scenarios-tab1.png` |

No writes to DB. No orders placed. No accounts created. No reset triggered. Networking calls were all GETs plus one POST to `/api/auth/login` (login side-effect).

---

## 5. Product judgment

**Ship.** 12/12 routes 200 and render; matrix + popover work on live data; 2 YELLOW findings are a known hydration warning and a suspected test-timing artifact — neither is a user-facing defect under normal navigation. The two fixes whose regression guard could not be exercised on this particular prod snapshot (PR #33 slippage, PR #34 empty-cache refetch) are both covered by unit tests in the same commits that shipped them. No RED findings, no 5xx, no missing pages.

**Follow-up executed:** The stay-put probe ran with `STAY_MS=10000`; both `/api/reversal` and `/api/runs` returned 200 with zero console errors and zero network failures. Finding #1 is definitively closed as a test-walker artifact.
