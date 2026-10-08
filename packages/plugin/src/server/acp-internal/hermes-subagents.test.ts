import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ProviderEvent } from "../provider.js";
import { HermesSubagents } from "./hermes-subagents.js";

function update(id: string, sequence: number, extra: Record<string, unknown> = {}): SessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: `hermes-subagent:${id}`,
    status: "in_progress",
    _meta: {
      hermes: {
        subagentProgress: {
          version: 1,
          id,
          sequence,
          parentId: null,
          depth: 1,
          status: "running",
          text: "",
          tools: [],
          ...extra,
        },
      },
    },
  };
}

function harness() {
  const events: ProviderEvent[] = [];
  const reducer = new HermesSubagents({
    sessionId: "root",
    cwd: "/fixture",
    emit: (event) => events.push(event),
  });
  return { reducer, events };
}

describe("Hermes ACP subagent snapshots", () => {
  it("routes concurrent/nested public output and tool activity into existing child sessions", () => {
    const { reducer, events } = harness();
    reducer.accept(
      update("nested", 3, { parentId: "alpha", depth: 2, text: "Nested public reply" }),
    );
    expect(events).toEqual([]);
    reducer.accept(update("beta", 2));
    reducer.accept(update("alpha", 1));
    reducer.accept(
      update("beta", 4, {
        text: "Beta reply",
        tools: ["terminal"],
        rawInput: { secret: "DO NOT SEND" },
      }),
    );
    expect(events.filter((event) => event.type === "session.opened")).toMatchObject([
      {
        sessionId: "root:hermes:beta",
        parentSessionId: "root",
        capabilities: [],
        restoration: "parent",
      },
      { sessionId: "root:hermes:alpha", parentSessionId: "root" },
      { sessionId: "root:hermes:nested", parentSessionId: "root:hermes:alpha" },
    ]);
    expect(events.filter((event) => event.type === "timeline.item")).toMatchObject([
      {
        sessionId: "root:hermes:nested",
        item: { type: "assistant_message", text: "Nested public reply" },
      },
      {
        sessionId: "root:hermes:beta",
        item: { type: "notification", message: "Started tool: terminal" },
      },
      { sessionId: "root:hermes:beta", item: { type: "assistant_message", text: "Beta reply" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("DO NOT SEND");
  });

  it.each(["completed", "failed", "canceled"])(
    "replays %s snapshots once and never revives terminal children",
    (status) => {
      const { reducer, events } = harness();
      const replay = update("child", 9, {
        status,
        text: "Retained public output",
        tools: ["read_file"],
      });
      expect(reducer.accept(replay)).toBe(true);
      const count = events.length;
      reducer.accept(replay);
      reducer.accept(update("child", 8));
      reducer.accept(update("child", 10));
      expect(events).toHaveLength(count);
      expect(events.at(-1)).toMatchObject({ type: "session.turn", state: status });
    },
  );

  it("leaves ordinary ACP and unknown versions to the standard path and rejects malformed identities", () => {
    const { reducer, events } = harness();
    expect(reducer.accept(update("child", 1, { version: 2 }))).toBe(false);
    expect(
      reducer.accept({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Root" },
      }),
    ).toBe(false);
    expect(reducer.accept(update("../private", 1))).toBe(false);
    reducer.accept(update("self", 1, { parentId: "self", depth: 2 }));
    reducer.accept(update("a", 1, { parentId: "b", depth: 2 }));
    reducer.accept(update("b", 2, { parentId: "a", depth: 3 }));
    reducer.accept(update("wrong-depth", 3, { parentId: "parent", depth: 3 }));
    reducer.accept(update("parent", 4));
    expect(events.filter((event) => event.type === "session.opened")).toHaveLength(1);
  });

  it("bounds children and fails only live children when the transport ends", () => {
    const { reducer, events } = harness();
    for (let index = 0; index < 70; index++) reducer.accept(update(`child-${index}`, index + 1));
    reducer.accept(update("child-0", 80, { status: "completed" }));
    reducer.finish("failed");
    expect(events.filter((event) => event.type === "session.opened")).toHaveLength(64);
    expect(
      events.filter((event) => event.type === "session.turn" && event.state === "failed"),
    ).toHaveLength(63);
    expect(
      events.filter((event) => event.type === "session.turn" && event.state === "completed"),
    ).toHaveLength(1);
  });
});
