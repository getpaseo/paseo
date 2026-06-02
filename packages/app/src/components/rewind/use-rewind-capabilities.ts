import { useMemo } from "react";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";

export type RewindMode = "conversation" | "files" | "both";

export interface RewindMenuItem {
  mode: RewindMode;
  label: string;
  testID: string;
}

export interface RewindMenuLabels {
  conversation: string;
  files: string;
  both: string;
}

const DEFAULT_REWIND_MENU_LABELS: RewindMenuLabels = {
  conversation: "Rewind conversation",
  files: "Rewind files",
  both: "Rewind conversation and files",
};

export function resolveRewindMenuItems(
  capabilities:
    | Pick<
        AgentCapabilityFlags,
        "supportsRewindConversation" | "supportsRewindFiles" | "supportsRewindBoth"
      >
    | null
    | undefined,
  labelsInput?: Partial<RewindMenuLabels>,
): RewindMenuItem[] {
  if (!capabilities) {
    return [];
  }
  const labels = { ...DEFAULT_REWIND_MENU_LABELS, ...labelsInput };
  const items: RewindMenuItem[] = [];
  if (capabilities.supportsRewindConversation) {
    items.push({
      mode: "conversation",
      label: labels.conversation,
      testID: "rewind-menu-conversation",
    });
  }
  if (capabilities.supportsRewindFiles) {
    items.push({
      mode: "files",
      label: labels.files,
      testID: "rewind-menu-files",
    });
  }
  if (capabilities.supportsRewindBoth) {
    items.push({
      mode: "both",
      label: labels.both,
      testID: "rewind-menu-both",
    });
  }
  return items;
}

export function useRewindCapabilities(
  capabilities: Parameters<typeof resolveRewindMenuItems>[0],
  labels?: Partial<RewindMenuLabels>,
): RewindMenuItem[] {
  return useMemo(() => resolveRewindMenuItems(capabilities, labels), [capabilities, labels]);
}
