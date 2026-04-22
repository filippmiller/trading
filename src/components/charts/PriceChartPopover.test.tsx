import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { PriceChartPopover, _resetPriceCacheForTests } from "./PriceChartPopover";
import type { ReversalEntry } from "@/lib/reversal";

function entry(overrides: Partial<ReversalEntry> = {}): ReversalEntry {
  const base: ReversalEntry = {
    id: 1,
    cohort_date: "2026-04-15",
    symbol: "AAPL",
    direction: "LONG",
    day_change_pct: 2.5,
    entry_price: 180,
    consecutive_days: 3,
    d1_morning: null, d1_midday: null, d1_close: null,
    d2_morning: null, d2_midday: null, d2_close: null,
    d3_morning: null, d3_midday: null, d3_close: null,
    d4_morning: null, d4_midday: null, d4_close: null,
    d5_morning: null, d5_midday: null, d5_close: null,
    d6_morning: null, d6_midday: null, d6_close: null,
    d7_morning: null, d7_midday: null, d7_close: null,
    d8_morning: null, d8_midday: null, d8_close: null,
    d9_morning: null, d9_midday: null, d9_close: null,
    d10_morning: null, d10_midday: null, d10_close: null,
    final_pnl_usd: null,
    final_pnl_pct: null,
    status: "ACTIVE",
    created_at: new Date().toISOString(),
  };
  return { ...base, ...overrides };
}

const anchor = { top: 100, left: 50 };
const noop = () => {};

function makeBar(date: string, close: number, opens: number = close - 0.5): { date: string; open: number; high: number; low: number; close: number } {
  return { date, open: opens, high: Math.max(opens, close) + 0.2, low: Math.min(opens, close) - 0.2, close };
}

function mockFetch(response: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => response,
  } as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  _resetPriceCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("PriceChartPopover", () => {
  it("shows loading placeholder while fetch is in flight", () => {
    let resolveFetch: (v: Response) => void = () => {};
    const pending = new Promise<Response>((r) => { resolveFetch = r; });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending));

    render(<PriceChartPopover entry={entry()} onClose={noop} anchor={anchor} />);
    expect(screen.getByText(/Loading last 90 days/i)).toBeInTheDocument();
    // Unblock to avoid hanging after-test state
    resolveFetch({ ok: true, status: 200, json: async () => ({ items: [] }) } as Response);
  });

  it("renders empty-state help text when API returns zero bars", async () => {
    mockFetch({ items: [] });
    render(<PriceChartPopover entry={entry({ symbol: "ZZZZ" })} onClose={noop} anchor={anchor} />);

    await waitFor(() => {
      expect(screen.getByText(/No historical bars in/i)).toBeInTheDocument();
    });
    // Symbol appears in both the header and the empty-state body — both are fine
    expect(screen.getAllByText(/ZZZZ/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("price-chart-svg")).toBeNull();
  });

  it("renders error banner when fetch returns non-ok", async () => {
    mockFetch({}, { ok: false, status: 500 });
    render(<PriceChartPopover entry={entry()} onClose={noop} anchor={anchor} />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load prices/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/HTTP 500/i)).toBeInTheDocument();
    expect(screen.queryByTestId("price-chart-svg")).toBeNull();
  });

  it("draws the out-of-window warning when enrollment date is not in the fetched bars", async () => {
    // Enrollment 2026-04-15, but bars cover only 2026-01-01..03 — warning must appear
    const bars = [
      makeBar("2026-01-01", 100),
      makeBar("2026-01-02", 101),
      makeBar("2026-01-03", 102),
    ];
    mockFetch({ items: bars });
    render(<PriceChartPopover entry={entry({ symbol: "INTC" })} onClose={noop} anchor={anchor} />);

    await waitFor(() => {
      expect(screen.getByText(/is OUTSIDE the loaded window/i)).toBeInTheDocument();
    });
    // Chart still renders (bars > 0), just without a streak marker
    expect(screen.getByTestId("price-chart-svg")).toBeInTheDocument();
  });

  it("renders a candle per bar when the enrollment day is inside the window", async () => {
    const bars = [
      makeBar("2026-04-13", 100),
      makeBar("2026-04-14", 102),
      makeBar("2026-04-15", 105), // enrollment day
      makeBar("2026-04-16", 104),
    ];
    mockFetch({ items: bars });
    render(<PriceChartPopover entry={entry()} onClose={noop} anchor={anchor} />);

    await waitFor(() => {
      expect(screen.getByTestId("price-chart-svg")).toBeInTheDocument();
    });
    // One <g data-testid="candle-<date>"> per bar
    expect(screen.getByTestId("candle-2026-04-13")).toBeInTheDocument();
    expect(screen.getByTestId("candle-2026-04-14")).toBeInTheDocument();
    expect(screen.getByTestId("candle-2026-04-15")).toBeInTheDocument();
    expect(screen.getByTestId("candle-2026-04-16")).toBeInTheDocument();
    // No out-of-window warning
    expect(screen.queryByText(/is OUTSIDE the loaded window/i)).toBeNull();
  });

  it("calls onClose when the backdrop is clicked", async () => {
    mockFetch({ items: [] });
    const onClose = vi.fn();
    render(<PriceChartPopover entry={entry()} onClose={onClose} anchor={anchor} />);

    await waitFor(() => expect(screen.getByText(/No historical bars/i)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("price-chart-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the × button is clicked, but NOT when inner content is clicked", async () => {
    mockFetch({ items: [] });
    const onClose = vi.fn();
    render(<PriceChartPopover entry={entry({ symbol: "MU" })} onClose={onClose} anchor={anchor} />);

    await waitFor(() => expect(screen.getByText(/No historical bars/i)).toBeInTheDocument());
    // Clicking the dialog body should NOT close (stopPropagation)
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    // Clicking × should close
    fireEvent.click(screen.getByLabelText(/Close chart/i));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("re-uses the module cache on second render of the same symbol (no second fetch)", async () => {
    const bars = [makeBar("2026-04-15", 105)];
    const fetchFn = mockFetch({ items: bars });

    const { unmount } = render(<PriceChartPopover entry={entry({ symbol: "AAPL" })} onClose={noop} anchor={anchor} />);
    await waitFor(() => expect(screen.getByTestId("price-chart-svg")).toBeInTheDocument());
    expect(fetchFn).toHaveBeenCalledTimes(1);

    unmount();

    render(<PriceChartPopover entry={entry({ symbol: "AAPL" })} onClose={noop} anchor={anchor} />);
    expect(screen.getByTestId("price-chart-svg")).toBeInTheDocument();
    expect(fetchFn).toHaveBeenCalledTimes(1); // still one — cached
  });

  it("encodes the symbol in the API URL (guards against trailing whitespace / special chars)", () => {
    const fetchFn = mockFetch({ items: [] });
    render(<PriceChartPopover entry={entry({ symbol: "BRK.B" })} onClose={noop} anchor={anchor} />);
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining("symbol=BRK.B"));
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining("limit=90"));
  });
});
