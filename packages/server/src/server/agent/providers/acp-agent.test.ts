import { describe, expect, test, vi } from "vitest";
import type {
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import {
  ACPAgentClient,
  ACPAgentSession,
  type SpawnedACPProcess,
  type SessionStateResponse,
  createLoggedNdJsonStream,
  deriveModelDefinitionsFromACP,
  deriveModesFromACP,
  mapACPUsage,
  resolveACPModeSelection,
  resolveACPModelSelection,
} from "./acp-agent.js";
import { transformPiModels } from "./pi-direct-agent.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

interface ACPSessionInternals {
  sessionId: string | null;
  connection: { prompt: (...args: unknown[]) => Promise<PromptResponse> };
  activeForegroundTurnId: string | null;
  configOptions: SessionConfigOption[];
  translateSessionUpdate(update: SessionUpdate): AgentStreamEvent[];
}

interface ACPModelSelectionInternals {
  sessionId: string | null;
  connection: {
    setSessionConfigOption: (input: {
      sessionId: string;
      configId: string;
      value: string;
    }) => Promise<unknown>;
  };
  configOptions: SessionConfigOption[];
}

interface ACPConfiguredOverrideInternals {
  sessionId: string | null;
  connection: {
    setSessionMode: (input: { sessionId: string; modeId: string }) => Promise<void>;
    setSessionConfigOption: (input: {
      sessionId: string;
      configId: string;
      value: string;
    }) => Promise<unknown>;
    unstable_setSessionModel?: (input: { sessionId: string; modelId: string }) => Promise<void>;
  };
  configOptions: SessionConfigOption[];
  availableModes: Array<{ id: string; label: string; description?: string }>;
  availableModels: Array<{ modelId: string; name: string; description?: string | null }> | null;
  currentMode: string | null;
  currentModel: string | null;
  applyConfiguredOverrides(): Promise<void>;
}

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

function createSessionWithConfig(
  config: { provider?: string; modeId?: string | null; model?: string | null } = {},
  logger: ReturnType<typeof createTestLogger> = createTestLogger(),
): ACPAgentSession {
  return new ACPAgentSession(
    {
      provider: config.provider ?? "claude-acp",
      cwd: "/tmp/paseo-acp-test",
      modeId: config.modeId ?? undefined,
      model: config.model ?? undefined,
    },
    {
      provider: config.provider ?? "claude-acp",
      logger,
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

function selectConfigOption(
  category: "mode" | "model" | "thought_level",
  values: string[],
  currentValue = values[0] ?? "",
): SessionConfigOption {
  return {
    id: `${category}-option`,
    name: selectConfigOptionName(category),
    category,
    type: "select",
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}

function selectConfigOptionName(category: "mode" | "model" | "thought_level"): string {
  if (category === "mode") {
    return "Mode";
  }
  if (category === "model") {
    return "Model";
  }
  return "Thinking";
}

function prepareConfiguredOverrideSession(
  session: ACPAgentSession,
  options: {
    currentMode?: string | null;
    availableModes?: Array<{ id: string; label: string; description?: string }>;
    currentModel?: string | null;
    availableModels?: Array<{ modelId: string; name: string; description?: string | null }> | null;
    configOptions?: SessionConfigOption[];
    connection?: Partial<ACPConfiguredOverrideInternals["connection"]>;
  } = {},
): {
  internals: ACPConfiguredOverrideInternals;
  setSessionMode: ReturnType<typeof vi.fn>;
  unstableSetSessionModel: ReturnType<typeof vi.fn>;
  setSessionConfigOption: ReturnType<typeof vi.fn>;
} {
  const setSessionMode = vi.fn(async () => undefined);
  const unstableSetSessionModel = vi.fn(async () => undefined);
  const setSessionConfigOption = vi.fn(async () => ({
    configOptions: options.configOptions ?? [],
  }));
  const internals = session as unknown as ACPConfiguredOverrideInternals;
  internals.sessionId = "session-1";
  internals.connection = {
    setSessionMode,
    setSessionConfigOption,
    unstable_setSessionModel: unstableSetSessionModel,
    ...options.connection,
  };
  internals.availableModes = options.availableModes ?? [];
  internals.availableModels = options.availableModels ?? null;
  internals.configOptions = options.configOptions ?? [];
  internals.currentMode = options.currentMode ?? null;
  internals.currentModel = options.currentModel ?? null;

  return { internals, setSessionMode, unstableSetSessionModel, setSessionConfigOption };
}

test("ACP setModel only uses config-option fallback when the matching select choice contains the model", async () => {
  const logger = createTestLogger();
  const childLogger = { warn: vi.fn() };
  vi.spyOn(logger, "child").mockReturnValue(childLogger as unknown as typeof logger);
  const session = createSessionWithConfig({}, logger);
  const setSessionConfigOption = vi.fn(async () => ({
    configOptions: [
      {
        id: "model-option",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "sonnet",
        options: [{ value: "sonnet", name: "Sonnet" }],
      },
    ],
  }));
  const internals = session as unknown as ACPModelSelectionInternals;
  internals.sessionId = "session-1";
  internals.connection = { setSessionConfigOption };
  internals.configOptions = [
    {
      id: "model-option",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "sonnet",
      options: [{ value: "sonnet", name: "Sonnet" }],
    },
  ];

  await session.setModel("sonnet");

  expect(setSessionConfigOption).toHaveBeenCalledWith({
    sessionId: "session-1",
    configId: "model-option",
    value: "sonnet",
  });

  setSessionConfigOption.mockClear();

  await expect(session.setModel("new-provider-model")).resolves.toBeUndefined();
  expect(childLogger.warn).toHaveBeenCalledWith(
    "new-provider-model",
    expect.stringContaining("is not a valid claude-acp model config option"),
  );
  expect(setSessionConfigOption).not.toHaveBeenCalled();
});

describe("createLoggedNdJsonStream", () => {
  test("routes malformed ACP stdout through the provider logger instead of console.error", async () => {
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const logger = {
      warn: vi.fn(),
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const stream = createLoggedNdJsonStream(output.writable, input.readable, {
      logger: logger as unknown as ReturnType<typeof createTestLogger>,
      provider: "gemini",
    });
    const reader = stream.readable.getReader();
    const writer = input.writable.getWriter();

    await writer.write(
      new TextEncoder().encode(
        'Please visit the following URL to authorize the application:\n{"jsonrpc":"2.0","method":"ok","params":{}}\n',
      ),
    );

    const parsed = await reader.read();

    expect(parsed.value).toEqual({ jsonrpc: "2.0", method: "ok", params: {} });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: {
          type: "SyntaxError",
          message: "ACP stdout line was not valid JSON",
        },
        provider: "gemini",
      }),
      "ACP agent emitted non-JSON stdout; ignoring line",
    );
    expect(logger.warn.mock.calls[0]?.[0]).not.toHaveProperty("linePreview");
    expect(consoleError).not.toHaveBeenCalled();

    await writer.close();
    reader.releaseLock();
    consoleError.mockRestore();
  });

  test("does not log terminal control sequences from malformed ACP stdout", async () => {
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const logger = {
      warn: vi.fn(),
    };

    const stream = createLoggedNdJsonStream(output.writable, input.readable, {
      logger: logger as unknown as ReturnType<typeof createTestLogger>,
      provider: "gemini",
    });
    const reader = stream.readable.getReader();
    const writer = input.writable.getWriter();

    await writer.write(new TextEncoder().encode('\u001b[1G\u001b[0JEn\n{"ok":true}\n'));

    const parsed = await reader.read();

    expect(parsed.value).toEqual({ ok: true });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("\u001b");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("[1G");
    expect(logger.warn.mock.calls[0]?.[0]).toEqual({
      err: {
        type: "SyntaxError",
        message: "ACP stdout line was not valid JSON",
      },
      provider: "gemini",
    });

    await writer.close();
    reader.releaseLock();
  });
});

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
    const result = deriveModesFromACP([{ id: "fallback", label: "Fallback" }], null, [
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
    ]);

    expect(result).toEqual({
      modes: [
        { id: "default", label: "Always Ask", description: undefined },
        { id: "acceptEdits", label: "Accept File Edits", description: undefined },
      ],
      currentModeId: "acceptEdits",
    });
  });

  test("returns an empty mode list when fallback modes are empty and config only exposes thought levels", () => {
    const result = deriveModesFromACP([], null, [
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
    ]);

    expect(result).toEqual({
      modes: [],
      currentModeId: null,
    });
  });
});

describe("ACP selection validity helpers", () => {
  test("classifies advertised ACP modes and select config option choices", () => {
    const result = resolveACPModeSelection({
      modeId: "plan",
      availableModes: [
        { id: "default", label: "Always Ask" },
        { id: "plan", label: "Plan" },
      ],
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Always Ask" }],
        },
      ],
    });

    expect(result).toMatchObject({
      availableMode: { id: "plan", label: "Plan" },
      configChoice: null,
      hasAvailableModes: true,
    });
    expect(result.configOption?.id).toBe("mode");
  });

  test("classifies model select config option choices separately from advertised models", () => {
    const result = resolveACPModelSelection({
      modelId: "opus",
      availableModels: [{ modelId: "sonnet", name: "Sonnet", description: null }],
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "sonnet",
          options: [
            {
              group: "Anthropic",
              options: [{ value: "opus", name: "Opus", description: "Deep" }],
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({
      availableModel: null,
      configChoice: {
        value: "opus",
        name: "Opus",
        description: "Deep",
        group: "Anthropic",
      },
      hasAvailableModels: true,
    });
    expect(result.configOption?.id).toBe("model");
  });
});

describe("ACPAgentSession Zed parity", () => {
  test("applies valid stored mode/model values, routes current_mode_update, and skips invalid Cursor-style stored values with warnings", async () => {
    const validSession = createSessionWithConfig({ modeId: "plan", model: "sonnet" });
    const valid = prepareConfiguredOverrideSession(validSession, {
      currentMode: "default",
      availableModes: [
        { id: "default", label: "Always Ask" },
        { id: "plan", label: "Plan" },
      ],
      currentModel: "haiku",
      availableModels: [
        { modelId: "haiku", name: "Haiku", description: null },
        { modelId: "sonnet", name: "Sonnet", description: null },
      ],
    });

    await valid.internals.applyConfiguredOverrides();
    expect(valid.setSessionMode).toHaveBeenCalledWith({ sessionId: "session-1", modeId: "plan" });
    expect(valid.unstableSetSessionModel).toHaveBeenCalledWith({
      sessionId: "session-1",
      modelId: "sonnet",
    });

    const modeEvents = (validSession as unknown as ACPSessionInternals).translateSessionUpdate({
      sessionUpdate: "current_mode_update",
      currentModeId: "default",
    });
    expect(modeEvents).toEqual([
      {
        type: "mode_changed",
        provider: "claude-acp",
        currentModeId: "default",
        availableModes: [
          { id: "default", label: "Always Ask" },
          { id: "plan", label: "Plan" },
        ],
      },
    ]);
    expect(await validSession.getCurrentMode()).toBe("default");

    const logger = createTestLogger();
    const childLogger = { warn: vi.fn() };
    vi.spyOn(logger, "child").mockReturnValue(childLogger as unknown as typeof logger);
    const invalidSession = createSessionWithConfig(
      { modeId: "acceptEdits", model: "opus" },
      logger,
    );
    const invalid = prepareConfiguredOverrideSession(invalidSession, {
      currentMode: "default",
      availableModes: [
        { id: "default", label: "Always Ask" },
        { id: "plan", label: "Plan" },
      ],
      currentModel: "sonnet",
      availableModels: [{ modelId: "sonnet", name: "Sonnet", description: null }],
    });

    await expect(invalid.internals.applyConfiguredOverrides()).resolves.toBeUndefined();
    expect(invalid.setSessionMode).not.toHaveBeenCalled();
    expect(invalid.unstableSetSessionModel).not.toHaveBeenCalled();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("acceptEdits"),
      expect.stringContaining("not valid"),
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("opus"),
      expect.stringContaining("not a valid"),
    );
  });

  test("does not use config-option fallback when Cursor-style availableModes omit the stored mode", async () => {
    const session = createSessionWithConfig({ modeId: "acceptEdits" });
    const { internals, setSessionConfigOption } = prepareConfiguredOverrideSession(session, {
      currentMode: "default",
      availableModes: [
        { id: "default", label: "Always Ask" },
        { id: "plan", label: "Plan" },
      ],
      configOptions: [selectConfigOption("mode", ["default", "acceptEdits"], "default")],
      connection: { unstable_setSessionModel: undefined },
    });

    await expect(internals.applyConfiguredOverrides()).resolves.toBeUndefined();
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  test("routes config_option_update and refreshes derived mode, model, and thinking state", async () => {
    const session = createSession();
    const internals = session as unknown as ACPSessionInternals;

    const events = internals.translateSessionUpdate({
      sessionUpdate: "config_option_update",
      configOptions: [
        selectConfigOption("mode", ["default", "plan"], "plan"),
        selectConfigOption("model", ["sonnet", "opus"], "opus"),
        selectConfigOption("thought_level", ["low", "high"], "high"),
      ],
    });

    expect(events).toMatchObject([
      {
        type: "mode_changed",
        provider: "claude-acp",
        currentModeId: "plan",
        availableModes: [
          { id: "default", label: "default" },
          { id: "plan", label: "plan" },
        ],
      },
      {
        type: "model_changed",
        provider: "claude-acp",
        runtimeInfo: expect.objectContaining({
          model: "opus",
          thinkingOptionId: "high",
          modeId: "plan",
        }),
      },
      {
        type: "thinking_option_changed",
        provider: "claude-acp",
        thinkingOptionId: "high",
      },
    ]);
    expect(internals.configOptions).toEqual([
      selectConfigOption("mode", ["default", "plan"], "plan"),
      selectConfigOption("model", ["sonnet", "opus"], "opus"),
      selectConfigOption("thought_level", ["low", "high"], "high"),
    ]);
    expect(await session.getAvailableModes()).toEqual([
      { id: "default", label: "default" },
      { id: "plan", label: "plan" },
    ]);
    expect(await session.getCurrentMode()).toBe("plan");
    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      model: "opus",
      thinkingOptionId: "high",
      modeId: "plan",
    });
  });

  test("keeps pushed mode when a later config_option_update has no mode payload", async () => {
    const session = createSession();
    const internals = session as unknown as ACPSessionInternals;

    internals.translateSessionUpdate({
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    });
    const events = internals.translateSessionUpdate({
      sessionUpdate: "config_option_update",
      configOptions: [selectConfigOption("model", ["sonnet"], "sonnet")],
    });

    expect(events.map((event) => event.type)).toEqual(["model_changed"]);
    expect(await session.getCurrentMode()).toBe("plan");
    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      model: "sonnet",
      modeId: "plan",
    });
  });

  test("uses last writer when current_mode_update and config_option_update both include a mode", async () => {
    const session = createSession();
    const internals = session as unknown as ACPSessionInternals;

    const configEvents = internals.translateSessionUpdate({
      sessionUpdate: "config_option_update",
      configOptions: [selectConfigOption("mode", ["default", "plan"], "plan")],
    });
    const modeEvents = internals.translateSessionUpdate({
      sessionUpdate: "current_mode_update",
      currentModeId: "default",
    });

    expect(configEvents).toMatchObject([{ type: "mode_changed", currentModeId: "plan" }]);
    expect(modeEvents).toMatchObject([{ type: "mode_changed", currentModeId: "default" }]);
    expect(await session.getCurrentMode()).toBe("default");
  });

  test("uses canonical mode returned by setSessionConfigOption response", async () => {
    const session = createSession();
    const internals = session as unknown as ACPModelSelectionInternals;
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    internals.sessionId = "session-1";
    internals.configOptions = [selectConfigOption("mode", ["ask", "default"], "ask")];
    internals.connection = {
      setSessionConfigOption: vi.fn(async () => ({
        configOptions: [selectConfigOption("mode", ["ask", "default"], "default")],
      })),
    };

    await session.setMode("ask");
    unsubscribe();

    expect(await session.getCurrentMode()).toBe("default");
    expect(events).toMatchObject([
      {
        type: "mode_changed",
        provider: "claude-acp",
        currentModeId: "default",
        availableModes: [
          { id: "ask", label: "ask" },
          { id: "default", label: "default" },
        ],
      },
    ]);
  });

  test("uses canonical model returned by setSessionConfigOption response", async () => {
    const session = createSession();
    const internals = session as unknown as ACPModelSelectionInternals;
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    internals.sessionId = "session-1";
    internals.configOptions = [selectConfigOption("model", ["claude-sonnet", "sonnet"], "sonnet")];
    internals.connection = {
      setSessionConfigOption: vi.fn(async () => ({
        configOptions: [selectConfigOption("model", ["claude-sonnet", "sonnet"], "sonnet")],
      })),
    };

    await session.setModel("claude-sonnet");
    unsubscribe();

    await expect(session.getRuntimeInfo()).resolves.toMatchObject({ model: "sonnet" });
    expect(events).toContainEqual({
      type: "model_changed",
      provider: "claude-acp",
      runtimeInfo: expect.objectContaining({ model: "sonnet" }),
    });
  });

  test("uses canonical thinking option returned by setSessionConfigOption response", async () => {
    const session = createSession();
    const internals = session as unknown as ACPModelSelectionInternals;
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    internals.sessionId = "session-1";
    internals.configOptions = [
      selectConfigOption("thought_level", ["think-hard", "high"], "think-hard"),
    ];
    internals.connection = {
      setSessionConfigOption: vi.fn(async () => ({
        configOptions: [selectConfigOption("thought_level", ["think-hard", "high"], "high")],
      })),
    };

    await session.setThinkingOption("think-hard");
    unsubscribe();

    await expect(session.getRuntimeInfo()).resolves.toMatchObject({ thinkingOptionId: "high" });
    expect(events).toContainEqual({
      type: "thinking_option_changed",
      provider: "claude-acp",
      thinkingOptionId: "high",
    });
  });

  test("passes Copilot Autopilot ACP permission requests through to the user", async () => {
    // Zed parity: Copilot Autopilot no longer auto-approves ACP permission requests,
    // so the accepted UX regression is that every tool request reaches the user UI.
    const session = createSessionWithConfig({
      provider: "copilot",
      modeId: "https://agentclientprotocol.com/protocol/session-modes#autopilot",
    });
    const events: Array<{ type: string; request?: { id: string } }> = [];
    const permissionOptions: PermissionOption[] = [
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ];

    (session as unknown as ACPSessionInternals).sessionId = "session-1";
    session.subscribe((event) => {
      events.push(event as { type: string; request?: { id: string } });
    });

    const permission = session.requestPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "Edit file",
        kind: "edit",
        status: "pending",
      },
      options: permissionOptions,
    } satisfies RequestPermissionRequest);

    await Promise.resolve();

    const requested = events.find((event) => event.type === "permission_requested");
    expect(requested?.request?.id).toEqual(expect.any(String));

    await session.respondToPermission(requested!.request!.id, { behavior: "allow" });
    await expect(permission).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });
});

describe("deriveModelDefinitionsFromACP", () => {
  test("attaches shared thinking options to ACP model state", () => {
    const result = deriveModelDefinitionsFromACP(
      "claude-acp",
      {
        availableModels: [
          { modelId: "haiku", name: "Haiku", description: "Fast" },
          { modelId: "sonnet", name: "Sonnet", description: "Balanced" },
        ],
        currentModelId: "haiku",
      },
      [
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
      ],
    );

    expect(result).toEqual([
      {
        provider: "claude-acp",
        id: "haiku",
        label: "Haiku",
        description: "Fast",
        isDefault: true,
        thinkingOptions: [
          {
            id: "low",
            label: "Low",
            description: undefined,
            isDefault: false,
            metadata: undefined,
          },
          {
            id: "medium",
            label: "Medium",
            description: undefined,
            isDefault: true,
            metadata: undefined,
          },
          {
            id: "high",
            label: "High",
            description: undefined,
            isDefault: false,
            metadata: undefined,
          },
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
          {
            id: "low",
            label: "Low",
            description: undefined,
            isDefault: false,
            metadata: undefined,
          },
          {
            id: "medium",
            label: "Medium",
            description: undefined,
            isDefault: true,
            metadata: undefined,
          },
          {
            id: "high",
            label: "High",
            description: undefined,
            isDefault: false,
            metadata: undefined,
          },
        ],
        defaultThinkingOptionId: "medium",
      },
    ]);
  });
});

describe("ACPAgentClient modelTransformer", () => {
  test("applies modelTransformer after deriving ACP models", async () => {
    class TestACPAgentClient extends ACPAgentClient {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
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
        } as unknown as SpawnedACPProcess;
      }

      protected override async closeProbe(): Promise<void> {}
    }

    const client = new TestACPAgentClient({
      provider: "pi",
      logger: createTestLogger(),
      defaultCommand: ["test-acp"],
      modelTransformer: transformPiModels,
    });

    await expect(client.listModels({ cwd: "/tmp/acp-models", force: false })).resolves.toEqual([
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
    protected override async spawnProcess(): Promise<SpawnedACPProcess> {
      const response: SessionStateResponse = {
        sessionId: "session-1",
        modes: {
          availableModes: [{ id: "raw", name: "Raw", description: "Before transform" }],
          currentModeId: "raw",
        },
        models: null,
        configOptions: [],
      };

      return {
        child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
        connection: {
          newSession: vi.fn().mockResolvedValue(response),
        },
        initialize: { agentCapabilities: {} },
      } as unknown as SpawnedACPProcess;
    }

    protected override async closeProbe(): Promise<void> {}
  }

  test("applies sessionResponseTransformer before deriving list probe modes", async () => {
    const client = new TestACPAgentClient({
      provider: "claude-acp",
      logger: createTestLogger(),
      defaultCommand: ["claude", "--acp"],
      defaultModes: [],
      sessionResponseTransformer: (response) => ({
        ...response,
        modes: {
          availableModes: [{ id: "review", name: "Review", description: "After transform" }],
          currentModeId: "review",
        },
      }),
    });

    await expect(client.listModes({ cwd: "/tmp/acp-modes", force: false })).resolves.toEqual([
      {
        id: "review",
        label: "Review",
        description: "After transform",
      },
    ]);
  });
});

describe("ACPAgentClient listModes", () => {
  test("passes the requested cwd to list model and mode probes", async () => {
    const newSession = vi.fn().mockResolvedValue({ modes: null, models: null, configOptions: [] });

    class TestACPAgentClient extends ACPAgentClient {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: { newSession },
          initialize: { agentCapabilities: {} },
        } as unknown as SpawnedACPProcess;
      }

      protected override async closeProbe(): Promise<void> {}
    }

    const client = new TestACPAgentClient({
      provider: "pi",
      logger: createTestLogger(),
      defaultCommand: ["test-acp"],
      defaultModes: [],
    });

    await client.listModels({ cwd: "/tmp/acp-model-cwd", force: false });
    await client.listModes({ cwd: "/tmp/acp-mode-cwd", force: false });

    expect(newSession).toHaveBeenNthCalledWith(1, {
      cwd: "/tmp/acp-model-cwd",
      mcpServers: [],
    });
    expect(newSession).toHaveBeenNthCalledWith(2, {
      cwd: "/tmp/acp-mode-cwd",
      mcpServers: [],
    });
  });

  test("returns an empty array when no ACP modes are reported and fallback modes are empty", async () => {
    class TestACPAgentClient extends ACPAgentClient {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
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
        } as unknown as SpawnedACPProcess;
      }

      protected override async closeProbe(): Promise<void> {}
    }

    const client = new TestACPAgentClient({
      provider: "pi",
      logger: createTestLogger(),
      defaultCommand: ["test-acp"],
      defaultModes: [],
    });

    await expect(client.listModes({ cwd: "/tmp/acp-modes", force: false })).resolves.toEqual([]);
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
  test("returns immediately for ACP sessions that do not wait for async command discovery", async () => {
    const session = createSession();

    await expect(session.listCommands()).resolves.toEqual([]);
  });

  test("waits for async available_commands_update when enabled", async () => {
    const session = new ACPAgentSession(
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
        waitForInitialCommands: true,
        initialCommandsWaitTimeoutMs: 1500,
      },
    );

    const listCommandsPromise = session.listCommands();

    (session as unknown as ACPSessionInternals).translateSessionUpdate({
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

    expect(await listCommandsPromise).toEqual([
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
  test("emits assistant and reasoning chunks as deltas while user chunks stay accumulated", async () => {
    const session = createSession();
    const events: Array<{ type: string; item?: { type: string; text?: string } }> = [];
    (session as unknown as ACPSessionInternals).sessionId = "session-1";

    session.subscribe((event) => {
      events.push(event as { type: string; item?: { type: string; text?: string } });
    });

    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: "Hey!" },
      } as unknown as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: " How are you?" },
      } as unknown as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "Thinking" },
      } as unknown as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: " more" },
      } as unknown as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: "hel" },
      } as unknown as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: "lo" },
      } as unknown as SessionUpdate,
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
    let resolvePrompt!: (value: PromptResponse) => void;
    const prompt = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePrompt = resolve;
        }),
    );

    (session as unknown as ACPSessionInternals).sessionId = "session-1";
    (session as unknown as ACPSessionInternals).connection = { prompt };

    session.subscribe((event) => {
      events.push(event as { type: string; turnId?: string });
    });

    const { turnId } = await session.startTurn("hello");

    expect(prompt).toHaveBeenCalledOnce();
    expect(events.find((event) => event.type === "turn_started")).toMatchObject({
      type: "turn_started",
      turnId,
    });
    expect((session as unknown as ACPSessionInternals).activeForegroundTurnId).toBe(turnId);

    resolvePrompt({ stopReason: "end_turn", usage: { outputTokens: 3 } });
    await Promise.resolve();
    await Promise.resolve();

    expect(events.find((event) => event.type === "turn_completed")).toMatchObject({
      type: "turn_completed",
      turnId,
    });
    expect((session as unknown as ACPSessionInternals).activeForegroundTurnId).toBeNull();
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

    (session as unknown as ACPSessionInternals).sessionId = "session-1";
    (session as unknown as ACPSessionInternals).connection = { prompt };

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
    expect((session as unknown as ACPSessionInternals).activeForegroundTurnId).toBeNull();
  });
});
