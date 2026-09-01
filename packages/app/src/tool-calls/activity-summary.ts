import type { ToolCallItem } from "@/types/stream";
import { resolveToolCallIconName, type ToolCallIcon } from "@/utils/tool-call-icon-name";
import { describeToolCall } from "./detail-level/grouping";

export interface ToolCallActivitySummary {
  toolCallCount: number;
  iconNames: readonly ToolCallIcon[];
}

/** Summarizes tool activity without adding presentation or provider-specific branches. */
export function summarizeToolCallActivity(calls: readonly ToolCallItem[]): ToolCallActivitySummary {
  const iconNames = new Set<ToolCallIcon>();
  for (const call of calls) {
    const descriptor = describeToolCall(call);
    iconNames.add(resolveToolCallIconName(descriptor.name, descriptor.detail));
  }
  return {
    toolCallCount: calls.length,
    iconNames: [...iconNames],
  };
}
