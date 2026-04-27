import { describe, expect, test } from "vitest";
import {
  createExternalCommandProcessEnv,
  createExternalProcessEnv,
  createHubcodeInternalEnv,
  resolveHubcodeNodeEnv,
} from "./hubcode-env.js";

describe("hubcode env contract", () => {
  const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";
  const HUBCODE_NODE_ENV = "HUBCODE_NODE_ENV";
  const baseEnv = {
    [ELECTRON_RUN_AS_NODE]: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    NODE_ENV: "development",
    PATH: "/usr/bin",
    HUBCODE_AGENT_ID: "agent-123",
    HUBCODE_DESKTOP_MANAGED: "1",
    [HUBCODE_NODE_ENV]: "production",
    HUBCODE_SUPERVISED: "1",
  };
  const runtimeControlEnvKeys = [
    "ELECTRON_RUN_AS_NODE",
    "HUBCODE_NODE_ENV",
    "HUBCODE_DESKTOP_MANAGED",
    "HUBCODE_SUPERVISED",
    "ELECTRON_NO_ATTACH_CONSOLE",
  ] as const;

  test("builds internal daemon child env by preserving pass-through and control vars", () => {
    const env = createHubcodeInternalEnv(baseEnv);

    expect(env).toMatchObject({
      [ELECTRON_RUN_AS_NODE]: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      NODE_ENV: "development",
      PATH: "/usr/bin",
      HUBCODE_DESKTOP_MANAGED: "1",
      [HUBCODE_NODE_ENV]: "production",
      HUBCODE_SUPERVISED: "1",
      HUBCODE_AGENT_ID: "agent-123",
    });
  });

  test("builds external process env by scrubbing runtime control vars after overlays", () => {
    const env = createExternalProcessEnv(baseEnv, {
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      ELECTRON_RUN_AS_NODE: "0",
      EXTRA_VALUE: "from-overlay",
      HUBCODE_DESKTOP_MANAGED: "1",
      HUBCODE_NODE_ENV: "test",
      HUBCODE_SUPERVISED: "1",
      PATH: "/custom/bin",
    });

    for (const key of runtimeControlEnvKeys) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.NODE_ENV).toBe("development");
    expect(env.HUBCODE_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("applies non-control overlays to external process env", () => {
    const env = createExternalProcessEnv(baseEnv, { PATH: "/custom/bin" }, { CUSTOM: "value" });

    expect(env.CUSTOM).toBe("value");
    expect(env.NODE_ENV).toBe("development");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("builds process.execPath external command env with Electron node mode", () => {
    const env = createExternalCommandProcessEnv(process.execPath, baseEnv, {
      ELECTRON_RUN_AS_NODE: "0",
      HUBCODE_NODE_ENV: "test",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBe("1");
    expect(env.NODE_ENV).toBe("development");
    expect(env.HUBCODE_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(env.HUBCODE_DESKTOP_MANAGED).toBeUndefined();
    expect(env[HUBCODE_NODE_ENV]).toBeUndefined();
    expect(env.HUBCODE_SUPERVISED).toBeUndefined();
  });

  test("always re-adds Electron node mode after scrubbing process.execPath overlays", () => {
    const env = createExternalCommandProcessEnv(process.execPath, baseEnv, {
      ELECTRON_RUN_AS_NODE: undefined,
    });

    for (const key of runtimeControlEnvKeys) {
      if (key === ELECTRON_RUN_AS_NODE) continue;
      expect(env[key]).toBeUndefined();
    }
    expect(env[ELECTRON_RUN_AS_NODE]).toBe("1");
  });

  test("does not add Electron node mode for non-execPath commands", () => {
    const env = createExternalCommandProcessEnv("node", baseEnv, {
      ELECTRON_RUN_AS_NODE: "1",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
  });

  test("does not use user NODE_ENV as Hubcode runtime mode", () => {
    expect(resolveHubcodeNodeEnv({ NODE_ENV: "development" })).toBeUndefined();
    expect(resolveHubcodeNodeEnv({ NODE_ENV: "development", HUBCODE_NODE_ENV: "production" })).toBe(
      "production",
    );
    expect(resolveHubcodeNodeEnv({ NODE_ENV: "test", HUBCODE_NODE_ENV: "local" })).toBeUndefined();
  });
});
