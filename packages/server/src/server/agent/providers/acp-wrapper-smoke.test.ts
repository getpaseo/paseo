import { ClientSideConnection } from "@agentclientprotocol/sdk";
import type {
  PromptResponse,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  AgentCapabilityFlags,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent-sdk-types.js";
import { ACPAgentSession } from "./acp-agent.js";

const smokeSelection = new Set(
  (process.env.ACP_SMOKE ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);

const capabilities: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

interface SmokeLogger extends Logger {
  warn: ReturnType<typeof vi.fn>;
}

interface WrapperSmokeConfig {
  id: "claude-acp" | "codex-acp";
  packageName: string;
  version: string;
  command: [string, ...string[]];
  env?: Record<string, string>;
}

interface CapturedRpc {
  direction: "out" | "in" | "error";
  method: string;
  payload: unknown;
}

interface CanonicalValueMapping {
  configId: string;
  category: string | null;
  requested: string;
  responseCurrentValue: string | null;
  behavior: "echoed" | "canonicalized" | "missing-response-option";
}

interface SmokeCriterionReport {
  outcome: "PASS" | "PRECONDITION-NOT-MET";
  detail: string;
}

interface SmokeTrace {
  wrapper: string;
  package: string;
  command: string[];
  rpc: CapturedRpc[];
  notifications: unknown[];
  events: AgentStreamEvent[];
  canonicalValueMappings: CanonicalValueMapping[];
  criteria: {
    toolSnapshot: SmokeCriterionReport | null;
    permission: SmokeCriterionReport | null;
  };
  finalState: unknown;
  notes: string[];
}

interface SessionInternals {
  availableModels: Array<{ modelId: string; name?: string }> | null;
  configOptions: SessionConfigOption[];
  toolCalls: Map<string, unknown>;
}

const wrappers: WrapperSmokeConfig[] = [
  {
    id: "claude-acp",
    packageName: "@agentclientprotocol/claude-agent-acp",
    version: "0.31.4",
    command: ["npx", "--yes", "@agentclientprotocol/claude-agent-acp@0.31.4"],
    env: {
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_EXECUTABLE: "/opt/homebrew/bin/claude",
    },
  },
  {
    id: "codex-acp",
    packageName: "@zed-industries/codex-acp",
    version: "0.12.0",
    command: ["npx", "--yes", "@zed-industries/codex-acp@0.12.0"],
  },
];

function shouldRunWrapper(id: string): boolean {
  return smokeSelection.has(id) || smokeSelection.has("both");
}

function createSmokeLogger(): SmokeLogger {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  return logger as unknown as SmokeLogger;
}

function createTrace(config: WrapperSmokeConfig): SmokeTrace {
  return {
    wrapper: config.id,
    package: `${config.packageName}@${config.version}`,
    command: config.command,
    rpc: [],
    notifications: [],
    events: [],
    canonicalValueMappings: [],
    criteria: {
      toolSnapshot: null,
      permission: null,
    },
    finalState: null,
    notes: [],
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function summarizeSessionResponse(response: unknown): unknown {
  const value = response as {
    sessionId?: string;
    modes?: unknown;
    models?: unknown;
    configOptions?: unknown;
  };
  return {
    sessionId: value.sessionId,
    modes: value.modes,
    models: value.models,
    configOptions: value.configOptions,
  };
}

function summarizeUpdate(update: SessionUpdate): unknown {
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return {
      sessionUpdate: update.sessionUpdate,
      toolCallId: update.toolCallId,
      status: "status" in update ? update.status : undefined,
      title: "title" in update ? update.title : undefined,
      kind: "kind" in update ? update.kind : undefined,
    };
  }
  return update;
}

function captureCanonicalMapping({
  trace,
  configId,
  requested,
  response,
}: {
  trace: SmokeTrace;
  configId: string;
  requested: string;
  response: { configOptions: SessionConfigOption[] };
}): void {
  const responseOption = response.configOptions.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.type === "select" && option.id === configId,
  );
  const responseCurrentValue = responseOption?.currentValue ?? null;
  let behavior: CanonicalValueMapping["behavior"] = "missing-response-option";
  if (responseCurrentValue) {
    behavior = responseCurrentValue === requested ? "echoed" : "canonicalized";
  }
  trace.canonicalValueMappings.push({
    configId,
    category: responseOption?.category ?? null,
    requested,
    responseCurrentValue,
    behavior,
  });
}

function summarizeEvents(events: AgentStreamEvent[]): unknown[] {
  return events.map((event) => {
    if (event.type !== "timeline") {
      return event;
    }
    const item = event.item;
    if (item.type === "tool_call") {
      return {
        ...event,
        item: {
          type: item.type,
          id: item.id,
          title: item.title,
          status: item.status,
          kind: item.kind,
        },
      };
    }
    if (item.type === "assistant_message" || item.type === "reasoning") {
      return {
        ...event,
        item: { type: item.type, text: item.text.slice(0, 400) },
      };
    }
    return event;
  });
}

function installWireCapture(trace: SmokeTrace): void {
  const originalNewSession = ClientSideConnection.prototype.newSession;
  vi.spyOn(ClientSideConnection.prototype, "newSession").mockImplementation(
    async function (params) {
      trace.rpc.push({ direction: "out", method: "session/new", payload: params });
      try {
        const response = await originalNewSession.call(this, params);
        trace.rpc.push({
          direction: "in",
          method: "session/new",
          payload: summarizeSessionResponse(response),
        });
        return response;
      } catch (error) {
        trace.rpc.push({ direction: "error", method: "session/new", payload: formatError(error) });
        throw error;
      }
    },
  );

  const originalSetMode = ClientSideConnection.prototype.setSessionMode;
  vi.spyOn(ClientSideConnection.prototype, "setSessionMode").mockImplementation(
    async function (params) {
      trace.rpc.push({ direction: "out", method: "session/setMode", payload: params });
      try {
        const response = await originalSetMode.call(this, params);
        trace.rpc.push({ direction: "in", method: "session/setMode", payload: response });
        return response;
      } catch (error) {
        trace.rpc.push({
          direction: "error",
          method: "session/setMode",
          payload: formatError(error),
        });
        throw error;
      }
    },
  );

  const originalSetModel = ClientSideConnection.prototype.unstable_setSessionModel;
  vi.spyOn(ClientSideConnection.prototype, "unstable_setSessionModel").mockImplementation(
    async function (params) {
      trace.rpc.push({ direction: "out", method: "session/setModel", payload: params });
      try {
        const response = await originalSetModel.call(this, params);
        trace.rpc.push({ direction: "in", method: "session/setModel", payload: response });
        return response;
      } catch (error) {
        trace.rpc.push({
          direction: "error",
          method: "session/setModel",
          payload: formatError(error),
        });
        throw error;
      }
    },
  );

  const originalSetConfig = ClientSideConnection.prototype.setSessionConfigOption;
  vi.spyOn(ClientSideConnection.prototype, "setSessionConfigOption").mockImplementation(
    async function (params) {
      trace.rpc.push({ direction: "out", method: "session/setConfigOption", payload: params });
      try {
        const response = await originalSetConfig.call(this, params);
        trace.rpc.push({ direction: "in", method: "session/setConfigOption", payload: response });
        captureCanonicalMapping({
          trace,
          configId: params.configId,
          requested: params.value,
          response,
        });
        return response;
      } catch (error) {
        trace.rpc.push({
          direction: "error",
          method: "session/setConfigOption",
          payload: formatError(error),
        });
        throw error;
      }
    },
  );

  const originalPrompt = ClientSideConnection.prototype.prompt;
  vi.spyOn(ClientSideConnection.prototype, "prompt").mockImplementation(async function (params) {
    trace.rpc.push({ direction: "out", method: "session/prompt", payload: params });
    try {
      const response: PromptResponse = await originalPrompt.call(this, params);
      trace.rpc.push({ direction: "in", method: "session/prompt", payload: response });
      return response;
    } catch (error) {
      trace.rpc.push({ direction: "error", method: "session/prompt", payload: formatError(error) });
      throw error;
    }
  });

  const originalSessionUpdate = ACPAgentSession.prototype.sessionUpdate;
  vi.spyOn(ACPAgentSession.prototype, "sessionUpdate").mockImplementation(async function (
    params: SessionNotification,
  ) {
    trace.notifications.push({
      sessionId: params.sessionId,
      update: summarizeUpdate(params.update),
    });
    return originalSessionUpdate.call(this, params);
  });
}

function createSession(config: WrapperSmokeConfig, logger: Logger): ACPAgentSession {
  return new ACPAgentSession(
    {
      provider: config.id,
      cwd: process.cwd(),
    },
    {
      provider: config.id,
      logger,
      defaultCommand: config.command,
      defaultModes: [],
      capabilities,
      launchEnv: config.env,
    },
  );
}

async function bootSession(
  config: WrapperSmokeConfig,
  trace: SmokeTrace,
): Promise<ACPAgentSession> {
  const logger = createSmokeLogger();
  const session = createSession(config, logger);
  session.subscribe((event) => trace.events.push(event));
  await session.initializeNewSession();
  await captureFinalState(session, trace);
  return session;
}

async function captureFinalState(session: ACPAgentSession, trace: SmokeTrace): Promise<void> {
  const internals = session as unknown as SessionInternals;
  trace.finalState = {
    runtime: await session.getRuntimeInfo(),
    availableModes: await session.getAvailableModes(),
    availableModels: internals.availableModels,
    configOptions: internals.configOptions,
    toolSnapshotCount: internals.toolCalls.size,
  };
}

function getModelIds(session: ACPAgentSession): string[] {
  const internals = session as unknown as SessionInternals;
  return internals.availableModels?.map((model) => model.modelId) ?? [];
}

function getSelectOption(
  session: ACPAgentSession,
  category: string,
): Extract<SessionConfigOption, { type: "select" }> | null {
  const internals = session as unknown as SessionInternals;
  return (
    internals.configOptions.find(
      (option): option is Extract<SessionConfigOption, { type: "select" }> =>
        option.type === "select" && option.category === category,
    ) ?? null
  );
}

function flattenSelectValues(option: Extract<SessionConfigOption, { type: "select" }>): string[] {
  const values: string[] = [];
  for (const choice of option.options) {
    if ("value" in choice) {
      values.push(choice.value);
      continue;
    }
    for (const nested of choice.options) {
      values.push(nested.value);
    }
  }
  return values;
}

function firstToolTimelineItem(events: AgentStreamEvent[]): AgentTimelineItem | null {
  const match = events.find(
    (event) => event.type === "timeline" && event.item.type === "tool_call",
  );
  return match?.type === "timeline" ? match.item : null;
}

function emitEvidence(label: string, trace: SmokeTrace): void {
  console.log(
    `ACP_WRAPPER_SMOKE_EVIDENCE ${label} ${JSON.stringify(
      {
        ...trace,
        events: summarizeEvents(trace.events),
      },
      null,
      2,
    )}`,
  );
}

async function runToolPrompt(
  session: ACPAgentSession,
  trace: SmokeTrace,
): Promise<{ permissionCount: number; resultText: string }> {
  const permissionRequests: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "permission_requested") {
      return;
    }
    permissionRequests.push(event.request.id);
    void session.respondToPermission(event.request.id, { behavior: "allow" });
  });

  try {
    const result = await session.run(
      "Use your file-reading tool to read package.json in the current working directory, then reply with only the JSON package name.",
    );
    await captureFinalState(session, trace);
    return { permissionCount: permissionRequests.length, resultText: result.finalText };
  } finally {
    unsubscribe();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

for (const config of wrappers) {
  const wrapperDescribe = shouldRunWrapper(config.id) ? describe.sequential : describe.skip;

  wrapperDescribe(`real ${config.id} ACP wrapper smoke`, () => {
    let toolPromptTraceForEvidence: SmokeTrace | null = null;

    test("(a) session/new exposes modes/models and applySessionState derives runtime state", async () => {
      const trace = createTrace(config);
      installWireCapture(trace);
      let session: ACPAgentSession | null = null;

      try {
        session = await bootSession(config, trace);
        const modes = await session.getAvailableModes();
        const modelIds = getModelIds(session);
        const modelOption = getSelectOption(session, "model");

        expect(modes.length).toBeGreaterThan(0);
        expect(
          modelIds.length + (modelOption ? flattenSelectValues(modelOption).length : 0),
        ).toBeGreaterThan(0);
        expect((await session.getRuntimeInfo()).sessionId).toBeTruthy();
        expect(
          trace.rpc.some((entry) => entry.method === "session/new" && entry.direction === "in"),
        ).toBe(true);
      } finally {
        await captureFinalStateIfOpen(session, trace);
        emitEvidence(`${config.id}:a`, trace);
        await session?.close();
      }
    }, 120_000);

    test("(b) valid setMode round-trip applies via RPC success and stays unchanged on RPC error", async () => {
      const trace = createTrace(config);
      installWireCapture(trace);
      let session: ACPAgentSession | null = null;
      let originalSessionId: string | null = null;

      try {
        session = await bootSession(config, trace);
        const currentMode = await session.getCurrentMode();
        const mode =
          (await session.getAvailableModes()).find((entry) => entry.id !== currentMode) ??
          (await session.getAvailableModes())[0];
        expect(mode).toBeDefined();

        await session.setMode(mode.id);
        await captureFinalState(session, trace);

        expect(await session.getCurrentMode()).toBe(mode.id);
        expect(trace.rpc).toContainEqual(
          expect.objectContaining({
            direction: "out",
            method: expect.stringMatching(/session\/(setMode|setConfigOption)/),
            payload: expect.objectContaining({ sessionId: session.id }),
          }),
        );

        const modeAfterSuccess = await session.getCurrentMode();
        originalSessionId = session.id;
        (session as unknown as { sessionId: string }).sessionId = `${originalSessionId}-missing`;
        await expect(session.setMode(mode.id)).rejects.toThrow();
        expect(await session.getCurrentMode()).toBe(modeAfterSuccess);
        trace.notes.push(
          "RPC-error check used the real wrapper with a deliberately unknown sessionId; local currentMode stayed unchanged after rejection.",
        );
      } finally {
        if (session && originalSessionId) {
          (session as unknown as { sessionId: string }).sessionId = originalSessionId;
        }
        await captureFinalStateIfOpen(session, trace);
        emitEvidence(`${config.id}:b`, trace);
        await session?.close();
      }
    }, 120_000);

    test("(c) valid setModel round-trip applies", async () => {
      const trace = createTrace(config);
      installWireCapture(trace);
      let session: ACPAgentSession | null = null;

      try {
        session = await bootSession(config, trace);
        const modelId = getModelIds(session)[0] ?? firstSelectValue(session, "model");
        expect(modelId).toBeTruthy();

        await session.setModel(modelId);
        await captureFinalState(session, trace);

        const modelMapping = trace.canonicalValueMappings.find(
          (mapping) => mapping.category === "model" && mapping.requested === modelId,
        );
        expect((await session.getRuntimeInfo()).model).toBe(
          modelMapping?.responseCurrentValue ?? modelId,
        );
        expect(
          trace.rpc.some(
            (entry) =>
              entry.direction === "out" &&
              (entry.method === "session/setModel" || entry.method === "session/setConfigOption") &&
              JSON.stringify(entry.payload).includes(modelId),
          ),
        ).toBe(true);
      } finally {
        await captureFinalStateIfOpen(session, trace);
        emitEvidence(`${config.id}:c`, trace);
        await session?.close();
      }
    }, 120_000);

    test("(d) thinking-mode setSessionConfigOption round-trip updates thinkingOptionId when supported", async () => {
      const trace = createTrace(config);
      installWireCapture(trace);
      let session: ACPAgentSession | null = null;

      try {
        session = await bootSession(config, trace);
        const thinkingOptionId = firstSelectValue(session, "thought_level");
        if (!thinkingOptionId) {
          trace.notes.push(
            "PRECONDITION-NOT-MET: wrapper did not expose thought_level select config option.",
          );
          return;
        }

        await session.setThinkingOption(thinkingOptionId);
        await captureFinalState(session, trace);

        const thinkingMapping = trace.canonicalValueMappings.find(
          (mapping) =>
            mapping.category === "thought_level" && mapping.requested === thinkingOptionId,
        );
        expect((await session.getRuntimeInfo()).thinkingOptionId).toBe(
          thinkingMapping?.responseCurrentValue ?? thinkingOptionId,
        );
        expect(
          trace.rpc.some(
            (entry) =>
              entry.direction === "out" &&
              entry.method === "session/setConfigOption" &&
              JSON.stringify(entry.payload).includes(thinkingOptionId),
          ),
        ).toBe(true);
      } finally {
        await captureFinalStateIfOpen(session, trace);
        emitEvidence(`${config.id}:d`, trace);
        await session?.close();
      }
    }, 120_000);

    test("(e) real assistant tool call becomes a Paseo tool snapshot and observes permission flow when emitted", async () => {
      const trace = createTrace(config);
      installWireCapture(trace);
      let session: ACPAgentSession | null = null;

      try {
        session = await bootSession(config, trace);
        const result = await runToolPrompt(session, trace);
        const toolItem = firstToolTimelineItem(trace.events);

        expect(toolItem).toBeTruthy();
        expect(
          trace.notifications.some((entry) => JSON.stringify(entry).includes("tool_call")),
        ).toBe(true);
        expect(
          trace.notifications.some((entry) => JSON.stringify(entry).includes("tool_call_update")),
        ).toBe(true);
        expect((session as unknown as SessionInternals).toolCalls.size).toBeGreaterThan(0);
        trace.criteria.toolSnapshot = {
          outcome: "PASS",
          detail:
            "Read-file prompt produced ACP tool_call/tool_call_update notifications and Paseo tool snapshots.",
        };

        if (result.permissionCount === 0) {
          trace.criteria.permission = {
            outcome: "PRECONDITION-NOT-MET",
            detail: "Wrapper emitted no requestPermission during read-file smoke.",
          };
          trace.notes.push(
            "PRECONDITION-NOT-MET: wrapper emitted no requestPermission during read-file smoke.",
          );
        } else {
          expect(trace.events.some((event) => event.type === "permission_requested")).toBe(true);
          expect(trace.events.some((event) => event.type === "permission_resolved")).toBe(true);
          expect(session.getPendingPermissions()).toHaveLength(0);
          trace.criteria.permission = {
            outcome: "PASS",
            detail:
              "Permission requests surfaced as AgentStreamEvents and the user response resolved them.",
          };
        }
      } finally {
        await captureFinalStateIfOpen(session, trace);
        toolPromptTraceForEvidence = trace;
        emitEvidence(`${config.id}:e`, trace);
        await session?.close();
      }
    }, 180_000);

    test("(f) permission criterion reports the outcome observed during the tool-call smoke", () => {
      expect(toolPromptTraceForEvidence?.criteria.permission).toBeTruthy();
      emitEvidence(`${config.id}:f`, toolPromptTraceForEvidence ?? createTrace(config));
    });
  });
}

function firstSelectValue(session: ACPAgentSession, category: string): string | null {
  const option = getSelectOption(session, category);
  return option ? (flattenSelectValues(option)[0] ?? null) : null;
}

async function captureFinalStateIfOpen(
  session: ACPAgentSession | null,
  trace: SmokeTrace,
): Promise<void> {
  if (!session?.id) {
    return;
  }
  await captureFinalState(session, trace);
}
