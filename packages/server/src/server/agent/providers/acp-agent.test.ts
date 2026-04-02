import { describe, expect, test, vi } from "vitest";

import {
  ACPAgentSession,
  deriveModelDefinitionsFromACP,
  deriveModesFromACP,
  mapACPUsage,
} from "./acp-agent.js";
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

describe("ACPAgentSession", () => {
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
