import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { ProviderSubagentStore } from "../provider-subagents/store.js";
import { HermesAcpSubagents } from "./acp-hermes-subagents.js";

function snapshot(sequence: number, text: string, status = "running"): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: "hermes-subagent:alpha",
    title: "Hermes subagent",
    status: "in_progress",
    _meta: {
      hermes: {
        subagentProgress: {
          version: 1,
          id: "alpha",
          parentId: null,
          depth: 1,
          sequence,
          status,
          text,
          tools: ["terminal"],
        },
      },
    },
  };
}

describe("built-in ACP Hermes child events", () => {
  it("emits live text deltas and retains one full replay snapshot with terminal state", () => {
    const events: AgentStreamEvent[] = [];
    const children = new HermesAcpSubagents({
      provider: "acp",
      cwd: "/fixture",
      emit: (event) => events.push(event),
    });
    children.update(snapshot(1, "First"));
    children.update(snapshot(2, "First reply"));
    children.update(snapshot(3, "First reply", "completed"));
    const text = events.flatMap((event) =>
      event.type === "provider_subagent" &&
      event.event.type === "timeline" &&
      event.event.item.type === "assistant_message"
        ? [event.event.item.text]
        : [],
    );
    expect(text).toEqual(["First", " reply"]);
    const replay = children.replay();
    expect(replay).toMatchObject([
      {
        type: "provider_subagent",
        event: { type: "upsert", parentSubagentId: null, status: "completed", cwd: "/fixture" },
      },
      {
        type: "provider_subagent",
        event: {
          type: "timeline",
          item: { type: "notification", message: "Started tool: terminal" },
        },
      },
      {
        type: "provider_subagent",
        event: { type: "timeline", item: { type: "assistant_message", text: "First reply" } },
      },
    ]);
    children.finish("failed");
    expect(children.replay()).toEqual(replay);
  });
  it("replaces shortened and rewritten public snapshots without retaining old text", () => {
    const store = new ProviderSubagentStore();
    const children = new HermesAcpSubagents({
      provider: "acp",
      cwd: "/fixture",
      emit(event) {
        if (event.type === "provider_subagent") store.apply("root", "acp", event.event);
      },
    });
    children.update(snapshot(1, "Old public output"));
    const old = store.fetchTimeline("root", "acp-root:hermes:alpha");
    children.update(snapshot(2, "Short"));
    const shorter = store.fetchTimeline("root", "acp-root:hermes:alpha");
    expect(shorter.epoch).not.toBe(old.epoch);
    expect(shorter.rows.map((row) => row.item)).toEqual([
      expect.objectContaining({ type: "notification", message: "Started tool: terminal" }),
      expect.objectContaining({ type: "assistant_message", text: "Short" }),
    ]);
    children.update(snapshot(3, ""));
    expect(
      store
        .fetchTimeline("root", "acp-root:hermes:alpha")
        .rows.some((row) => row.item.type === "assistant_message" && row.item.text),
    ).toBe(false);
  });
});
