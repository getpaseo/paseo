import { z } from "zod";
import type { ToolCallTimelineItem } from "./agent-types.js";

export type ToolCallSummaryPhase = "input" | "output";
export const TOOL_CALL_INPUT_SUMMARY_KEY = "paseo.toolCallInputSummary";

export const TOOL_CALL_SUMMARY_KEY = "paseo.toolCallSummary";
export const ToolCallSummarySchema = z.object({
  description: z.string().trim().min(1).max(600),
  filePath: z.string().min(1).max(4096).optional(),
});
export type ToolCallSummary = z.infer<typeof ToolCallSummarySchema>;

export function readToolCallSummary(
  metadata: ToolCallTimelineItem["metadata"],
  phase: ToolCallSummaryPhase = "output",
): string | undefined {
  const result = ToolCallSummarySchema.safeParse(
    metadata?.[phase === "input" ? TOOL_CALL_INPUT_SUMMARY_KEY : TOOL_CALL_SUMMARY_KEY],
  );
  return result.success ? result.data.description : undefined;
}

export function readToolCallSummaryFilePath(
  metadata: ToolCallTimelineItem["metadata"],
  phase: ToolCallSummaryPhase = "output",
): string | undefined {
  const result = ToolCallSummarySchema.safeParse(
    metadata?.[phase === "input" ? TOOL_CALL_INPUT_SUMMARY_KEY : TOOL_CALL_SUMMARY_KEY],
  );
  return result.success ? result.data.filePath : undefined;
}

export function isSummarizableToolCall(
  item: ToolCallTimelineItem,
  phase: ToolCallSummaryPhase = "output",
): boolean {
  const generic = item.detail.type === "unknown" || item.detail.type === "plain_text";
  return (
    (phase === "input" || item.status !== "running") && (item.detail.type === "shell" || generic)
  );
}
