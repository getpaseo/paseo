import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import type { Api, Model } from "@mariozechner/pi-ai";
import pino from "pino";

import type { AgentStreamEvent } from "../agent-sdk-types.js";
import {
  PiDirectAgentClient,
  PiDirectAgentSession,
  type PiDirectSessionRuntimeAdapter,
  type PiDirectSessionAdapter,
} from "./pi-direct-agent.js";

function createPiSession(prompt: () => Promise<void>): PiDirectSessionAdapter {
  return {
    sessionId: "pi-session-1",
    thinkingLevel: "medium",
    model: undefined,
    messages: [],
    extensionRunner: undefined,
    promptTemplates: [],
    resourceLoader: {
      getSkills: () => ({ skills: [] }),
    },
    agent: {
      state: {
        systemPrompt: "",
        errorMessage: null,
      },
    },
    sessionManager: {
      getSessionFile: () => "/tmp/pi-session.json",
      getCwd: () => "/tmp/paseo-pi-test",
    },
    subscribe: vi.fn(),
    prompt,
    abort: vi.fn(),
    dispose: vi.fn(),
    getSessionStats: vi.fn(() => ({})),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
  };
}

function createPiRuntime(
  session: PiDirectSessionAdapter,
  dispose: () => Promise<void> = vi.fn(async () => undefined),
): PiDirectSessionRuntimeAdapter {
  return {
    session,
    dispose,
  };
}

function createPiModel(provider: string, id: string): Model<Api> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  } as Model<Api>;
}

describe("PiDirectAgentSession", () => {
  test("treats SDK request abort rejections as turn cancellations", async () => {
    const session = new PiDirectAgentSession(
      createPiRuntime(createPiSession(() => Promise.reject(new Error("Request was aborted.")))),
      { find: vi.fn(), getAll: vi.fn(() => []) },
      {
        provider: "pi",
        cwd: "/tmp/paseo-pi-test",
      },
    );
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const { turnId } = await session.startTurn("hello");
    await Promise.resolve();

    expect(events).toEqual([
      {
        type: "turn_canceled",
        provider: "pi",
        turnId,
        reason: "Request was aborted.",
      },
    ]);
  });

  test("setModel creates a minimal model for new ids under a known provider", async () => {
    const sdkSession = createPiSession(async () => undefined);
    const session = new PiDirectAgentSession(
      createPiRuntime(sdkSession),
      {
        find: vi.fn(() => undefined),
        getAll: vi.fn(() => [createPiModel("openrouter", "known-model")]),
      },
      {
        provider: "pi",
        cwd: "/tmp/paseo-pi-test",
      },
    );

    await session.setModel("openrouter/blabal");

    expect(sdkSession.setModel).toHaveBeenCalledWith({
      id: "blabal",
      name: "blabal",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://example.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
      compat: undefined,
    });
  });
});

describe("PiDirectAgentClient", () => {
  test("lists only Pi models with configured auth", async () => {
    const client = new PiDirectAgentClient({
      logger: pino({ level: "silent" }),
    });
    const registry = {
      find: vi.fn(),
      getAll: vi.fn(() => [createPiModel("amazon-bedrock", "claude-sonnet-4")]),
      getAvailable: vi.fn(() => [createPiModel("anthropic", "claude-opus-4-5")]),
    };
    (client as unknown as { modelRegistry: typeof registry }).modelRegistry = registry;

    const models = await client.listModels({ cwd: "/tmp/paseo-pi-test", force: false });

    expect(registry.getAvailable).toHaveBeenCalledTimes(1);
    expect(registry.getAll).not.toHaveBeenCalled();
    expect(models.map((model) => model.id)).toEqual(["anthropic/claude-opus-4-5"]);
  });

  test("loads project extensions before listing available models", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "paseo-pi-extension-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    try {
      const agentDir = join(testRoot, "agent");
      const cwd = join(testRoot, "project");
      const extensionDir = join(cwd, ".pi", "extensions");
      process.env.PI_CODING_AGENT_DIR = agentDir;

      await mkdir(extensionDir, { recursive: true });
      await writeFile(
        join(extensionDir, "dummy-provider.ts"),
        `
export default function(pi) {
  pi.registerProvider("paseo-dummy", {
    baseUrl: "https://example.invalid/v1",
    apiKey: "paseo-test-key",
    api: "openai-responses",
    models: [
      {
        id: "extension-model",
        name: "Extension Model",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096
      }
    ]
  });
}
`,
        "utf-8",
      );

      const client = new PiDirectAgentClient({
        logger: pino({ level: "silent" }),
      });

      const models = await client.listModels({ cwd, force: false });

      expect(models.map((model) => model.id)).toContain("paseo-dummy/extension-model");
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  test("creates sessions with project extension models and exposes extension commands", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "paseo-pi-extension-session-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    try {
      const agentDir = join(testRoot, "agent");
      const cwd = join(testRoot, "project");
      const extensionDir = join(cwd, ".pi", "extensions");
      const shutdownMarker = join(testRoot, "shutdown.txt");
      process.env.PI_CODING_AGENT_DIR = agentDir;

      await mkdir(extensionDir, { recursive: true });
      await writeFile(
        join(extensionDir, "dummy-command.ts"),
        `
import { writeFileSync } from "node:fs";

export default function(pi) {
  pi.registerProvider("paseo-dummy", {
    baseUrl: "https://example.invalid/v1",
    apiKey: "paseo-test-key",
    api: "openai-responses",
    models: [
      {
        id: "extension-model",
        name: "Extension Model",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096
      }
    ]
  });

  pi.registerCommand("dummy-command", {
    description: "Dummy extension command",
    handler: async () => {}
  });

  pi.on("session_shutdown", async () => {
    writeFileSync(${JSON.stringify(shutdownMarker)}, "closed");
  });
}
`,
        "utf-8",
      );

      const client = new PiDirectAgentClient({
        logger: pino({ level: "silent" }),
      });
      const session = await client.createSession({
        provider: "pi",
        cwd,
        model: "paseo-dummy/extension-model",
      });
      let closed = false;

      try {
        await expect(session.listCommands()).resolves.toContainEqual({
          name: "dummy-command",
          description: "Dummy extension command",
          argumentHint: "",
        });
        await session.close();
        closed = true;
        await expect(readFile(shutdownMarker, "utf-8")).resolves.toBe("closed");
      } finally {
        if (!closed) {
          await session.close();
        }
      }
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
