/**
 * The command center's tabs, in the order Tab walks them. All shows every kind of result; each
 * other tab shows one kind.
 */
const COMMAND_CENTER_TABS = ["all", "workspaces", "files", "actions"] as const;

export type CommandCenterTab = (typeof COMMAND_CENTER_TABS)[number];

/**
 * The tabs on offer, in the order Tab walks them. Files searches the open workspace, so it is
 * offered only when a workspace is open; without one, All lists no files either.
 */
export function availableCommandCenterTabs(context: {
  hasWorkspace: boolean;
}): readonly CommandCenterTab[] {
  return context.hasWorkspace
    ? COMMAND_CENTER_TABS
    : COMMAND_CENTER_TABS.filter((tab) => tab !== "files");
}

/** The tab to show for a requested one: itself when on offer, otherwise All. */
export function resolveCommandCenterTab(
  requested: CommandCenterTab,
  available: readonly CommandCenterTab[],
): CommandCenterTab {
  return available.includes(requested) ? requested : "all";
}

/** The available tab after (or before) `tab`, wrapping at either end. */
export function rotateCommandCenterTab(
  tab: CommandCenterTab,
  direction: "next" | "previous",
  available: readonly CommandCenterTab[],
): CommandCenterTab {
  const index = available.indexOf(tab);
  const delta = direction === "next" ? 1 : -1;
  const count = available.length;
  return available[(index + delta + count) % count];
}
