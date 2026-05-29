import { useMemo } from "react";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";

export type RewindMode = "conversation" | "files" | "both";

export interface RewindMenuItem {
  mode: RewindMode;
  label: string;
  testID: string;
}

export function resolveRewindMenuItems(
  capabilities:
    | Pick<
        AgentCapabilityFlags,
        "supportsRewindConversation" | "supportsRewindFiles" | "supportsRewindBoth"
      >
    | null
    | undefined,
): RewindMenuItem[] {
  if (!capabilities) {
    return [];
  }
  const items: RewindMenuItem[] = [];
  if (capabilities.supportsRewindConversation) {
    items.push({
      mode: "conversation",
      label: "Rewind conversation",
      testID: "rewind-menu-conversation",
    });
  }
  if (capabilities.supportsRewindFiles) {
    items.push({
      mode: "files",
      label: "Rewind files",
      testID: "rewind-menu-files",
    });
  }
  if (capabilities.supportsRewindBoth) {
    items.push({
      mode: "both",
      label: "Rewind conversation and files",
      testID: "rewind-menu-both",
    });
  }
  return items;
}

export function useRewindCapabilities(
  capabilities: Parameters<typeof resolveRewindMenuItems>[0],
): RewindMenuItem[] {
  return useMemo(() => resolveRewindMenuItems(capabilities), [capabilities]);
}
