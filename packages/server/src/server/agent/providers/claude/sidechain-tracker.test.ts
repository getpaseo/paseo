import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeSidechainTracker } from "./sidechain-tracker.js";

describe("ClaudeSidechainTracker", () => {
  it("uses Claude's native agent name for the provider subagent title", () => {
    const tracker = new ClaudeSidechainTracker({
      getToolInput: () => ({
        name: "repo_researcher",
        subagent_type: "Explore",
        description: "Inspect the repository",
      }),
    });

    const events = tracker.handleMessage(
      {
        type: "assistant",
        parent_tool_use_id: "task-1",
        message: { content: [] },
      } as unknown as SDKMessage,
      "task-1",
    );

    expect(events[0]).toEqual({
      type: "provider_subagent",
      provider: "claude",
      event: {
        type: "upsert",
        id: "task-1",
        title: "repo_researcher",
        description: "Inspect the repository",
        status: "running",
        toolCallId: "task-1",
      },
    });
  });

  it("shows a SubagentHandback report as the subagent's final message", () => {
    const tracker = new ClaudeSidechainTracker({ getToolInput: () => null });
    const report = "## Verdict\n\n- **Coherent**";
    const frames = [
      {
        type: "stream_event",
        parent_tool_use_id: "task-1",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "handback-1",
            name: "SubagentHandback",
            input: {},
          },
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "task-1",
        message: {
          id: "msg-1",
          content: [
            {
              type: "tool_use",
              id: "handback-1",
              name: "SubagentHandback",
              input: { message: report },
            },
          ],
        },
      },
      {
        type: "user",
        parent_tool_use_id: "task-1",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "handback-1",
              content: [{ type: "text", text: '{"success":true}' }],
            },
          ],
        },
      },
    ];

    const childItems = frames
      .flatMap((frame) => tracker.handleMessage(frame as unknown as SDKMessage, "task-1"))
      .flatMap((event) =>
        event.type === "provider_subagent" && event.event.type === "timeline"
          ? [event.event.item]
          : [],
      );

    expect(childItems).toEqual([{ type: "assistant_message", text: report, messageId: "msg-1" }]);
  });
});
