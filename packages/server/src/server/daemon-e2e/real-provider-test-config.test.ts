import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { resolveOpenCodeV2CredentialSourcePath } from "../agent/providers/opencode-v2/server-manager.js";
import {
  canRunRealProvider,
  createRealProviderClient,
  getRealProviderConfig,
  getRealProviderRuntimeSettings,
} from "./real-provider-test-config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("real-provider-test-config opencode-v2", () => {
  test("getRealProviderConfig returns the opencode-v2 provider with a real model and mode", () => {
    const config = getRealProviderConfig("opencode-v2");
    expect(config.provider).toBe("opencode-v2");
    expect(config.model).toMatch(/^baseten\//);
    expect(config.modeId).toBe("build");
  });

  test("getRealProviderRuntimeSettings returns an isolated env for opencode-v2", () => {
    const settings = getRealProviderRuntimeSettings("opencode-v2");
    expect(settings.env?.PASEO_HOME).toContain("paseo-real-opencode-v2");
    expect(settings.env?.HOME).toBeTruthy();
    expect(settings.env?.XDG_CONFIG_HOME).toBeTruthy();
    expect(settings.env?.XDG_DATA_HOME).toBeTruthy();
    expect(settings.env?.XDG_CACHE_HOME).toBeTruthy();
    expect(settings.env?.OPENCODE_PASSWORD).toBeTruthy();
    if (settings.env?.PASEO_HOME) {
      tempDirs.push(path.dirname(settings.env.PASEO_HOME));
    }
  });

  test("createRealProviderClient returns an OpenCodeV2AgentClient", () => {
    const client = createRealProviderClient("opencode-v2", createTestLogger());
    expect(client.provider).toBe("opencode-v2");
  });

  test("canRunRealProvider gate agrees with the binary and credential presence", async () => {
    // The gate must report runnable exactly when the opencode2 binary is on
    // PATH AND the real user's opencode2 auth file exists. In the mission
    // environment both are present, so the gate reports true.
    const canRun = await canRunRealProvider("opencode-v2");
    const binaryPresent = await isCommandAvailable("opencode2");
    const credentialsPresent = existsSync(resolveOpenCodeV2CredentialSourcePath());
    expect(canRun).toBe(binaryPresent && credentialsPresent);
  });
});
