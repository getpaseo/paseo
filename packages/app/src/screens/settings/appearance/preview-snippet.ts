// A small, syntax-rich TypeScript change rendered side-by-side in the appearance
// preview. BEFORE and AFTER are aligned 1:1 (5 lines each); only the indices in
// CHANGED_LINE_INDICES differ, so the diff tints land on matching rows.

export const PREVIEW_BEFORE: string[] = [
  "// Format a price for display",
  "export function formatPrice(cents: number) {",
  "  const amount = cents / 100;",
  '  return "$" + amount;',
  "}",
];

export const PREVIEW_AFTER: string[] = [
  "// Format a price for display",
  "export function formatPrice(cents: number): string {",
  "  const amount = cents / 100;",
  "  return `$${amount.toFixed(2)}`;",
  "}",
];

export const CHANGED_LINE_INDICES: ReadonlySet<number> = new Set([1, 3]);
