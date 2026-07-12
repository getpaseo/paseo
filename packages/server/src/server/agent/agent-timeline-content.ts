import type { AgentTimelineItem } from "./agent-sdk-types.js";

const TOOL_CALL_CONTENT_MAX_LENGTH = 64 * 1024;

function limitFailedShellError(item: AgentTimelineItem): AgentTimelineItem {
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "shell" ||
    item.status !== "failed" ||
    typeof item.error !== "object" ||
    item.error === null ||
    !("content" in item.error) ||
    typeof item.error.content !== "string" ||
    item.error.content.length <= TOOL_CALL_CONTENT_MAX_LENGTH
  ) {
    return item;
  }
  return {
    ...item,
    error: {
      ...item.error,
      content: item.error.content.slice(0, TOOL_CALL_CONTENT_MAX_LENGTH),
    },
  };
}

export function limitAgentTimelineItemContent(item: AgentTimelineItem): AgentTimelineItem {
  item = limitFailedShellError(item);
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "shell" ||
    typeof item.detail.output !== "string"
  ) {
    return item;
  }
  if (item.detail.output.length <= TOOL_CALL_CONTENT_MAX_LENGTH) {
    return item;
  }
  return {
    ...item,
    detail: {
      ...item.detail,
      output: item.detail.output.slice(0, TOOL_CALL_CONTENT_MAX_LENGTH),
    },
  };
}
