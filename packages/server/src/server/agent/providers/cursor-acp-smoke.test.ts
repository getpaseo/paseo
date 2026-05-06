import { ClientSideConnection } from "@agentclientprotocol/sdk";
import type { Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentCapabilityFlags, AgentStreamEvent } from "../agent-sdk-types.js";
import { ACPAgentSession } from "./acp-agent.js";

const runCursorACPSmoke = process.env.CURSOR_ACP_SMOKE === "1" ? describe : describe.skip;
const cursorClaudeModel = "claude-opus-4-7[thinking=true,thinking_budget=20000]";
const issue560ClaudeModel = "claude-opus-4-7[thinking=true,reasoning_effort=xhigh]";
const provider = "cursor-acp";

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

interface SmokeEvidence {
  availableModes: unknown;
  warnings: unknown[];
  initialCurrentMode: string | null;
  acceptEditsRpcSent: boolean;
  reconnectCurrentMode: string | null;
  reconnectWarnings: unknown[];
  requestPermissionCalls: number;
  error: string | null;
  permissionScope: string;
}

interface Issue560Evidence {
  sessionNewSucceeded: boolean;
  availableModes: unknown;
  warnings: unknown[];
  setModeRpc: Array<{ modeId: string; direction: "out" | "in" | "error"; payload: unknown }>;
  setConfigRpc: Array<{ configId: string; value: string; direction: "out" | "in" | "error" }>;
  setModelRpc: Array<{ modelId: string; direction: "out" | "in" | "error" }>;
  acceptEditsConfigRpcSent: boolean;
  bracketedModelConfigRpcSent: boolean;
  planCurrentMode: string | null;
  defaultCurrentMode: string | null;
  userFacingErrors: unknown[];
  finalVerdict: "PASS" | "FAIL";
  failure: string | null;
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

function createCursorSessionWithPersistedClaudeValues({
  logger,
  model,
}: {
  logger: Logger;
  model: string;
}): ACPAgentSession {
  return new ACPAgentSession(
    {
      provider,
      cwd: process.cwd(),
      modeId: "acceptEdits",
      model,
    },
    {
      provider,
      logger,
      defaultCommand: ["npx", "--yes", "cursor-acp@0.1.0"],
      defaultModes: [],
      capabilities,
    },
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

afterEach(() => {
  vi.restoreAllMocks();
});

runCursorACPSmoke("real cursor-acp@0.1.0 smoke", () => {
  test("reconnect skips invalid persisted values again on a fresh session", async () => {
    const setModeSpy = vi.spyOn(ClientSideConnection.prototype, "setSessionMode");
    const setModelSpy = vi.spyOn(ClientSideConnection.prototype, "unstable_setSessionModel");
    const requestPermissionSpy = vi.spyOn(ACPAgentSession.prototype, "requestPermission");
    const logger = createSmokeLogger();
    const reconnectLogger = createSmokeLogger();
    let session: ACPAgentSession | null = null;
    let reconnectedSession: ACPAgentSession | null = null;
    const evidence: SmokeEvidence = {
      availableModes: null,
      warnings: [],
      initialCurrentMode: null,
      acceptEditsRpcSent: false,
      reconnectCurrentMode: null,
      reconnectWarnings: [],
      requestPermissionCalls: 0,
      error: null,
      permissionScope:
        "cursor-acp@0.1.0 emits no requestPermission calls; Cursor's hidden TUI permission UI is out of scope for this wrapper smoke.",
    };

    try {
      session = createCursorSessionWithPersistedClaudeValues({ logger, model: cursorClaudeModel });
      await session.initializeNewSession();
      evidence.availableModes = await session.getAvailableModes();
      evidence.warnings = logger.warn.mock.calls;
      evidence.initialCurrentMode = await session.getCurrentMode();
      evidence.acceptEditsRpcSent = setModeSpy.mock.calls.some(
        ([params]) => params.modeId === "acceptEdits",
      );

      await session.close();
      session = null;

      reconnectedSession = createCursorSessionWithPersistedClaudeValues({
        logger: reconnectLogger,
        model: cursorClaudeModel,
      });
      await reconnectedSession.initializeNewSession();
      evidence.reconnectCurrentMode = await reconnectedSession.getCurrentMode();
      evidence.reconnectWarnings = reconnectLogger.warn.mock.calls;
      evidence.requestPermissionCalls = requestPermissionSpy.mock.calls.length;

      expect((evidence.availableModes as Array<{ id: string }>).map((mode) => mode.id)).toEqual([
        "default",
        "plan",
      ]);
      expect(evidence.acceptEditsRpcSent).toBe(false);
      expect(evidence.initialCurrentMode).toBe("default");
      expect(logger.warn).toHaveBeenCalledWith(
        "acceptEdits",
        expect.stringContaining("is not valid cursor-acp mode"),
      );
      expect(reconnectLogger.warn).toHaveBeenCalledWith(
        "acceptEdits",
        expect.stringContaining("is not valid cursor-acp mode"),
      );
      expect(evidence.reconnectCurrentMode).toBe("default");
      expect(evidence.requestPermissionCalls).toBe(0);
      expect(setModelSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ modelId: cursorClaudeModel }),
      );
    } catch (error) {
      evidence.error = formatError(error);
      throw error;
    } finally {
      console.log(`CURSOR_ACP_SMOKE_EVIDENCE ${JSON.stringify(evidence, null, 2)}`);
      await reconnectedSession?.close();
      await session?.close();
    }
  }, 120_000);

  test("issue #560 replay skips invalid Claude selections and allows valid Cursor modes after resume", async () => {
    const logger = createSmokeLogger();
    const evidence: Issue560Evidence = {
      sessionNewSucceeded: false,
      availableModes: null,
      warnings: [],
      setModeRpc: [],
      setConfigRpc: [],
      setModelRpc: [],
      acceptEditsConfigRpcSent: false,
      bracketedModelConfigRpcSent: false,
      planCurrentMode: null,
      defaultCurrentMode: null,
      userFacingErrors: [],
      finalVerdict: "FAIL",
      failure: null,
    };
    let session: ACPAgentSession | null = null;

    const originalSetMode = ClientSideConnection.prototype.setSessionMode;
    vi.spyOn(ClientSideConnection.prototype, "setSessionMode").mockImplementation(
      async function (params) {
        evidence.setModeRpc.push({ modeId: params.modeId, direction: "out", payload: params });
        try {
          const response = await originalSetMode.call(this, params);
          evidence.setModeRpc.push({ modeId: params.modeId, direction: "in", payload: response });
          return response;
        } catch (error) {
          evidence.setModeRpc.push({
            modeId: params.modeId,
            direction: "error",
            payload: formatError(error),
          });
          throw error;
        }
      },
    );

    const originalSetConfig = ClientSideConnection.prototype.setSessionConfigOption;
    vi.spyOn(ClientSideConnection.prototype, "setSessionConfigOption").mockImplementation(
      async function (params) {
        evidence.setConfigRpc.push({
          configId: params.configId,
          value: params.value,
          direction: "out",
        });
        try {
          const response = await originalSetConfig.call(this, params);
          evidence.setConfigRpc.push({
            configId: params.configId,
            value: params.value,
            direction: "in",
          });
          return response;
        } catch (error) {
          evidence.setConfigRpc.push({
            configId: params.configId,
            value: params.value,
            direction: "error",
          });
          throw error;
        }
      },
    );

    const originalSetModel = ClientSideConnection.prototype.unstable_setSessionModel;
    vi.spyOn(ClientSideConnection.prototype, "unstable_setSessionModel").mockImplementation(
      async function (params) {
        evidence.setModelRpc.push({ modelId: params.modelId, direction: "out" });
        try {
          const response = await originalSetModel.call(this, params);
          evidence.setModelRpc.push({ modelId: params.modelId, direction: "in" });
          return response;
        } catch (error) {
          evidence.setModelRpc.push({ modelId: params.modelId, direction: "error" });
          throw error;
        }
      },
    );

    try {
      session = createCursorSessionWithPersistedClaudeValues({
        logger,
        model: issue560ClaudeModel,
      });
      session.subscribe((event: AgentStreamEvent) => {
        if (
          event.type === "turn_failed" ||
          (event.type === "timeline" &&
            event.item.type === "error" &&
            /Unknown acp model|unknown.*model/i.test(event.item.message))
        ) {
          evidence.userFacingErrors.push(event);
        }
      });

      await session.initializeNewSession();
      evidence.sessionNewSucceeded = true;
      evidence.availableModes = await session.getAvailableModes();
      evidence.warnings = logger.warn.mock.calls;

      await session.setMode("plan");
      evidence.planCurrentMode = await session.getCurrentMode();

      await session.setMode("default");
      evidence.defaultCurrentMode = await session.getCurrentMode();

      evidence.acceptEditsConfigRpcSent = evidence.setConfigRpc.some(
        (entry) => entry.value === "acceptEdits",
      );
      evidence.bracketedModelConfigRpcSent = evidence.setConfigRpc.some(
        (entry) => entry.value === issue560ClaudeModel,
      );

      expect(evidence.sessionNewSucceeded).toBe(true);
      expect((evidence.availableModes as Array<{ id: string }>).map((mode) => mode.id)).toEqual([
        "default",
        "plan",
      ]);
      expect(evidence.setModeRpc.some((entry) => entry.modeId === "acceptEdits")).toBe(false);
      expect(evidence.acceptEditsConfigRpcSent).toBe(false);
      expect(evidence.setModelRpc.some((entry) => entry.modelId === issue560ClaudeModel)).toBe(
        false,
      );
      expect(evidence.bracketedModelConfigRpcSent).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        "acceptEdits",
        expect.stringContaining("is not valid cursor-acp mode"),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        issue560ClaudeModel,
        expect.stringContaining("is not a valid cursor-acp model"),
      );
      expect(evidence.setModeRpc).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ modeId: "plan", direction: "out" }),
          expect.objectContaining({ modeId: "plan", direction: "in" }),
          expect.objectContaining({ modeId: "default", direction: "out" }),
          expect.objectContaining({ modeId: "default", direction: "in" }),
        ]),
      );
      expect(evidence.planCurrentMode).toBe("plan");
      expect(evidence.defaultCurrentMode).toBe("default");
      expect(
        evidence.userFacingErrors.some((event) =>
          /Unknown acp model|unknown.*model/i.test(JSON.stringify(event)),
        ),
      ).toBe(false);

      evidence.finalVerdict = "PASS";
    } catch (error) {
      evidence.failure = formatError(error);
      throw error;
    } finally {
      console.log(`CURSOR_ACP_ISSUE_560_EVIDENCE ${JSON.stringify(evidence, null, 2)}`);
      await session?.close();
    }
  }, 120_000);
});
