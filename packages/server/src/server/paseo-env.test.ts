import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildSelfNodeCommand,
  createExternalCommandProcessEnv,
  createExternalProcessEnv,
  createPaseoInternalEnv,
  resolvePaseoNodeEnv,
} from "./paseo-env.js";

describe("paseo env contract", () => {
  const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";
  const PASEO_NODE_ENV = "PASEO_NODE_ENV";
  const baseEnv = {
    [ELECTRON_RUN_AS_NODE]: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    NODE_ENV: "development",
    PATH: "/usr/bin",
    PASEO_AGENT_ID: "agent-123",
    PASEO_DESKTOP_MANAGED: "1",
    [PASEO_NODE_ENV]: "production",
    PASEO_SUPERVISED: "1",
  };
  const runtimeControlEnvKeys = [
    "ELECTRON_RUN_AS_NODE",
    "PASEO_NODE_ENV",
    "PASEO_DESKTOP_MANAGED",
    "PASEO_SUPERVISED",
    "ELECTRON_NO_ATTACH_CONSOLE",
  ] as const;

  test("builds internal daemon child env by preserving pass-through and control vars", () => {
    const env = createPaseoInternalEnv(baseEnv);

    expect(env).toMatchObject({
      [ELECTRON_RUN_AS_NODE]: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      NODE_ENV: "development",
      PATH: "/usr/bin",
      PASEO_DESKTOP_MANAGED: "1",
      [PASEO_NODE_ENV]: "production",
      PASEO_SUPERVISED: "1",
      PASEO_AGENT_ID: "agent-123",
    });
  });

  test("builds external process env by scrubbing runtime control vars after overlays", () => {
    const env = createExternalProcessEnv(baseEnv, {
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      ELECTRON_RUN_AS_NODE: "0",
      EXTRA_VALUE: "from-overlay",
      PASEO_DESKTOP_MANAGED: "1",
      PASEO_NODE_ENV: "test",
      PASEO_SUPERVISED: "1",
      PATH: "/custom/bin",
    });

    for (const key of runtimeControlEnvKeys) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("applies non-control overlays to external process env", () => {
    const env = createExternalProcessEnv(baseEnv, { PATH: "/custom/bin" }, { CUSTOM: "value" });

    expect(env.CUSTOM).toBe("value");
    expect(env.NODE_ENV).toBe("development");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("builds external command env without process.execPath special-casing", () => {
    const env = createExternalCommandProcessEnv(process.execPath, baseEnv, {
      ELECTRON_RUN_AS_NODE: "0",
      PASEO_NODE_ENV: "test",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(env[PASEO_NODE_ENV]).toBeUndefined();
    expect(env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("builds self node command with Electron node mode", () => {
    const command = buildSelfNodeCommand(["script.js"], {
      CUSTOM: "value",
    });

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual(["script.js"]);
    expect(command.env[ELECTRON_RUN_AS_NODE]).toBe("1");
    expect(command.env.CUSTOM).toBe("value");
    expect(command.env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(command.env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(command.env[PASEO_NODE_ENV]).toBeUndefined();
    expect(command.env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("does not add Electron node mode for non-execPath commands", () => {
    const env = createExternalCommandProcessEnv("node", baseEnv, {
      ELECTRON_RUN_AS_NODE: "1",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
  });

  test("does not use user NODE_ENV as Paseo runtime mode", () => {
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development" })).toBeUndefined();
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development", PASEO_NODE_ENV: "production" })).toBe(
      "production",
    );
    expect(resolvePaseoNodeEnv({ NODE_ENV: "test", PASEO_NODE_ENV: "local" })).toBeUndefined();
  });
});

describe("external process env UTF-8 locale default", () => {
  const baseEnv = { PATH: "/usr/bin" };

  test("injects a UTF-8 LANG when no locale category is set", () => {
    const env = createExternalProcessEnv(baseEnv);

    expect(env.LANG).toBe("en_US.UTF-8");
  });

  test("preserves an explicit LANG instead of overriding it", () => {
    const env = createExternalProcessEnv(baseEnv, { LANG: "C.UTF-8" });

    expect(env.LANG).toBe("C.UTF-8");
  });

  test("does not inject LANG when LC_ALL already selects a locale", () => {
    const env = createExternalProcessEnv(baseEnv, { LC_ALL: "ja_JP.UTF-8" });

    expect(env.LANG).toBeUndefined();
    expect(env.LC_ALL).toBe("ja_JP.UTF-8");
  });

  test("does not inject LANG when LC_CTYPE already selects a locale", () => {
    const env = createExternalProcessEnv(baseEnv, { LC_CTYPE: "en_US.UTF-8" });

    expect(env.LANG).toBeUndefined();
    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
  });
});

describe("buildSelfNodeCommand UTF-8 locale default", () => {
  const localeKeys = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
  const savedLocale: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of localeKeys) {
      savedLocale[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of localeKeys) {
      if (savedLocale[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedLocale[key];
      }
    }
  });

  test("injects a UTF-8 LANG when neither the daemon env nor the overlay set a locale", () => {
    const command = buildSelfNodeCommand(["script.js"]);

    expect(command.env.LANG).toBe("en_US.UTF-8");
  });

  test("does not inject a stray LANG when the overlay selects a locale via LC_ALL", () => {
    const command = buildSelfNodeCommand(["script.js"], { LC_ALL: "C" });

    expect(command.env.LC_ALL).toBe("C");
    expect(command.env.LANG).toBeUndefined();
  });

  test("preserves an explicit LANG overlay instead of overriding it", () => {
    const command = buildSelfNodeCommand(["script.js"], { LANG: "C.UTF-8" });

    expect(command.env.LANG).toBe("C.UTF-8");
  });

  test("preserves a locale already present in the daemon environment", () => {
    process.env.LANG = "fr_FR.UTF-8";

    const command = buildSelfNodeCommand(["script.js"]);

    expect(command.env.LANG).toBe("fr_FR.UTF-8");
  });
});
