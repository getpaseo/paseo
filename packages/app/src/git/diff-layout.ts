import type { Breakpoint } from "@/constants/layout";

export type DiffLayout = "unified" | "split";
export type DiffLayoutPreference = DiffLayout | "auto";
export type DiffBreakpoint = Breakpoint;

// Two code columns need the wide breakpoints; below them each side gets too
// narrow to read a diff.
const SPLIT_LAYOUT_BREAKPOINTS = new Set<DiffBreakpoint>(["lg", "xl"]);

export function resolveDiffLayout(
  preference: DiffLayoutPreference,
  canUseSplitLayout: boolean,
  breakpoint: DiffBreakpoint | undefined,
): DiffLayout {
  if (!canUseSplitLayout || !breakpoint) {
    return "unified";
  }
  if (preference === "auto") {
    return SPLIT_LAYOUT_BREAKPOINTS.has(breakpoint) ? "split" : "unified";
  }
  return preference;
}
