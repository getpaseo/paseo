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
  host.onToolStart({
    callId: start.toolCallId,
    toolName: start.toolName,
    args: start.args,
    status: "running",
    result: null,
  });
  const mapped = host.mapDialog(dialogs[0], "pi");
  if (mapped?.type !== "permission") throw new Error("Question permission missing");
  return { host, permission: mapped.request, firstDialog: dialogs[0] };
}

test("the form opens when the tool asks, and carries every question", () => {
  const host = createPiExtensionHost();
  expect(
    host.onToolStart({
      callId: start.toolCallId,
      toolName: start.toolName,
      args: start.args,
      status: "running",
      result: null,
    }),
  ).toBeUndefined();
  expect(host.mapDialog(dialogs[0], "pi")).toMatchObject({
    type: "permission",
    request: {
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
    },
  });
});

test("real rpiv RPC dialogs use one form and preserve choices, multi-select, and custom text", () => {
  const { host, permission } = startedHost();
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

test("cancellation declines the open dialog and each remaining real RPC dialog", () => {
  const { host, permission, firstDialog } = startedHost();
  expect(host.respondToPermission(permission, { behavior: "deny" })).toEqual({
    responses: [{ id: firstDialog.id, response: { cancelled: true } }],
  });
  for (const dialog of dialogs.slice(1)) {
    expect(host.mapDialog(dialog, "pi")).toEqual({
      type: "response",
      response: { cancelled: true },
    });
  }
});

test("a questionnaire pi would reject over its own caps never opens a form", () => {
  const host = createPiExtensionHost();
  const rejected = structuredClone(start.args);
  rejected.questions[0].header = "Brainstorm cadence"; // 18 chars, pi caps headers at 16
  host.onToolStart({
    callId: "rejected-call",
    toolName: start.toolName,
    args: rejected,
    status: "running",
    result: null,
  });
  // No orphan card, and the tool never reaches the point of asking, so the
  // generic dialog fallback stays available instead.
  expect(
    host.mapDialog({ ...dialogs[0], id: "orphan", title: "[Brainstorm cadence] Pick one?" }, "pi")
      ?.type,
  ).toBeUndefined();
});

test("two questionnaires keep separate forms and one form cannot cancel the other", () => {
  const host = createPiExtensionHost();
  const second = {
    questions: [
      {
        question: "Which drink?",
        header: "Drink",
        options: [
          { label: "Water", description: "Plain" },
          { label: "Juice", description: "Sweet" },
        ],
      },
    ],
  };
  host.onToolStart({
    callId: start.toolCallId,
    toolName: start.toolName,
    args: start.args,
    status: "running",
    result: null,
  });
  host.onToolStart({
    callId: "call_second",
    toolName: "ask_user_question",
    args: second,
    status: "running",
    result: null,
  });
  const firstForm = host.mapDialog(dialogs[0], "pi");
  const drinkDialog = {
    id: "drink-dialog",
    type: "extension_ui_request",
    method: "select",
    title: "[Drink] Which drink?",
    options: ["1. Water — Plain", "2. Juice — Sweet", "3. Type something."],
  };
  const secondForm = host.mapDialog(drinkDialog, "pi");
  expect(firstForm?.type).toBe("permission");
  expect(secondForm?.type).toBe("permission");

  // Closing the first questionnaire must not touch the second one.
  expect(host.respondToPermission(firstForm.request, { behavior: "deny" })).toEqual({
    responses: [{ id: dialogs[0].id, response: { cancelled: true } }],
  });
  expect(
    host.respondToPermission(secondForm.request, {
      behavior: "allow",
      updatedInput: { answers: { Drink: "Juice" } },
    }),
  ).toEqual({
    responses: [{ id: drinkDialog.id, response: { value: drinkDialog.options[1] } }],
  });
});

test("a form whose tool call already ended resolves nothing", () => {
  const { host, permission } = startedHost();
  host.onToolEnd({
    callId: start.toolCallId,
    toolName: start.toolName,
    args: start.args,
    status: "failed",
    result: null,
  });
  expect(host.respondToPermission(permission, { behavior: "deny" })).toEqual({ responses: [] });
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
  expect(session.getPendingPermissions()).toEqual([]);
  runtime.emit(dialogs[0]);
  const [permission] = session.getPendingPermissions();
  expect(permission.input?.questions).toHaveLength(3);
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
