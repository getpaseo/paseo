import { describe, expect, test, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { toAgentPayload } from "./agent-projections.js";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentSession,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";

function createFakeClaudeQuery() {
  async function* empty() {
    // Keep the query generator idle until closed.
  }
  const gen = empty();
  return Object.assign(gen, {
    interrupt: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    supportedCommands: vi.fn(async () => []),
    supportedModels: vi.fn(async () => []),
    mcpServerStatus: vi.fn(async () => []),
    accountInfo: vi.fn(async () => ({})),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
    close: vi.fn(() => {}),
  });
}

describe("Claude prompt suggestions", () => {
  test("enables promptSuggestions for normal sessions and disables them for internal sessions", async () => {
    const queryFactory = vi.fn(() => createFakeClaudeQuery());
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: queryFactory as never,
    });

    const normal = await client.createSession({ provider: "claude", cwd: process.cwd() });
    const internal = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      internal: true,
    });

    try {
      await normal.startTurn("hello");
      await internal.startTurn("summarize");

      const normalOptions = (queryFactory.mock.calls as unknown[][])[0]?.[0] as {
        options?: Record<string, unknown>;
      };
      const internalOptions = (queryFactory.mock.calls as unknown[][])[1]?.[0] as {
        options?: Record<string, unknown>;
      };
      expect(normalOptions.options?.promptSuggestions).toBe(true);
      expect(internalOptions.options?.promptSuggestions).toBe(false);
    } finally {
      await normal.close();
      await internal.close();
    }
  });

  test("translates prompt_suggestion messages only when idle and non-internal", async () => {
    const queryFactory = vi.fn(() => createFakeClaudeQuery());
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: queryFactory as never,
    });

    const normal = await client.createSession({ provider: "claude", cwd: process.cwd() });
    const internalSession = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      internal: true,
    });
    const normalInternals = normal as unknown as {
      translateMessageToEvents(message: SDKMessage): Promise<AgentStreamEvent[]>;
    };
    const internalInternals = internalSession as unknown as {
      translateMessageToEvents(message: SDKMessage): Promise<AgentStreamEvent[]>;
    };

    try {
      // Idle normal session emits trimmed suggestion.
      await expect(
        normalInternals.translateMessageToEvents({
          type: "prompt_suggestion",
          suggestion: "  Run the unit tests  ",
          uuid: "00000000-0000-0000-0000-000000000001",
          session_id: "session-1",
        } as unknown as SDKMessage),
      ).resolves.toContainEqual({
        type: "prompt_suggestion",
        provider: "claude",
        suggestion: "Run the unit tests",
      });

      // Blank suggestions are dropped.
      await expect(
        normalInternals.translateMessageToEvents({
          type: "prompt_suggestion",
          suggestion: "   ",
          uuid: "00000000-0000-0000-0000-000000000002",
          session_id: "session-1",
        } as unknown as SDKMessage),
      ).resolves.toEqual([]);

      // Internal sessions ignore suggestions.
      const internalEvents = await internalInternals.translateMessageToEvents({
        type: "prompt_suggestion",
        suggestion: "Ignored",
        uuid: "00000000-0000-0000-0000-000000000003",
        session_id: "session-2",
      } as unknown as SDKMessage);
      expect(internalEvents.filter((event) => event.type === "prompt_suggestion")).toEqual([]);

      // Busy sessions ignore stale suggestions while a turn is active.
      await normal.startTurn("next prompt");
      await expect(
        normalInternals.translateMessageToEvents({
          type: "prompt_suggestion",
          suggestion: "Stale suggestion",
          uuid: "00000000-0000-0000-0000-000000000004",
          session_id: "session-1",
        } as unknown as SDKMessage),
      ).resolves.toEqual([]);
    } finally {
      await normal.close();
      await internalSession.close();
    }
  });
});

describe("AgentManager promptSuggestion lifecycle", () => {
  class ScriptedSession implements AgentSession {
    readonly provider = "claude" as const;
    readonly capabilities = {
      supportsStreaming: true,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    };
    private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
    readonly id = "scripted-session";
    private turnCount = 0;

    emit(event: AgentStreamEvent): void {
      for (const listener of this.listeners) {
        listener(event);
      }
    }

    subscribe(listener: (event: AgentStreamEvent) => void): () => void {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }

    async startTurn(_prompt: AgentPromptInput): Promise<{ turnId: string }> {
      this.turnCount += 1;
      const turnId = `turn-${this.turnCount}`;
      this.emit({ type: "turn_started", provider: "claude", turnId });
      return { turnId };
    }

    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
    describePersistence(): AgentPersistenceHandle | null {
      return null;
    }
    getPendingPermissions() {
      return [];
    }
    async respondToPermission(): Promise<void> {}
    async getCurrentMode(): Promise<string | null> {
      return null;
    }
    async getAvailableModes() {
      return [];
    }
    async setMode(): Promise<void> {}
  }

  test("projects promptSuggestion on idle state updates, drops while busy, and clears on new turn", async () => {
    const session = new ScriptedSession();
    const client = {
      provider: "claude" as const,
      capabilities: session.capabilities,
      async isAvailable() {
        return true;
      },
      async createSession() {
        return session;
      },
      async resumeSession() {
        return session;
      },
      async listModels() {
        return [];
      },
    } as unknown as AgentClient;

    const manager = new AgentManager({
      clients: { claude: client },
      logger: createTestLogger(),
    });

    try {
      const agent = await manager.createAgent(
        {
          provider: "claude",
          cwd: process.cwd(),
        },
        undefined,
        { workspaceId: undefined },
      );
      try {
        const stateSnapshots: Array<string | null | undefined> = [];
        const unsubscribe = manager.subscribe(
          (event) => {
            if (event.type === "agent_state" && event.agent.id === agent.id) {
              stateSnapshots.push(toAgentPayload(event.agent).promptSuggestion);
            }
          },
          { agentId: agent.id, replayState: false },
        );

        const drain = async (gen: AsyncGenerator<unknown>) => {
          for await (const _ of gen) {
            // Drain stream.
          }
        };

        // Start turn 1 -> while running, a stale prompt_suggestion is ignored.
        const turn1Done = drain(manager.streamAgent(agent.id, "First prompt"));
        await manager.waitForAgentRunStart(agent.id);
        session.emit({
          type: "prompt_suggestion",
          provider: "claude",
          suggestion: "Should be ignored while busy",
        });
        await manager.flush();
        expect(toAgentPayload(manager.getAgent(agent.id)!).promptSuggestion).toBeNull();

        // Complete turn 1 -> idle agent accepts prompt_suggestion and emits state update.
        session.emit({ type: "turn_completed", provider: "claude", turnId: "turn-1" });
        await turn1Done;
        session.emit({
          type: "prompt_suggestion",
          provider: "claude",
          suggestion: "Run the test suite",
        });
        await manager.flush();

        expect(toAgentPayload(manager.getAgent(agent.id)!).promptSuggestion).toBe(
          "Run the test suite",
        );
        expect(stateSnapshots.at(-1)).toBe("Run the test suite");

        // Starting turn 2 clears promptSuggestion.
        const turn2Done = drain(manager.streamAgent(agent.id, "Second prompt"));
        await manager.waitForAgentRunStart(agent.id);
        expect(toAgentPayload(manager.getAgent(agent.id)!).promptSuggestion).toBeNull();
        session.emit({ type: "turn_completed", provider: "claude", turnId: "turn-2" });
        await turn2Done;
        unsubscribe();
      } finally {
        await manager.closeAgent(agent.id);
      }
    } finally {
      await manager.flush();
    }
  });
});
