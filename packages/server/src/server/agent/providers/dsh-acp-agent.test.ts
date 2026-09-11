import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  DSH_PERMISSION_MODE_ENV,
  DSH_PERMISSION_MODES,
  DshACPAgentClient,
  isDshPermissionMode,
  resolveDshPermissionEnv,
  writeDshProviderMode,
} from "./dsh-acp-agent.js";

function createContext(requestedModeId: string) {
  return {
    connection: {},
    sessionId: "session-1",
    requestedModeId,
    currentModeId: "workspace-write",
    selection: {
      availableMode: null,
      configOption: null,
      configChoice: null,
      hasAvailableModes: true,
    },
    configOptions: [],
    logger: createTestLogger(),
  } as unknown as Parameters<typeof writeDshProviderMode>[0];
}

describe("DeepSeek Harness permission modes", () => {
  test("offers DSH's shipped presets in its own order", () => {
    expect(DSH_PERMISSION_MODES.map((mode) => mode.id)).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]);
    expect(DSH_PERMISSION_MODES.map((mode) => mode.label)).toEqual([
      "Read Only",
      "Workspace Write",
      "Full Access",
    ]);
    expect(isDshPermissionMode("danger-full-access")).toBe(true);
    expect(isDshPermissionMode("bypassPermissions")).toBe(false);
    expect(isDshPermissionMode(undefined)).toBe(false);
  });

  test("starts the ACP process with the selected preset", () => {
    expect(resolveDshPermissionEnv({ modeId: "danger-full-access" })).toEqual({
      [DSH_PERMISSION_MODE_ENV]: "danger-full-access",
    });
    expect(resolveDshPermissionEnv({ modeId: "read-only" })).toEqual({
      [DSH_PERMISSION_MODE_ENV]: "read-only",
    });
  });

  test("leaves hosts that configure their own default alone", () => {
    expect(resolveDshPermissionEnv({ modeId: undefined })).toBeNull();
    expect(resolveDshPermissionEnv({ modeId: "not-a-preset" })).toBeNull();
    expect(
      resolveDshPermissionEnv({ modeId: "read-only", configuredMode: "workspace-write" }),
    ).toBeNull();
  });

  test("answers an in-session switch with a notice instead of a silent no-op", async () => {
    const result = await writeDshProviderMode(createContext("danger-full-access"));

    expect(result).toEqual({
      handled: true,
      notice: {
        type: "warning",
        message: "Start a new DeepSeek Harness session to change the permission mode.",
      },
    });
    expect(result.currentModeId).toBeUndefined();
  });

  test("leaves modes it does not own to the base session", async () => {
    await expect(writeDshProviderMode(createContext("plan"))).resolves.toEqual({ handled: false });
  });

  test("advertises the presets as the session's modes", () => {
    class TestDshACPAgentClient extends DshACPAgentClient {
      readDefaultModes() {
        return this.defaultModes;
      }
    }

    const client = new TestDshACPAgentClient({
      logger: createTestLogger(),
      command: ["dsh", "--profile", "acp"],
      providerId: "dsh",
    });

    expect(client.readDefaultModes()).toEqual(DSH_PERMISSION_MODES);
  });
});
