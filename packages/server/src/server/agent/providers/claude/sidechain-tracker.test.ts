import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeSidechainTracker } from "./sidechain-tracker.js";

describe("ClaudeSidechainTracker", () => {
  it("keeps a background child's card across the parent finishing", () => {
    const tracker = new ClaudeSidechainTracker({
      getToolInput: () => ({ subagent_type: "general-purpose", description: "List files" }),
      isDescriptorOwnedElsewhere: () => true,
    });
    const action = (id: string, command: string) =>
      ({
        type: "assistant",
        parent_tool_use_id: "task-1",
        message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
      }) as unknown as SDKMessage;
    const parentCards = (events: ReturnType<typeof tracker.handleMessage>) =>
      events.filter((event) => event.type === "timeline");
    const childCallIds = (events: ReturnType<typeof tracker.handleMessage>) =>
      events.flatMap((event) =>
        event.type === "provider_subagent" &&
        event.event.type === "timeline" &&
        event.event.item.type === "tool_call"
          ? [event.event.item.callId]
          : [],
      );

    expect(parentCards(tracker.handleMessage(action("ls", "ls -1"), "task-1"))).toHaveLength(1);
    expect(tracker.finishAll("completed")).toEqual([]);
    const afterFinish = tracker.handleMessage(action("pwd", "pwd"), "task-1");
    expect(parentCards(afterFinish)).toEqual([]);
    expect(childCallIds(afterFinish)).toEqual(["pwd"]);

    tracker.delete("task-1");
    const next = tracker.handleMessage(action("next", "ls"), "task-1");
    expect(parentCards(next)).toHaveLength(1);
    expect(childCallIds(next)).toEqual(["next"]);
  });

  it("shows a streamed child tool call's input once the assistant message brings it", () => {
    const tracker = new ClaudeSidechainTracker({ getToolInput: () => null });
    const frames = [
      {
        type: "stream_event",
        parent_tool_use_id: "task-1",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "bash-1", name: "Bash", input: {} },
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "task-1",
        message: {
          content: [
            { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "echo child" } },
          ],
        },
      },
    ] as unknown as SDKMessage[];

    const childCards = frames
      .flatMap((frame) => tracker.handleMessage(frame, "task-1"))
      .flatMap((event) =>
        event.type === "provider_subagent" &&
        event.event.type === "timeline" &&
        event.event.item.type === "tool_call"
          ? [event.event.item]
          : [],
      );

    expect(childCards.at(-1)).toMatchObject({
      callId: "bash-1",
      status: "running",
      detail: { type: "shell", command: "echo child" },
    });
  });

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
    const report = "    indented code\n\n## Verdict\n\n- **Coherent**";
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
              tool_name: "SubagentHandback",
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
