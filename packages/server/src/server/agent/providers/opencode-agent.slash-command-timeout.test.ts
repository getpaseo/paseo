import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@opencode-ai/sdk/v2/client", () => ({
  createOpencodeClient: vi.fn(),
}));

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { createTestOpenCodeServerManager } from "./opencode/test-server-manager.js";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("OpenCodeAgentSession slash command timeout handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("lists only OpenCode built-in slash commands Paseo can execute", async () => {
    vi.mocked(createOpencodeClient).mockReturnValue({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
      },
      provider: {
        list: vi.fn().mockResolvedValue({
          data: {
            connected: ["openai"],
            all: [{ id: "openai", name: "OpenAI", models: {} }],
          },
        }),
      },
      command: {
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
      app: {
        agents: vi.fn().mockResolvedValue({ data: [] }),
      },
    } as never);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, {
      serverManager: createTestOpenCodeServerManager(),
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp" });

    await expect(session.listCommands?.()).resolves.toEqual(
      expect.arrayContaining([
        { name: "compact", description: "Compact the current session", argumentHint: "" },
      ]),
    );
    await expect(session.listCommands?.()).resolves.not.toEqual(
      expect.arrayContaining([
        { name: "models", description: expect.any(String), argumentHint: "" },
      ]),
    );
  });

  test("executes compact through the OpenCode summarize endpoint", async () => {
    const command = vi.fn();
    const summarize = vi.fn().mockResolvedValue({ data: {} });

    vi.mocked(createOpencodeClient).mockReturnValue({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
        command,
        summarize,
      },
      provider: {
        list: vi.fn().mockResolvedValue({
          data: {
            connected: ["openai"],
            all: [{ id: "openai", name: "OpenAI", models: {} }],
          },
        }),
      },
      event: {
        subscribe: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield {
              type: "session.idle",
              properties: { sessionID: "session-1" },
            };
          })(),
        }),
      },
      command: {
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
      app: {
        agents: vi.fn().mockResolvedValue({ data: [] }),
      },
    } as never);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, {
      serverManager: createTestOpenCodeServerManager(),
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp" });

    await expect(session.run("/compact")).resolves.toMatchObject({
      sessionId: "session-1",
      finalText: "",
      timeline: [],
      usage: undefined,
    });
    expect(summarize).toHaveBeenCalledWith({ sessionID: "session-1", directory: "/tmp" });
    expect(command).not.toHaveBeenCalled();
  });

  test("waits for SSE completion when slash commands hit a header timeout", async () => {
    const idleEventGate = createDeferred<void>();

    vi.mocked(createOpencodeClient).mockReturnValue({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }),
        command: vi.fn().mockRejectedValue(new Error("fetch failed: Headers Timeout Error")),
      },
      provider: {
        list: vi.fn().mockResolvedValue({
          data: {
            connected: ["openai"],
            all: [{ id: "openai", name: "OpenAI", models: {} }],
          },
        }),
      },
      event: {
        subscribe: vi.fn().mockResolvedValue({
          stream: (async function* () {
            await idleEventGate.promise;
            yield {
              type: "session.idle",
              properties: { sessionID: "session-1" },
            };
          })(),
        }),
      },
      command: {
        list: vi.fn().mockResolvedValue({
          data: [{ name: "help", description: "Show help", hints: [] }],
        }),
      },
      app: {
        agents: vi.fn().mockResolvedValue({ data: [] }),
      },
    } as never);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, undefined, {
      serverManager: createTestOpenCodeServerManager(),
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp" });

    const runPromise = session.run("/help");
    await Promise.resolve();
    idleEventGate.resolve();

    await expect(runPromise).resolves.toMatchObject({
      sessionId: "session-1",
      finalText: "",
      timeline: [],
      usage: undefined,
    });
  });
});
