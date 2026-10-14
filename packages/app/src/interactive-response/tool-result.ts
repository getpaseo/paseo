import { extractInteractiveDocumentId } from "@getpaseo/protocol/interactive-response-reference";
import { isInteractiveResponseToolName } from "@getpaseo/protocol/tool-name-normalization";
import type { ToolCallItem } from "@/types/stream";
import { describeToolCall } from "@/tool-calls/detail-level/grouping";
export function isInteractiveTool(name: string): boolean {
  return isInteractiveResponseToolName(name);
}
export function interactiveToolDocumentId(item: ToolCallItem): string | null {
  const descriptor = describeToolCall(item);
  const result = descriptor.detail.type === "unknown" ? descriptor.detail.output : null;
  return extractInteractiveDocumentId(result);
}
