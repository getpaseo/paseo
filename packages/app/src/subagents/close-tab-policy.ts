import type { Agent } from "@/stores/session-store";

/**
 * Closing an agent tab is always layout-only. Archive is an explicit lifecycle
 * gesture (History/list actions), not a side-effect of dismissing a tab.
 *
 * `archive-on-close` remains in the union only for historical call sites/tests;
 * the resolver no longer returns it.
 */
export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

export function resolveCloseAgentTabPolicy(
  _agent: Pick<Agent, "parentAgentId"> | null | undefined,
): CloseAgentTabPolicy {
  return { kind: "layout-only" };
}
