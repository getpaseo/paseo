/**
 * The pages of the compact agent settings sheet. One sheet swaps its page in place; nothing stacks
 * a second sheet over it.
 */
export type AgentSheetPage =
  | { kind: "home" }
  | { kind: "model" }
  /** A select too long to scan on home, by control id; `mode` is the agent's mode. */
  | { kind: "select"; controlId: string };

export const AGENT_SHEET_HOME: AgentSheetPage = { kind: "home" };

export type AgentSheetEscape = "clearQuery" | "home" | "close";

/** Escape undoes one step: the search, then the page, then the sheet. */
export function resolveAgentSheetEscape(input: {
  page: AgentSheetPage;
  query: string;
}): AgentSheetEscape {
  if (input.page.kind === "home") return "close";
  return input.query.trim().length > 0 ? "clearQuery" : "home";
}
