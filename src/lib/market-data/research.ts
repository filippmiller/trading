export type Direction = "UP" | "DOWN";
export type TradeSide = "LONG" | "SHORT";

export type DatedClose = {
  date: string;
  close: number;
};

export type RepeatedListEntry = {
  symbol: string;
  date: string;
  direction: Direction;
};

export type RepeatedListCandidate<T extends RepeatedListEntry = RepeatedListEntry> = {
  entry: T;
  runLength: number;
  sequenceDates: string[];
};

export type PriceStreak = {
  direction: Direction;
  length: number;
  evidence: Array<DatedClose & { movePct: number | null }>;
};

export type PnlPoint = {
  label: string;
  exitPrice: number;
  stockMovePct: number;
  tradePnlPct: number;
  tradePnlUsd: number;
  isReversal: boolean;
};

export function tradeSideForContrarian(direction: Direction): TradeSide {
  return direction === "UP" ? "SHORT" : "LONG";
}

export function computeTradePnlPct(entryPrice: number, exitPrice: number, side: TradeSide): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error("entryPrice must be a positive finite number");
  }
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
    throw new Error("exitPrice must be a positive finite number");
  }
  const rawPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  return side === "SHORT" ? -rawPct : rawPct;
}

export function computePnlPath(params: {
  direction: Direction;
  entryPrice: number;
  investmentUsd: number;
  exits: Array<{ label: string; price: number | null | undefined }>;
}): PnlPoint[] {
  const side = tradeSideForContrarian(params.direction);
  return params.exits
    .filter((exit): exit is { label: string; price: number } => exit.price != null && Number.isFinite(exit.price))
    .map((exit) => {
      const stockMovePct = ((exit.price - params.entryPrice) / params.entryPrice) * 100;
      const tradePnlPct = computeTradePnlPct(params.entryPrice, exit.price, side);
      return {
        label: exit.label,
        exitPrice: exit.price,
        stockMovePct,
        tradePnlPct,
        tradePnlUsd: (tradePnlPct / 100) * params.investmentUsd,
        isReversal: params.direction === "UP" ? stockMovePct < 0 : stockMovePct > 0,
      };
    });
}

export function detectPriceStreak(closes: DatedClose[]): PriceStreak | null {
  const sorted = [...closes]
    .filter((row) => Number.isFinite(row.close) && row.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return null;

  let direction: Direction | null = null;
  let length = 0;
  for (let i = sorted.length - 1; i > 0; i--) {
    const prev = sorted[i - 1].close;
    const cur = sorted[i].close;
    if (cur === prev) break;
    const moveDirection: Direction = cur > prev ? "UP" : "DOWN";
    if (direction == null) direction = moveDirection;
    if (moveDirection !== direction) break;
    length++;
  }
  if (!direction || length === 0) return null;

  const evidenceStart = Math.max(0, sorted.length - (length + 1));
  const evidence = sorted.slice(evidenceStart).map((row, index, arr) => {
    if (index === 0) return { ...row, movePct: null };
    return {
      ...row,
      movePct: ((row.close - arr[index - 1].close) / arr[index - 1].close) * 100,
    };
  });
  return { direction, length, evidence };
}

export function detectRepeatedTopListCandidates<T extends RepeatedListEntry>(
  entries: T[],
  cohortDates: string[],
  minimumRunLength = 3,
): Array<RepeatedListCandidate<T>> {
  const cohortIndex = new Map(cohortDates.map((date, index) => [date, index]));
  const uniqueEntries = new Map<string, T>();
  for (const entry of entries) {
    const key = `${entry.symbol}|${entry.direction}|${entry.date}`;
    if (!uniqueEntries.has(key)) uniqueEntries.set(key, entry);
  }
  const sorted = [...uniqueEntries.values()].sort((a, b) => {
    const bySymbol = a.symbol.localeCompare(b.symbol);
    if (bySymbol !== 0) return bySymbol;
    const byDirection = a.direction.localeCompare(b.direction);
    if (byDirection !== 0) return byDirection;
    return a.date.localeCompare(b.date);
  });

  const candidates: Array<RepeatedListCandidate<T>> = [];
  let currentKey = "";
  let run: T[] = [];

  function flush() {
    if (run.length < minimumRunLength) return;
    for (let i = minimumRunLength - 1; i < run.length; i++) {
      candidates.push({
        entry: run[i],
        runLength: i + 1,
        sequenceDates: run.slice(0, i + 1).map((entry) => entry.date),
      });
    }
  }

  for (const entry of sorted) {
    const key = `${entry.symbol}|${entry.direction}`;
    const index = cohortIndex.get(entry.date);
    const prev = run[run.length - 1];
    const prevIndex = prev ? cohortIndex.get(prev.date) : null;
    const continues = key === currentKey && index != null && prevIndex != null && index === prevIndex + 1;

    if (!continues) {
      flush();
      currentKey = key;
      run = [entry];
    } else {
      run.push(entry);
    }
  }
  flush();
  return candidates;
}

export function firstReversalLabel(path: PnlPoint[]): string | null {
  return path.find((point) => point.isReversal)?.label ?? null;
}
