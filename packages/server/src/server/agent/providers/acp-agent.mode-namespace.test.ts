import { describe, expect, test, vi } from "vitest";
import type {
  ClientSideConnection,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { ACPAgentSession, type SessionStateResponse } from "./acp-agent.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { asInternals } from "../../test-utils/class-mocks.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

interface ModeSessionInternals {
  sessionId: string | null;
  connection: Pick<ClientSideConnection, "setSessionMode" | "setSessionConfigOption">;
  applySessionState(response: SessionStateResponse): void;
  translateSessionUpdate(update: SessionUpdate): AgentStreamEvent[];
}

const modes = {
  currentModeId: "accept_edits",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "accept_edits", name: "Accept Edits" },
    { id: "dont_ask", name: "Don't Ask" },
  ],
};
function editOptions(currentValue = "workspace_session"): SessionConfigOption[] {
  return [
    {
      id: "edit_approval_policy",
      name: "Edits",
      category: "mode",
      type: "select",
      currentValue,
      options: [
        { value: "ask", name: "Default" },
        { value: "workspace_session", name: "Accept Edits" },
        { value: "session", name: "Don't Ask" },
      ],
    },
  ];
}
function fixture(withSessionModes = true) {
  const session = new ACPAgentSession(
    { provider: "hermes", cwd: process.cwd() },
    {
      provider: "hermes",
      logger: createTestLogger(),
      defaultCommand: ["not-spawned"],
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
  const setSessionMode = vi.fn(async ({ modeId }: { sessionId: string; modeId: string }) => {
    if (!modes.availableModes.some((mode) => mode.id === modeId)) throw new Error("invalid_params");
    return {};
  });
  const setSessionConfigOption = vi.fn(
    async ({ value }: { sessionId: string; configId: string; value: string }) => ({
      configOptions: editOptions(value),
    }),
  );
  const internals = asInternals<ModeSessionInternals>(session);
  internals.sessionId = "isolated-session";
  internals.connection = { setSessionMode, setSessionConfigOption };
  internals.applySessionState({
    sessionId: "isolated-session",
    modes: withSessionModes ? modes : undefined,
    configOptions: editOptions(),
  });
  return { session, internals, setSessionMode, setSessionConfigOption };
}

describe("ACP mode and config-value namespaces", () => {
  test("keeps a pushed current mode when config values describe a different namespace", async () => {
    const { session, internals } = fixture();
    internals.translateSessionUpdate({
      sessionUpdate: "current_mode_update",
      currentModeId: "dont_ask",
    });
    internals.translateSessionUpdate({
      sessionUpdate: "config_option_update",
      configOptions: editOptions("session"),
    });
    expect(await session.getCurrentMode()).toBe("dont_ask");
    internals.translateSessionUpdate({ sessionUpdate: "config_option_update", configOptions: [] });
    expect(await session.getCurrentMode()).toBe("dont_ask");
    expect((await session.getAvailableModes()).map((mode) => mode.id)).toEqual([
      "default",
      "accept_edits",
      "dont_ask",
    ]);
  });

  test("does not send a config policy value to the mode endpoint or silently fall back", async () => {
    const { session, internals, setSessionMode, setSessionConfigOption } = fixture();
    internals.translateSessionUpdate({
      sessionUpdate: "config_option_update",
      configOptions: editOptions(),
    });
    await session.setMode("session");
    expect(setSessionMode).not.toHaveBeenCalled();
    expect(setSessionConfigOption).not.toHaveBeenCalled();
    expect(await session.getCurrentMode()).toBe("accept_edits");
  });

  test("keeps the confirmed mode when the mode request fails", async () => {
    const { session, setSessionMode, setSessionConfigOption } = fixture();
    setSessionMode.mockRejectedValueOnce(new Error("mode denied"));
    await expect(session.setMode("dont_ask")).rejects.toThrow("mode denied");
    expect(await session.getCurrentMode()).toBe("accept_edits");
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  test("uses the config endpoint when a provider only advertises config choices", async () => {
    const { session, setSessionMode, setSessionConfigOption } = fixture(false);
    await session.setMode("session");
    expect(setSessionMode).not.toHaveBeenCalled();
    expect(setSessionConfigOption).toHaveBeenCalledExactlyOnceWith({
      sessionId: "isolated-session",
      configId: "edit_approval_policy",
      value: "session",
    });
    expect(await session.getCurrentMode()).toBe("session");
  });

  test("keeps real mode IDs after a config update and sends Don't Ask to the mode endpoint", async () => {
    const { session, internals, setSessionMode, setSessionConfigOption } = fixture();
    internals.translateSessionUpdate({
      sessionUpdate: "config_option_update",
      configOptions: editOptions(),
    });
    expect(await session.getAvailableModes()).toEqual(
      modes.availableModes.map(({ id, name }) => ({ id, label: name, description: undefined })),
    );
    expect(await session.getCurrentMode()).toBe("accept_edits");
    await session.setMode("dont_ask");
    expect(setSessionMode).toHaveBeenCalledExactlyOnceWith({
      sessionId: "isolated-session",
      modeId: "dont_ask",
    });
    expect(setSessionConfigOption).not.toHaveBeenCalled();
    expect(await session.getCurrentMode()).toBe("dont_ask");
  });
});
