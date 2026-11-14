/**
 * The command center's tabs, in the order Tab walks them. All shows every kind of result; each
 * other tab shows one kind.
 */
export const COMMAND_CENTER_TABS = ["all", "workspaces", "files", "actions"] as const;

export type CommandCenterTab = (typeof COMMAND_CENTER_TABS)[number];

/** The tab after (or before) `tab`, wrapping at either end. */
export function rotateCommandCenterTab(
  tab: CommandCenterTab,
  direction: "next" | "previous",
): CommandCenterTab {
  const index = COMMAND_CENTER_TABS.indexOf(tab);
  const delta = direction === "next" ? 1 : -1;
  const count = COMMAND_CENTER_TABS.length;
  return COMMAND_CENTER_TABS[(index + delta + count) % count];
}
