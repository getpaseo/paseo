export function formatPrTabLabel(prNumber: number | null): string {
  return prNumber === null ? "#—" : `#${prNumber}`;
}
