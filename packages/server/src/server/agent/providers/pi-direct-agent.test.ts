import { describe, expect, test, vi } from "vitest";
import type { Api, Model } from "@mariozechner/pi-ai";
import pino from "pino";

import type { AgentStreamEvent } from "../agent-sdk-types.js";
import {
  PiDirectAgentClient,
  PiDirectAgentSession,
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
    setThinkingLevel: vi.fn(),
  };
}

function createPiModel(provider: string, id: string): Model<Api> {
  return {
    provider,
    id,
    name: id,
    reasoning: true,
  } as Model<Api>;
}

describe("PiDirectAgentSession", () => {
  test("treats SDK request abort rejections as turn cancellations", async () => {
    const session = new PiDirectAgentSession(
      createPiSession(() => Promise.reject(new Error("Request was aborted."))),
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
});
