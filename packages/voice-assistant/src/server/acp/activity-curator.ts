import type { AgentUpdate } from "./types.js";

/**
 * Curate agent activity updates into a human-readable, token-efficient format
 * Consolidates message chunks, formats tool calls, and structures output cleanly
 */
export function curateAgentActivity(updates: AgentUpdate[]): string {
  const sections: string[] = [];

  // Group updates by type and consolidate
  let currentMessage = "";
  let currentThought = "";
  const toolCalls: Array<{ timestamp: Date; data: any }> = [];
  const plans: Array<{ timestamp: Date; data: any }> = [];

  for (const update of updates) {
    const updateType = update.notification.update.sessionUpdate;
    const content = (update.notification.update as any).content;

    switch (updateType) {
      case "agent_message_chunk":
        if (content?.type === "text" && content?.text) {
          currentMessage += content.text;
        }
        break;

      case "agent_thought_chunk":
        if (content?.type === "text" && content?.text) {
          currentThought += content.text;
        }
        break;

      case "tool_call":
      case "tool_call_update":
        toolCalls.push({
          timestamp: update.timestamp,
          data: update.notification.update,
        });
        break;

      case "plan":
        plans.push({
          timestamp: update.timestamp,
          data: (update.notification.update as any).entries,
        });
        break;
    }
  }

  // Format consolidated message
  if (currentMessage.trim()) {
    sections.push("## Agent Response\n\n" + currentMessage.trim());
  }

  // Format consolidated thoughts
  if (currentThought.trim()) {
    sections.push(
      "## Agent Thoughts\n\n```\n" + currentThought.trim() + "\n```"
    );
  }

  // Format tool calls
  if (toolCalls.length > 0) {
    const toolSection = ["## Tool Calls\n"];

    // Group tool calls by toolCallId to show lifecycle
    const toolGroups = new Map<string, typeof toolCalls>();
    for (const call of toolCalls) {
      const toolCallId = call.data.toolCallId || "unknown";
      if (!toolGroups.has(toolCallId)) {
        toolGroups.set(toolCallId, []);
      }
      toolGroups.get(toolCallId)!.push(call);
    }

    for (const [toolCallId, calls] of toolGroups) {
      const latestCall = calls[calls.length - 1];
      const data = latestCall.data;

      toolSection.push(`\n### ${data.title || data.kind || "Tool"}`);
      toolSection.push(`- **Status**: ${data.status || "unknown"}`);
      toolSection.push(`- **Call ID**: ${toolCallId.slice(0, 8)}...`);

      if (data.rawInput && Object.keys(data.rawInput).length > 0) {
        toolSection.push(`- **Input**: ${JSON.stringify(data.rawInput, null, 2)}`);
      }

      if (data.rawOutput && Object.keys(data.rawOutput).length > 0) {
        toolSection.push(`- **Output**: ${JSON.stringify(data.rawOutput, null, 2)}`);
      }

      if (data.content && data.content.length > 0) {
        toolSection.push(`- **Content**: ${formatToolContent(data.content)}`);
      }
    }

    sections.push(toolSection.join("\n"));
  }

  // Format plans
  if (plans.length > 0) {
    const latestPlan = plans[plans.length - 1];
    const planSection = ["## Plan\n"];

    for (const entry of latestPlan.data) {
      const icon =
        entry.status === "completed" ? "✅" :
        entry.status === "in_progress" ? "🔄" :
        "⏳";

      const priority =
        entry.priority === "high" ? "🔴" :
        entry.priority === "medium" ? "🟡" :
        "🟢";

      planSection.push(`${icon} ${priority} ${entry.content}`);
    }

    sections.push(planSection.join("\n"));
  }

  return sections.join("\n\n---\n\n") || "No activity to display.";
}

/**
 * Format tool call content into readable text
 */
function formatToolContent(content: any[]): string {
  return content
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }
      if (item.type === "image") {
        return `[Image: ${item.source || "embedded"}]`;
      }
      return JSON.stringify(item);
    })
    .join("\n");
}
