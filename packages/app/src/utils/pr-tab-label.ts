import type { PrPaneData } from "./pr-pane-data";

export function formatPrTabLabel(data: PrPaneData | null): string {
  return data ? `#${data.number}` : "#—";
}
