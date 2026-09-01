/**
 * Whether a workspace row can expand into the agents running inside it.
 *
 * Not one of the boolean row items, for the same reason CI is not: the middle answer is real.
 * "collapsed" shows how many agents a workspace holds and lets you open the list; "expanded"
 * keeps it open. A boolean would have to pick one and call the other off.
 *
 * The list is only ever drawn for a workspace holding more than one active root agent. A
 * single-agent workspace row already is that agent's row — its dot, its status, and its click
 * target all belong to that agent — so a lone child restating them is noise, not information.
 * That rule lives in `hasSidebarAgentRows` rather than in either row renderer, so both list modes
 * answer it the same way.
 *
 * Pure on purpose, like `row-items.ts` and `checks-display.ts`: `hooks/use-settings/storage.ts`
 * validates the persisted value through `parseSidebarAgentRows` rather than growing its own copy
 * of the value list.
 */

export const SIDEBAR_AGENT_ROWS_MODES = ["collapsed", "expanded", "none"] as const;

export type SidebarAgentRows = (typeof SIDEBAR_AGENT_ROWS_MODES)[number];

export const DEFAULT_SIDEBAR_AGENT_ROWS: SidebarAgentRows = "collapsed";

/** How many active root agents a workspace needs before the sub-list earns its space. */
export const SIDEBAR_AGENT_ROWS_MIN_COUNT = 2;

/** Null for anything that isn't one of the three, so callers can tell "absent" from "chosen". */
export function parseSidebarAgentRows(value: unknown): SidebarAgentRows | null {
  if (typeof value !== "string") {
    return null;
  }
  return (SIDEBAR_AGENT_ROWS_MODES as readonly string[]).includes(value)
    ? (value as SidebarAgentRows)
    : null;
}

/** Whether this workspace draws a disclosure and an agent sub-list at all. */
export function hasSidebarAgentRows(input: {
  agentCount: number;
  mode: SidebarAgentRows;
}): boolean {
  return input.mode !== "none" && input.agentCount >= SIDEBAR_AGENT_ROWS_MIN_COUNT;
}
