import { setImmediate as waitForImmediate } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import pino from "pino";
import { PiRpcAgentClient } from "../../agent.js";
import { FakePi } from "../../test-utils/fake-pi.js";
import { createPiExtensionHost } from "../index.js";

describe("pi-ask-user adapter", () => {
  test("combines selection and comment, then answers the follow-up dialog", () => {
    const host = createPiExtensionHost();
    host.onToolStart({
      callId: "ask-1",
      toolName: "ask_user",
      args: { allowComment: true, allowFreeform: false },
      status: "running",
      result: null,
    });
    const mapped = host.mapDialog(
      {
        type: "extension_ui_request",
        id: "select-1",
        method: "select",
        title: "Pick one",
        options: ["A", "B"],
      },
      "pi",
    );
    expect(mapped?.type).toBe("permission");
    if (mapped?.type !== "permission") throw new Error("Expected a combined permission");
    expect(mapped.request.input?.questions).toHaveLength(2);
    expect(
      host.respondToPermission(mapped.request, {
        behavior: "allow",
        updatedInput: { answers: { Response: "B", Comment: "Looks good" } },
      }),
    ).toEqual({ responses: [{ id: "select-1", response: { value: "B" } }] });
    expect(
      host.mapDialog(
        {
          type: "extension_ui_request",
          id: "comment-1",
          method: "input",
          placeholder: "Optional comment (press Enter to skip)...",
        },
        "pi",
      ),
    ).toEqual({ type: "response", response: { value: "Looks good" } });
  });

  test("declines unrelated dialogs and cancels denied selection", () => {
    const host = createPiExtensionHost();
    expect(
      host.mapDialog(
        { type: "extension_ui_request", id: "other", method: "select", options: ["A"] },
        "pi",
      ),
    ).toBeUndefined();
    host.onToolStart({
      callId: "ask-2",
      toolName: "ask_user",
      args: { allowComment: true },
      status: "running",
      result: null,
    });
    const mapped = host.mapDialog(
      { type: "extension_ui_request", id: "select-2", method: "select", options: ["A"] },
      "pi",
    );
    if (mapped?.type !== "permission") throw new Error("Expected a combined permission");
    expect(host.respondToPermission(mapped.request, { behavior: "deny" })).toEqual({
      responses: [{ id: "select-2", response: { cancelled: true } }],
    });
  });

  test("honours selectedActionId on an allow and rejects unmatched or bare allow without cancelling", async () => {
    const pi = new FakePi();
    const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
    const session = await client.createSession({
      provider: "pi",
      cwd: "/tmp/paseo-pi-ask-user-test",
    });
    const runtime = pi.latestSession();

    await session.startTurn("ask");
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "ask-3",
      toolName: "ask_user",
      args: { allowComment: true, allowFreeform: false },
    });
    runtime.emit({
      type: "extension_ui_request",
      id: "select-3",
      method: "select",
      title: "Pick one",
      options: ["Yes", "No"],
    });

    await expect(
      session.respondToPermission("select-3", { behavior: "allow", selectedActionId: "Sure" }),
    ).rejects.toThrow(/"Yes", "No"/);
    await expect(session.respondToPermission("select-3", { behavior: "allow" })).rejects.toThrow(
      /must name the option/,
    );
    expect(runtime.extensionUiResponses).toEqual([]);
    expect(session.getPendingPermissions()).toHaveLength(1);

    await session.respondToPermission("select-3", { behavior: "allow", selectedActionId: "Yes" });
    expect(runtime.extensionUiResponses).toEqual([{ id: "select-3", response: { value: "Yes" } }]);
    expect(session.getPendingPermissions()).toEqual([]);

    runtime.emit({
      type: "extension_ui_request",
      id: "comment-3",
      method: "input",
      placeholder: "Optional comment (press Enter to skip)...",
    });
    expect(runtime.extensionUiResponses).toEqual([
      { id: "select-3", response: { value: "Yes" } },
      { id: "comment-3", response: { value: "" } },
    ]);
    await session.close();
  });

  test("steers a denial reason before cancelling a combined pi-ask-user permission", async () => {
    const pi = new FakePi();
    const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
    const session = await client.createSession({
      provider: "pi",
      cwd: "/tmp/paseo-pi-ask-user-deny-steer-test",
    });
    const runtime = pi.latestSession();

    await session.startTurn("ask");
    runtime.emit({ type: "agent_start" });
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "ask-deny-1",
      toolName: "ask_user",
      args: { allowComment: true, allowFreeform: false },
    });
    runtime.emit({
      type: "extension_ui_request",
      id: "select-deny-1",
      method: "select",
      title: "Pick one",
      options: ["Yes", "No"],
    });

    let releaseSteer!: () => void;
    runtime.steerCompletion = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });

    const respondPromise = session.respondToPermission("select-deny-1", {
      behavior: "deny",
      message: "skip the survey and proceed with defaults",
    });
    await waitForImmediate();

    expect(runtime.steerCalls).toHaveLength(1);
    expect(runtime.steerCalls[0]?.message).toContain("skip the survey and proceed with defaults");
    expect(runtime.extensionUiResponses).toEqual([]);

    releaseSteer();
    await respondPromise;

    expect(runtime.rpcCallOrder).toEqual(["steer", "extension_ui_response"]);
    expect(runtime.extensionUiResponses).toEqual([
      { id: "select-deny-1", response: { cancelled: true } },
    ]);
    await session.close();
  });
});
