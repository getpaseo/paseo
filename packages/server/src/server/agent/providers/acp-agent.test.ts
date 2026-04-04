import { describe, expect, test, vi } from "vitest";

import {
  ACPAgentClient,
  ACPAgentSession,
  type SessionStateResponse,
  deriveModelDefinitionsFromACP,
  deriveModesFromACP,
  mapACPUsage,
} from "./acp-agent.js";
import { transformPiModels, transformPiSessionResponse } from "./pi-acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

function createSession(): ACPAgentSession {
  return new ACPAgentSession(
    {
      provider: "claude-acp",
      cwd: "/tmp/paseo-acp-test",
    },
    {
      provider: "claude-acp",
      logger: createTestLogger(),
      defaultCommand: ["claude", "--acp"],
      defaultModes: [],
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
    },
  );
}

describe("mapACPUsage", () => {
  test("maps ACP usage fields into Paseo usage", () => {
    expect(
      mapACPUsage({
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        cachedReadTokens: 5,
      }),
    ).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cachedInputTokens: 5,
    });
  });
});

describe("deriveModesFromACP", () => {
  test("prefers explicit ACP mode state", () => {
    const result = deriveModesFromACP(
      [{ id: "fallback", label: "Fallback" }],
      {
        availableModes: [
          { id: "default", name: "Always Ask", description: "Prompt before tools" },
          { id: "plan", name: "Plan", description: "Read only" },
        ],
        currentModeId: "plan",
      },
      [],
    );

    expect(result).toEqual({
      modes: [
        { id: "default", label: "Always Ask", description: "Prompt before tools" },
        { id: "plan", label: "Plan", description: "Read only" },
      ],
      currentModeId: "plan",
    });
  });

  test("falls back to config options when explicit mode state is absent", () => {
    const result = deriveModesFromACP(
      [{ id: "fallback", label: "Fallback" }],
      null,
      [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "acceptEdits",
          options: [
            { value: "default", name: "Always Ask" },
            { value: "acceptEdits", name: "Accept File Edits" },
          ],
        },
      ],
    );

    expect(result).toEqual({
      modes: [
        { id: "default", label: "Always Ask", description: undefined },
        { id: "acceptEdits", label: "Accept File Edits", description: undefined },
      ],
      currentModeId: "acceptEdits",
    });
  });

  test("returns an empty mode list when fallback modes are empty and config only exposes thought levels", () => {
    const result = deriveModesFromACP(
      [],
      null,
      [
        {
          id: "thought_level",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
      ],
    );

    expect(result).toEqual({
      modes: [],
      currentModeId: null,
    });
  });
});

describe("deriveModelDefinitionsFromACP", () => {
  test("attaches shared thinking options to ACP model state", () => {
    const result = deriveModelDefinitionsFromACP("claude-acp", {
      availableModels: [
        { modelId: "haiku", name: "Haiku", description: "Fast" },
        { modelId: "sonnet", name: "Sonnet", description: "Balanced" },
      ],
      currentModelId: "haiku",
    }, [
      {
        id: "reasoning",
        name: "Reasoning",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ]);

    expect(result).toEqual([
      {
        provider: "claude-acp",
        id: "haiku",
        label: "Haiku",
        description: "Fast",
        isDefault: true,
        thinkingOptions: [
          { id: "low", label: "Low", description: undefined, isDefault: false, metadata: undefined },
          { id: "medium", label: "Medium", description: undefined, isDefault: true, metadata: undefined },
          { id: "high", label: "High", description: undefined, isDefault: false, metadata: undefined },
        ],
        defaultThinkingOptionId: "medium",
      },
      {
        provider: "claude-acp",
        id: "sonnet",
        label: "Sonnet",
        description: "Balanced",
        isDefault: false,
        thinkingOptions: [
          { id: "low", label: "Low", description: undefined, isDefault: false, metadata: undefined },
          { id: "medium", label: "Medium", description: undefined, isDefault: true, metadata: undefined },
          { id: "high", label: "High", description: undefined, isDefault: false, metadata: undefined },
        ],
        defaultThinkingOptionId: "medium",
      },
    ]);
  });
});

describe("ACPAgentClient modelTransformer", () => {
  test("applies modelTransformer after deriving ACP models", async () => {
    class TestACPAgentClient extends ACPAgentClient {
      protected override async spawnProcess(): Promise<any> {
        return {
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              models: {
                availableModels: [
                  {
                    modelId: "openrouter/openai/gpt-4.1-mini",
                    name: "openrouter/openai/gpt-4.1-mini",
                    description: null,
                  },
                ],
                currentModelId: "openrouter/openai/gpt-4.1-mini",
              },
              configOptions: [],
            }),
          },
          initialize: { agentCapabilities: {} },
        };
      }

      protected override async closeProbe(): Promise<void> {}
    }

    const client = new TestACPAgentClient({
      provider: "pi",
      logger: createTestLogger(),
      defaultCommand: ["pi-acp"],
      modelTransformer: transformPiModels,
    });

    await expect(client.listModels()).resolves.toEqual([
      {
        provider: "pi",
        id: "openrouter/openai/gpt-4.1-mini",
        label: "gpt-4.1-mini",
        description: "openrouter/openai/gpt-4.1-mini",
        isDefault: true,
        thinkingOptions: undefined,
        defaultThinkingOptionId: undefined,
      },
    ]);
  });
});

describe("ACPAgentClient sessionResponseTransformer", () => {
  class TestACPAgentClient extends ACPAgentClient {
    protected override async spawnProcess(): Promise<any> {
      const response: SessionStateResponse = {
        sessionId: "session-1",
        modes: {
          availableModes: [
            { id: "off", name: "Thinking: Off", description: "No extra reasoning" },
            { id: "medium", name: "Thinking: Medium", description: "Balanced reasoning" },
            { id: "high", name: "Thinking: High", description: "Deeper reasoning" },
          ],
          currentModeId: "medium",
        },
        models: {
          availableModels: [
            {
              modelId: "openrouter/openai/gpt-4.1-mini",
              name: "openrouter/openai/gpt-4.1-mini",
              description: null,
            },
          ],
          currentModelId: "openrouter/openai/gpt-4.1-mini",
        },
        configOptions: [],
      };

      return {
        child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
        connection: {
          newSession: vi.fn().mockResolvedValue(response),
        },
        initialize: { agentCapabilities: {} },
      };
    }

    protected override async closeProbe(): Promise<void> {}
  }

  test("remaps Pi thinking modes into thinking options for list probes", async () => {
    const client = new TestACPAgentClient({
      provider: "pi",
      logger: createTestLogger(),
      defaultCommand: ["pi-acp"],
      defaultModes: [],
      modelTransformer: transformPiModels,
      sessionResponseTransformer: transformPiSessionResponse,
    });

    await expect(client.listModes()).resolves.toEqual([]);
    await expect(client.listModels()).resolves.toEqual([
      {
        provider: "pi",
        id: "openrouter/openai/gpt-4.1-mini",
        label: "gpt-4.1-mini",
        description: "openrouter/openai/gpt-4.1-mini",
        isDefault: true,
        thinkingOptions: [
          {
            id: "off",
            label: "Off",
            description: "No extra reasoning",
            isDefault: false,
            metadata: undefined,
          },
          {
            id: "medium",
            label: "Medium",
            description: "Balanced reasoning",
            isDefault: true,
            metadata: undefined,
          },
          {
            id: "high",
            label: "High",
            description: "Deeper reasoning",
            isDefault: false,
            metadata: undefined,
          },
        ],
        defaultThinkingOptionId: "medium",
      },
    ]);
  });
});

describe("ACPAgentClient listModes", () => {
  test("returns an empty array when no ACP modes are reported and fallback modes are empty", async () => {
    class TestACPAgentClient extends ACPAgentClient {
      protected override async spawnProcess(): Promise<any> {
        return {
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              modes: null,
              configOptions: [
                {
                  id: "thought_level",
                  name: "Thinking",
                  category: "thought_level",
                  type: "select",
                  currentValue: "medium",
                  options: [
                    { value: "low", name: "Low" },
                    { value: "medium", name: "Medium" },
                    { value: "high", name: "High" },
                  ],
                },
              ],
            }),
          },
          initialize: { agentCapabilities: {} },
        };
      }

      protected override async closeProbe(): Promise<void> {}
    }

    const client = new TestACPAgentClient({
      provider: "pi",
      logger: createTestLogger(),
      defaultCommand: ["pi-acp"],
      defaultModes: [],
    });

    await expect(client.listModes()).resolves.toEqual([]);
  });
});

describe("transformPiModels", () => {
  test("keeps slash-free labels unchanged", () => {
    expect(
      transformPiModels([
        {
          provider: "pi",
          id: "gpt-4.1-mini",
          label: "GPT 4.1 Mini",
          description: "Fast",
        },
      ]),
    ).toEqual([
      {
        provider: "pi",
        id: "gpt-4.1-mini",
        label: "GPT 4.1 Mini",
        description: "Fast",
      },
    ]);
  });

  test("uses the last path segment as label and preserves existing descriptions", () => {
    expect(
      transformPiModels([
        {
          provider: "pi",
          id: "openrouter/openai/gpt-4.1-mini",
          label: "openrouter/openai/gpt-4.1-mini",
          description: undefined,
        },
        {
          provider: "pi",
          id: "anthropic/claude-sonnet-4",
          label: "anthropic/claude-sonnet-4",
          description: "Balanced",
        },
      ]),
    ).toEqual([
      {
        provider: "pi",
        id: "openrouter/openai/gpt-4.1-mini",
        label: "gpt-4.1-mini",
        description: "openrouter/openai/gpt-4.1-mini",
      },
      {
        provider: "pi",
        id: "anthropic/claude-sonnet-4",
        label: "claude-sonnet-4",
        description: "Balanced",
      },
    ]);
  });
});

describe("ACPAgentSession slash commands", () => {
  test("caches ACP available commands for listCommands", async () => {
    const session = createSession();

    expect(await session.listCommands()).toEqual([]);

    (session as any).translateSessionUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        {
          name: "research_codebase",
          description: "Search the workspace for relevant files",
        },
        {
          name: "create_plan",
          description: "Draft a plan for the requested work",
        },
      ],
    });

    expect(await session.listCommands()).toEqual([
      {
        name: "research_codebase",
        description: "Search the workspace for relevant files",
        argumentHint: "",
      },
      {
        name: "create_plan",
        description: "Draft a plan for the requested work",
        argumentHint: "",
      },
    ]);
  });
});

describe("ACPAgentSession", () => {
  test("applies sessionResponseTransformer before deriving modes and thinking state", () => {
    const session = new ACPAgentSession(
      {
        provider: "pi",
        cwd: "/tmp/paseo-acp-test",
      },
      {
        provider: "pi",
        logger: createTestLogger(),
        defaultCommand: ["pi-acp"],
        defaultModes: [],
        modelTransformer: transformPiModels,
        sessionResponseTransformer: transformPiSessionResponse,
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: true,
          supportsMcpServers: false,
          supportsReasoningStream: true,
          supportsToolInvocations: true,
        },
      },
    );

    (session as any).applySessionState({
      sessionId: "session-1",
      modes: {
        availableModes: [
          { id: "low", name: "Thinking: Low", description: "Faster" },
          { id: "medium", name: "Thinking: Medium", description: "Balanced" },
        ],
        currentModeId: "medium",
      },
      models: {
        availableModels: [
          {
            modelId: "openrouter/openai/gpt-4.1-mini",
            name: "openrouter/openai/gpt-4.1-mini",
            description: null,
          },
        ],
        currentModelId: "openrouter/openai/gpt-4.1-mini",
      },
      configOptions: [],
    } satisfies SessionStateResponse);

    expect((session as any).availableModes).toEqual([]);
    expect((session as any).thinkingOptionId).toBe("medium");
    expect((session as any).availableModels).toEqual([
      {
        provider: "pi",
        id: "openrouter/openai/gpt-4.1-mini",
        label: "gpt-4.1-mini",
        description: "openrouter/openai/gpt-4.1-mini",
        isDefault: true,
        thinkingOptions: [
          {
            id: "low",
            label: "Low",
            description: "Faster",
            isDefault: false,
            metadata: undefined,
          },
          {
            id: "medium",
            label: "Medium",
            description: "Balanced",
            isDefault: true,
            metadata: undefined,
          },
        ],
        defaultThinkingOptionId: "medium",
      },
    ]);
  });

  test("emits assistant and reasoning chunks as deltas while user chunks stay accumulated", async () => {
    const session = createSession();
    const events: Array<{ type: string; item?: { type: string; text?: string } }> = [];
    (session as any).sessionId = "session-1";

    session.subscribe((event) => {
      events.push(event as { type: string; item?: { type: string; text?: string } });
    });

    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: "Hey!" },
      } as any,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: " How are you?" },
      } as any,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "Thinking" },
      } as any,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: " more" },
      } as any,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: "hel" },
      } as any,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: "lo" },
      } as any,
    });

    const timeline = events
      .filter((event) => event.type === "timeline")
      .map((event) => event.item)
      .filter(Boolean);

    expect(timeline).toEqual([
      { type: "assistant_message", text: "Hey!" },
      { type: "assistant_message", text: " How are you?" },
      { type: "reasoning", text: "Thinking" },
      { type: "reasoning", text: " more" },
      { type: "user_message", text: "hel", messageId: "user-1" },
      { type: "user_message", text: "hello", messageId: "user-1" },
    ]);
  });

  test("startTurn returns before the ACP prompt settles and completes later via subscribers", async () => {
    const session = createSession();
    const events: Array<{ type: string; turnId?: string }> = [];
    let resolvePrompt!: (value: any) => void;
    const prompt = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePrompt = resolve;
        }),
    );

    (session as any).sessionId = "session-1";
    (session as any).connection = { prompt };

    session.subscribe((event) => {
      events.push(event as { type: string; turnId?: string });
    });

    const { turnId } = await session.startTurn("hello");

    expect(prompt).toHaveBeenCalledOnce();
    expect(events.find((event) => event.type === "turn_started")).toMatchObject({
      type: "turn_started",
      turnId,
    });
    expect((session as any).activeForegroundTurnId).toBe(turnId);

    resolvePrompt({ stopReason: "end_turn", usage: { outputTokens: 3 } });
    await Promise.resolve();
    await Promise.resolve();

    expect(events.find((event) => event.type === "turn_completed")).toMatchObject({
      type: "turn_completed",
      turnId,
    });
    expect((session as any).activeForegroundTurnId).toBeNull();
  });

  test("startTurn converts background prompt rejections into turn_failed events", async () => {
    const session = createSession();
    const events: Array<{ type: string; turnId?: string; error?: string }> = [];
    let rejectPrompt!: (error: Error) => void;
    const prompt = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectPrompt = reject;
        }),
    );

    (session as any).sessionId = "session-1";
    (session as any).connection = { prompt };

    session.subscribe((event) => {
      events.push(event as { type: string; turnId?: string; error?: string });
    });

    const { turnId } = await session.startTurn("hello");

    rejectPrompt(new Error("prompt failed"));
    await Promise.resolve();
    await Promise.resolve();

    const turnFailedEvent = events.find((event) => event.type === "turn_failed");
    expect(turnFailedEvent).toMatchObject({
      type: "turn_failed",
      turnId,
      error: "prompt failed",
    });
    expect((session as any).activeForegroundTurnId).toBeNull();
  });
});
