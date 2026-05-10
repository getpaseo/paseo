import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  createEventStream,
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
  openCodeClient.eventStream = createEventStream(options.events ?? [idleEvent()]);
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

describe("OpenCode full-access mode", () => {
  test("includes virtual full-access mode with dynamic OpenCode agents", async () => {
    const { runtime } = mockOpenCodeClient({
      agents: [
        { name: "build", mode: "primary", hidden: false, description: "Build agent" },
        { name: "paseo-custom", mode: "primary", hidden: false, description: "Custom agent" },
      ],
    });

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, { runtime });
    const modes = await client.listModes({ cwd: "/tmp/project", force: false });

    expect(modes.map((mode) => mode.id)).toEqual(["build", "plan", "full-access", "paseo-custom"]);
    expect(modes.find((mode) => mode.id === "full-access")).toMatchObject({
      label: "Full Access",
      description: "Automatically approves all tool permission prompts for the session",
    });
  });

  test("reports full-access but sends prompts through OpenCode build agent", async () => {
    const { openCodeClient, runtime } = mockOpenCodeClient();

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, { runtime });
    const session = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      modeId: "full-access",
    });

    expect(await session.getCurrentMode()).toBe("full-access");

    await session.run("Implement the change");

    expect(openCodeClient.calls.sessionPromptAsync).toHaveLength(1);
    expect(openCodeClient.calls.sessionPromptAsync[0]).toEqual(
      expect.objectContaining({ agent: "build" }),
    );

    await session.close();
  });

  test("auto-approves tool permissions in full-access without surfacing them", async () => {
    const { openCodeClient, runtime } = mockOpenCodeClient({
      events: [toolPermissionEvent(), idleEvent()],
    });
    const receivedEvents: AgentStreamEvent[] = [];

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, { runtime });
    const session = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      modeId: "full-access",
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

  test("keeps questions separate from full-access tool auto-approval", async () => {
    const { openCodeClient, runtime } = mockOpenCodeClient({
      events: [questionEvent(), idleEvent()],
    });
    const receivedEvents: AgentStreamEvent[] = [];

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, { runtime });
    const session = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      modeId: "full-access",
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
