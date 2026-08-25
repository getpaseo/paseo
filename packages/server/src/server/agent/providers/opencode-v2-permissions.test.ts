import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientError } from "@opencode-ai/client";
import type { EventSubscribeOutput } from "@opencode-ai/client";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentSessionConfig, AgentStreamEvent, ToolCallDetail } from "../agent-sdk-types.js";
import { OpenCodeV2AgentClient } from "./opencode-v2-agent.js";
import {
  TestOpenCodeV2Client,
  TestOpenCodeV2Harness,
} from "./opencode-v2/test-utils/test-opencode-v2-harness.js";
import {
  buildOpenCodeV2PermissionRules,
  type OpenCodeV2PermissionRule,
} from "./opencode-v2/options.js";
import {
  applyOpenCodeV2PermissionConfig,
  resolveOpenCodeV2ConfigFile,
} from "./opencode-v2/permission-config.js";

const TEST_MODEL = "baseten/deepseek-ai/DeepSeek-V4-Flash-0731";

function buildConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: "opencode-v2",
    cwd: "/workspace/repo",
    model: TEST_MODEL,
    ...overrides,
  };
}

function v2Event(
  input: Omit<EventSubscribeOutput, "id" | "created" | "type"> & {
    type: EventSubscribeOutput["type"];
  },
): EventSubscribeOutput {
  return {
    id: "event-1",
    created: 1,
    ...input,
  } as EventSubscribeOutput;
}

function permissionAskedEvent(
  sessionId: string,
  id: string,
  action = "shell",
): EventSubscribeOutput {
  return v2Event({
    type: "permission.asked",
    data: {
      id,
      sessionID: sessionId,
      action,
      resources: ["bash"],
      metadata: { command: "ls -la", cwd: "/workspace" },
    },
  });
}

function formCreatedEvent(sessionId: string, formId: string): EventSubscribeOutput {
  return v2Event({
    type: "form.created",
    data: {
      form: {
        id: formId,
        sessionID: sessionId,
        title: "Pick an option",
        description: "Choose how to proceed",
        fields: [
          {
            key: "choice",
            title: "Choice",
            description: "Your selection",
            type: "string",
            required: true,
          },
        ],
      },
    },
  });
}

async function createSession(
  configOverrides: Partial<AgentSessionConfig> = {},
  configure?: (openCode: TestOpenCodeV2Client) => void,
): Promise<{
  readonly session: Awaited<ReturnType<OpenCodeV2AgentClient["createSession"]>>;
  readonly openCode: TestOpenCodeV2Client;
  readonly runtime: TestOpenCodeV2Harness;
}> {
  const runtime = new TestOpenCodeV2Harness();
  const openCode = new TestOpenCodeV2Client();
  configure?.(openCode);
  runtime.enqueueClient(openCode);
  const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const session = await client.createSession(buildConfig(configOverrides));
  return { session, openCode, runtime };
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  await assertion();
}

function collectPermissionEvents(session: {
  subscribe: (callback: (event: AgentStreamEvent) => void) => () => void;
}): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => {
    if (event.type === "permission_requested") {
      events.push(event);
    }
  });
  return events;
}

describe("buildOpenCodeV2PermissionRules", () => {
  test("default rules make sensitive native actions ask and safe ones allow", () => {
    const rules = buildOpenCodeV2PermissionRules(undefined, undefined);
    expect(rules).toBeDefined();
    const find = (action: string, resource = "*") =>
      rules!.find((rule) => rule.action === action && rule.resource === resource);
    expect(find("shell")).toMatchObject({ effect: "ask" });
    expect(find("edit")).toMatchObject({ effect: "ask" });
    expect(find("webfetch")).toMatchObject({ effect: "ask" });
    expect(find("websearch")).toMatchObject({ effect: "ask" });
    expect(find("external_directory")).toMatchObject({ effect: "ask" });
    expect(find("read")).toMatchObject({ effect: "allow" });
    expect(find("glob")).toMatchObject({ effect: "allow" });
    expect(find("grep")).toMatchObject({ effect: "allow" });
    expect(find("subagent")).toMatchObject({ effect: "allow" });
    // No catch-all: MCP tools fall through to the built-in agent's allow.
    expect(rules!.some((rule) => rule.action === "*")).toBe(false);
  });

  test("a string permission option appends a catch-all that wins", () => {
    const allow = buildOpenCodeV2PermissionRules({ permission: "allow" }, undefined);
    expect(allow!.at(-1)).toEqual({ action: "*", resource: "*", effect: "allow" });

    const deny = buildOpenCodeV2PermissionRules({ permission: "deny" }, undefined);
    expect(deny!.at(-1)).toEqual({ action: "*", resource: "*", effect: "deny" });
  });

  test("per-tool permission rules are appended in order", () => {
    const rules = buildOpenCodeV2PermissionRules(
      { permission: { shell: "allow", edit: { "**/*.ts": "allow" } } },
      undefined,
    );
    expect(rules!.slice(-2)).toEqual([
      { action: "shell", resource: "*", effect: "allow" },
      { action: "edit", resource: "**/*.ts", effect: "allow" },
    ]);
  });

  test("exact MCP preapproval grants map to the composite v2 action", () => {
    const rules = buildOpenCodeV2PermissionRules(undefined, {
      preapproved: [{ kind: "mcp", server: "echo-server", tool: "echo" }],
    });
    // With a tool policy the catch-all is ask so non-preapproved tools prompt.
    expect(rules!.some((rule) => rule.action === "*" && rule.effect === "ask")).toBe(true);
    expect(rules!).toContainEqual({
      action: "echo-server_echo",
      resource: "*",
      effect: "allow",
    });
  });

  test("MCP actions sanitize non-alphanumeric server/tool names", () => {
    const rules = buildOpenCodeV2PermissionRules(undefined, {
      preapproved: [{ kind: "mcp", server: "my.server", tool: "read-file" }],
    });
    expect(rules!).toContainEqual({
      action: "my_server_read-file",
      resource: "*",
      effect: "allow",
    });
  });
});

describe("applyOpenCodeV2PermissionConfig", () => {
  test("writes permissions into the isolated config, preserving other keys", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "paseo-oc2-perm-"));
    const configFile = path.join(home, ".config", "opencode", "opencode.json");
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify({ model: "test-model" }), "utf8");

    const rules: OpenCodeV2PermissionRule[] = [{ action: "shell", resource: "*", effect: "ask" }];
    applyOpenCodeV2PermissionConfig(rules, createTestLogger(), home);

    const written = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    expect(written.model).toBe("test-model");
    expect(written.permissions).toEqual(rules);

    rmSync(home, { recursive: true, force: true });
  });

  test("is a no-op when there are no rules", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "paseo-oc2-perm-"));
    applyOpenCodeV2PermissionConfig(undefined, createTestLogger(), home);
    expect(() => resolveOpenCodeV2ConfigFile({ ...process.env, PASEO_HOME: home })).not.toThrow();
    rmSync(home, { recursive: true, force: true });
  });
});

describe("opencode-v2 permission session behavior", () => {
  test("auto_accept auto-approves tool-kind requests without surfacing them", async () => {
    const { session, openCode } = await createSession({
      featureValues: { auto_accept: true },
    });
    const permissionEvents = collectPermissionEvents(session);

    const runPromise = session.run("Run a shell command");
    openCode.emitEvent(permissionAskedEvent("session-1", "perm-1"));

    await waitFor(() => expect(openCode.calls.permissionReply).toHaveLength(1));
    expect(openCode.calls.permissionReply).toEqual([
      { sessionID: "session-1", requestID: "perm-1", reply: "once" },
    ]);
    expect(session.getPendingPermissions()).toHaveLength(0);
    expect(permissionEvents).toHaveLength(0);

    openCode.emitEvent(
      v2Event({
        type: "session.text.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "ok",
        },
      }),
    );
    openCode.emitEvent(
      v2Event({ type: "session.execution.succeeded", data: { sessionID: "session-1" } }),
    );
    const result = await runPromise;
    expect(result.finalText).toBe("ok");
    await session.close();
  });

  test("auto_accept never auto-approves form (question-kind) requests", async () => {
    const { session, openCode } = await createSession({
      featureValues: { auto_accept: true },
    });
    const permissionEvents = collectPermissionEvents(session);

    const runPromise = session.run("Ask me a question");
    openCode.emitEvent(formCreatedEvent("session-1", "form-1"));

    await waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));
    expect(openCode.calls.formReply).toHaveLength(0);
    expect(openCode.calls.permissionReply).toHaveLength(0);
    const pending = session.getPendingPermissions();
    expect(pending[0]).toMatchObject({ id: "form-1", kind: "question" });
    expect(permissionEvents).toHaveLength(1);

    await session.respondToPermission("form-1", {
      behavior: "allow",
      updatedInput: { answers: { choice: "first" } },
    });
    expect(openCode.calls.formReply).toEqual([
      { sessionID: "session-1", formID: "form-1", answer: { choice: "first" } },
    ]);

    openCode.emitEvent(
      v2Event({
        type: "session.text.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "done",
        },
      }),
    );
    openCode.emitEvent(
      v2Event({ type: "session.execution.succeeded", data: { sessionID: "session-1" } }),
    );
    const result = await runPromise;
    expect(result.finalText).toBe("done");
    await session.close();
  });

  test("setFeature toggles auto_accept and listFeatures reports it", async () => {
    const { session, openCode } = await createSession();

    const features = session.features;
    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({ id: "auto_accept", type: "toggle", value: false });

    await session.setFeature("auto_accept", true);
    expect(session.features[0]?.value).toBe(true);

    const runPromise = session.run("Run a shell command");
    openCode.emitEvent(permissionAskedEvent("session-1", "perm-1"));
    await waitFor(() => expect(openCode.calls.permissionReply).toHaveLength(1));
    expect(session.getPendingPermissions()).toHaveLength(0);

    // Disabling restores surfacing.
    await session.setFeature("auto_accept", false);
    openCode.emitEvent(permissionAskedEvent("session-1", "perm-2"));
    await waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));
    expect(session.getPendingPermissions()[0]?.id).toBe("perm-2");

    openCode.emitEvent(
      v2Event({
        type: "session.text.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "done",
        },
      }),
    );
    openCode.emitEvent(
      v2Event({ type: "session.execution.succeeded", data: { sessionID: "session-1" } }),
    );
    await runPromise;
    await session.close();
  });

  test("setFeature rejects unknown feature ids", async () => {
    const { session } = await createSession();
    await expect(session.setFeature("nope", true)).rejects.toThrow(
      "Unknown feature 'nope' for opencode-v2",
    );
    await session.close();
  });

  test("deny with interrupt stops the agent after replying", async () => {
    const { session, openCode } = await createSession();

    const runPromise = session.run("Run a shell command");
    openCode.emitEvent(permissionAskedEvent("session-1", "perm-1"));
    await waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));

    await session.respondToPermission("perm-1", {
      behavior: "deny",
      message: "Not allowed",
      interrupt: true,
    });
    expect(openCode.calls.permissionReply).toEqual([
      { sessionID: "session-1", requestID: "perm-1", reply: "reject", message: "Not allowed" },
    ]);
    expect(openCode.calls.sessionInterrupt).toEqual([{ sessionID: "session-1", continue: true }]);
    expect(session.getPendingPermissions()).toHaveLength(0);

    openCode.emitEvent(
      v2Event({
        type: "session.text.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "done",
        },
      }),
    );
    openCode.emitEvent(
      v2Event({ type: "session.execution.succeeded", data: { sessionID: "session-1" } }),
    );
    await runPromise;
    await session.close();
  });

  test("deny without interrupt does not interrupt the session", async () => {
    const { session, openCode } = await createSession();

    const runPromise = session.run("Run a shell command");
    openCode.emitEvent(permissionAskedEvent("session-1", "perm-1"));
    await waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));

    await session.respondToPermission("perm-1", { behavior: "deny" });
    expect(openCode.calls.permissionReply).toEqual([
      { sessionID: "session-1", requestID: "perm-1", reply: "reject" },
    ]);
    expect(openCode.calls.sessionInterrupt).toHaveLength(0);

    openCode.emitEvent(
      v2Event({
        type: "session.text.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "done",
        },
      }),
    );
    openCode.emitEvent(
      v2Event({ type: "session.execution.succeeded", data: { sessionID: "session-1" } }),
    );
    await runPromise;
    await session.close();
  });

  test("allow-always replies 'always'", async () => {
    const { session, openCode } = await createSession();

    const runPromise = session.run("Run a shell command");
    openCode.emitEvent(permissionAskedEvent("session-1", "perm-1"));
    await waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));

    await session.respondToPermission("perm-1", {
      behavior: "allow",
      selectedActionId: "allow_always",
    });
    expect(openCode.calls.permissionReply).toEqual([
      { sessionID: "session-1", requestID: "perm-1", reply: "always" },
    ]);

    openCode.emitEvent(
      v2Event({
        type: "session.text.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "done",
        },
      }),
    );
    openCode.emitEvent(
      v2Event({ type: "session.execution.succeeded", data: { sessionID: "session-1" } }),
    );
    await runPromise;
    await session.close();
  });

  test("a stale permission reply is a graceful no-op", async () => {
    const { session, openCode } = await createSession(undefined, (client) => {
      client.permissionReplyError = new ClientError("UnexpectedStatus", {
        cause: { status: 404 },
      });
    });

    const runPromise = session.run("Run a shell command");
    openCode.emitEvent(permissionAskedEvent("session-1", "perm-1"));
    await waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));

    await expect(
      session.respondToPermission("perm-1", { behavior: "allow" }),
    ).resolves.toBeUndefined();
    expect(session.getPendingPermissions()).toHaveLength(0);

    openCode.emitEvent(
      v2Event({
        type: "session.text.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "done",
        },
      }),
    );
    openCode.emitEvent(
      v2Event({ type: "session.execution.succeeded", data: { sessionID: "session-1" } }),
    );
    await runPromise;
    await session.close();
  });

  test("a stale form reply is a graceful no-op", async () => {
    const { session, openCode } = await createSession(undefined, (client) => {
      client.formReplyError = new ClientError("UnexpectedStatus", { cause: { status: 404 } });
    });

    const runPromise = session.run("Ask me a question");
    openCode.emitEvent(formCreatedEvent("session-1", "form-1"));
    await waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));

    await expect(
      session.respondToPermission("form-1", {
        behavior: "allow",
        updatedInput: { answers: { choice: "first" } },
      }),
    ).resolves.toBeUndefined();
    expect(session.getPendingPermissions()).toHaveLength(0);

    openCode.emitEvent(
      v2Event({
        type: "session.text.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "done",
        },
      }),
    );
    openCode.emitEvent(
      v2Event({ type: "session.execution.succeeded", data: { sessionID: "session-1" } }),
    );
    await runPromise;
    await session.close();
  });

  test("a non-stale permission reply error still propagates", async () => {
    const { session, openCode } = await createSession(undefined, (client) => {
      client.permissionReplyError = new Error("network down");
    });

    const runPromise = session.run("Run a shell command");
    openCode.emitEvent(permissionAskedEvent("session-1", "perm-1"));
    await waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));

    await expect(session.respondToPermission("perm-1", { behavior: "allow" })).rejects.toThrow(
      "network down",
    );
    // The pending request stays for a retryable failure.
    expect(session.getPendingPermissions()).toHaveLength(1);

    openCode.emitEvent(
      v2Event({
        type: "session.text.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "done",
        },
      }),
    );
    openCode.emitEvent(
      v2Event({ type: "session.execution.succeeded", data: { sessionID: "session-1" } }),
    );
    await runPromise;
    await session.close();
  });

  test("a tool permission request surfaces full detail metadata", async () => {
    const { session, openCode } = await createSession();

    const runPromise = session.run("Run a shell command");
    openCode.emitEvent(permissionAskedEvent("session-1", "perm-1"));
    await waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));

    const pending = session.getPendingPermissions()[0]!;
    expect(pending).toMatchObject({
      id: "perm-1",
      kind: "tool",
      name: "shell",
      input: {
        command: "ls -la",
        cwd: "/workspace",
        resources: ["bash"],
      },
    });
    expect(pending.detail).toBeDefined();
    const detail = pending.detail as ToolCallDetail;
    expect(detail.type).toBe("shell");
    expect(detail.command).toBe("ls -la");

    openCode.emitEvent(
      v2Event({
        type: "session.text.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "done",
        },
      }),
    );
    openCode.emitEvent(
      v2Event({ type: "session.execution.succeeded", data: { sessionID: "session-1" } }),
    );
    await runPromise;
    await session.close();
  });
});

describe("opencode-v2 client permission config", () => {
  test("listFeatures reports the auto_accept toggle with the current value", async () => {
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: new TestOpenCodeV2Harness(),
      createClient: new TestOpenCodeV2Harness().createClient,
    });
    const features = await client.listFeatures(buildConfig());
    expect(features).toHaveLength(1);
    expect(features[0]).toMatchObject({ id: "auto_accept", type: "toggle", value: false });

    const enabled = await client.listFeatures(
      buildConfig({ featureValues: { auto_accept: true } }),
    );
    expect(enabled[0]?.value).toBe(true);
  });

  test("resolveCreateConfig enables auto_accept for unattended creates", () => {
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: new TestOpenCodeV2Harness(),
      createClient: new TestOpenCodeV2Harness().createClient,
    });
    const resolved = client.resolveCreateConfig({
      provider: "opencode-v2",
      requestedMode: undefined,
      featureValues: undefined,
      parent: null,
      unattended: true,
      availableModes: [],
    });
    expect(resolved.featureValues).toMatchObject({ auto_accept: true });
  });

  test("resolveCreateConfig leaves featureValues alone for interactive creates", () => {
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: new TestOpenCodeV2Harness(),
      createClient: new TestOpenCodeV2Harness().createClient,
    });
    const resolved = client.resolveCreateConfig({
      provider: "opencode-v2",
      requestedMode: undefined,
      featureValues: { other: 1 },
      parent: null,
      unattended: false,
      availableModes: [],
    });
    expect(resolved.featureValues).toEqual({ other: 1 });
  });

  test("isCreateConfigUnattended recognizes the auto_accept feature", () => {
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: new TestOpenCodeV2Harness(),
      createClient: new TestOpenCodeV2Harness().createClient,
    });
    expect(
      client.isCreateConfigUnattended({
        modeId: null,
        config: buildConfig(),
        availableModes: [],
      }),
    ).toBe(false);
    expect(
      client.isCreateConfigUnattended({
        modeId: null,
        config: buildConfig({ featureValues: { auto_accept: true } }),
        availableModes: [],
      }),
    ).toBe(true);
  });
});
