/** The sidebar footer's icon line, in row order. */
export const SIDEBAR_FOOTER_ACTIONS = [
  "add-project",
  "usage",
  "hosts",
  "help",
  "settings",
] as const;

export type SidebarFooterAction = (typeof SIDEBAR_FOOTER_ACTIONS)[number];

/** The order actions keep their place in a row too narrow for all of them. */
const KEEP_ORDER: readonly SidebarFooterAction[] = [
  "settings",
  "add-project",
  "hosts",
  "usage",
  "help",
];

/** Measured widths land a hair under the exact sum of their parts. */
const MEASUREMENT_TOLERANCE = 0.5;

export interface SidebarFooterLayout {
  /** Actions drawn in the row, in row order. */
  inline: SidebarFooterAction[];
  /** Actions behind the overflow caret, in row order. Empty when everything fits. */
  overflow: SidebarFooterAction[];
}

/**
 * Splits the footer's actions between the row and the overflow menu. Buttons keep their full size;
 * when they don't all fit, the caret takes one slot and the actions that lose their place move
 * behind it, Help first and Settings last. Nothing is placed until the row has a measured width.
 */
export function resolveSidebarFooterLayout(input: {
  rowWidth: number;
  controlSize: number;
  rowPadding: number;
  actions: readonly SidebarFooterAction[];
}): SidebarFooterLayout {
  const { rowWidth, controlSize, rowPadding, actions } = input;
  // An unmeasured row stays empty: any guess would paint a clipped row for a frame on a narrow
  // sidebar before the real width arrives.
  if (rowWidth <= 0) {
    return { inline: [], overflow: [] };
  }
  const slots = Math.floor(
    (rowWidth - rowPadding * 2 + MEASUREMENT_TOLERANCE) / Math.max(controlSize, 1),
  );
  if (slots >= actions.length) {
    return { inline: [...actions], overflow: [] };
  }
  const inlineCount = Math.max(slots - 1, 0);
  const kept = new Set(
    KEEP_ORDER.filter((action) => actions.includes(action)).slice(0, inlineCount),
  );
  return {
    inline: actions.filter((action) => kept.has(action)),
    overflow: actions.filter((action) => !kept.has(action)),
  };
}
