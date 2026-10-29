import { SPACING } from "@/styles/theme";

/**
 * Every vertical size in the Command Center list, in one place.
 *
 * The list is virtualized, so it needs each row's height before rendering it. Rather than keep
 * those numbers in sync with the styles by hand, rows render at exactly the height computed here
 * and center their content. The styles read the line heights below, so this arithmetic is the
 * layout.
 *
 * A layout chooses one thing: the inset above and below a row's text. Both layouts share the same
 * shape, so nothing downstream asks which one it got.
 */
export const COMMAND_CENTER_LINE_HEIGHT = {
  /** A row with no subtitle. Also the icon slot, so the icon centers on the title. */
  singleLine: 20,
  title: 18,
  subtitle: 16,
  sectionLabel: 16,
} as const;

/** Space around a section's label and around the rule between sections. */
export const COMMAND_CENTER_SECTION_GAP = SPACING[2];
const SECTION_DIVIDER_THICKNESS = 1;

export interface CommandCenterListMetrics {
  singleLineRow: number;
  twoLineRow: number;
  /** A section label and the gaps around it. */
  sectionTitle: number;
  /** The rule between two sections and the gaps around it. */
  sectionDivider: number;
}

function listMetrics(rowInset: number): CommandCenterListMetrics {
  const line = COMMAND_CENTER_LINE_HEIGHT;
  return {
    singleLineRow: rowInset + line.singleLine + rowInset,
    twoLineRow: rowInset + line.title + line.subtitle + rowInset,
    sectionTitle: COMMAND_CENTER_SECTION_GAP + line.sectionLabel + COMMAND_CENTER_SECTION_GAP,
    sectionDivider:
      COMMAND_CENTER_SECTION_GAP + SECTION_DIVIDER_THICKNESS + COMMAND_CENTER_SECTION_GAP,
  };
}

/**
 * Desktop is dense for a pointer. Compact keeps single-line rows at the 44pt touch height that
 * `density.rowHeight` uses on compact layouts.
 */
export const COMMAND_CENTER_LIST_METRICS = {
  desktop: listMetrics(SPACING[1.5]),
  compact: listMetrics(SPACING[3]),
} as const satisfies Record<string, CommandCenterListMetrics>;
