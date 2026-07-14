export const AGENT_HISTORY_UNTITLED_TITLE = "Untitled session";

const agentHistoryCollator = new Intl.Collator("en", {
  usage: "sort",
  numeric: true,
  sensitivity: "base",
});

export function normalizeAgentHistoryTitle(title: string | null | undefined): string {
  return title?.trim() || AGENT_HISTORY_UNTITLED_TITLE;
}

export function compareAgentHistoryText(left: string, right: string): number {
  return agentHistoryCollator.compare(left, right);
}
