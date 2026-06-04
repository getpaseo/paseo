import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  idleEvent,
  TestOpenCodeClient,
  TestOpenCodeRuntime,
} from "./opencode/test-utils/test-opencode-runtime.js";

interface MockOpenCodeClientOptions {
  agents?: unknown[];
  events?: unknown[];
}

function mockOpenCodeClient(options: MockOpenCodeClientOptions = {}) {
  const runtime = new TestOpenCodeRuntime();
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.appAgentsResponse = { data: options.agents ?? [] };
  openCodeClient.sessionPromptAsyncEvents = options.events ?? [idleEvent()];
  runtime.enqueueClient(openCodeClient);

  return { openCodeClient, runtime };
}

function toolPermissionEvent(): unknown {
  return {
    type: "permission.asked",
    properties: {
      id: "permission-1",
      sessionID: "session-1",
      permission: "bash",
      patterns: [],
      metadata: {
        command: "npm test",
        reason: "Run verification",
      },
    },
  };
}

function questionEvent(): unknown {
  return {
    type: "question.asked",
    properties: {
      id: "question-1",
      sessionID: "session-1",
      questions: [
        {
          question: "Which option should OpenCode use?",
          header: "Decision",
          options: [{ label: "Proceed", description: "Continue with the change" }],
        },
      ],
      tool: {
        messageID: "message-1",
        callID: "call-1",
      },
    },
  };
}

describe("OpenCode auto_accept feature", () => {
  test("lists OpenCode modes without the legacy virtual full-access mode", async () => {
    const { runtime } = mockOpenCodeClient({
      agents: [
        { name: "build", mode: "primary", hidden: false, description: "Build agent" },
        { name: "paseo-custom", mode: "primary", hidden: false, description: "Custom agent" },
      ],
    });

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
    const modes = await client.listModes({ cwd: "/tmp/project", force: false });

    expect(modes.map((mode) => mode.id)).toEqual(["build", "plan", "paseo-custom"]);
  });

  test("lists auto accept as a provider feature", async () => {
    const { runtime } = mockOpenCodeClient();

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
    const enabledFeatures = await client.listFeatures({
      provider: "opencode",
      cwd: "/tmp/project",
      featureValues: { auto_accept: true },
    });
    const legacyFeatures = await client.listFeatures({
      provider: "opencode",
      cwd: "/tmp/project",
      modeId: "full-access",
    });

    expect(enabledFeatures).toEqual([
      expect.objectContaining({
        type: "toggle",
        id: "auto_accept",
        label: "Auto Accept",
        value: true,
      }),
    ]);
    expect(legacyFeatures).toEqual([expect.objectContaining({ id: "auto_accept", value: true })]);
  });

  test("keeps legacy full-access as an alias for build plus auto accept", async () => {
    const { openCodeClient, runtime } = mockOpenCodeClient();

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
    const session = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      modeId: "full-access",
    });

    expect(await session.getCurrentMode()).toBe("build");
    expect(session.features).toEqual([expect.objectContaining({ id: "auto_accept", value: true })]);

    await session.run("Implement the change");

    expect(openCodeClient.calls.sessionPromptAsync).toHaveLength(1);
    expect(openCodeClient.calls.sessionPromptAsync[0]).toEqual(
      expect.objectContaining({ agent: "build" }),
    );

    await session.close();
  });

  test("resolves legacy full-access for provider-driven child creation", () => {
    const client = new OpenCodeAgentClient(createTestLogger());

    expect(
      client.resolveCreateConfig({
        provider: "opencode",
        requestedMode: "full-access",
        featureValues: undefined,
        parent: null,
        unattended: false,
        availableModes: [
          { id: "build", label: "Build" },
          { id: "plan", label: "Plan" },
        ],
      }),
    ).toEqual({ modeId: "build", featureValues: { auto_accept: true } });
  });

  test("inherits unattended callers as build plus auto accept", () => {
    const client = new OpenCodeAgentClient(createTestLogger());

    expect(
      client.resolveCreateConfig({
        provider: "opencode",
        requestedMode: undefined,
        featureValues: undefined,
        parent: {
          provider: "claude",
          modeId: "bypassPermissions",
          isUnattended: true,
        },
        unattended: true,
        availableModes: [
          { id: "build", label: "Build" },
          { id: "plan", label: "Plan" },
        ],
      }),
    ).toEqual({ modeId: "build", featureValues: { auto_accept: true } });
  });

  test("defaults unattended creation without a parent to build plus auto accept", () => {
    const client = new OpenCodeAgentClient(createTestLogger());

    expect(
      client.resolveCreateConfig({
        provider: "opencode",
        requestedMode: undefined,
        featureValues: undefined,
        parent: null,
        unattended: true,
        availableModes: [
          { id: "build", label: "Build" },
          { id: "plan", label: "Plan" },
        ],
      }),
    ).toEqual({ modeId: "build", featureValues: { auto_accept: true } });
  });

  test("preserves the selected OpenCode agent when inheriting auto accept from an OpenCode parent", () => {
    const client = new OpenCodeAgentClient(createTestLogger());

    expect(
      client.resolveCreateConfig({
        provider: "opencode",
        requestedMode: undefined,
        featureValues: undefined,
        parent: {
          provider: "opencode",
          modeId: "paseo-custom",
          isUnattended: true,
        },
        unattended: true,
        availableModes: [
          { id: "build", label: "Build" },
          { id: "plan", label: "Plan" },
          { id: "paseo-custom", label: "Paseo Custom" },
        ],
      }),
    ).toEqual({ modeId: "paseo-custom", featureValues: { auto_accept: true } });
  });

  test("auto-approves tool permissions when auto accept is enabled", async () => {
    const { openCodeClient, runtime } = mockOpenCodeClient({
      events: [toolPermissionEvent(), idleEvent()],
    });
    const receivedEvents: AgentStreamEvent[] = [];

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
    const session = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      featureValues: { auto_accept: true },
    });
    session.subscribe((event) => receivedEvents.push(event));

    await session.run("Run verification");

    expect(openCodeClient.calls.permissionReply).toHaveLength(1);
    expect(openCodeClient.calls.permissionReply[0]).toEqual({
      requestID: "permission-1",
      directory: "/tmp/project",
      reply: "once",
    });
    expect(receivedEvents.filter((event) => event.type === "permission_requested")).toEqual([]);
    expect(session.getPendingPermissions()).toEqual([]);

    await session.close();
  });

  test("keeps questions separate from auto accept tool approval", async () => {
    const { openCodeClient, runtime } = mockOpenCodeClient({
      events: [questionEvent(), idleEvent()],
    });
    const receivedEvents: AgentStreamEvent[] = [];

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
    const session = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      featureValues: { auto_accept: true },
    });
    session.subscribe((event) => receivedEvents.push(event));

    await session.run("Ask a question");

    expect(receivedEvents.filter((event) => event.type === "permission_requested")).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({
          id: "question-1",
          kind: "question",
        }),
      }),
    ]);
    expect(session.getPendingPermissions()).toHaveLength(1);

    await session.respondToPermission("question-1", {
      behavior: "allow",
      updatedInput: { answers: { Decision: "Proceed" } },
    });

    expect(openCodeClient.calls.questionReply).toHaveLength(1);
    expect(openCodeClient.calls.questionReply[0]).toEqual({
      requestID: "question-1",
      directory: "/tmp/project",
      answers: [["Proceed"]],
    });
    expect(openCodeClient.calls.permissionReply).toEqual([]);
    expect(session.getPendingPermissions()).toEqual([]);

    await session.close();
  });
});
