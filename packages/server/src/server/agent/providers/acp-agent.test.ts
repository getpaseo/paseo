import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import {
  ACPAgentClient,
  ACPAgentSession,
  type ACPConfigFeatureOption,
  type SpawnedACPProcess,
  type SessionStateResponse,
  buildACPClientCapabilities,
  createLoggedNdJsonStream,
  deriveModelDefinitionsFromACP,
  deriveModesFromACP,
  mapACPUsage,
  resolveACPModeSelection,
  resolveACPModelSelection,
  summarizeACPRequestError,
} from "./acp-agent.js";
import type { ProcessTerminator, TreeKillTarget } from "../../../utils/tree-kill.js";
import {
  COPILOT_AGENT_FEATURE_OPTION,
  COPILOT_ALLOW_ALL_MODE_ID,
  COPILOT_MODES,
  CopilotACPAgentClient,
  beforeCopilotModeWriter,
  transformCopilotConfigOptions,
  transformCopilotModeId,
  transformCopilotSessionResponse,
  writeCopilotProviderMode,
} from "./copilot-acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { parseKiroExtensionCommands } from "./kiro-acp-agent.js";
import { transformPiModels } from "./pi/agent.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { getAgentStreamEventTurnId } from "../agent-sdk-types.js";
import type { AgentCapabilityFlags, AgentPersistenceHandle } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { buildStringCommandShellInvocation } from "../../../utils/string-command-shell.js";
import { asInternals } from "../../test-utils/class-mocks.js";
import * as spawnUtils from "../../../utils/spawn.js";

describe("buildACPClientCapabilities", () => {
  test("keeps filesystem and terminal execution with the agent by default", () => {
    expect(buildACPClientCapabilities()).toEqual({
      fs: {
        readTextFile: false,
        writeTextFile: false,
      },
      terminal: false,
    });
  });

  test("applies provider capability overrides without dropping metadata", () => {
    expect(
      buildACPClientCapabilities(
        { source: "provider" },
        {
          fs: {
            readTextFile: true,
          },
          terminal: true,
        },
      ),
    ).toEqual({
      fs: {
        readTextFile: true,
        writeTextFile: false,
      },
      terminal: true,
      _meta: { source: "provider" },
    });
  });
});

interface ACPSessionInternals {
  sessionId: string | null;
  connection: { prompt: (...args: unknown[]) => Promise<PromptResponse> };
  activeForegroundTurnId: string | null;
  configOptions: SessionConfigOption[];
  translateSessionUpdate(update: SessionUpdate): AgentStreamEvent[];
  acpMcpServers(): unknown[];
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
  modeSource: "legacy" | "config" | "fallback";
  availableModels: Array<{ modelId: string; name: string; description?: string | null }> | null;
  currentMode: string | null;
  currentModel: string | null;
  applyConfiguredOverrides(): Promise<void>;
}

function createSession(terminateProcess?: ProcessTerminator): ACPAgentSession {
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
      ...(terminateProcess ? { terminateProcess } : {}),
    },
  );
}

// Typed substitute for the real tree-kill terminator. Records which child
// processes it was asked to terminate, so tests assert on observable state
// instead of spying on the production function. In "deferred" mode the
// terminations hang until releaseAll(), letting tests observe parallelism.
class FakeTerminator {
  readonly terminated: TreeKillTarget[] = [];
  private readonly pending: Array<() => void> = [];

  constructor(private readonly mode: "immediate" | "deferred" = "immediate") {}

  readonly terminate: ProcessTerminator = async (child) => {
    this.terminated.push(child);
    if (this.mode === "deferred") {
      await new Promise<void>((resolve) => this.pending.push(resolve));
    }
    return "terminated";
  };

  releaseAll(): void {
    for (const resolve of this.pending.splice(0)) {
      resolve();
    }
  }
}

function createSessionWithConfig(
  config: {
    provider?: string;
    modeId?: string | null;
    model?: string | null;
    featureValues?: Record<string, unknown>;
  } = {},
  logger: ReturnType<typeof createTestLogger> = createTestLogger(),
): ACPAgentSession {
  return new ACPAgentSession(
    {
      provider: config.provider ?? "claude-acp",
      cwd: "/tmp/paseo-acp-test",
      modeId: config.modeId ?? undefined,
      model: config.model ?? undefined,
      featureValues: config.featureValues,
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

function createKiroSession(
  options: { waitForInitialCommands?: boolean; initialCommandsWaitTimeoutMs?: number } = {},
  logger: ReturnType<typeof createTestLogger> = createTestLogger(),
): ACPAgentSession {
  return new ACPAgentSession(
    {
      provider: "kiro",
      cwd: "/tmp/paseo-acp-test",
    },
    {
      provider: "kiro",
      logger,
      defaultCommand: ["kiro-cli", "acp"],
      defaultModes: [],
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      extensionCommandsParser: parseKiroExtensionCommands,
      waitForInitialCommands: options.waitForInitialCommands ?? false,
      initialCommandsWaitTimeoutMs: options.initialCommandsWaitTimeoutMs,
    },
  );
}

function createTerminalChildStub(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.kill = vi.fn(() => true) as ChildProcess["kill"];
  return child;
}

function createDestroyableStream(): { destroyed: boolean; destroy: () => void } {
  const stream = {
    destroyed: false,
    destroy() {
      stream.destroyed = true;
    },
  };
  return stream;
}

function createProbeChildStub(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = createDestroyableStream() as unknown as ChildProcessWithoutNullStreams["stdin"];
  child.stdout = createDestroyableStream() as unknown as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = createDestroyableStream() as unknown as ChildProcessWithoutNullStreams["stderr"];
  child.kill = vi.fn(() => true) as ChildProcessWithoutNullStreams["kill"];
  return child;
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

function createCopilotSessionWithConfig(
  modeId?: string | null,
  featureValues?: Record<string, unknown>,
): ACPAgentSession {
  return new ACPAgentSession(
    {
      provider: "copilot",
      cwd: "/tmp/paseo-acp-test",
      modeId: modeId ?? undefined,
      ...(featureValues ? { featureValues } : {}),
    },
    {
      provider: "copilot",
      logger: createTestLogger(),
      defaultCommand: ["copilot", "--acp"],
      defaultModes: COPILOT_MODES,
      sessionResponseTransformer: transformCopilotSessionResponse,
      configOptionsTransformer: transformCopilotConfigOptions,
      configFeatureOptions: [COPILOT_AGENT_FEATURE_OPTION],
      modeIdTransformer: transformCopilotModeId,
      providerModeWriter: writeCopilotProviderMode,
      beforeModeWriter: beforeCopilotModeWriter,
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

function copilotModeConfigOption(currentValue: string): SessionConfigOption {
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue,
    options: [
      {
        value: "https://agentclientprotocol.com/protocol/session-modes#agent",
        name: "Agent",
      },
      {
        value: "https://agentclientprotocol.com/protocol/session-modes#plan",
        name: "Plan",
      },
      {
        value: "https://agentclientprotocol.com/protocol/session-modes#autopilot",
        name: "Autopilot",
      },
    ],
  };
}

function copilotAllowAllConfigOption(currentValue: "on" | "off"): SessionConfigOption {
  return {
    id: "allow_all",
    name: "Allow All",
    category: "permissions",
    type: "select",
    currentValue,
    options: [
      { value: "on", name: "On" },
      { value: "off", name: "Off" },
    ],
  };
}

function copilotAgentConfigOption(currentValue: string): SessionConfigOption {
  return {
    id: "agent",
    name: "Agent",
    category: "_agent",
    type: "select",
    currentValue,
    options: [
      {
        value: "",
        name: "",
      },
      {
        value: "Probe Agent",
        name: "Probe Agent",
        description: "Temporary probe agent",
      },
    ],
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
    modeSource?: "legacy" | "config" | "fallback";
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
  const internals = asInternals<ACPConfiguredOverrideInternals>(session);
  internals.sessionId = "session-1";
  internals.connection = {
    setSessionMode,
    setSessionConfigOption,
    unstable_setSessionModel: unstableSetSessionModel,
    ...options.connection,
  };
  internals.availableModes = options.availableModes ?? [];
  // Tests that inject availableModes without an explicit source are modeling legacy
  // ACP session modes (session/set_mode), not config-mirrored lists.
  internals.modeSource =
    options.modeSource ??
    (options.availableModes && options.availableModes.length > 0 ? "legacy" : "fallback");
  internals.availableModels = options.availableModels ?? null;
  internals.configOptions = options.configOptions ?? [];
  internals.currentMode = options.currentMode ?? null;
  internals.currentModel = options.currentModel ?? null;

  return { internals, setSessionMode, unstableSetSessionModel, setSessionConfigOption };
}

test("ACP setModel only uses config-option fallback when the matching select choice contains the model", async () => {
  const logger = createTestLogger();
  const childLogger = { trace: vi.fn(), warn: vi.fn() };
  vi.spyOn(logger, "child").mockReturnValue(asInternals<typeof logger>(childLogger));
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
  const internals = asInternals<ACPModelSelectionInternals>(session);
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
    { value: "new-provider-model" },
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
      logger: asInternals<ReturnType<typeof createTestLogger>>(logger),
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

  test("normalizes stringified numeric ACP response ids", async () => {
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const logger = {
      warn: vi.fn(),
    };

    const stream = createLoggedNdJsonStream(output.writable, input.readable, {
      logger: asInternals<ReturnType<typeof createTestLogger>>(logger),
      provider: "deepseek-tui",
    });
    const reader = stream.readable.getReader();
    const writer = input.writable.getWriter();

    await writer.write(
      new TextEncoder().encode('{"jsonrpc":"2.0","id":"0","result":{"ok":true}}\n'),
    );

    const parsed = await reader.read();

    expect(parsed.value).toEqual({ jsonrpc: "2.0", id: 0, result: { ok: true } });
    expect(logger.warn).not.toHaveBeenCalled();

    await writer.close();
    reader.releaseLock();
  });

  test("does not log terminal control sequences from malformed ACP stdout", async () => {
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const logger = {
      warn: vi.fn(),
    };

    const stream = createLoggedNdJsonStream(output.writable, input.readable, {
      logger: asInternals<ReturnType<typeof createTestLogger>>(logger),
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

describe("ACPAgentSession terminal tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("runs single-string terminal commands through the platform shell", async () => {
    const child = createTerminalChildStub();
    const spawn = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
    const session = createSession();
    const shell = buildStringCommandShellInvocation({
      command: "git -C /repo status --short",
      windowsShell: "cmd",
    });

    await session.createTerminal({
      sessionId: "session-1",
      command: "git -C /repo status --short",
      cwd: "/repo",
    });

    expect(spawn).toHaveBeenCalledWith(
      shell.shell,
      shell.args,
      expect.objectContaining({
        cwd: "/repo",
        envOverlay: expect.objectContaining({ BASH_ENV: undefined }),
        shell: false,
      }),
    );
  });

  test("preserves cmd semantics for single-string terminal commands on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    try {
      const child = createTerminalChildStub();
      const spawn = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
      const session = createSession();

      await session.createTerminal({
        sessionId: "session-1",
        command: "echo %TEMP% && echo ok",
        cwd: "C:\\repo",
      });

      expect(spawn).toHaveBeenCalledWith(
        "cmd.exe",
        ["/c", "echo %TEMP% && echo ok"],
        expect.objectContaining({
          cwd: "C:\\repo",
          envOverlay: expect.objectContaining({ BASH_ENV: undefined }),
          shell: false,
        }),
      );
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  test("preserves explicit terminal argv", async () => {
    const child = createTerminalChildStub();
    const spawn = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
    const session = createSession();

    await session.createTerminal({
      sessionId: "session-1",
      command: "git",
      args: ["status", "--short"],
      cwd: "/repo",
    });

    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["status", "--short"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  test("surfaces spawn errors through terminal output and waitForTerminalExit", async () => {
    const child = createTerminalChildStub();
    vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
    const session = createSession();

    const terminal = await session.createTerminal({
      sessionId: "session-1",
      command: "missing-command",
    });
    child.emit("error", new Error("spawn missing-command ENOENT"));

    await expect(
      session.waitForTerminalExit({
        sessionId: "session-1",
        terminalId: terminal.terminalId,
      }),
    ).rejects.toThrow("spawn missing-command ENOENT");
    await expect(
      session.terminalOutput({
        sessionId: "session-1",
        terminalId: terminal.terminalId,
      }),
    ).resolves.toMatchObject({
      output: "spawn missing-command ENOENT\n",
      truncated: false,
    });
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
      source: "legacy",
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
      source: "config",
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
      source: "fallback",
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
      modeSource: "legacy",
    });

    expect(result).toMatchObject({
      availableMode: { id: "plan", label: "Plan" },
      configChoice: null,
      hasAvailableModes: true,
      modeSource: "legacy",
      usesLegacySessionMode: true,
    });
    expect(result.configOption?.id).toBe("mode");
  });

  test("does not treat config-mirrored mode lists as legacy session modes", () => {
    const result = resolveACPModeSelection({
      modeId: "bypassPermissions",
      availableModes: [
        { id: "default", label: "Standard" },
        { id: "plan", label: "Plan Mode" },
        { id: "bypassPermissions", label: "Skip Permissions" },
      ],
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "default",
          options: [
            { value: "default", name: "Standard" },
            { value: "plan", name: "Plan Mode" },
            { value: "bypassPermissions", name: "Skip Permissions" },
          ],
        },
      ],
      modeSource: "config",
    });

    expect(result).toMatchObject({
      availableMode: { id: "bypassPermissions", label: "Skip Permissions" },
      configChoice: { value: "bypassPermissions", name: "Skip Permissions" },
      hasAvailableModes: true,
      modeSource: "config",
      usesLegacySessionMode: false,
    });
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

    const modeEvents = asInternals<ACPSessionInternals>(validSession).translateSessionUpdate({
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
    const childLogger = { trace: vi.fn(), warn: vi.fn() };
    vi.spyOn(logger, "child").mockReturnValue(asInternals<typeof logger>(childLogger));
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
      { value: expect.stringContaining("acceptEdits") },
      expect.stringContaining("not valid"),
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      { value: expect.stringContaining("opus") },
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

  test("does not fail session start when configured model cannot be applied by ACP", async () => {
    const logger = createTestLogger();
    const childLogger = { trace: vi.fn(), warn: vi.fn() };
    vi.spyOn(logger, "child").mockReturnValue(asInternals<typeof logger>(childLogger));
    const session = createSessionWithConfig(
      { provider: "deepseek-tui", model: "deepseek/v4" },
      logger,
    );
    const { internals, setSessionConfigOption, unstableSetSessionModel } =
      prepareConfiguredOverrideSession(session, {
        currentModel: null,
        availableModels: null,
        configOptions: [],
        connection: { unstable_setSessionModel: undefined },
      });

    await expect(internals.applyConfiguredOverrides()).resolves.toBeUndefined();
    expect(unstableSetSessionModel).not.toHaveBeenCalled();
    expect(setSessionConfigOption).not.toHaveBeenCalled();
    expect(childLogger.warn).toHaveBeenCalledWith(
      { value: "deepseek/v4" },
      "deepseek-tui does not expose ACP model selection; using provider default model",
    );
  });

  test("routes config_option_update and refreshes derived mode, model, and thinking state", async () => {
    const session = createSession();
    const internals = asInternals<ACPSessionInternals>(session);

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
    const internals = asInternals<ACPSessionInternals>(session);

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
    const internals = asInternals<ACPSessionInternals>(session);

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
    const internals = asInternals<ACPModelSelectionInternals>(session);
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    internals.sessionId = "session-1";
    internals.configOptions = [selectConfigOption("mode", ["ask", "default"], "ask")];
    asInternals<{ modeSource: string; availableModes: Array<{ id: string; label: string }> }>(
      session,
    ).modeSource = "config";
    asInternals<{ availableModes: Array<{ id: string; label: string }> }>(session).availableModes =
      [
        { id: "ask", label: "ask" },
        { id: "default", label: "default" },
      ];
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

  test("routes legacy session modes through session/set_mode", async () => {
    const session = createSessionWithConfig({ modeId: "plan" });
    const { internals, setSessionMode, setSessionConfigOption } = prepareConfiguredOverrideSession(
      session,
      {
        currentMode: "default",
        modeSource: "legacy",
        availableModes: [
          { id: "default", label: "Always Ask" },
          { id: "plan", label: "Plan" },
        ],
        configOptions: [selectConfigOption("mode", ["default", "plan"], "default")],
      },
    );

    await internals.applyConfiguredOverrides();

    expect(setSessionMode).toHaveBeenCalledWith({ sessionId: "session-1", modeId: "plan" });
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  test("routes config-option modes through session/set_config_option (antigravity bypassPermissions)", async () => {
    const antigravityModes = [
      { id: "default", label: "Standard" },
      { id: "plan", label: "Plan Mode" },
      { id: "bypassPermissions", label: "Skip Permissions" },
    ];
    const modeConfig = {
      id: "mode",
      name: "Mode",
      category: "mode" as const,
      type: "select" as const,
      currentValue: "default",
      options: [
        { value: "default", name: "Standard" },
        { value: "plan", name: "Plan Mode" },
        { value: "bypassPermissions", name: "Skip Permissions" },
      ],
    };
    const session = createSessionWithConfig({
      provider: "antigravity-acp",
      modeId: "bypassPermissions",
    });
    const setSessionConfigOption = vi.fn(async () => ({
      configOptions: [{ ...modeConfig, currentValue: "bypassPermissions" }],
    }));
    const setSessionMode = vi.fn(async () => {
      throw Object.assign(new Error('"Method not found": session/set_mode'), {
        code: -32601,
        data: { method: "session/set_mode" },
      });
    });
    const { internals } = prepareConfiguredOverrideSession(session, {
      currentMode: "default",
      modeSource: "config",
      availableModes: antigravityModes,
      configOptions: [modeConfig],
      connection: { setSessionConfigOption, setSessionMode },
    });

    await internals.applyConfiguredOverrides();

    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "mode",
      value: "bypassPermissions",
    });
    expect(setSessionMode).not.toHaveBeenCalled();
    await expect(session.getCurrentMode()).resolves.toBe("bypassPermissions");
  });

  test("uses canonical model returned by setSessionConfigOption response", async () => {
    const session = createSession();
    const internals = asInternals<ACPModelSelectionInternals>(session);
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
    const internals = asInternals<ACPModelSelectionInternals>(session);
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

  test("passes generic ACP permission requests through to the user", async () => {
    const session = createSessionWithConfig({
      provider: "cursor-acp",
      modeId: "https://agentclientprotocol.com/protocol/session-modes#agent",
    });
    const events: AgentStreamEvent[] = [];
    const permissionOptions: PermissionOption[] = [
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ];

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    session.subscribe((event) => {
      events.push(event);
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
    expect(requested).toMatchObject({
      type: "permission_requested",
      request: {
        actions: [
          { id: "allow-once", label: "Allow", behavior: "allow" },
          { id: "reject-once", label: "Reject", behavior: "deny" },
        ],
      },
    });
    if (requested?.type !== "permission_requested") {
      throw new Error("Expected permission request");
    }

    await session.respondToPermission(requested.request.id, { behavior: "allow" });
    await expect(permission).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });

  test("preserves ACP chooser actions and returns the selected option", async () => {
    const session = createSessionWithConfig({
      provider: "kimi-acp",
      modeId: "https://agentclientprotocol.com/protocol/session-modes#agent",
    });
    const events: AgentStreamEvent[] = [];

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    session.subscribe((event) => events.push(event));

    const permission = session.requestPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "question-1",
        title: "AskUserQuestion",
        status: "pending",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Which path should Paseo take?",
            },
          },
        ],
      },
      options: [
        { optionId: "q0_opt_0", name: "Narrow fix", kind: "allow_once" },
        { optionId: "q0_opt_1", name: "Protocol fix", kind: "allow_once" },
        { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
      ],
    } satisfies RequestPermissionRequest);

    await Promise.resolve();

    const requested = events.find((event) => event.type === "permission_requested");
    expect(requested).toMatchObject({
      type: "permission_requested",
      request: {
        detail: {
          type: "plain_text",
          label: "AskUserQuestion",
          text: "Which path should Paseo take?",
        },
        actions: [
          { id: "q0_opt_0", label: "Narrow fix", behavior: "allow" },
          { id: "q0_opt_1", label: "Protocol fix", behavior: "allow" },
          { id: "q0_skip", label: "Skip", behavior: "deny" },
        ],
      },
    });
    if (requested?.type !== "permission_requested") {
      throw new Error("Expected permission request");
    }

    await session.respondToPermission(requested.request.id, {
      behavior: "allow",
      selectedActionId: "q0_opt_1",
    });

    await expect(permission).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "q0_opt_1" },
    });
  });

  test("preserves ACP permission requests after invalid selected actions", async () => {
    const session = createSessionWithConfig({ provider: "generic-acp" });
    const events: AgentStreamEvent[] = [];

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    session.subscribe((event) => events.push(event));

    const permission = session.requestPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "Edit file",
        kind: "edit",
        status: "pending",
      },
      options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    } satisfies RequestPermissionRequest);

    await Promise.resolve();

    const requested = events.find((event) => event.type === "permission_requested");
    if (requested?.type !== "permission_requested") {
      throw new Error("Expected permission request");
    }

    await expect(
      session.respondToPermission(requested.request.id, {
        behavior: "allow",
        selectedActionId: "",
      }),
    ).rejects.toThrow("does not exist");
    expect(session.getPendingPermissions()).toHaveLength(1);

    await expect(
      session.respondToPermission(requested.request.id, {
        behavior: "deny",
        selectedActionId: "allow-once",
      }),
    ).rejects.toThrow("does not match 'deny' behavior");
    expect(session.getPendingPermissions()).toHaveLength(1);

    await session.respondToPermission(requested.request.id, {
      behavior: "deny",
      selectedActionId: "reject-once",
    });
    await expect(permission).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
  });

  test("auto-accepts ACP permission requests when the shared feature is enabled", async () => {
    const session = createSessionWithConfig({
      provider: "cursor-acp",
      featureValues: { auto_accept: true },
    });
    const events: Array<{ type: string }> = [];

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    session.subscribe((event) => events.push(event as { type: string }));

    await expect(
      session.requestPermission({
        sessionId: "session-1",
        toolCall: {
          toolCallId: "tool-1",
          title: "Edit file",
          kind: "edit",
          status: "pending",
        },
        options: [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      } satisfies RequestPermissionRequest),
    ).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "permission_requested" }));
    expect(session.getPendingPermissions()).toEqual([]);
  });

  test("does not auto-accept ACP chooser requests", async () => {
    const session = createSessionWithConfig({
      provider: "kimi-acp",
      featureValues: { auto_accept: true },
    });
    const events: AgentStreamEvent[] = [];

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    session.subscribe((event) => events.push(event));

    const permission = session.requestPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "question-1",
        title: "AskUserQuestion",
        status: "pending",
      },
      options: [
        { optionId: "q0_opt_0", name: "Narrow fix", kind: "allow_once" },
        { optionId: "q0_opt_1", name: "Protocol fix", kind: "allow_once" },
        { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
      ],
    } satisfies RequestPermissionRequest);

    await Promise.resolve();

    const requested = events.find((event) => event.type === "permission_requested");
    expect(requested).toMatchObject({
      type: "permission_requested",
      request: {
        actions: [
          { id: "q0_opt_0", label: "Narrow fix", behavior: "allow" },
          { id: "q0_opt_1", label: "Protocol fix", behavior: "allow" },
          { id: "q0_skip", label: "Skip", behavior: "deny" },
        ],
      },
    });
    if (requested?.type !== "permission_requested") {
      throw new Error("Expected permission request");
    }

    await session.respondToPermission(requested.request.id, {
      behavior: "allow",
      selectedActionId: "q0_opt_0",
    });
    await expect(permission).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "q0_opt_0" },
    });
  });

  test("starts auto-accepting permissions when the shared feature is toggled on", async () => {
    const session = createSessionWithConfig({ provider: "generic-acp" });
    const internals = asInternals<ACPSessionInternals>(session);
    internals.sessionId = "session-1";
    internals.connection = {};

    await session.setFeature("auto_accept", true);

    expect(session.features).toContainEqual(
      expect.objectContaining({ type: "toggle", id: "auto_accept", value: true }),
    );
    await expect(
      session.requestPermission({
        sessionId: "session-1",
        toolCall: {
          toolCallId: "tool-1",
          title: "Run command",
          kind: "execute",
          status: "pending",
        },
        options: [{ optionId: "allow-always", name: "Always allow", kind: "allow_always" }],
      } satisfies RequestPermissionRequest),
    ).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-always" },
    });
  });

  test("surfaces an ACP permission when auto-accept has no allow option", async () => {
    const session = createSessionWithConfig({ featureValues: { auto_accept: true } });
    const events: Array<{ type: string; request?: { id: string } }> = [];
    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    session.subscribe((event) => events.push(event as { type: string; request?: { id: string } }));

    const permission = session.requestPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "Unavailable approval",
        kind: "other",
        status: "pending",
      },
      options: [{ optionId: "reject-once", name: "Reject", kind: "reject_once" }],
    } satisfies RequestPermissionRequest);
    await Promise.resolve();

    const requested = events.find((event) => event.type === "permission_requested");
    expect(requested?.request?.id).toEqual(expect.any(String));
    await session.respondToPermission(requested!.request!.id, { behavior: "deny" });
    await expect(permission).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
  });

  test("maps Copilot Allow All mode to allow_all ACP config on session start", async () => {
    const setSessionConfigOption = vi.fn(async () => ({
      configOptions: [
        copilotModeConfigOption("https://agentclientprotocol.com/protocol/session-modes#agent"),
        copilotAllowAllConfigOption("on"),
      ],
    }));
    const setSessionMode = vi.fn(async () => undefined);
    const session = createCopilotSessionWithConfig(COPILOT_ALLOW_ALL_MODE_ID);
    const { internals } = prepareConfiguredOverrideSession(session, {
      currentMode: "https://agentclientprotocol.com/protocol/session-modes#agent",
      availableModes: COPILOT_MODES,
      configOptions: [
        copilotModeConfigOption("https://agentclientprotocol.com/protocol/session-modes#agent"),
        copilotAllowAllConfigOption("off"),
      ],
      connection: { setSessionConfigOption, setSessionMode },
    });
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    await internals.applyConfiguredOverrides();
    unsubscribe();

    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "allow_all",
      value: "on",
    });
    expect(setSessionMode).not.toHaveBeenCalled();
    await expect(session.getCurrentMode()).resolves.toBe(COPILOT_ALLOW_ALL_MODE_ID);
    expect(events.some((event) => event.type === "permission_requested")).toBe(false);
  });

  test("accepts Copilot's legacy autopilot mode ID as Allow All", async () => {
    const setSessionConfigOption = vi.fn(async () => ({
      configOptions: [
        copilotModeConfigOption("https://agentclientprotocol.com/protocol/session-modes#agent"),
        copilotAllowAllConfigOption("on"),
      ],
    }));
    const setSessionMode = vi.fn(async () => undefined);
    const session = createCopilotSessionWithConfig();
    prepareConfiguredOverrideSession(session, {
      currentMode: "https://agentclientprotocol.com/protocol/session-modes#agent",
      availableModes: COPILOT_MODES,
      configOptions: [
        copilotModeConfigOption("https://agentclientprotocol.com/protocol/session-modes#agent"),
        copilotAllowAllConfigOption("off"),
      ],
      connection: { setSessionConfigOption, setSessionMode },
    });

    await session.setMode("https://agentclientprotocol.com/protocol/session-modes#autopilot");

    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "allow_all",
      value: "on",
    });
    expect(setSessionMode).not.toHaveBeenCalled();
    await expect(session.getCurrentMode()).resolves.toBe(COPILOT_ALLOW_ALL_MODE_ID);
  });

  test("switching Copilot away from Allow All turns allow_all off before setting the ACP mode", async () => {
    const setSessionConfigOption = vi.fn(async (input: { value: string }) => ({
      configOptions: [
        copilotModeConfigOption("https://agentclientprotocol.com/protocol/session-modes#agent"),
        copilotAllowAllConfigOption(input.value === "on" ? "on" : "off"),
      ],
    }));
    const setSessionMode = vi.fn(async () => undefined);
    const session = createCopilotSessionWithConfig(COPILOT_ALLOW_ALL_MODE_ID);
    prepareConfiguredOverrideSession(session, {
      currentMode: COPILOT_ALLOW_ALL_MODE_ID,
      availableModes: COPILOT_MODES,
      configOptions: [
        copilotModeConfigOption(COPILOT_ALLOW_ALL_MODE_ID),
        copilotAllowAllConfigOption("on"),
      ],
      connection: { setSessionConfigOption, setSessionMode },
    });

    await session.setMode("https://agentclientprotocol.com/protocol/session-modes#agent");

    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "allow_all",
      value: "off",
    });
    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: "session-1",
      modeId: "https://agentclientprotocol.com/protocol/session-modes#agent",
    });
  });

  test("trusts Copilot allow_all config updates as the current mode source", async () => {
    const session = createCopilotSessionWithConfig();
    const internals = asInternals<ACPSessionInternals>(session);

    const events = internals.translateSessionUpdate({
      sessionUpdate: "config_option_update",
      configOptions: [
        copilotModeConfigOption("https://agentclientprotocol.com/protocol/session-modes#agent"),
        copilotAllowAllConfigOption("on"),
      ],
    });

    expect(events).toMatchObject([
      {
        type: "mode_changed",
        provider: "copilot",
        currentModeId: COPILOT_ALLOW_ALL_MODE_ID,
        availableModes: expect.arrayContaining([
          expect.objectContaining({ id: COPILOT_ALLOW_ALL_MODE_ID, label: "Allow All" }),
        ]),
      },
    ]);
    await expect(session.getCurrentMode()).resolves.toBe(COPILOT_ALLOW_ALL_MODE_ID);
  });

  test("exposes Copilot custom agents as a select feature", () => {
    const session = createCopilotSessionWithConfig();
    const internals = asInternals<ACPSessionInternals>(session);
    internals.configOptions = [copilotAgentConfigOption("")];

    expect(session.features).toEqual([
      expect.objectContaining({
        type: "toggle",
        id: "auto_accept",
        value: false,
      }),
      {
        type: "select",
        id: "agent",
        label: "Agent",
        description: "Use a Copilot custom agent profile",
        tooltip: "Select Copilot agent",
        icon: undefined,
        value: "",
        options: [
          {
            id: "",
            label: "Default",
            description: undefined,
            isDefault: true,
            metadata: undefined,
          },
          {
            id: "Probe Agent",
            label: "Probe Agent",
            description: "Temporary probe agent",
            isDefault: false,
            metadata: undefined,
          },
        ],
      },
    ]);
  });

  test("applies configured Copilot custom agent before the first turn", async () => {
    const setSessionConfigOption = vi.fn(async () => ({
      configOptions: [copilotAgentConfigOption("Probe Agent")],
    }));
    const session = createCopilotSessionWithConfig(null, { agent: "Probe Agent" });
    const { internals } = prepareConfiguredOverrideSession(session, {
      configOptions: [copilotAgentConfigOption("")],
      connection: { setSessionConfigOption },
    });

    await internals.applyConfiguredOverrides();

    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "agent",
      value: "Probe Agent",
    });
    expect(session.features).toEqual([
      expect.objectContaining({
        id: "auto_accept",
        value: false,
      }),
      expect.objectContaining({
        id: "agent",
        value: "Probe Agent",
      }),
    ]);
  });

  test("sets Copilot custom agent through ACP config options", async () => {
    const setSessionConfigOption = vi.fn(async () => ({
      configOptions: [copilotAgentConfigOption("Probe Agent")],
    }));
    const session = createCopilotSessionWithConfig();
    prepareConfiguredOverrideSession(session, {
      configOptions: [copilotAgentConfigOption("")],
      connection: { setSessionConfigOption },
    });

    await session.setFeature("agent", "Probe Agent");

    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "agent",
      value: "Probe Agent",
    });
    expect(session.features).toEqual([
      expect.objectContaining({
        id: "auto_accept",
        value: false,
      }),
      expect.objectContaining({
        id: "agent",
        value: "Probe Agent",
      }),
    ]);
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
        } as SpawnedACPProcess;
      }

      protected override async closeProbe(): Promise<void> {}
    }

    const client = new TestACPAgentClient({
      provider: "pi",
      logger: createTestLogger(),
      defaultCommand: ["test-acp"],
      modelTransformer: transformPiModels,
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/acp-models", force: false }),
    ).resolves.toEqual({
      models: [
        {
          provider: "pi",
          id: "openrouter/openai/gpt-4.1-mini",
          label: "gpt-4.1-mini",
          description: "openrouter/openai/gpt-4.1-mini",
          isDefault: true,
          thinkingOptions: undefined,
          defaultThinkingOptionId: undefined,
        },
      ],
      modes: [],
    });
  });
});

describe("ACPAgentClient config features", () => {
  test("enables Auto Accept for unattended ACP creation", () => {
    const client = new ACPAgentClient({
      provider: "generic-acp",
      logger: createTestLogger(),
      defaultCommand: ["generic-acp", "acp"],
    });

    expect(
      client.resolveCreateConfig({
        provider: "generic-acp",
        requestedMode: undefined,
        featureValues: { provider_feature: "kept" },
        parent: null,
        unattended: true,
        availableModes: [],
      }),
    ).toEqual({
      modeId: undefined,
      featureValues: { provider_feature: "kept", auto_accept: true },
    });
  });

  test("preserves an explicit Auto Accept override for unattended ACP creation", () => {
    const client = new ACPAgentClient({
      provider: "generic-acp",
      logger: createTestLogger(),
      defaultCommand: ["generic-acp", "acp"],
    });

    expect(
      client.resolveCreateConfig({
        provider: "generic-acp",
        requestedMode: undefined,
        featureValues: { auto_accept: false },
        parent: null,
        unattended: true,
        availableModes: [],
      }),
    ).toEqual({ modeId: undefined, featureValues: { auto_accept: false } });
  });

  test("maps an unattended cross-provider parent to ACP Auto Accept", () => {
    const client = new ACPAgentClient({
      provider: "generic-acp",
      logger: createTestLogger(),
      defaultCommand: ["generic-acp", "acp"],
    });

    expect(
      client.resolveCreateConfig({
        provider: "generic-acp",
        requestedMode: undefined,
        featureValues: undefined,
        parent: {
          provider: "claude",
          modeId: "bypassPermissions",
          isUnattended: true,
        },
        unattended: false,
        availableModes: [{ id: "agent", label: "Agent" }],
      }),
    ).toEqual({ modeId: undefined, featureValues: { auto_accept: true } });
  });

  test("treats Auto Accept as an unattended ACP configuration", () => {
    const client = new ACPAgentClient({
      provider: "generic-acp",
      logger: createTestLogger(),
      defaultCommand: ["generic-acp", "acp"],
    });

    expect(
      client.isCreateConfigUnattended({
        modeId: null,
        config: {
          provider: "generic-acp",
          cwd: "/tmp/acp-features",
          featureValues: { auto_accept: true },
        },
        availableModes: [],
      }),
    ).toBe(true);
  });

  test("exposes Auto Accept for every ACP provider without starting a probe", async () => {
    const client = new ACPAgentClient({
      provider: "generic-acp",
      logger: createTestLogger(),
      defaultCommand: ["generic-acp", "acp"],
    });

    await expect(
      client.listFeatures({
        provider: "generic-acp",
        cwd: "/tmp/acp-features",
        featureValues: { auto_accept: true },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "toggle",
        id: "auto_accept",
        label: "Auto Accept",
        value: true,
      }),
    ]);
  });

  test("derives features from configured ACP select options", async () => {
    class TestACPAgentClient extends ACPAgentClient {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: {
            newSession: vi.fn().mockResolvedValue({
              sessionId: "session-1",
              configOptions: [copilotAgentConfigOption("Probe Agent")],
            }),
          },
          initialize: { agentCapabilities: {} },
        } as SpawnedACPProcess;
      }

      protected override async closeProbe(): Promise<void> {}
    }

    const client = new TestACPAgentClient({
      provider: "copilot",
      logger: createTestLogger(),
      defaultCommand: ["copilot", "--acp"],
      configFeatureOptions: [COPILOT_AGENT_FEATURE_OPTION],
    });

    await expect(
      client.listFeatures({
        provider: "copilot",
        cwd: "/tmp/acp-features",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "toggle",
        id: "auto_accept",
        value: false,
      }),
      expect.objectContaining({
        type: "select",
        id: "agent",
        value: "Probe Agent",
        options: [
          expect.objectContaining({ id: "", label: "Default", isDefault: false }),
          expect.objectContaining({ id: "Probe Agent", label: "Probe Agent", isDefault: true }),
        ],
      }),
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
      } as SpawnedACPProcess;
    }

    protected override async closeProbe(): Promise<void> {}
  }

  test("applies sessionResponseTransformer before deriving catalog modes", async () => {
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

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/acp-modes", force: false }),
    ).resolves.toEqual({
      models: [],
      modes: [
        {
          id: "review",
          label: "Review",
          description: "After transform",
        },
      ],
    });
  });
});

describe("ACPAgentClient fetchCatalog", () => {
  test("passes the requested cwd to the catalog probe", async () => {
    const newSession = vi.fn().mockResolvedValue({ modes: null, models: null, configOptions: [] });

    class TestACPAgentClient extends ACPAgentClient {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: { newSession },
          initialize: { agentCapabilities: {} },
        } as SpawnedACPProcess;
      }

      protected override async closeProbe(): Promise<void> {}
    }

    const client = new TestACPAgentClient({
      provider: "pi",
      logger: createTestLogger(),
      defaultCommand: ["test-acp"],
      defaultModes: [],
    });

    await client.fetchCatalog({ scope: "workspace", cwd: "/tmp/acp-catalog-cwd", force: false });

    expect(newSession).toHaveBeenCalledWith({
      cwd: "/tmp/acp-catalog-cwd",
      mcpServers: [],
    });
  });

  test("returns an empty modes array when no ACP modes are reported and fallback modes are empty", async () => {
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
        } as SpawnedACPProcess;
      }

      protected override async closeProbe(): Promise<void> {}
    }

    const client = new TestACPAgentClient({
      provider: "pi",
      logger: createTestLogger(),
      defaultCommand: ["test-acp"],
      defaultModes: [],
    });

    await expect(
      client.fetchCatalog({ scope: "workspace", cwd: "/tmp/acp-modes", force: false }),
    ).resolves.toEqual({
      models: [],
      modes: [],
    });
  });
});

describe("ACPAgentClient listImportableSessions", () => {
  function makeClient(args: { listSessions: ReturnType<typeof vi.fn>; supportsList?: boolean }) {
    class TestACPAgentClient extends ACPAgentClient {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
          connection: { listSessions: args.listSessions },
          initialize: {
            agentCapabilities:
              args.supportsList === false ? {} : { sessionCapabilities: { list: {} } },
          },
        } as unknown as SpawnedACPProcess;
      }

      protected override async closeProbe(): Promise<void> {}
    }

    return new TestACPAgentClient({
      provider: "kimi",
      logger: createTestLogger(),
      defaultCommand: ["kimi", "acp"],
      defaultModes: [],
    });
  }

  test("forwards the requested cwd to session/list so the agent filters by directory", async () => {
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [
        {
          sessionId: "session-1",
          cwd: "/Users/moonshot",
          title: "细致查看一下本仓库内容",
          updatedAt: "2026-06-13T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });

    const client = makeClient({ listSessions });
    const result = await client.listImportableSessions({ cwd: "/Users/moonshot", limit: 20 });

    expect(listSessions).toHaveBeenCalledWith({ cwd: "/Users/moonshot" });
    expect(result).toEqual([
      {
        providerHandleId: "session-1",
        cwd: "/Users/moonshot",
        title: "细致查看一下本仓库内容",
        firstPromptPreview: null,
        lastPromptPreview: null,
        lastActivityAt: new Date("2026-06-13T00:00:00.000Z"),
      },
    ]);
  });

  test("omits cwd from session/list when none is requested", async () => {
    const listSessions = vi.fn().mockResolvedValue({ sessions: [], nextCursor: null });
    const client = makeClient({ listSessions });

    await client.listImportableSessions({ limit: 20 });

    expect(listSessions).toHaveBeenCalledWith({});
  });

  test("forwards cwd alongside the pagination cursor across pages", async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [{ sessionId: "s1", cwd: "/Users/moonshot", title: null, updatedAt: null }],
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        sessions: [{ sessionId: "s2", cwd: "/Users/moonshot", title: null, updatedAt: null }],
        nextCursor: null,
      });

    const client = makeClient({ listSessions });
    await client.listImportableSessions({ cwd: "/Users/moonshot" });

    expect(listSessions).toHaveBeenNthCalledWith(1, { cwd: "/Users/moonshot" });
    expect(listSessions).toHaveBeenNthCalledWith(2, {
      cursor: "cursor-2",
      cwd: "/Users/moonshot",
    });
  });
});

describe("ACP providers advertise session listing", () => {
  // The daemon's agent-manager only queries providers whose
  // capabilities.supportsSessionListing is true. Without it, ACP providers
  // (Kimi and other custom ACP agents, Copilot) are skipped and import shows
  // nothing even though listImportableSessions is implemented.
  test("generic ACP clients (e.g. Kimi) report supportsSessionListing", () => {
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["kimi", "acp"],
    });
    expect(client.capabilities.supportsSessionListing).toBe(true);
  });

  test("Copilot ACP client reports supportsSessionListing", () => {
    const client = new CopilotACPAgentClient({ logger: createTestLogger() });
    expect(client.capabilities.supportsSessionListing).toBe(true);
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
        waitForInitialCommands: false,
      },
    );

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

    asInternals<ACPSessionInternals>(session).translateSessionUpdate({
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
        kind: "command",
      },
      {
        name: "create_plan",
        description: "Draft a plan for the requested work",
        argumentHint: "",
        kind: "command",
      },
    ]);

    expect(await session.listCommands()).toEqual([
      {
        name: "research_codebase",
        description: "Search the workspace for relevant files",
        argumentHint: "",
        kind: "command",
      },
      {
        name: "create_plan",
        description: "Draft a plan for the requested work",
        argumentHint: "",
        kind: "command",
      },
    ]);
  });
});

describe("ACPAgentSession", () => {
  test("drops MCP servers from ACP requests when the provider does not support MCP", () => {
    const session = new ACPAgentSession(
      {
        provider: "no-mcp-acp",
        cwd: "/tmp/paseo-acp-test",
        mcpServers: {
          paseo: {
            type: "http",
            url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
          },
        },
      },
      {
        provider: "no-mcp-acp",
        logger: createTestLogger(),
        defaultCommand: ["no-mcp-acp", "serve"],
        defaultModes: [],
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

    expect(asInternals<ACPSessionInternals>(session).acpMcpServers()).toEqual([]);
  });

  test("summarizes JSON-RPC error details without stringifying objects", () => {
    const summary = summarizeACPRequestError(
      new RequestError(-32603, "Internal error", {
        details: "Droid process exited unexpectedly (exit code 1)",
      }),
    );

    expect(summary).toMatchObject({
      message: "Internal error: Droid process exited unexpectedly (exit code 1)",
      code: "-32603",
    });
    expect(summary.message).not.toContain("[object Object]");
    expect(summary.diagnostic).toContain("Droid process exited unexpectedly");
  });

  test("accepts ACP extension notifications without failing the JSON-RPC connection", async () => {
    const logger = createTestLogger();
    const trace = vi.spyOn(logger, "trace");
    const session = createSessionWithConfig({ provider: "kiro" }, logger);

    await expect(
      session.extNotification("_kiro.dev/session/initialized", {
        sessionId: "session-1",
      }),
    ).resolves.toBeUndefined();
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "kiro",
        method: "_kiro.dev/session/initialized",
        sessionId: "session-1",
      }),
      "provider.acp.extension_notification",
    );
  });

  test("maps the Kiro _kiro.dev/commands/available notification into slash commands and skills", async () => {
    const session = createKiroSession({
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: 1500,
    });
    asInternals<ACPSessionInternals>(session).sessionId = "session-1";

    const listCommandsPromise = session.listCommands();

    await session.extNotification("_kiro.dev/commands/available", {
      sessionId: "session-1",
      commands: [
        {
          name: "/agent",
          description: "Select or list available agents",
          meta: { inputType: "selection", hint: "swap <name>" },
        },
      ],
      prompts: [
        {
          name: "agent-sync-doctor",
          description: "Hand off Claude or Codex state across Macs",
          arguments: [],
          serverName: "skill:config",
        },
      ],
      // Tools are not slash commands and must be ignored.
      tools: [{ name: "code", description: "Code intelligence", source: "built-in" }],
    });

    expect(await listCommandsPromise).toEqual([
      {
        name: "agent",
        description: "Select or list available agents",
        argumentHint: "swap <name>",
        kind: "command",
      },
      {
        name: "agent-sync-doctor",
        description: "Hand off Claude or Codex state across Macs",
        argumentHint: "",
        kind: "skill",
      },
    ]);
  });

  test("ignores Kiro _kiro.dev/commands/available for a different session", async () => {
    const session = createKiroSession();
    asInternals<ACPSessionInternals>(session).sessionId = "session-1";

    await session.extNotification("_kiro.dev/commands/available", {
      sessionId: "other-session",
      commands: [{ name: "/agent", description: "Select or list available agents" }],
      prompts: [],
    });

    expect(await session.listCommands()).toEqual([]);
  });

  test("settles listCommands() immediately on an empty Kiro commands batch", async () => {
    // A long timeout means a resolution can only come from settleCommandsReady()
    // firing — not from the wait timer — so this test would hang if the empty
    // batch failed to unblock listCommands() (the P1 regression).
    const session = createKiroSession({
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: 60_000,
    });
    asInternals<ACPSessionInternals>(session).sessionId = "session-1";

    const listCommandsPromise = session.listCommands();

    await session.extNotification("_kiro.dev/commands/available", {
      sessionId: "session-1",
      commands: [],
      prompts: [],
    });

    expect(await listCommandsPromise).toEqual([]);
  });

  test("emits assistant and reasoning chunks as deltas while user chunks stay accumulated", async () => {
    const session = createSession();
    const events: Array<{
      type: string;
      item?: { type: string; text?: string; messageId?: string };
    }> = [];
    asInternals<ACPSessionInternals>(session).sessionId = "session-1";

    session.subscribe((event) => {
      events.push(
        event as { type: string; item?: { type: string; text?: string; messageId?: string } },
      );
    });

    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: "Hey!" },
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: " How are you?" },
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "Thinking" },
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: " more" },
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: "hel" },
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: "lo" },
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-2",
        content: { type: "text", text: "" },
      } as SessionUpdate,
    });

    const timeline = events
      .filter((event) => event.type === "timeline")
      .map((event) => event.item)
      .filter(Boolean);

    expect(timeline).toEqual([
      { type: "assistant_message", text: "Hey!", messageId: "assistant-1" },
      { type: "assistant_message", text: " How are you?", messageId: "assistant-1" },
      { type: "reasoning", text: "Thinking" },
      { type: "reasoning", text: " more" },
      { type: "user_message", text: "hello", messageId: "user-1" },
    ]);
  });

  test("assigns one fallback ID per contiguous assistant message", async () => {
    const session = createSession();
    const assistantMessages: Array<{ text: string; messageId?: string }> = [];
    asInternals<ACPSessionInternals>(session).sessionId = "session-1";

    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "assistant_message") {
        assistantMessages.push(event.item);
      }
    });

    for (const text of ["First", " message"]) {
      await session.sessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        } as SessionUpdate,
      });
    }
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Next response" },
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Second message" },
      } as SessionUpdate,
    });

    expect(assistantMessages).toHaveLength(3);
    expect(assistantMessages[0].messageId).toEqual(expect.any(String));
    expect(assistantMessages[1].messageId).toBe(assistantMessages[0].messageId);
    expect(assistantMessages[2].messageId).toEqual(expect.any(String));
    expect(assistantMessages[2].messageId).not.toBe(assistantMessages[0].messageId);
  });

  test("keeps ACP configuration notifications outside the turn lifecycle", async () => {
    const session = createSession();
    asInternals<ACPSessionInternals>(session).sessionId = "session-1";

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [
          selectConfigOption("mode", ["plan", "yolo"], "yolo"),
          selectConfigOption("model", ["kimi-code/kimi-for-coding"]),
          selectConfigOption("thought_level", ["off", "on"], "on"),
        ],
      } as SessionUpdate,
    });

    expect(events.map((event) => event.type)).toEqual([
      "thread_started",
      "mode_changed",
      "model_changed",
      "thinking_option_changed",
    ]);
  });

  test("forwards out-of-prompt ACP content without inventing a turn", async () => {
    const session = createSession();
    asInternals<ACPSessionInternals>(session).sessionId = "session-1";

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "unscoped-message",
        content: { type: "text", text: "Unscoped ACP update" },
      } as SessionUpdate,
    });

    expect(events).toEqual([
      {
        type: "thread_started",
        provider: "claude-acp",
        sessionId: "session-1",
      },
      {
        type: "timeline",
        provider: "claude-acp",
        item: {
          type: "assistant_message",
          text: "Unscoped ACP update",
          messageId: "unscoped-message",
        },
      },
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

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    asInternals<ACPSessionInternals>(session).connection = { prompt };

    session.subscribe((event) => {
      events.push(event as { type: string; turnId?: string });
    });

    const { turnId } = await session.startTurn("hello");

    expect(prompt).toHaveBeenCalledOnce();
    expect(events.find((event) => event.type === "turn_started")).toMatchObject({
      type: "turn_started",
      turnId,
    });
    expect(asInternals<ACPSessionInternals>(session).activeForegroundTurnId).toBe(turnId);

    resolvePrompt({ stopReason: "end_turn", usage: { outputTokens: 3 } });
    await Promise.resolve();
    await Promise.resolve();

    expect(events.find((event) => event.type === "turn_completed")).toMatchObject({
      type: "turn_completed",
      turnId,
    });
    expect(asInternals<ACPSessionInternals>(session).activeForegroundTurnId).toBeNull();
  });

  test("startTurn emits the submitted user message even when ACP does not echo it", async () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    let resolvePrompt!: (value: PromptResponse) => void;
    const prompt = vi.fn(
      () =>
        new Promise<PromptResponse>((resolve) => {
          resolvePrompt = resolve;
        }),
    );

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    asInternals<ACPSessionInternals>(session).connection = { prompt };

    session.subscribe((event) => {
      events.push(event);
    });

    const { turnId } = await session.startTurn("hello", {
      clientMessageId: "msg-client-1",
    });

    expect(prompt).toHaveBeenCalledWith({
      sessionId: "session-1",
      messageId: "msg-client-1",
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(
      events
        .filter(
          (event) =>
            event.type === "turn_started" ||
            (event.type === "timeline" && event.item.type === "user_message"),
        )
        .map((event) => event.type),
    ).toEqual(["turn_started", "timeline"]);
    expect(
      events.filter((event) => event.type === "timeline" && event.item.type === "user_message"),
    ).toEqual([
      {
        type: "timeline",
        provider: "claude-acp",
        turnId,
        item: {
          type: "user_message",
          text: "hello",
          messageId: "msg-client-1",
          clientMessageId: "msg-client-1",
        },
      },
    ]);

    resolvePrompt({ stopReason: "end_turn" });
  });

  test("startTurn dedupes ACP user echo chunks for the submitted message", async () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    const prompt = vi.fn(() => new Promise<PromptResponse>(() => {}));

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    asInternals<ACPSessionInternals>(session).connection = { prompt };

    session.subscribe((event) => {
      events.push(event);
    });

    await session.startTurn("hello", { clientMessageId: "msg-client-1" });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "msg-client-1",
        content: { type: "text", text: "hello" },
      } as SessionUpdate,
    });

    expect(
      events.filter((event) => event.type === "timeline" && event.item.type === "user_message"),
    ).toHaveLength(1);
  });

  test("startTurn dedupes ACP user echo chunks without message ids for the submitted message", async () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    const prompt = vi.fn(() => new Promise<PromptResponse>(() => {}));

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    asInternals<ACPSessionInternals>(session).connection = { prompt };

    session.subscribe((event) => {
      events.push(event);
    });

    await session.startTurn("hello", { clientMessageId: "msg-client-1" });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hello" },
      } as SessionUpdate,
    });

    expect(
      events.filter((event) => event.type === "timeline" && event.item.type === "user_message"),
    ).toEqual([
      {
        type: "timeline",
        provider: "claude-acp",
        item: {
          type: "user_message",
          text: "hello",
          messageId: "msg-client-1",
          clientMessageId: "msg-client-1",
        },
        turnId: expect.any(String),
      },
    ]);
  });

  test("startTurn dedupes ACP user echo chunks without message ids across turns", async () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    let resolvePrompt!: (value: PromptResponse) => void;
    const prompt = vi.fn(
      () =>
        new Promise<PromptResponse>((resolve) => {
          resolvePrompt = resolve;
        }),
    );

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    asInternals<ACPSessionInternals>(session).connection = { prompt };

    session.subscribe((event) => {
      events.push(event);
    });

    await session.startTurn("first", { clientMessageId: "msg-client-1" });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "first" },
      } as SessionUpdate,
    });
    resolvePrompt({ stopReason: "end_turn" });
    await Promise.resolve();
    await Promise.resolve();

    await session.startTurn("second", { clientMessageId: "msg-client-2" });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "second" },
      } as SessionUpdate,
    });

    expect(
      events.filter((event) => event.type === "timeline" && event.item.type === "user_message"),
    ).toEqual([
      {
        type: "timeline",
        provider: "claude-acp",
        item: {
          type: "user_message",
          text: "first",
          messageId: "msg-client-1",
          clientMessageId: "msg-client-1",
        },
        turnId: expect.any(String),
      },
      {
        type: "timeline",
        provider: "claude-acp",
        item: {
          type: "user_message",
          text: "second",
          messageId: "msg-client-2",
          clientMessageId: "msg-client-2",
        },
        turnId: expect.any(String),
      },
    ]);
  });

  test("startTurn dedupes ACP user echo chunks with provider-owned ids for the submitted message", async () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    const prompt = vi.fn(() => new Promise<PromptResponse>(() => {}));

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    asInternals<ACPSessionInternals>(session).connection = { prompt };

    session.subscribe((event) => {
      events.push(event);
    });

    await session.startTurn("hello", { clientMessageId: "msg-client-1" });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "msg-provider-1",
        content: { type: "text", text: "hello" },
      } as SessionUpdate,
    });

    expect(
      events.filter((event) => event.type === "timeline" && event.item.type === "user_message"),
    ).toEqual([
      {
        type: "timeline",
        provider: "claude-acp",
        item: {
          type: "user_message",
          text: "hello",
          messageId: "msg-client-1",
          clientMessageId: "msg-client-1",
        },
        turnId: expect.any(String),
      },
    ]);
  });

  test("startTurn dedupes a provider-owned user echo streamed as text and image chunks", async () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    const prompt = vi.fn(() => new Promise<PromptResponse>(() => {}));

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    asInternals<ACPSessionInternals>(session).connection = { prompt };

    session.subscribe((event) => {
      events.push(event);
    });

    await session.startTurn(
      [
        { type: "text", text: "hey" },
        { type: "image", data: "AA==", mimeType: "image/png" },
      ],
      { clientMessageId: "msg-client-1" },
    );
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "msg-provider-1",
        content: { type: "text", text: "hey" },
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        messageId: "msg-provider-1",
        content: { type: "image", data: "AA==", mimeType: "image/png" },
      } as SessionUpdate,
    });

    expect(
      events.filter((event) => event.type === "timeline" && event.item.type === "user_message"),
    ).toEqual([
      {
        type: "timeline",
        provider: session.provider,
        item: {
          type: "user_message",
          text: "hey",
          messageId: "msg-client-1",
          clientMessageId: "msg-client-1",
        },
        turnId: expect.any(String),
      },
    ]);
  });

  test("startTurn keeps an image-only provider echo when no canonical user message was emitted", async () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    const prompt = vi.fn(() => new Promise<PromptResponse>(() => {}));

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    asInternals<ACPSessionInternals>(session).connection = { prompt };

    session.subscribe((event) => {
      events.push(event);
    });

    await session.startTurn([{ type: "image", data: "AA==", mimeType: "image/png" }], {
      clientMessageId: "msg-client-1",
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "image", data: "AA==", mimeType: "image/png" },
      } as SessionUpdate,
    });
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "assistant-1",
        content: { type: "text", text: "I see it" },
      } as SessionUpdate,
    });

    expect(
      events.filter((event) => event.type === "timeline" && event.item.type === "user_message"),
    ).toEqual([
      {
        type: "timeline",
        provider: session.provider,
        item: { type: "user_message", text: "[image]" },
        turnId: expect.any(String),
      },
    ]);
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

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    asInternals<ACPSessionInternals>(session).connection = { prompt };

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
    expect(asInternals<ACPSessionInternals>(session).activeForegroundTurnId).toBeNull();
  });

  test("flushes an image-only provider echo before a rejected turn finishes", async () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    let rejectPrompt!: (error: Error) => void;
    const prompt = vi.fn(
      () =>
        new Promise<PromptResponse>((_, reject) => {
          rejectPrompt = reject;
        }),
    );

    asInternals<ACPSessionInternals>(session).sessionId = "session-1";
    asInternals<ACPSessionInternals>(session).connection = { prompt };
    session.subscribe((event) => events.push(event));

    const { turnId } = await session.startTurn([
      { type: "image", data: "AA==", mimeType: "image/png" },
    ]);
    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "image", data: "AA==", mimeType: "image/png" },
      } as SessionUpdate,
    });

    rejectPrompt(new Error("prompt failed"));
    await Promise.resolve();
    await Promise.resolve();

    expect(
      events.filter((event) => event.type === "timeline" || event.type === "turn_failed"),
    ).toEqual([
      {
        type: "timeline",
        provider: session.provider,
        item: { type: "user_message", text: "[image]" },
        turnId,
      },
      expect.objectContaining({ type: "turn_failed", turnId, error: "prompt failed" }),
    ]);
  });

  test("startTurn preserves JSON-RPC error details from a real ACP prompt response", async () => {
    const session = createSession();
    const clientToAgent = new TransformStream();
    const agentToClient = new TransformStream();
    const upstreamMessage =
      "Authentication failed: Please authenticate to continue. Run `/login` to log in.";
    const upstreamData = {
      cause: "auth_required",
      errorMessage: "Please authenticate to continue. Run `/login` to log in.",
    };
    const agent: Agent = {
      async initialize() {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {},
          authMethods: [{ id: "windsurf-api-key", name: "API Key" }],
        };
      },
      async newSession() {
        return { sessionId: "session-1" };
      },
      async prompt() {
        throw new RequestError(-32000, upstreamMessage, upstreamData);
      },
      async authenticate() {},
      async cancel() {},
    };
    const agentConnection = new AgentSideConnection(
      () => agent,
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
    const connection = new ClientSideConnection(
      () => ({
        async requestPermission() {
          return { outcome: { outcome: "cancelled" } };
        },
        async sessionUpdate() {},
      }),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "Paseo test", version: "dev" },
    });
    expect(agentConnection.signal.aborted).toBe(false);
    const sessionResponse = await connection.newSession({
      cwd: "/tmp/paseo-acp-test",
      mcpServers: [],
    });
    const turnFailed = new Promise<Extract<AgentStreamEvent, { type: "turn_failed" }>>(
      (resolve) => {
        session.subscribe((event) => {
          if (event.type === "turn_failed") {
            resolve(event);
          }
        });
      },
    );

    asInternals<ACPSessionInternals>(session).sessionId = sessionResponse.sessionId;
    asInternals<ACPSessionInternals>(session).connection = connection;

    await session.startTurn("hello");

    await expect(turnFailed).resolves.toMatchObject({
      error: expect.stringContaining(upstreamMessage),
      code: "-32000",
      diagnostic: expect.stringContaining("auth_required"),
    });
    await expect(turnFailed).resolves.toMatchObject({
      error: expect.not.stringContaining("[object Object]"),
    });
  });
});

interface ACPCloseInternals {
  child: ChildProcess | null;
  connection: unknown;
  sessionId: string | null;
}

async function startTerminal(
  session: ACPAgentSession,
  child: ChildProcess,
  command = "sleep",
): Promise<string> {
  vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child as ChildProcessWithoutNullStreams);
  const terminal = await session.createTerminal({
    sessionId: "session-1",
    command,
    args: ["60"],
  });
  vi.restoreAllMocks();
  return terminal.terminalId;
}

describe("ACPAgentSession close() tree-kill", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("close() flushes a buffered provider-owned user message before unsubscribing", async () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    asInternals<ACPCloseInternals>(session).sessionId = "session-1";

    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "image", data: "AA==", mimeType: "image/png" },
      } as SessionUpdate,
    });
    expect(events).toEqual([]);

    await session.close();

    expect(events).toEqual([
      {
        type: "timeline",
        provider: session.provider,
        item: { type: "user_message", text: "[image]" },
      },
    ]);
  });

  test("close() terminates the main child process via the process tree", async () => {
    const terminator = new FakeTerminator();
    const session = createSession(terminator.terminate);
    const internals = asInternals<ACPCloseInternals>(session);

    const child = createTerminalChildStub();
    // The ACP host process is set by the live connect handshake, which has no
    // in-test seam; everything else is driven through the public API.
    internals.child = child;
    internals.connection = null;
    internals.sessionId = null;

    await session.close();

    expect(terminator.terminated).toContain(child);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test("close() terminates running terminal child processes", async () => {
    const terminator = new FakeTerminator();
    const session = createSession(terminator.terminate);

    const terminalChild = createTerminalChildStub();
    await startTerminal(session, terminalChild);

    await session.close();

    expect(terminator.terminated).toContain(terminalChild);
    expect(terminalChild.kill).not.toHaveBeenCalled();
  });

  test("close() terminates terminal child processes in parallel", async () => {
    const terminator = new FakeTerminator("deferred");
    const session = createSession(terminator.terminate);

    const firstChild = createTerminalChildStub();
    const secondChild = createTerminalChildStub();
    await startTerminal(session, firstChild);
    await startTerminal(session, secondChild);

    const close = session.close();
    await Promise.resolve();

    expect(terminator.terminated).toEqual([firstChild, secondChild]);

    terminator.releaseAll();
    await close;
  });

  test("killTerminal terminates the terminal process tree without a direct SIGTERM", async () => {
    const terminator = new FakeTerminator();
    const session = createSession(terminator.terminate);

    const child = createTerminalChildStub();
    const terminalId = await startTerminal(session, child);

    await session.killTerminal({ sessionId: "session-1", terminalId });

    expect(terminator.terminated).toContain(child);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test("releaseTerminal terminates and removes a running terminal", async () => {
    const terminator = new FakeTerminator();
    const session = createSession(terminator.terminate);

    const child = createTerminalChildStub();
    const terminalId = await startTerminal(session, child);

    await session.releaseTerminal({ sessionId: "session-1", terminalId });

    expect(terminator.terminated).toContain(child);
    expect(child.kill).not.toHaveBeenCalled();
    await expect(session.terminalOutput({ sessionId: "session-1", terminalId })).rejects.toThrow(
      `Unknown terminal '${terminalId}'`,
    );
  });
});

describe("ACPAgentSession initialization cleanup", () => {
  test("terminates the ACP process when session/new fails", async () => {
    const terminator = new FakeTerminator();
    const child = createProbeChildStub();

    class FailingNewSession extends ACPAgentSession {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child,
          connection: {
            newSession: vi.fn().mockRejectedValue(new Error("session/new failed")),
            closed: new Promise<void>(() => {}),
          } as unknown as ClientSideConnection,
          initialize: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
        };
      }
    }

    const session = new FailingNewSession(
      { provider: "copilot", cwd: "/tmp/paseo-acp-test" },
      {
        provider: "copilot",
        logger: createTestLogger(),
        defaultCommand: ["copilot", "--acp"],
        defaultModes: [],
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: true,
          supportsMcpServers: true,
          supportsReasoningStream: true,
          supportsToolInvocations: true,
        },
        terminateProcess: terminator.terminate,
      },
    );

    await expect(session.initializeNewSession()).rejects.toThrow("session/new failed");

    expect(terminator.terminated).toContain(child);
  });

  test("terminates the ACP process when session/load fails", async () => {
    const terminator = new FakeTerminator();
    const child = createProbeChildStub();

    class FailingLoadSession extends ACPAgentSession {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child,
          connection: {
            loadSession: vi.fn().mockRejectedValue(new Error("session/load failed")),
            closed: new Promise<void>(() => {}),
          } as unknown as ClientSideConnection,
          initialize: {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { loadSession: true },
          },
        };
      }
    }

    const session = new FailingLoadSession(
      { provider: "cursor", cwd: "/tmp/paseo-acp-test" },
      {
        provider: "cursor",
        logger: createTestLogger(),
        defaultCommand: ["cursor-agent", "acp"],
        defaultModes: [],
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: true,
          supportsMcpServers: true,
          supportsReasoningStream: true,
          supportsToolInvocations: true,
        },
        handle: { provider: "cursor", sessionId: "session-1" },
        terminateProcess: terminator.terminate,
      },
    );

    await expect(session.initializeResumedSession()).rejects.toThrow("session/load failed");

    expect(terminator.terminated).toContain(child);
  });
});

describe("ACPAgentClient probe cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("terminates the probe process tree and closes its stdio", async () => {
    const terminator = new FakeTerminator();
    const child = createProbeChildStub();

    class TestACPAgentClient extends ACPAgentClient {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child,
          connection: {
            newSession: vi.fn().mockResolvedValue({
              modes: null,
              models: null,
              configOptions: [],
            }),
          },
          initialize: { agentCapabilities: {} },
        } as SpawnedACPProcess;
      }
    }

    const client = new TestACPAgentClient({
      provider: "claude-acp",
      logger: createTestLogger(),
      defaultCommand: ["claude", "--acp"],
      defaultModes: [],
      terminateProcess: terminator.terminate,
    });

    await client.fetchCatalog({ scope: "workspace", cwd: "/tmp/acp-models", force: false });

    expect(terminator.terminated).toContain(child);
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });
});

describe("ACP session/load invariant — cwd and mcpServers always passed", () => {
  /**
   * Shared factory: creates an ACPAgentSession subclass whose spawnProcess
   * returns stubbed ACP internals so tests can inspect connection method calls
   * without spawning real processes. Each call produces fresh vi.fn() stubs.
   */
  function makeTestSession(args: {
    capabilities?: AgentCapabilityFlags;
    handle: AgentPersistenceHandle;
    loadSession?: ReturnType<typeof vi.fn>;
    unstableResumeSession?: ReturnType<typeof vi.fn>;
  }) {
    const loadSession =
      args.loadSession ??
      vi.fn().mockResolvedValue({
        sessionId: "session-1",
        modes: null,
        models: null,
        configOptions: [],
      });
    const unstableResumeSession =
      args.unstableResumeSession ??
      vi.fn().mockResolvedValue({
        sessionId: "session-1",
        modes: null,
        models: null,
        configOptions: [],
      });

    class TestSession extends ACPAgentSession {
      protected override async spawnProcess(): Promise<SpawnedACPProcess> {
        return {
          child: createProbeChildStub(),
          connection: {
            prompt: vi.fn(),
            loadSession,
            unstable_resumeSession: unstableResumeSession,
            // Mirrors the SDK ClientSideConnection: a never-settling closed
            // promise, since this stubbed transport stays open.
            closed: new Promise<void>(() => {}),
          } as unknown as ClientSideConnection,
          initialize: { agentCapabilities: args.capabilities ?? {} },
        } as SpawnedACPProcess;
      }
    }

    // Pass handle through the typed constructor option (no private-field casts).
    const session = new TestSession(
      { provider: "claude-acp", cwd: "/tmp/paseo-acp-test" },
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
          ...args.capabilities,
        },
        handle: args.handle,
      },
    );

    return { session, loadSession, unstableResumeSession };
  }

  test("loadSession is always called with sessionId, cwd, and mcpServers even when mcpServers is empty", async () => {
    const { session, loadSession } = makeTestSession({
      capabilities: { loadSession: true, supportsMcpServers: true },
      handle: { sessionId: "session-1", provider: "claude-acp" },
    });

    await session.initializeResumedSession();

    expect(loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/tmp/paseo-acp-test",
      mcpServers: [],
    });
  });

  test("preserves assistant message IDs from loadSession replay", async () => {
    let session!: ACPAgentSession;
    const loadSession = async () => {
      await session.sessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "assistant-replay-1",
          content: { type: "text", text: "Welcome back" },
        } as SessionUpdate,
      });
      return {
        sessionId: "session-1",
        modes: null,
        models: null,
        configOptions: [],
      };
    };
    ({ session } = makeTestSession({
      capabilities: { loadSession: true },
      handle: { sessionId: "session-1", provider: "claude-acp" },
      loadSession,
    }));

    await session.initializeResumedSession();

    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) {
      history.push(event);
    }
    expect(history).toEqual([
      {
        type: "timeline",
        provider: "claude-acp",
        item: {
          type: "assistant_message",
          text: "Welcome back",
          messageId: "assistant-replay-1",
        },
      },
    ]);
  });

  test("coalesces an ID-less text and image user message during loadSession replay", async () => {
    let session!: ACPAgentSession;
    const loadSession = async () => {
      await session.sessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "hey" },
        } as SessionUpdate,
      });
      await session.sessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "image", data: "AA==", mimeType: "image/png" },
        } as SessionUpdate,
      });
      await session.sessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "assistant-replay-1",
          content: { type: "text", text: "Hello" },
        } as SessionUpdate,
      });
      return {
        sessionId: "session-1",
        modes: null,
        models: null,
        configOptions: [],
      };
    };
    ({ session } = makeTestSession({
      capabilities: { loadSession: true },
      handle: { sessionId: "session-1", provider: "test-acp" },
      loadSession,
    }));

    await session.initializeResumedSession();

    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) {
      history.push(event);
    }
    expect(history).toEqual([
      {
        type: "timeline",
        provider: session.provider,
        item: { type: "user_message", text: "hey[image]" },
      },
      {
        type: "timeline",
        provider: session.provider,
        item: {
          type: "assistant_message",
          text: "Hello",
          messageId: "assistant-replay-1",
        },
      },
    ]);
  });

  test("assigns stable fallback IDs to ID-less assistant messages during loadSession replay", async () => {
    let session!: ACPAgentSession;
    const loadSession = async () => {
      for (const text of ["Loaded", " response"]) {
        await session.sessionUpdate({
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          } as SessionUpdate,
        });
      }
      await session.sessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Follow up" },
        } as SessionUpdate,
      });
      await session.sessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Loaded second response" },
        } as SessionUpdate,
      });
      return {
        sessionId: "session-1",
        modes: null,
        models: null,
        configOptions: [],
      };
    };
    ({ session } = makeTestSession({
      capabilities: { loadSession: true },
      handle: { sessionId: "session-1", provider: "claude-acp" },
      loadSession,
    }));

    await session.initializeResumedSession();

    const assistantMessages: Array<{ text: string; messageId?: string }> = [];
    for await (const event of session.streamHistory()) {
      if (event.type === "timeline" && event.item.type === "assistant_message") {
        assistantMessages.push(event.item);
      }
    }
    expect(assistantMessages).toHaveLength(3);
    expect(assistantMessages[0].messageId).toEqual(expect.any(String));
    expect(assistantMessages[1].messageId).toBe(assistantMessages[0].messageId);
    expect(assistantMessages[2].messageId).toEqual(expect.any(String));
    expect(assistantMessages[2].messageId).not.toBe(assistantMessages[0].messageId);
  });

  test("loadSession is always called with mcpServers even when supportsMcpServers is false", async () => {
    const { session, loadSession } = makeTestSession({
      capabilities: { loadSession: true, supportsMcpServers: false },
      handle: { sessionId: "session-1", provider: "claude-acp" },
    });

    await session.initializeResumedSession();

    // Even with supportsMcpServers=false, mcpServers: [] must still be passed
    expect(loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/tmp/paseo-acp-test",
      mcpServers: [],
    });
  });

  test("unstable_resumeSession is always called with sessionId, cwd, and mcpServers", async () => {
    const { session, unstableResumeSession } = makeTestSession({
      capabilities: { sessionCapabilities: { resume: {} } },
      handle: { sessionId: "session-1", provider: "claude-acp" },
    });

    await session.initializeResumedSession();

    expect(unstableResumeSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/tmp/paseo-acp-test",
      mcpServers: [],
    });
  });
});

interface ACPCrashRecoveryInternals {
  sessionId: string | null;
  connection: unknown;
  child: unknown;
  activeForegroundTurnId: string | null;
  processState?: string;
  pendingSpawnChild?: unknown;
  respawnPromise?: Promise<void> | null;
}

interface FakeACPAgentBehavior {
  agentCapabilities?: Record<string, unknown>;
  sessionId?: string;
  /** Extra fields merged into new/load/resume session responses (modes, models, configOptions). */
  sessionState?: Record<string, unknown>;
  prompt?: (params: { sessionId: string }) => Promise<PromptResponse>;
  loadSession?: ReturnType<typeof vi.fn>;
  resumeSession?: ReturnType<typeof vi.fn>;
  failInitialize?: Error;
  /** Initialize never responds, simulating an ACP host hung during handshake. */
  hangInitialize?: boolean;
  /** When set, initialize responds only after this promise resolves. */
  initializeGate?: Promise<void>;
  /** session/load never responds. */
  hangLoadSession?: boolean;
  /** unstable_resumeSession never responds. */
  hangResumeSession?: boolean;
  /** session/new never responds. */
  hangNewSession?: boolean;
  /** session/set_mode never responds. */
  hangSetSessionMode?: boolean;
}

function applyConfigValue(
  configOptions: unknown,
  params: { configId: string; value: string },
): unknown {
  return (configOptions as Array<Record<string, unknown>>).map((option) =>
    option.id === params.configId
      ? Object.assign({}, option, { currentValue: params.value })
      : option,
  );
}

/**
 * In-memory stand-in for an ACP host process. PassThrough pipes connect the
 * session's real ClientSideConnection to an in-process AgentSideConnection, so
 * tests exercise the production spawn/exit-handler path end to end. crash()
 * simulates SIGKILL: the pipes die first, then the exit event fires.
 */
class FakeACPAgentProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  readonly kill = vi.fn(() => true);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly agent: Agent;
  readonly agentConnection: AgentSideConnection;

  constructor(pid: number, behavior: FakeACPAgentBehavior = {}) {
    super();
    this.pid = pid;
    const sessionId = behavior.sessionId ?? "session-1";
    const sessionState = { modes: null, models: null, configOptions: [], ...behavior.sessionState };
    this.agent = {
      initialize: vi.fn(async () => {
        if (behavior.hangInitialize) {
          await new Promise<void>(() => {});
        }
        if (behavior.initializeGate) {
          await behavior.initializeGate;
        }
        if (behavior.failInitialize) {
          throw behavior.failInitialize;
        }
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: behavior.agentCapabilities ?? { loadSession: true },
          authMethods: [],
        };
      }),
      newSession: vi.fn(async () => {
        if (behavior.hangNewSession) {
          await new Promise<void>(() => {});
        }
        return { sessionId, ...sessionState };
      }),
      loadSession:
        behavior.loadSession ??
        vi.fn(async () => {
          if (behavior.hangLoadSession) {
            await new Promise<void>(() => {});
          }
          return { sessionId, ...sessionState };
        }),
      unstable_resumeSession:
        behavior.resumeSession ??
        vi.fn(async () => {
          if (behavior.hangResumeSession) {
            await new Promise<void>(() => {});
          }
          return { sessionId, ...sessionState };
        }),
      setSessionMode: vi.fn(async () => {
        if (behavior.hangSetSessionMode) {
          await new Promise<void>(() => {});
        }
      }),
      setSessionConfigOption: vi.fn(async (params: { configId: string; value: string }) => ({
        // Mirror the provider contract: the response reports the applied value.
        configOptions: applyConfigValue(sessionState.configOptions, params),
      })),
      unstable_setSessionModel: vi.fn(async () => {}),
      prompt: vi.fn(
        behavior.prompt ?? (async () => ({ stopReason: "end_turn" }) as PromptResponse),
      ),
      cancel: vi.fn(async () => {}),
      authenticate: vi.fn(async () => {}),
    } as unknown as Agent;
    this.agentConnection = new AgentSideConnection(
      () => this.agent,
      ndJsonStream(Writable.toWeb(this.stdout), Readable.toWeb(this.stdin)),
    );
  }

  crash(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
    this.emit("exit", code, signal);
  }

  /** Kills the NDJSON transport while the process itself stays alive. */
  killTransport(): void {
    this.stdout.destroy();
  }

  emitSpawnError(error: Error): void {
    this.stdin.destroy();
    this.stdout.destroy();
    this.stderr.destroy();
    this.emit("error", error);
  }
}

function createFakeManagedProcessRegistry() {
  let nextId = 0;
  return {
    record: vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      id: `record-${++nextId}`,
      identity: { commandLine: null, startedAt: null },
      createdAt: new Date().toISOString(),
    })),
    remove: vi.fn(async () => {}),
    updateMetadata: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    reapStale: vi.fn(async () => ({
      checked: 0,
      dead: 0,
      mismatched: 0,
      removed: 0,
      terminated: 0,
      errors: [],
    })),
  };
}

function createCrashTestHarness(
  options: {
    behaviors?: FakeACPAgentBehavior[] | ((spawnIndex: number) => FakeACPAgentBehavior);
    managedProcesses?: ReturnType<typeof createFakeManagedProcessRegistry>;
    terminateProcess?: ProcessTerminator;
    configFeatureOptions?: ACPConfigFeatureOption[];
    initializeTimeoutMs?: number;
    sessionLoadTimeoutMs?: number;
  } = {},
) {
  const children: FakeACPAgentProcess[] = [];
  let nextPid = 41000;
  const spawnSpy = vi.spyOn(spawnUtils, "spawnProcess").mockImplementation(() => {
    const index = children.length;
    const behavior =
      typeof options.behaviors === "function"
        ? options.behaviors(index)
        : (options.behaviors?.[index] ?? {});
    const child = new FakeACPAgentProcess(nextPid++, behavior);
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  });

  const session = new ACPAgentSession({ provider: "claude-acp", cwd: "/tmp/paseo-acp-test" }, {
    provider: "claude-acp",
    logger: createTestLogger(),
    // An absolute, always-resolvable binary path: the spawn itself is
    // mocked, but launch resolution still checks the command exists.
    defaultCommand: [process.execPath, "--fake-acp"],
    defaultModes: [],
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    ...(options.managedProcesses ? { managedProcesses: options.managedProcesses } : {}),
    ...(options.terminateProcess ? { terminateProcess: options.terminateProcess } : {}),
    ...(options.configFeatureOptions ? { configFeatureOptions: options.configFeatureOptions } : {}),
    ...(options.initializeTimeoutMs ? { initializeTimeoutMs: options.initializeTimeoutMs } : {}),
    ...(options.sessionLoadTimeoutMs ? { sessionLoadTimeoutMs: options.sessionLoadTimeoutMs } : {}),
  } as ConstructorParameters<typeof ACPAgentSession>[1]);

  return { session, children, spawnSpy };
}

function internalsOf(session: ACPAgentSession): ACPCrashRecoveryInternals {
  return asInternals<ACPCrashRecoveryInternals>(session);
}

type ACPTurnFinishType = "turn_completed" | "turn_failed" | "turn_canceled";

function countTurnEvents(
  events: AgentStreamEvent[],
  type: ACPTurnFinishType,
  turnId?: string,
): number {
  return events.filter(
    (event) =>
      event.type === type && (turnId === undefined || getAgentStreamEventTurnId(event) === turnId),
  ).length;
}

function turnFailedEvents(
  events: AgentStreamEvent[],
): Array<Extract<AgentStreamEvent, { type: "turn_failed" }>> {
  return events.filter(
    (event): event is Extract<AgentStreamEvent, { type: "turn_failed" }> =>
      event.type === "turn_failed",
  );
}

function waitForTurnEvent(
  events: AgentStreamEvent[],
  type: ACPTurnFinishType,
  turnId?: string,
): Promise<void> {
  return vi.waitFor(() => {
    expect(countTurnEvents(events, type, turnId)).toBeGreaterThan(0);
  });
}

function waitForAssertion(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion);
}

function deferredPromise<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ACPAgentSession process crash recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("detects an idle process exit and respawns with session/load on the next prompt", async () => {
    const { session, children, spawnSpy } = createCrashTestHarness();
    await session.initializeNewSession();
    expect(children).toHaveLength(1);

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    children[0].crash(null, "SIGKILL");

    const internals = internalsOf(session);
    expect(internals.processState).toBe("dead");
    expect(internals.child).toBeNull();
    expect(internals.connection).toBeNull();
    expect(internals.activeForegroundTurnId).toBeNull();
    expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(0);

    const { turnId } = await session.startTurn("hello after crash");

    expect(spawnSpy).toHaveBeenCalledTimes(2);
    expect(children).toHaveLength(2);
    const resumedAgent = children[1].agent;
    expect(resumedAgent.loadSession).toHaveBeenCalledTimes(1);
    expect(resumedAgent.loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/tmp/paseo-acp-test",
      mcpServers: [],
    });
    expect(resumedAgent.newSession).not.toHaveBeenCalled();
    expect(internalsOf(session).processState).toBe("running");

    await waitForAssertion(() => {
      expect(resumedAgent.prompt).toHaveBeenCalled();
    });
    await waitForTurnEvent(events, "turn_completed", turnId);
  });

  test("fails the active turn with process_exit on crash and unblocks the next prompt", async () => {
    const { session, children } = createCrashTestHarness({
      behaviors: [{ prompt: () => new Promise<PromptResponse>(() => {}) }],
    });
    await session.initializeNewSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const { turnId } = await session.startTurn("work");
    children[0].crash(137, "SIGKILL");

    await waitForTurnEvent(events, "turn_failed", turnId);

    const failed = turnFailedEvents(events);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      turnId,
      code: "process_exit",
      error: expect.stringContaining("exited unexpectedly"),
    });
    expect(internalsOf(session).activeForegroundTurnId).toBeNull();

    // The next prompt respawns instead of failing with "foreground turn is already active".
    const next = await session.startTurn("again");
    expect(children).toHaveLength(2);
    await waitForTurnEvent(events, "turn_completed", next.turnId);
    // The prompt-stream rejection after the crash must not double-finish the turn.
    expect(turnFailedEvents(events)).toHaveLength(1);
  });

  test("coalesces concurrent prompts after a crash into a single respawn", async () => {
    const { session, children } = createCrashTestHarness();
    await session.initializeNewSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    children[0].crash(1, null);

    const [first, second] = await Promise.allSettled([
      session.startTurn("one"),
      session.startTurn("two"),
    ]);

    // Exactly one process respawn, one initialize, one session/load.
    expect(children).toHaveLength(2);
    const resumedAgent = children[1].agent;
    expect(resumedAgent.initialize).toHaveBeenCalledTimes(1);
    expect(resumedAgent.loadSession).toHaveBeenCalledTimes(1);

    // One prompt wins the foreground turn; the other keeps the existing
    // contract error, and the session state stays consistent.
    const outcomes = [first, second];
    const fulfilled = outcomes.find(
      (outcome): outcome is PromiseFulfilledResult<{ turnId: string }> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(fulfilled).toBeDefined();
    expect(rejected).toBeDefined();
    expect(rejected?.reason.message).toContain("foreground turn");
    expect(internalsOf(session).processState).toBe("running");

    await waitForTurnEvent(events, "turn_completed", fulfilled?.value.turnId);
    await expect(session.startTurn("three")).resolves.toBeDefined();
  });

  test("close() does not respawn, removes the ledger record, and emits no crash failure", async () => {
    const terminator = new FakeTerminator();
    const managedProcesses = createFakeManagedProcessRegistry();
    const { session, children } = createCrashTestHarness({
      terminateProcess: terminator.terminate,
      managedProcesses,
    });
    await session.initializeNewSession();
    expect(managedProcesses.record).toHaveBeenCalledTimes(1);

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.close();

    expect(terminator.terminated).toContain(children[0]);
    expect(children).toHaveLength(1);
    await vi.waitFor(() => {
      expect(managedProcesses.remove).toHaveBeenCalledWith("record-1");
    });
    expect(internalsOf(session).processState).toBe("dead");
    expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(0);
    await expect(session.startTurn("after close")).rejects.toThrow("session is closed");
  });

  test("records spawned PIDs in the managed process ledger and removes them on exit", async () => {
    const managedProcesses = createFakeManagedProcessRegistry();
    const { session, children } = createCrashTestHarness({ managedProcesses });
    await session.initializeNewSession();

    expect(managedProcesses.record).toHaveBeenCalledTimes(1);
    expect(managedProcesses.record).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { provider: "claude-acp", kind: "acp-agent" },
        pid: children[0].pid,
        command: process.execPath,
        args: ["--fake-acp"],
        metadata: expect.objectContaining({ cwd: "/tmp/paseo-acp-test" }),
      }),
    );

    children[0].crash(null, "SIGKILL");
    await vi.waitFor(() => {
      expect(managedProcesses.remove).toHaveBeenCalledWith("record-1");
    });

    await session.startTurn("revive");
    expect(managedProcesses.record).toHaveBeenCalledTimes(2);
    expect(managedProcesses.record.mock.calls[1][0]).toMatchObject({
      pid: children[1].pid,
      metadata: expect.objectContaining({ sessionId: "session-1" }),
    });
  });

  test("terminates the fresh process and rethrows when session/load fails during respawn", async () => {
    const terminator = new FakeTerminator();
    const { session, children } = createCrashTestHarness({
      terminateProcess: terminator.terminate,
      behaviors: (spawnIndex) =>
        spawnIndex === 1
          ? { loadSession: vi.fn().mockRejectedValue(new Error("session gone")) }
          : {},
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    await expect(session.startTurn("revive")).rejects.toThrow("session gone");

    // No fallback to session/new; the half-initialized process is torn down.
    expect(children[1].agent.newSession).not.toHaveBeenCalled();
    expect(terminator.terminated).toContain(children[1]);
    expect(internalsOf(session).processState).toBe("dead");

    // A later prompt retries with a fresh process.
    await session.startTurn("retry");
    expect(children).toHaveLength(3);
  });

  test("resumes via unstable_resumeSession on respawn when loadSession is unsupported", async () => {
    const { session, children } = createCrashTestHarness({
      behaviors: () => ({ agentCapabilities: { sessionCapabilities: { resume: {} } } }),
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    await session.startTurn("revive");

    expect(children).toHaveLength(2);
    const resumedAgent = children[1].agent as unknown as {
      unstable_resumeSession: ReturnType<typeof vi.fn>;
      loadSession: ReturnType<typeof vi.fn>;
    };
    expect(resumedAgent.unstable_resumeSession).toHaveBeenCalledTimes(1);
    expect(resumedAgent.unstable_resumeSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/tmp/paseo-acp-test",
      mcpServers: [],
    });
    expect(resumedAgent.loadSession).not.toHaveBeenCalled();
  });
});

describe("ACPAgentSession runtime state across crash respawn", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function modeSessionState(currentModeId: string): Record<string, unknown> {
    return {
      modes: {
        availableModes: [
          { id: "yolo", name: "Yolo" },
          { id: "plan", name: "Plan" },
        ],
        currentModeId,
      },
    };
  }

  test("runtime mode survives crash respawn in both directions", async () => {
    const { session, children } = createCrashTestHarness({
      behaviors: () => ({ sessionState: modeSessionState("yolo") }),
    });
    await session.initializeNewSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    // yolo (create-time) -> plan (runtime) -> crash -> the new process gets plan.
    await session.setMode("plan");
    children[0].crash(1, null);
    const first = await session.startTurn("after first crash");

    const firstRespawn = children[1].agent;
    expect(firstRespawn.setSessionMode).toHaveBeenCalledWith({
      sessionId: "session-1",
      modeId: "plan",
    });
    // The runtime state is re-applied before the queued prompt goes out.
    await waitForAssertion(() => {
      expect(firstRespawn.prompt).toHaveBeenCalled();
    });
    const modeCallOrder = (firstRespawn.setSessionMode as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const promptCallOrder = (firstRespawn.prompt as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(modeCallOrder).toBeLessThan(promptCallOrder);
    await waitForTurnEvent(events, "turn_completed", first.turnId);
    expect(await session.getCurrentMode()).toBe("plan");

    // plan -> yolo (runtime) -> crash -> the new process must NOT be dragged back to plan.
    await session.setMode("yolo");
    children[1].crash(1, null);
    await session.startTurn("after second crash");

    expect(children[2].agent.setSessionMode).not.toHaveBeenCalled();
    expect(await session.getCurrentMode()).toBe("yolo");
  });

  test("runtime model survives crash respawn", async () => {
    const { session, children } = createCrashTestHarness({
      behaviors: () => ({
        sessionState: {
          models: {
            availableModels: [
              { modelId: "m-fast", name: "Fast" },
              { modelId: "m-smart", name: "Smart" },
            ],
            currentModelId: "m-fast",
          },
        },
      }),
    });
    await session.initializeNewSession();

    await session.setModel("m-smart");
    children[0].crash(1, null);
    await session.startTurn("after crash");

    expect(children[1].agent.unstable_setSessionModel).toHaveBeenCalledWith({
      sessionId: "session-1",
      modelId: "m-smart",
    });
    const runtimeInfo = await session.getRuntimeInfo();
    expect(runtimeInfo.model).toBe("m-smart");
  });

  test("thinking option and feature values survive crash respawn", async () => {
    const configOptions = [
      {
        id: "thought",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: "low",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
      {
        id: "agent",
        name: "Agent",
        category: "_agent",
        type: "select",
        currentValue: "",
        options: [
          { value: "", name: "Default" },
          { value: "probe", name: "Probe" },
        ],
      },
    ];
    const { session, children } = createCrashTestHarness({
      behaviors: () => ({ sessionState: { configOptions } }),
      configFeatureOptions: [
        {
          id: "agent",
          configId: "agent",
          category: "_agent",
          label: "Agent",
        },
      ],
    });
    await session.initializeNewSession();

    await session.setThinkingOption("high");
    await session.setFeature("agent", "probe");
    children[0].crash(1, null);
    await session.startTurn("after crash");

    const resumedConfigCalls = (
      children[1].agent.setSessionConfigOption as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[0]);
    expect(resumedConfigCalls).toContainEqual({
      sessionId: "session-1",
      configId: "thought",
      value: "high",
    });
    expect(resumedConfigCalls).toContainEqual({
      sessionId: "session-1",
      configId: "agent",
      value: "probe",
    });

    const runtimeInfo = await session.getRuntimeInfo();
    expect(runtimeInfo.thinkingOptionId).toBe("high");
    expect(session.features).toEqual([expect.objectContaining({ id: "agent", value: "probe" })]);
  });
});

describe("ACPAgentSession transport failure without process exit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("transport dies without child exit → current turn fails and next prompt respawns", async () => {
    const terminator = new FakeTerminator();
    const { session, children } = createCrashTestHarness({
      terminateProcess: terminator.terminate,
      behaviors: [{ prompt: () => new Promise<PromptResponse>(() => {}) }],
    });
    await session.initializeNewSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const { turnId } = await session.startTurn("work");
    children[0].killTransport();

    await waitForTurnEvent(events, "turn_failed", turnId);
    const failed = turnFailedEvents(events);
    expect(failed).toHaveLength(1);
    expect(failed[0].code).toBe("transport_closed");
    expect(failed[0].error).not.toContain("ERR_STREAM_PREMATURE_CLOSE");
    expect(internalsOf(session).activeForegroundTurnId).toBeNull();
    expect(internalsOf(session).processState).toBe("dead");

    // The process outlived its transport, so its tree is killed explicitly.
    await waitForAssertion(() => {
      expect(terminator.terminated).toContain(children[0]);
    });

    const next = await session.startTurn("again");
    expect(children).toHaveLength(2);
    expect(children[1].agent.loadSession).toHaveBeenCalledTimes(1);
    await waitForTurnEvent(events, "turn_completed", next.turnId);
    expect(turnFailedEvents(events)).toHaveLength(1);
  });

  test("stale events from a replaced process do not affect the new generation", async () => {
    const oldPrompt = deferredPromise<PromptResponse>();
    const newPrompt = deferredPromise<PromptResponse>();
    const { session, children } = createCrashTestHarness({
      behaviors: [{ prompt: () => oldPrompt.promise }, { prompt: () => newPrompt.promise }],
    });
    await session.initializeNewSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const turn1 = await session.startTurn("one");
    children[0].killTransport();
    children[0].crash(9, null);
    await waitForTurnEvent(events, "turn_failed", turn1.turnId);

    const turn2 = await session.startTurn("two");
    expect(children).toHaveLength(2);

    // Late events from the dead generation: exit re-emission, transport close
    // settling, and the old prompt promise resolving must all be ignored.
    children[0].emit("exit", 9, null);
    oldPrompt.resolve({ stopReason: "end_turn" } as PromptResponse);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(internalsOf(session).processState).toBe("running");
    expect(internalsOf(session).activeForegroundTurnId).toBe(turn2.turnId);
    expect(countTurnEvents(events, "turn_completed", turn2.turnId)).toBe(0);
    expect(countTurnEvents(events, "turn_completed", turn1.turnId)).toBe(0);
    expect(children).toHaveLength(2);

    newPrompt.resolve({ stopReason: "end_turn" } as PromptResponse);
    await waitForTurnEvent(events, "turn_completed", turn2.turnId);
    expect(countTurnEvents(events, "turn_completed")).toBe(1);
    expect(turnFailedEvents(events)).toHaveLength(1);
  });
});

describe("ACPAgentSession cancel and close races", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("cancel during respawn prevents the queued prompt from being dispatched", async () => {
    const loadGate = deferredPromise<void>();
    const { session, children } = createCrashTestHarness({
      behaviors: (spawnIndex) =>
        spawnIndex === 1
          ? {
              loadSession: vi.fn(async () => {
                await loadGate.promise;
                return { sessionId: "session-1", modes: null, models: null, configOptions: [] };
              }),
            }
          : {},
    });
    await session.initializeNewSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    children[0].crash(1, null);
    const startPromise = session.startTurn("queued");
    await waitForAssertion(() => {
      expect(children).toHaveLength(2);
    });

    await session.interrupt();
    loadGate.resolve();

    const { turnId } = await startPromise;
    await waitForTurnEvent(events, "turn_canceled", turnId);
    expect(children[1].agent.prompt).not.toHaveBeenCalled();
    // The prompt never reached the provider, so no session/cancel may go out.
    expect(children[1].agent.cancel).not.toHaveBeenCalled();
    expect(turnFailedEvents(events)).toHaveLength(0);
    expect(internalsOf(session).activeForegroundTurnId).toBeNull();
  });

  test("cancel after prompt dispatch invokes provider cancel", async () => {
    const { session, children } = createCrashTestHarness({
      behaviors: [{ prompt: () => new Promise<PromptResponse>(() => {}) }],
    });
    await session.initializeNewSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("work");
    await session.interrupt();

    expect(children[0].agent.cancel).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  test("cancel racing with process exit finishes the turn exactly once", async () => {
    const { session, children } = createCrashTestHarness({
      behaviors: [{ prompt: () => new Promise<PromptResponse>(() => {}) }],
    });
    await session.initializeNewSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const { turnId } = await session.startTurn("work");
    const interruptPromise = session.interrupt();
    children[0].crash(9, null);
    await interruptPromise;

    await waitForTurnEvent(events, "turn_failed", turnId);
    const finishes =
      countTurnEvents(events, "turn_failed", turnId) +
      countTurnEvents(events, "turn_canceled", turnId) +
      countTurnEvents(events, "turn_completed", turnId);
    expect(finishes).toBe(1);
  });

  test("cancel followed by a new prompt works normally", async () => {
    const cancelledPrompt = deferredPromise<PromptResponse>();
    let promptCall = 0;
    const { session, children } = createCrashTestHarness({
      behaviors: [
        {
          prompt: () =>
            promptCall++ === 0
              ? cancelledPrompt.promise
              : Promise.resolve({ stopReason: "end_turn" } as PromptResponse),
        },
      ],
    });
    await session.initializeNewSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const first = await session.startTurn("first");
    await session.interrupt();
    cancelledPrompt.resolve({ stopReason: "cancelled" } as PromptResponse);
    await waitForTurnEvent(events, "turn_canceled", first.turnId);

    const second = await session.startTurn("second");
    await waitForTurnEvent(events, "turn_completed", second.turnId);
    expect(children).toHaveLength(1);
  });

  test("cancel from an old turn cannot cancel a newer turn", async () => {
    const oldPrompt = deferredPromise<PromptResponse>();
    let promptCall = 0;
    const { session, children } = createCrashTestHarness({
      behaviors: [
        {
          prompt: () =>
            promptCall++ === 0
              ? oldPrompt.promise
              : Promise.resolve({ stopReason: "end_turn" } as PromptResponse),
        },
      ],
    });
    await session.initializeNewSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const first = await session.startTurn("first");
    await session.interrupt();
    oldPrompt.resolve({ stopReason: "cancelled" } as PromptResponse);
    await waitForTurnEvent(events, "turn_canceled", first.turnId);

    const second = await session.startTurn("second");
    await waitForTurnEvent(events, "turn_completed", second.turnId);
    expect(children[0].agent.cancel).toHaveBeenCalledTimes(1);
    expect(countTurnEvents(events, "turn_canceled", second.turnId)).toBe(0);
  });

  test("close during respawn leaves no process and no ledger record", async () => {
    const terminator = new FakeTerminator();
    const managedProcesses = createFakeManagedProcessRegistry();
    const loadGate = deferredPromise<void>();
    const { session, children } = createCrashTestHarness({
      terminateProcess: terminator.terminate,
      managedProcesses,
      behaviors: (spawnIndex) =>
        spawnIndex === 1
          ? {
              loadSession: vi.fn(async () => {
                await loadGate.promise;
                return { sessionId: "session-1", modes: null, models: null, configOptions: [] };
              }),
            }
          : {},
    });
    await session.initializeNewSession();

    children[0].crash(1, null);
    const startPromise = session.startTurn("revive");
    await waitForAssertion(() => {
      expect(children).toHaveLength(2);
    });

    const closePromise = session.close();
    loadGate.resolve();
    await closePromise;

    await expect(startPromise).rejects.toThrow("session is closed");
    expect(internalsOf(session).processState).toBe("dead");
    expect(internalsOf(session).child).toBeNull();
    expect(terminator.terminated).toContain(children[1]);
    expect(managedProcesses.record).toHaveBeenCalledTimes(2);
    await waitForAssertion(() => {
      expect(managedProcesses.remove).toHaveBeenCalledTimes(2);
    });
    await expect(session.startTurn("after close")).rejects.toThrow("session is closed");
  });
});

describe("ACPAgentSession respawn robustness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("initialize failure during respawn surfaces a controlled error and allows retry", async () => {
    const terminator = new FakeTerminator();
    const { session, children } = createCrashTestHarness({
      terminateProcess: terminator.terminate,
      behaviors: (spawnIndex) =>
        spawnIndex === 1 ? { failInitialize: new Error("init boom") } : {},
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    await expect(session.startTurn("revive")).rejects.toThrow("init boom");
    expect(children).toHaveLength(2);
    expect(terminator.terminated).toContain(children[1]);
    expect(internalsOf(session).processState).toBe("dead");

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const { turnId } = await session.startTurn("retry");
    expect(children).toHaveLength(3);
    await waitForTurnEvent(events, "turn_completed", turnId);
  });

  test("several successive crashes respawn cleanly each time", async () => {
    const { session, children } = createCrashTestHarness();
    await session.initializeNewSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    for (let round = 0; round < 3; round += 1) {
      children[round].crash(1, null);
      const { turnId } = await session.startTurn(`round ${round}`);
      await waitForTurnEvent(events, "turn_completed", turnId);
      expect(children).toHaveLength(round + 2);
      expect(children[round + 1].agent.loadSession).toHaveBeenCalledTimes(1);
    }
    expect(turnFailedEvents(events)).toHaveLength(0);
  });

  test("crash cancels a pending permission and a late response is rejected", async () => {
    const { session, children } = createCrashTestHarness({
      behaviors: [{ prompt: () => new Promise<PromptResponse>(() => {}) }],
    });
    await session.initializeNewSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("work");
    const permissionPromise = session.requestPermission({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "Run command",
        kind: "execute",
        status: "pending",
        content: [],
        locations: [],
      },
      options: [],
    } as unknown as RequestPermissionRequest);

    children[0].crash(1, null);

    await expect(permissionPromise).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(session.getPendingPermissions()).toEqual([]);

    const requestEvent = events.find((event) => event.type === "permission_requested");
    const requestId =
      requestEvent && requestEvent.type === "permission_requested"
        ? requestEvent.request.id
        : "missing";
    await expect(session.respondToPermission(requestId, { behavior: "allow" })).rejects.toThrow(
      "No pending permission request",
    );
  });

  test("setMode after an idle crash lazily resumes the session", async () => {
    const { session, children } = createCrashTestHarness({
      behaviors: () => ({
        sessionState: {
          modes: {
            availableModes: [
              { id: "yolo", name: "Yolo" },
              { id: "plan", name: "Plan" },
            ],
            currentModeId: "yolo",
          },
        },
      }),
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    await session.setMode("plan");

    expect(children).toHaveLength(2);
    expect(children[1].agent.loadSession).toHaveBeenCalledTimes(1);
    expect(children[1].agent.setSessionMode).toHaveBeenCalledWith({
      sessionId: "session-1",
      modeId: "plan",
    });
    expect(await session.getCurrentMode()).toBe("plan");
  });

  test("provider without session resume capability does not enter a spawn-kill loop", async () => {
    const { session, children } = createCrashTestHarness({
      behaviors: () => ({ agentCapabilities: {} }),
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    await expect(session.startTurn("revive")).rejects.toThrow(/resume/);
    expect(children).toHaveLength(2);

    await expect(session.startTurn("again")).rejects.toThrow(/session_resume_unsupported|resume/);
    expect(children).toHaveLength(2);
  });

  test("managed process metadata receives sessionId after session/new and session/load", async () => {
    const managedProcesses = createFakeManagedProcessRegistry();
    const { session, children } = createCrashTestHarness({ managedProcesses });
    await session.initializeNewSession();

    await waitForAssertion(() => {
      expect(managedProcesses.updateMetadata).toHaveBeenCalledWith(
        "record-1",
        expect.objectContaining({ sessionId: "session-1" }),
      );
    });

    children[0].crash(1, null);
    await session.startTurn("revive");

    await waitForAssertion(() => {
      expect(managedProcesses.updateMetadata).toHaveBeenCalledWith(
        "record-2",
        expect.objectContaining({ sessionId: "session-1" }),
      );
    });
  });
});

describe("ACPAgentSession hung initialize recovery (NEW-1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function hungRespawnHarness(options: {
    terminator: FakeTerminator;
    managedProcesses?: ReturnType<typeof createFakeManagedProcessRegistry>;
    initializeTimeoutMs?: number;
  }) {
    return createCrashTestHarness({
      terminateProcess: options.terminator.terminate,
      ...(options.managedProcesses ? { managedProcesses: options.managedProcesses } : {}),
      ...(options.initializeTimeoutMs ? { initializeTimeoutMs: options.initializeTimeoutMs } : {}),
      behaviors: (spawnIndex) => (spawnIndex === 1 ? { hangInitialize: true } : {}),
    });
  }

  test("close during a hung initialize completes within timeout and leaves no process", async () => {
    const terminator = new FakeTerminator();
    const managedProcesses = createFakeManagedProcessRegistry();
    const { session, children } = hungRespawnHarness({ terminator, managedProcesses });
    await session.initializeNewSession();
    expect(managedProcesses.record).toHaveBeenCalledTimes(1);

    children[0].crash(1, null);
    const startPromise = session.startTurn("revive");
    startPromise.catch(() => {});
    await waitForAssertion(() => {
      expect(children).toHaveLength(2);
      expect(children[1].agent.initialize).toHaveBeenCalledTimes(1);
    });

    // initialize never answers: close() must still finish in bounded time.
    const closeOutcome = await Promise.race([
      session.close().then(() => "closed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_500)),
    ]);
    expect(closeOutcome).toBe("closed");

    await expect(startPromise).rejects.toThrow("session is closed");
    expect(terminator.terminated).toContain(children[1]);
    const internals = internalsOf(session);
    expect(internals.child).toBeNull();
    expect(internals.pendingSpawnChild ?? null).toBeNull();
    expect(internals.processState).toBe("dead");
    expect(internals.respawnPromise ?? null).toBeNull();
    await waitForAssertion(() => {
      expect(managedProcesses.remove).toHaveBeenCalledTimes(2);
    });
    // No late session/load or prompt after close.
    expect(children[1].agent.loadSession).not.toHaveBeenCalled();
    expect(children[1].agent.newSession).not.toHaveBeenCalled();
    expect(children[1].agent.prompt).not.toHaveBeenCalled();
    await expect(session.startTurn("after close")).rejects.toThrow("session is closed");
  });

  test("initialize timeout kills the spawned process and clears the ledger", async () => {
    const terminator = new FakeTerminator();
    const managedProcesses = createFakeManagedProcessRegistry();
    const { session, children } = hungRespawnHarness({
      terminator,
      managedProcesses,
      initializeTimeoutMs: 200,
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    await expect(session.startTurn("revive")).rejects.toThrow("acp_initialize_timeout");

    expect(terminator.terminated).toContain(children[1]);
    // No fallback to session/new after an initialize timeout.
    expect(children[1].agent.newSession).not.toHaveBeenCalled();
    expect(children[1].agent.loadSession).not.toHaveBeenCalled();
    const internals = internalsOf(session);
    expect(internals.child).toBeNull();
    expect(internals.pendingSpawnChild ?? null).toBeNull();
    expect(internals.processState).toBe("dead");
    await waitForAssertion(() => {
      expect(managedProcesses.remove).toHaveBeenCalledTimes(2);
    });
  });

  test("close racing with initialize success cleans up exactly once", async () => {
    const terminator = new FakeTerminator();
    const gate = deferredPromise<void>();
    const { session, children } = createCrashTestHarness({
      terminateProcess: terminator.terminate,
      behaviors: (spawnIndex) => (spawnIndex === 1 ? { initializeGate: gate.promise } : {}),
    });
    await session.initializeNewSession();
    children[0].crash(1, null);
    const startPromise = session.startTurn("revive");
    startPromise.catch(() => {});
    await waitForAssertion(() => {
      expect(children[1]?.agent.initialize).toHaveBeenCalledTimes(1);
    });

    const closePromise = session.close();
    // initialize succeeds while close() is in flight; exactly one teardown wins.
    gate.resolve();
    await closePromise;

    await expect(startPromise).rejects.toThrow("session is closed");
    expect(terminator.terminated.filter((child) => child === children[1])).toHaveLength(1);
    const internals = internalsOf(session);
    expect(internals.child).toBeNull();
    expect(internals.pendingSpawnChild ?? null).toBeNull();
    expect(internals.processState).toBe("dead");
    expect(children[1].agent.loadSession).not.toHaveBeenCalled();
    expect(children[1].agent.prompt).not.toHaveBeenCalled();
  });

  test("process exit during initialize does not wait for the initialize timeout", async () => {
    const terminator = new FakeTerminator();
    const { session, children } = hungRespawnHarness({
      terminator,
      initializeTimeoutMs: 30_000,
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    const startPromise = session.startTurn("revive");
    await waitForAssertion(() => {
      expect(children[1]?.agent.initialize).toHaveBeenCalledTimes(1);
    });

    const exitedAt = Date.now();
    children[1].crash(1, null);
    await expect(startPromise).rejects.toThrow(/exited|closed/i);
    expect(Date.now() - exitedAt).toBeLessThan(5_000);
    expect(internalsOf(session).processState).toBe("dead");
  });

  test("late initialize response after timeout is ignored", async () => {
    const terminator = new FakeTerminator();
    const managedProcesses = createFakeManagedProcessRegistry();
    const gate = deferredPromise<void>();
    const { session, children } = createCrashTestHarness({
      terminateProcess: terminator.terminate,
      managedProcesses,
      initializeTimeoutMs: 200,
      behaviors: (spawnIndex) => (spawnIndex === 1 ? { initializeGate: gate.promise } : {}),
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    await expect(session.startTurn("revive")).rejects.toThrow("acp_initialize_timeout");
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(children[1].agent.loadSession).not.toHaveBeenCalled();
    expect(children[1].agent.newSession).not.toHaveBeenCalled();
    expect(children[1].agent.prompt).not.toHaveBeenCalled();
    const internals = internalsOf(session);
    expect(internals.child).toBeNull();
    expect(internals.pendingSpawnChild ?? null).toBeNull();
    expect(internals.processState).toBe("dead");
    expect(managedProcesses.record).toHaveBeenCalledTimes(2);
    await waitForAssertion(() => {
      expect(managedProcesses.remove).toHaveBeenCalledTimes(2);
    });
  });

  test("timeout followed by a new prompt retries with a fresh process", async () => {
    const terminator = new FakeTerminator();
    const { session, children } = hungRespawnHarness({
      terminator,
      initializeTimeoutMs: 200,
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    await expect(session.startTurn("revive")).rejects.toThrow("acp_initialize_timeout");

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const { turnId } = await session.startTurn("retry");
    expect(children).toHaveLength(3);
    expect(children[2].agent.loadSession).toHaveBeenCalledTimes(1);
    await waitForTurnEvent(events, "turn_completed", turnId);
    expect(turnFailedEvents(events)).toHaveLength(0);
  });

  test("close after an initialize timeout remains idempotent", async () => {
    const terminator = new FakeTerminator();
    const managedProcesses = createFakeManagedProcessRegistry();
    const { session, children } = hungRespawnHarness({
      terminator,
      managedProcesses,
      initializeTimeoutMs: 200,
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    await expect(session.startTurn("revive")).rejects.toThrow("acp_initialize_timeout");

    await session.close();
    await session.close();

    expect(terminator.terminated.filter((child) => child === children[1])).toHaveLength(1);
    expect(internalsOf(session).processState).toBe("dead");
    await waitForAssertion(() => {
      expect(managedProcesses.remove).toHaveBeenCalledTimes(2);
    });
    await expect(session.startTurn("after close")).rejects.toThrow("session is closed");
  });
});

describe("ACPAgentSession session-attach hang recovery (Finding 1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Settles to the resolution value, the rejection error, or "timeout". */
  function settleOutcome(promise: Promise<unknown>, ms = 2_500): Promise<unknown> {
    return Promise.race([
      promise.then(
        () => "resolved",
        (error: unknown) => error,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), ms)),
    ]);
  }

  test("process crash during session/load rejects the respawn and allows a fresh retry", async () => {
    const terminator = new FakeTerminator();
    const managedProcesses = createFakeManagedProcessRegistry();
    const { session, children } = createCrashTestHarness({
      terminateProcess: terminator.terminate,
      managedProcesses,
      // Large: the exit path must not wait for the attach timeout.
      sessionLoadTimeoutMs: 30_000,
      behaviors: (spawnIndex) => (spawnIndex === 1 ? { hangLoadSession: true } : {}),
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    const startPromise = session.startTurn("revive");
    await waitForAssertion(() => {
      expect(children[1]?.agent.loadSession).toHaveBeenCalledTimes(1);
    });
    // The worker dies mid-load; the pending loadSession RPC must not hang.
    children[1].crash(1, null);

    const outcome = await settleOutcome(startPromise);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/exited during session\/load/);
    const internals = internalsOf(session);
    expect(internals.respawnPromise ?? null).toBeNull();
    expect(internals.processState).toBe("dead");
    expect(internals.child).toBeNull();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const { turnId } = await session.startTurn("retry");
    expect(children).toHaveLength(3);
    await waitForTurnEvent(events, "turn_completed", turnId);
  });

  test("live process that never answers session/load times out and recovers", async () => {
    const terminator = new FakeTerminator();
    const managedProcesses = createFakeManagedProcessRegistry();
    const { session, children } = createCrashTestHarness({
      terminateProcess: terminator.terminate,
      managedProcesses,
      sessionLoadTimeoutMs: 200,
      behaviors: (spawnIndex) => (spawnIndex === 1 ? { hangLoadSession: true } : {}),
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    const outcome = await settleOutcome(session.startTurn("revive"));
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("acp_attach_timeout");

    // No fallback to session/new after a session/load timeout.
    expect(children[1].agent.newSession).not.toHaveBeenCalled();
    expect(terminator.terminated).toContain(children[1]);
    const internals = internalsOf(session);
    expect(internals.respawnPromise ?? null).toBeNull();
    expect(internals.processState).toBe("dead");
    expect(internals.child).toBeNull();
    await waitForAssertion(() => {
      expect(managedProcesses.remove).toHaveBeenCalledTimes(2);
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const { turnId } = await session.startTurn("retry");
    expect(children).toHaveLength(3);
    await waitForTurnEvent(events, "turn_completed", turnId);
  });

  test("close during a hung session/load completes and settles respawnPromise", async () => {
    const terminator = new FakeTerminator();
    const managedProcesses = createFakeManagedProcessRegistry();
    const { session, children } = createCrashTestHarness({
      terminateProcess: terminator.terminate,
      managedProcesses,
      // Large: close must abort the attach, not wait for the timeout.
      sessionLoadTimeoutMs: 30_000,
      behaviors: (spawnIndex) => (spawnIndex === 1 ? { hangLoadSession: true } : {}),
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    const startPromise = session.startTurn("revive");
    startPromise.catch(() => {});
    await waitForAssertion(() => {
      expect(children[1]?.agent.loadSession).toHaveBeenCalledTimes(1);
    });

    const closeOutcome = await Promise.race([
      session.close().then(() => "closed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_500)),
    ]);
    expect(closeOutcome).toBe("closed");

    await expect(startPromise).rejects.toThrow("session is closed");
    const internals = internalsOf(session);
    expect(internals.respawnPromise ?? null).toBeNull();
    expect(internals.child).toBeNull();
    expect(internals.processState).toBe("dead");
    expect(terminator.terminated).toContain(children[1]);
    await waitForAssertion(() => {
      expect(managedProcesses.remove).toHaveBeenCalledTimes(2);
    });
    expect(children[1].agent.prompt).not.toHaveBeenCalled();
  });

  test("hung unstable_resumeSession during respawn is bounded", async () => {
    const terminator = new FakeTerminator();
    const { session, children } = createCrashTestHarness({
      terminateProcess: terminator.terminate,
      sessionLoadTimeoutMs: 200,
      behaviors: (spawnIndex) => ({
        agentCapabilities: { sessionCapabilities: { resume: {} } },
        ...(spawnIndex === 1 ? { hangResumeSession: true } : {}),
      }),
    });
    await session.initializeNewSession();
    children[0].crash(1, null);

    const outcome = await settleOutcome(session.startTurn("revive"));
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("acp_attach_timeout");

    const resumedAgent = children[1].agent as unknown as {
      unstable_resumeSession: ReturnType<typeof vi.fn>;
      loadSession: ReturnType<typeof vi.fn>;
    };
    expect(resumedAgent.unstable_resumeSession).toHaveBeenCalledTimes(1);
    expect(resumedAgent.loadSession).not.toHaveBeenCalled();
    expect(terminator.terminated).toContain(children[1]);
    expect(internalsOf(session).respawnPromise ?? null).toBeNull();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const { turnId } = await session.startTurn("retry");
    expect(children).toHaveLength(3);
    await waitForTurnEvent(events, "turn_completed", turnId);
  });

  test("hung session/new during initial setup is bounded", async () => {
    const terminator = new FakeTerminator();
    const { session, children } = createCrashTestHarness({
      terminateProcess: terminator.terminate,
      sessionLoadTimeoutMs: 200,
      behaviors: [{ hangNewSession: true }],
    });

    const outcome = await settleOutcome(session.initializeNewSession());
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("acp_attach_timeout");
    expect(children).toHaveLength(1);
    expect(children[0].agent.newSession).toHaveBeenCalledTimes(1);
  });

  test("hung runtime override RPC after respawn is bounded and allows retry", async () => {
    const terminator = new FakeTerminator();
    const { session, children } = createCrashTestHarness({
      terminateProcess: terminator.terminate,
      sessionLoadTimeoutMs: 200,
      behaviors: (spawnIndex) => ({
        sessionState: {
          modes: {
            availableModes: [
              { id: "yolo", name: "Yolo" },
              { id: "plan", name: "Plan" },
            ],
            currentModeId: "yolo",
          },
        },
        ...(spawnIndex === 1 ? { hangSetSessionMode: true } : {}),
      }),
    });
    await session.initializeNewSession();
    await session.setMode("plan");
    children[0].crash(1, null);

    // session/load reports mode "yolo"; re-applying the effective mode "plan"
    // hangs on the respawned worker and must hit the attach timeout.
    const outcome = await settleOutcome(session.startTurn("revive"));
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("acp_attach_timeout");
    expect(children[1].agent.setSessionMode).toHaveBeenCalledWith({
      sessionId: "session-1",
      modeId: "plan",
    });
    expect(terminator.terminated).toContain(children[1]);
    expect(internalsOf(session).respawnPromise ?? null).toBeNull();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const { turnId } = await session.startTurn("retry");
    expect(children).toHaveLength(3);
    await waitForTurnEvent(events, "turn_completed", turnId);
    // NOTE: the failed respawn overwrote currentMode with the provider-
    // reported value before the override hung, so the retry re-applies the
    // state captured at that point ("yolo"). Restoring the pre-respawn
    // effective mode after a failed override is a separate follow-up
    // (runtime-state re-application, see NEW-3) and out of scope here.
    expect(await session.getCurrentMode()).toBe("yolo");
  });
});
