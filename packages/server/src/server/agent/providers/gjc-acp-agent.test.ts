import { expect, test } from "vitest";

import { parseGjcExtensionSubagents, parseGjcTurnSignal } from "./gjc-acp-agent.js";

test("parseGjcTurnSignal maps turn lifecycle methods", () => {
  expect(parseGjcTurnSignal("_gjc/sdk/turn/start", {})).toEqual({ type: "start" });
  expect(parseGjcTurnSignal("_gjc/sdk/turn/end", {})).toEqual({ type: "end" });
  expect(parseGjcTurnSignal("_gjc/sdk/turn/fail", { error: "boom" })).toEqual({
    type: "fail",
    error: "boom",
  });
  expect(parseGjcTurnSignal("_gjc/sdk/turn/fail", {})).toEqual({
    type: "fail",
    error: "Autonomous turn failed",
  });
  expect(parseGjcTurnSignal("_gjc/sdk/subagent/update", {})).toBeNull();
  expect(parseGjcTurnSignal("_kiro.dev/commands/available", {})).toBeNull();
});

test("parseGjcExtensionSubagents maps _gjc/sdk/subagent/update payloads", () => {
  const events = parseGjcExtensionSubagents("_gjc/sdk/subagent/update", {
    sessionId: "session-1",
    subagents: [
      {
        type: "upsert",
        id: "subagent-1",
        title: "Audit the repo",
        status: "running",
        toolCallId: "call-1",
        cwd: "/tmp/gjc",
        subtitle: "Sub-agent",
        timestamp: "2026-08-10T00:00:00Z",
      },
      {
        type: "timeline",
        id: "subagent-1",
        item: { type: "assistant_message", text: "Started", messageId: "m1" },
      },
      { type: "remove", id: "subagent-2" },
    ],
  });
  expect(events).toEqual([
    {
      type: "upsert",
      id: "subagent-1",
      title: "Audit the repo",
      status: "running",
      toolCallId: "call-1",
      cwd: "/tmp/gjc",
      subtitle: "Sub-agent",
      timestamp: "2026-08-10T00:00:00Z",
    },
    {
      type: "timeline",
      id: "subagent-1",
      item: { type: "assistant_message", text: "Started", messageId: "m1" },
    },
    { type: "remove", id: "subagent-2" },
  ]);
});

test("parseGjcExtensionSubagents accepts a single event object and ignores other methods", () => {
  expect(
    parseGjcExtensionSubagents("_gjc/sdk/subagent/update", {
      subagents: { type: "remove", id: "subagent-1" },
    }),
  ).toEqual([{ type: "remove", id: "subagent-1" }]);
  expect(parseGjcExtensionSubagents("_gjc/sdk/other", { subagents: [] })).toBeNull();
  expect(parseGjcExtensionSubagents("_kiro.dev/commands/available", {})).toBeNull();
});

test("parseGjcExtensionSubagents filters malformed entries and unknown statuses", () => {
  const events = parseGjcExtensionSubagents("_gjc/sdk/subagent/update", {
    subagents: [
      { type: "bogus", id: "x" },
      { type: "upsert", id: "" },
      { type: "upsert", id: "subagent-1", status: "weird" },
      { type: "timeline", id: "subagent-2" },
      42,
    ],
  });
  expect(events).toEqual([{ type: "upsert", id: "subagent-1" }]);
});

test("parseGjcExtensionSubagents validates timeline items and preserves explicit nulls", () => {
  const events = parseGjcExtensionSubagents("_gjc/sdk/subagent/update", {
    subagents: [
      // Invalid timeline rows: tool_call without detail would crash the
      // store's content bounding, and a partial tool_call (missing
      // callId/name/status/error) fails the protocol schema and the client
      // outbound validator.
      { type: "timeline", id: "sub-1", item: { type: "tool_call" } },
      { type: "timeline", id: "sub-2", item: { type: "assistant_message" } },
      {
        type: "timeline",
        id: "sub-2b",
        item: { type: "tool_call", detail: { type: "shell", output: "ok" } },
      },
      // A complete tool_call row passes through.
      {
        type: "timeline",
        id: "sub-3",
        item: {
          type: "tool_call",
          callId: "call-1",
          name: "bash",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "echo ok", output: "ok" },
        },
      },
      // Explicit nulls clear nullable fields; omissions retain them.
      { type: "upsert", id: "sub-4", title: null, description: "kept", cwd: null },
      { type: "upsert", id: "sub-5" },
    ],
  });
  expect(events).toEqual([
    {
      type: "timeline",
      id: "sub-3",
      item: {
        type: "tool_call",
        callId: "call-1",
        name: "bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "echo ok", output: "ok" },
      },
    },
    { type: "upsert", id: "sub-4", title: null, description: "kept", cwd: null },
    { type: "upsert", id: "sub-5" },
  ]);
});
