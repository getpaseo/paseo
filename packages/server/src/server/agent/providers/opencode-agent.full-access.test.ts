import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: vi.fn(),
}));

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { createTestOpenCodeServerManager } from "./opencode/test-server-manager.js";

interface MockOpenCodeClientOptions {
  agents?: unknown[];
  events?: unknown[];
}

function createEventStream(events: unknown[]): AsyncGenerator<never> {
  return (async function* () {
    for (const event of events) {
      yield event as never;
    }
  })();
}

function mockOpenCodeClient(options: MockOpenCodeClientOptions = {}) {
  const promptAsync = vi.fn().mockResolvedValue({});
  const permissionReply = vi.fn().mockResolvedValue({});
  const questionReply = vi.fn().mockResolvedValue({});
  const questionReject = vi.fn().mockResolvedValue({});
  const appAgents = vi.fn().mockResolvedValue({ data: options.agents ?? [] });
  const events = options.events ?? [idleEvent()];

  vi.mocked(createOpencodeClient).mockReturnValue({
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
      promptAsync,
      abort: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    provider: {
      list: vi.fn().mockResolvedValue({ data: { connected: [], all: [] } }),
    },
    event: {
      subscribe: vi.fn().mockResolvedValue({ stream: createEventStream(events) }),
    },
    command: {
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
    app: {
      agents: appAgents,
    },
    permission: {
      reply: permissionReply,
    },
    question: {
      reply: questionReply,
      reject: questionReject,
    },
  } as never);

  return { appAgents, permissionReply, promptAsync, questionReject, questionReply };
}

function idleEvent(): unknown {
  return {
    type: "session.idle",
    properties: { sessionID: "session-1" },
  };
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("includes virtual full-access mode with dynamic OpenCode agents", async () => {
    const serverManager = createTestOpenCodeServerManager();
    mockOpenCodeClient({
      agents: [
        { name: "build", mode: "primary", hidden: false, description: "Build agent" },
        { name: "paseo-custom", mode: "primary", hidden: false, description: "Custom agent" },
      ],
    });

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, {
      serverManager,
    });
    const modes = await client.listModes({ cwd: "/tmp/project", force: false });

    expect(modes.map((mode) => mode.id)).toEqual(["build", "plan", "full-access", "paseo-custom"]);
    expect(modes.find((mode) => mode.id === "full-access")).toMatchObject({
      label: "Full Access",
      description: "Automatically approves all tool permission prompts for the session",
    });
  });

  test("reports full-access but sends prompts through OpenCode build agent", async () => {
    const serverManager = createTestOpenCodeServerManager();
    const { promptAsync } = mockOpenCodeClient();

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, {
      serverManager,
    });
    const session = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      modeId: "full-access",
    });

    expect(await session.getCurrentMode()).toBe("full-access");

    await session.run("Implement the change");

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({ agent: "build" }));

    await session.close();
  });

  test("auto-approves tool permissions in full-access without surfacing them", async () => {
    const serverManager = createTestOpenCodeServerManager();
    const { permissionReply } = mockOpenCodeClient({
      events: [toolPermissionEvent(), idleEvent()],
    });
    const receivedEvents: AgentStreamEvent[] = [];

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, {
      serverManager,
    });
    const session = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      modeId: "full-access",
    });
    session.subscribe((event) => receivedEvents.push(event));

    await session.run("Run verification");

    expect(permissionReply).toHaveBeenCalledTimes(1);
    expect(permissionReply).toHaveBeenCalledWith({
      requestID: "permission-1",
      directory: "/tmp/project",
      reply: "once",
    });
    expect(receivedEvents.filter((event) => event.type === "permission_requested")).toEqual([]);
    expect(session.getPendingPermissions()).toEqual([]);

    await session.close();
  });

  test("keeps questions separate from full-access tool auto-approval", async () => {
    const serverManager = createTestOpenCodeServerManager();
    const { permissionReply, questionReply } = mockOpenCodeClient({
      events: [questionEvent(), idleEvent()],
    });
    const receivedEvents: AgentStreamEvent[] = [];

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, {
      serverManager,
    });
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

    expect(questionReply).toHaveBeenCalledTimes(1);
    expect(questionReply).toHaveBeenCalledWith({
      requestID: "question-1",
      directory: "/tmp/project",
      answers: [["Proceed"]],
    });
    expect(permissionReply).not.toHaveBeenCalled();
    expect(session.getPendingPermissions()).toEqual([]);

    await session.close();
  });
});
