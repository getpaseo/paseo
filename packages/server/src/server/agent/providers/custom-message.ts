import type { AgentTimelineItem } from "../agent-sdk-types.js";

/** Preserve extension context as an expandable tool row instead of assistant speech. */
export function mapCustomMessageToToolCall(
  message: { role: "custom"; customType?: unknown; details?: unknown },
  text: string,
  callId: string,
): Extract<AgentTimelineItem, { type: "tool_call" }> {
  const customType =
    typeof message.customType === "string" && message.customType.trim()
      ? message.customType
      : "custom-message";
  return {
    type: "tool_call",
    callId,
    name: customType,
    status: "completed",
    detail: { type: "plain_text", text },
    metadata: {
      synthetic: true,
      customType,
      ...(message.details === undefined ? {} : { details: message.details }),
    },
    error: null,
  };
}
