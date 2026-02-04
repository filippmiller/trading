export const SYMBOL_REGEX = /^[A-Z0-9._-]{1,16}$/;

export function normalizeSymbol(input: string) {
  const value = String(input ?? "").trim().toUpperCase();
  if (!value || !SYMBOL_REGEX.test(value)) {
    throw new Error("Invalid symbol.");
  }
  return value;
}

export function toStooqSymbol(symbol: string) {
  const lower = symbol.toLowerCase();
  if (/\.[a-z]{2,3}$/.test(lower)) return lower;
  return `${lower}.us`;
}
