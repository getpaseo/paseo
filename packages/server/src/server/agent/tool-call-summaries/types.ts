import type { ToolCallSummaryPhase } from "@getpaseo/protocol/tool-call-summary";
import type { ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";

export interface ToolCallSummaryTarget {
  agentId: string;
  epoch: string;
  seq: number;
  key: string;
  phase?: ToolCallSummaryPhase;
}

export interface ToolCallSummarySource {
  item: ToolCallTimelineItem;
  turnId?: string;
  timestamp: string;
}
