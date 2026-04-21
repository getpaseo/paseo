import { describe, expect, test, vi } from "vitest";

import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { PiDirectAgentSession, type PiDirectSessionAdapter } from "./pi-direct-agent.js";

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
