import { describe, expect, test, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { createPiExtensionHost } from "./index.js";
import { PiHistoryMapper } from "../history-mapper.js";
import { parseToolArgs, parseToolResult } from "../tool-call-mapper.js";
import type { PiExtension } from "./contract.js";
import { PiExtensionHost } from "./host.js";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import {
  ManualChildSessionScheduler,
  childEntry,
  createChildSessionFile,
  streamTexts,
} from "./child-session-fixture.js";

const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";

const throwingAdapter: PiExtension = {
  id: "throwing-test-adapter",
  createSession: () => ({
    mapToolCall: () => {
      throw new Error("tool failed");
    },
    mapDialog: () => {
      throw new Error("dialog failed");
    },
    respondToPermission: () => {
      throw new Error("response failed");
    },
    onToolStart: () => {
      throw new Error("start failed");
    },
    onToolEnd: () => {
      throw new Error("end failed");
    },
    mapCustomMessage: () => {
      throw new Error("custom failed");
    },
  }),
};

describe("Pi extension host", () => {
  test("declines a throwing adapter and preserves generic history", async () => {
    const host = createPiExtensionHost(undefined, [throwingAdapter]);
    const mapper = new PiHistoryMapper("pi", [], {}, host);
    const events = mapper.mapMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "other", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "other",
        content: [{ type: "text", text: "ok" }],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    expect(events.filter((event) => event.type === "timeline")).toHaveLength(3);
    expect(await mapper.hydrate()).toEqual([]);
  });

  test("declines throwing lifecycle and dialog hooks", () => {
    const host = createPiExtensionHost(undefined, [throwingAdapter]);
    const call = {
      callId: "x",
      toolName: "other",
      args: {},
      status: "running" as const,
      result: null,
    };
    expect(host.onToolStart(call)).toBeUndefined();
    expect(() => host.onToolEnd(call)).not.toThrow();
    expect(
      host.mapDialog(
        {
          type: "extension_ui_request",
          id: "ui-1",
          method: "select",
          title: "Pick",
          options: ["A"],
        },
        "pi",
      ),
    ).toBeUndefined();
    expect(
      host.respondToPermission(
        { id: "ui-1", provider: "pi", kind: "question", title: "Pick", input: { questions: [] } },
        { behavior: "allow" },
      ),
    ).toBeUndefined();
    expect(
      host.mapCustomMessage({ role: "custom", customType: "other", content: "hello" }),
    ).toBeUndefined();
  });

  test("rejected child hydration emits no events", async () => {
    const host = new PiExtensionHost(
      [
        {
          id: "child",
          createSession: () => ({
            mapToolCall: () => ({ childSessions: [{ id: "child-1", file: "unused" }] }),
          }),
        },
      ],
      undefined,
      2 * 1024 * 1024,
      async () => {
        throw new Error("read failed");
      },
    );
    const output = host.mapToolCall({
      callId: "x",
      toolName: "other",
      args: {},
      status: "completed",
      result: null,
    });
    expect(await output?.hydration).toEqual([]);
  });

  test("limits total child reads during replay", async () => {
    const reads: string[] = [];
    const host = new PiExtensionHost(
      [
        {
          id: "child",
          createSession: () => ({
            mapToolCall: () => ({
              childSessions: Array.from({ length: 10 }, (_, index) => ({
                id: String(index),
                file: String(index),
              })),
            }),
          }),
        },
      ],
      undefined,
      16 * 1024 * 1024,
      async (id) => {
        reads.push(id);
        return [];
      },
    );
    const output = host.mapToolCall({
      callId: "x",
      toolName: "other",
      args: {},
      status: "completed",
      result: null,
    });
    await output?.hydration;
    expect(reads).toHaveLength(8);
  });
  test("claims a tool, declines an unrelated one, and maps history like live events", () => {
    const host = createPiExtensionHost();
    const args = { agent: "scout", task: "Inspect files" };
    const result = parseToolResult({ content: [{ type: "text", text: "Found two files" }] });
    const live = host.mapToolCall({
      callId: "call-1",
      toolName: "subagent",
      args,
      status: "completed",
      result,
    });
    expect(live).toEqual(
      expect.objectContaining({
        detail: {
          type: "sub_agent",
          subAgentType: "scout",
          description: "Inspect files",
          log: "Found two files",
        },
      }),
    );
    expect(
      host.mapToolCall({
        callId: "call-2",
        toolName: "unrelated",
        args: {},
        status: "completed",
        result,
      }),
    ).toBeUndefined();

    const mapper = new PiHistoryMapper("pi");
    const events = mapper.mapMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: args }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "subagent",
        content: [{ type: "text", text: "Found two files" }],
      },
    ]);
    const completed = events.find(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.status === "completed",
    );
    expect(
      completed?.type === "timeline" && completed.item.type === "tool_call"
        ? completed.item.detail
        : null,
    ).toEqual(live?.detail);
    expect(parseToolArgs("subagent", args).toolName).toBe("subagent");
  });

  test("follows a child session file while the child runs", async () => {
    const file = createChildSessionFile(childEntry("user", "first", T1));
    const events: AgentStreamEvent[] = [];
    const scheduler = new ManualChildSessionScheduler();
    let polls = 0;
    const host = new PiExtensionHost(
      [
        {
          id: "child",
          createSession: () => ({
            mapToolCall: () => ({
              subagents: [{ type: "upsert" as const, id: "child-1", status: "running" as const }],
              childSessions: [{ id: "child-1", file }],
            }),
            poll: () => {
              polls += 1;
              return undefined;
            },
          }),
        },
      ],
      undefined,
      undefined,
      undefined,
      { onEvents: (batch) => events.push(...batch), scheduler, intervalMs: 1 },
    );
    const output = host.mapToolCall({
      callId: "x",
      toolName: "other",
      args: {},
      status: "running",
      result: null,
    });
    // Following replaces the one-shot read, so nothing is hydrated up front.
    expect(await output?.hydration).toEqual([]);
    await vi.waitFor(() => expect(streamTexts(events)).toEqual(["first"]));

    appendFileSync(file, childEntry("assistant", "second", T2));
    scheduler.runScheduled();
    await vi.waitFor(() => expect(streamTexts(events)).toEqual(["first", "second"]));
    expect(polls).toBeGreaterThan(0);

    host.close();
    appendFileSync(file, childEntry("assistant", "after close", T2));
    scheduler.runScheduled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(streamTexts(events)).toEqual(["first", "second"]);
  });
});
