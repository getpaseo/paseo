import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import pino from "pino";
import { PiRpcAgentClient } from "../../agent.js";
import { PiHistoryMapper } from "../../history-mapper.js";
import { parseToolResult } from "../../tool-call-mapper.js";
import { FakePi } from "../../test-utils/fake-pi.js";
import { createPiExtensionHost } from "../index.js";
import { rpivAskUserQuestion } from "./index.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/rpc-session.json", import.meta.url), "utf8"),
);
const [start, ...rest] = fixture.frames;
const dialogs = rest.filter((frame: { type: string }) => frame.type === "extension_ui_request");
const end = rest.find((frame: { type: string }) => frame.type === "tool_execution_end");

function startedHost() {
  const host = createPiExtensionHost();
  const permission = host.onToolStart({
    callId: start.toolCallId,
    toolName: start.toolName,
    args: start.args,
    status: "running",
    result: null,
  });
  if (!permission) throw new Error("Question permission missing");
  return { host, permission };
}

test("real rpiv RPC dialogs use one form and preserve choices, multi-select, and custom text", () => {
  const { host, permission } = startedHost();
  expect(permission).toMatchObject({
    kind: "question",
    input: {
      questions: [
        {
          header: "Snack",
          options: [{ description: "Fresh fruit" }, { description: "Sweet treat" }],
          allowOther: true,
          multiSelect: false,
        },
        { header: "Colors", multiSelect: true },
        { header: "Project", allowOther: true },
      ],
    },
  });
  expect(host.mapDialog(dialogs[0], "pi")).toEqual({ type: "deferred" });
  expect(
    host.respondToPermission(permission, {
      behavior: "allow",
      updatedInput: {
        answers: { Snack: "Cookie", Colors: "Red, Blue", Project: "Nebula" },
      },
    }),
  ).toEqual({ responses: [{ id: dialogs[0].id, response: { value: dialogs[0].options[1] } }] });
  expect(host.mapDialog(dialogs[1], "pi")).toEqual({
    type: "response",
    response: { value: "1,2" },
  });
  expect(host.mapDialog(dialogs[2], "pi")).toEqual({
    type: "response",
    response: { value: dialogs[2].options[2] },
  });
  expect(host.mapDialog(dialogs[3], "pi")).toEqual({
    type: "response",
    response: { value: "Nebula" },
  });
});

test("cancellation declines each remaining real RPC dialog", () => {
  const { host, permission } = startedHost();
  expect(host.respondToPermission(permission, { behavior: "deny" })).toEqual({ responses: [] });
  for (const dialog of dialogs) {
    expect(host.mapDialog(dialog, "pi")).toEqual({
      type: "response",
      response: { cancelled: true },
    });
  }
});

test("captured result renders in live and history tool rows, while foreign shapes decline", () => {
  const call = {
    callId: end.toolCallId,
    toolName: end.toolName,
    args: start.args,
    status: "completed" as const,
    result: parseToolResult(end.result),
  };
  const live = createPiExtensionHost().mapToolCall(call);
  expect(live?.detail).toEqual({
    type: "plain_text",
    label: "Questions",
    text: "Which snack?: Cookie\nWhich colors?: Red, Blue\nWhat project name?: Nebula",
  });
  const history = new PiHistoryMapper("pi").mapMessages([
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: start.toolCallId, name: start.toolName, arguments: start.args },
      ],
    },
    {
      role: "toolResult",
      toolCallId: end.toolCallId,
      toolName: end.toolName,
      content: end.result.content,
      details: end.result.details,
    },
  ]);
  expect(history).toContainEqual(
    expect.objectContaining({
      type: "timeline",
      item: expect.objectContaining({
        type: "tool_call",
        status: "completed",
        detail: live?.detail,
      }),
    }),
  );
  expect(
    rpivAskUserQuestion.createSession().mapToolCall?.({
      ...call,
      result: parseToolResult({ content: [], details: { unrelated: true } }),
    }),
  ).toBeUndefined();
});

test("captured cancellation renders as cancelled in the tool row", () => {
  const cancelled = JSON.parse(
    readFileSync(new URL("./fixtures/cancel-result.json", import.meta.url), "utf8"),
  );
  const mapped = createPiExtensionHost().mapToolCall({
    callId: "cancelled",
    toolName: "ask_user_question",
    args: start.args,
    status: "completed",
    result: parseToolResult(cancelled.result),
  });
  expect(mapped?.detail).toEqual({ type: "plain_text", label: "Questions", text: "Cancelled" });
});

test("the Pi agent releases a deferred captured dialog when the form is answered", async () => {
  const pi = new FakePi();
  const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
  const session = await client.createSession({
    provider: "pi",
    cwd: "/tmp/paseo-pi-question-test",
  });
  const runtime = pi.latestSession();
  runtime.emit(start);
  const [permission] = session.getPendingPermissions();
  expect(permission.input?.questions).toHaveLength(3);
  runtime.emit(dialogs[0]);
  expect(runtime.extensionUiResponses).toEqual([]);
  await session.respondToPermission(permission.id, {
    behavior: "allow",
    updatedInput: {
      answers: { Snack: "Cookie", Colors: "Red, Blue", Project: "Nebula" },
    },
  });
  for (const dialog of dialogs.slice(1)) runtime.emit(dialog);
  expect(runtime.extensionUiResponses).toEqual([
    { id: dialogs[0].id, response: { value: dialogs[0].options[1] } },
    { id: dialogs[1].id, response: { value: "1,2" } },
    { id: dialogs[2].id, response: { value: dialogs[2].options[2] } },
    { id: dialogs[3].id, response: { value: "Nebula" } },
  ]);
  expect(session.getPendingPermissions()).toEqual([]);
  await session.close();
});
