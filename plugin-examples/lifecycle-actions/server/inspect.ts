import type { AgentPermissionRequest, AgentTimelineItem } from "@getpaseo/protocol/agent-types";

export function latestOutputText(timeline: readonly AgentTimelineItem[]): string {
  let output = "";
  for (const item of timeline) {
    if (item.type === "user_message") {
      output = "";
    } else if ("text" in item && typeof item.text === "string") {
      output += item.text;
    } else {
      output += JSON.stringify(item) + "\n";
    }
  }
  return output;
}

export function shellCommand(request: AgentPermissionRequest): string | null {
  if (!request.input) {
    return null;
  }
  if (typeof request.input.command === "string") {
    return request.input.command;
  }
  if (typeof request.input.cmd === "string") {
    return request.input.cmd;
  }
  return null;
}
