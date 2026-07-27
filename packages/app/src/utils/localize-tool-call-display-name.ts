import type { TFunction } from "i18next";

const KNOWN_DISPLAY_NAMES: Record<string, string> = {
  Shell: "toolCall.displayNames.shell",
  Read: "toolCall.displayNames.read",
  Edit: "toolCall.displayNames.edit",
  Write: "toolCall.displayNames.write",
  Search: "toolCall.displayNames.search",
  Fetch: "toolCall.displayNames.fetch",
  "Worktree Setup": "toolCall.displayNames.worktreeSetup",
  Task: "toolCall.displayNames.task",
  Thinking: "toolCall.displayNames.thinking",
  Terminal: "toolCall.displayNames.terminal",
  Plan: "toolCall.displayNames.plan",
};

/** Localize well-known tool-call badge labels; leave custom tool names as-is. */
export function localizeToolCallDisplayName(t: TFunction, displayName: string): string {
  const key = KNOWN_DISPLAY_NAMES[displayName];
  return key ? t(key) : displayName;
}
