import type { StreamItem } from "@/types/stream";
import type { ToolCallDetailLevel } from "@/hooks/use-settings/storage";
import {
  groupLiveToolCalls,
  prepareGroupedHistory,
  type GroupedHistory,
  type GroupedToolCalls,
} from "./grouping";
import { buildOverviewGroup, type OverviewToolCallGroup } from "./overview/model";

export type { ToolCallDetailLevel } from "@/hooks/use-settings/storage";
export type ToolCallDetailGroup = OverviewToolCallGroup;

export interface PreparedToolCallHistory {
  mode: "overview";
  grouped: GroupedHistory<ToolCallDetailGroup>;
}

export interface ToolCallDetailProjection extends GroupedToolCalls<ToolCallDetailGroup> {}

const EMPTY_TOOL_CALL_GROUPS = new Map<string, ToolCallDetailGroup>();

export function prepareToolCallHistory(
  level: ToolCallDetailLevel,
  tail: StreamItem[],
): PreparedToolCallHistory | null {
  if (level === "detailed") {
    return null;
  }
  return {
    mode: "overview",
    grouped: prepareGroupedHistory({ tail, buildGroup: buildOverviewGroup }),
  };
}

export function projectToolCallDetailLevel(input: {
  level: ToolCallDetailLevel;
  tail: StreamItem[];
  head: StreamItem[];
  preparedHistory: PreparedToolCallHistory | null;
  isTurnActive: boolean;
}): ToolCallDetailProjection {
  if (input.level === "detailed") {
    return {
      tail: input.tail,
      head: input.head,
      groupsByHostId: EMPTY_TOOL_CALL_GROUPS,
      historyGroupUpdatesByHostId: EMPTY_TOOL_CALL_GROUPS,
    };
  }
  if (!input.preparedHistory || input.preparedHistory.mode !== input.level) {
    throw new Error(`Missing prepared ${input.level} tool call history`);
  }
  return groupLiveToolCalls({
    history: input.preparedHistory.grouped,
    head: input.head,
    isTurnActive: input.isTurnActive,
    buildGroup: buildOverviewGroup,
  });
}
