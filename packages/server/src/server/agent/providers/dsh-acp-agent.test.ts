import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentPersistenceHandle, AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";
import { createStub, asInternals } from "../../test-utils/class-mocks.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ACPAgentClient, ACPAgentSession } from "./acp-agent.js";
import {
  DSH_PERMISSION_MODE_ENV,
  DSH_PERMISSION_MODES,
  DshACPAgentClient,
  writeDshProviderMode,
} from "./dsh-acp-agent.js";

const capabilities = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const modeChangeNotice = {
  type: "warning" as const,
  message: "Start a new DeepSeek Harness session to change the permission mode.",
};

interface DshSessionInternals {
  sessionId: string | null;
  connection: unknown;
}

function createDshSession(modeId: string): ACPAgentSession {
  return new ACPAgentSession(
    { provider: "dsh", cwd: "/tmp/paseo-dsh-test", modeId },
    {
      provider: "dsh",
      logger: createTestLogger(),
      defaultCommand: ["dsh", "--profile", "acp"],
      defaultModes: DSH_PERMISSION_MODES,
      providerModeWriter: writeDshProviderMode,
      capabilities,
    },
  );
}

function createDshClient(env?: Record<string, string>): DshACPAgentClient {
  return new DshACPAgentClient({
    logger: createTestLogger(),
    command: ["dsh", "--profile", "acp"],
    providerId: "dsh",
    ...(env ? { env } : {}),
  });
}

/** Only the arguments reach the base client; its return value is unused here. */
function stubBaseSession(): AgentSession {
  return asInternals<AgentSession>({});
}

function stubHandle(metadata: Record<string, unknown>): AgentPersistenceHandle {
  return createStub<AgentPersistenceHandle>({
    provider: "dsh",
    sessionId: "session-1",
    metadata,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DeepSeek Harness permission modes", () => {
  test("offers DSH's shipped presets as the session's modes", async () => {
    const modes = await createDshSession("workspace-write").getAvailableModes();

    expect(modes.map((mode) => mode.id)).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]);
    expect(modes.map((mode) => mode.label)).toEqual([
      "Read Only",
      "Workspace Write",
      "Full Access",
    ]);
  });

  test("answers an in-session switch with a notice and keeps the launched mode", async () => {
    const session = createDshSession("workspace-write");
    const internals = asInternals<DshSessionInternals>(session);
    internals.sessionId = "session-1";
    internals.connection = {};
    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));

    const notice = await session.setMode("danger-full-access");
    unsubscribe();

    expect(notice).toEqual(modeChangeNotice);
    expect(await session.getCurrentMode()).toBe("workspace-write");
    expect(events.map((event) => event.type)).not.toContain("mode_changed");
  });

  test("starts the process with the selected preset", async () => {
    const baseCreateSession = vi
      .spyOn(ACPAgentClient.prototype, "createSession")
      .mockResolvedValue(stubBaseSession());

    await createDshClient().createSession({
      provider: "dsh",
      cwd: "/tmp/paseo-dsh-test",
      modeId: "danger-full-access",
    });

    expect(baseCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "danger-full-access" }),
      { env: { [DSH_PERMISSION_MODE_ENV]: "danger-full-access" } },
    );
  });

  test("leaves a session without a preset to DSH's own default", async () => {
    const baseCreateSession = vi
      .spyOn(ACPAgentClient.prototype, "createSession")
      .mockResolvedValue(stubBaseSession());

    await createDshClient().createSession({
      provider: "dsh",
      cwd: "/tmp/paseo-dsh-test",
      modeId: "not-a-preset",
    });

    expect(baseCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "not-a-preset" }),
      undefined,
    );
  });

  test("reports the preset a provider environment pins, not the selected one", async () => {
    const baseCreateSession = vi
      .spyOn(ACPAgentClient.prototype, "createSession")
      .mockResolvedValue(stubBaseSession());

    await createDshClient({ [DSH_PERMISSION_MODE_ENV]: "danger-full-access" }).createSession({
      provider: "dsh",
      cwd: "/tmp/paseo-dsh-test",
      modeId: "read-only",
    });

    expect(baseCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "danger-full-access" }),
      undefined,
    );
  });

  test("reports the preset an agent environment pins", async () => {
    const baseCreateSession = vi
      .spyOn(ACPAgentClient.prototype, "createSession")
      .mockResolvedValue(stubBaseSession());

    await createDshClient().createSession(
      { provider: "dsh", cwd: "/tmp/paseo-dsh-test", modeId: "read-only" },
      { env: { [DSH_PERMISSION_MODE_ENV]: "workspace-write" } },
    );

    expect(baseCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: "workspace-write" }),
      { env: { [DSH_PERMISSION_MODE_ENV]: "workspace-write" } },
    );
  });

  test("re-applies the persisted preset when it resumes", async () => {
    const baseResumeSession = vi
      .spyOn(ACPAgentClient.prototype, "resumeSession")
      .mockResolvedValue(stubBaseSession());

    await createDshClient().resumeSession(stubHandle({ modeId: "read-only" }));

    expect(baseResumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
      undefined,
      { env: { [DSH_PERMISSION_MODE_ENV]: "read-only" } },
    );
  });

  test("resumes under the preset a provider environment pins", async () => {
    const baseResumeSession = vi
      .spyOn(ACPAgentClient.prototype, "resumeSession")
      .mockResolvedValue(stubBaseSession());

    await createDshClient({ [DSH_PERMISSION_MODE_ENV]: "danger-full-access" }).resumeSession(
      stubHandle({ modeId: "read-only" }),
    );

    expect(baseResumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" }),
      { modeId: "danger-full-access" },
      undefined,
    );
  });
});
