import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  checkProviderLaunchAvailable,
  createProviderEnv,
  migrateProviderSettings,
  ProviderOverrideSchema,
  resolveProviderLaunch,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "./provider-launch-config.js";

const originalPath = process.env.PATH;
const tempDirs: string[] = [];

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-provider-launch-"));
  tempDirs.push(dir);
  return dir;
}

interface TestExecutable {
  command: string;
  path: string;
}

function createExecutable(dir: string, name: string, body = "echo test-version\n"): TestExecutable {
  const command = process.platform === "win32" ? `${name}.cmd` : name;
  const file = path.join(dir, command);
  const contents = process.platform === "win32" ? "@echo test-version\r\n" : `#!/bin/sh\n${body}`;
  writeFileSync(file, contents, "utf8");
  chmodSync(file, 0o755);
  return {
    command,
    path: file,
  };
}

describe("resolveProviderCommandPrefix", () => {
  test("uses resolved default command in default mode", async () => {
    let calls = 0;
    const resolveDefault = () => {
      calls += 1;
      return "/usr/local/bin/claude";
    };

    const resolved = await resolveProviderCommandPrefix(undefined, resolveDefault);

    expect(calls).toBe(1);
    expect(resolved).toEqual({ command: "/usr/local/bin/claude", args: [] });
  });

  test("appends args in append mode", async () => {
    let calls = 0;
    const resolveDefault = () => {
      calls += 1;
      return "/usr/local/bin/claude";
    };

    const resolved = await resolveProviderCommandPrefix(
      {
        mode: "append",
        args: ["--chrome"],
      },
      resolveDefault,
    );

    expect(calls).toBe(1);
    expect(resolved).toEqual({
      command: "/usr/local/bin/claude",
      args: ["--chrome"],
    });
  });

  test("replaces command in replace mode without resolving default", async () => {
    let calls = 0;
    const resolveDefault = () => {
      calls += 1;
      return "/usr/local/bin/claude";
    };

    const resolved = await resolveProviderCommandPrefix(
      {
        mode: "replace",
        argv: ["docker", "run", "--rm", "my-wrapper"],
      },
      resolveDefault,
    );

    expect(calls).toBe(0);
    expect(resolved).toEqual({
      command: "docker",
      args: ["run", "--rm", "my-wrapper"],
    });
  });
});

describe("resolveProviderLaunch", () => {
  test("uses replace override as the spawned command", async () => {
    const binDir = makeTempDir();
    const shim = createExecutable(binDir, "custom-provider");

    const launch = await resolveProviderLaunch({
      commandConfig: { mode: "replace", argv: [shim.command, "--wrapped"] },
      defaultBinary: "provider",
    });

    expect(launch).toEqual({
      command: shim.command,
      args: ["--wrapped"],
      source: "override",
    });
  });

  test("keeps an absolute replace override when the path exists", async () => {
    const binDir = makeTempDir();
    const shim = createExecutable(binDir, "custom-provider", "exit 42\n");

    const launch = await resolveProviderLaunch({
      commandConfig: { mode: "replace", argv: [shim.path, "--wrapped"] },
      defaultBinary: "provider",
    });

    expect(launch).toEqual({
      command: shim.path,
      args: ["--wrapped"],
      source: "override",
    });
  });

  test("resolves append mode through the default binary", async () => {
    const binDir = makeTempDir();
    const binary = createExecutable(binDir, "default-provider");
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    const launch = await resolveProviderLaunch({
      commandConfig: { mode: "append", args: ["--profile", "work"] },
      defaultBinary: binary.command,
    });

    expect(launch).toEqual({
      command: binary.command,
      args: ["--profile", "work"],
      source: "append",
    });
  });

  test("resolves the default binary when no override is configured", async () => {
    const binDir = makeTempDir();
    const binary = createExecutable(binDir, "default-provider");
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    const launch = await resolveProviderLaunch({
      defaultBinary: binary.command,
    });

    expect(launch).toEqual({
      command: binary.command,
      args: [],
      source: "default",
    });
  });

  test("keeps the default command when the default binary is missing", async () => {
    process.env.PATH = makeTempDir();

    const launch = await resolveProviderLaunch({
      defaultBinary: "paseo-provider-missing",
    });

    expect(launch).toEqual({
      command: "paseo-provider-missing",
      args: [],
      source: "default",
    });
  });
});

describe("checkProviderLaunchAvailable", () => {
  test("reports available with a resolved path", async () => {
    const binDir = makeTempDir();
    const binary = createExecutable(binDir, "default-provider");
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    const launch = await resolveProviderLaunch({
      defaultBinary: binary.command,
    });

    await expect(checkProviderLaunchAvailable(launch)).resolves.toEqual({
      available: true,
      resolvedPath: binary.path,
    });
  });

  test("reports missing override commands as unavailable", async () => {
    process.env.PATH = makeTempDir();
    const launch = await resolveProviderLaunch({
      commandConfig: { mode: "replace", argv: ["paseo-provider-missing"] },
      defaultBinary: "provider",
    });

    await expect(checkProviderLaunchAvailable(launch)).resolves.toEqual({
      available: false,
      resolvedPath: null,
    });
  });
});

describe("createProviderEnv", () => {
  test("merges provider env overrides", () => {
    const base = {
      PATH: "/usr/bin",
      HOME: "/tmp",
    };
    const runtime: ProviderRuntimeSettings = {
      env: {
        HOME: "/custom/home",
        FOO: "bar",
      },
    };

    const env = createProviderEnv({ baseEnv: base, runtimeSettings: runtime });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/custom/home");
    expect(env.FOO).toBe("bar");
    expect(Object.keys(env).length).toBeGreaterThanOrEqual(3);
  });

  test("runtimeSettings env wins over base env", () => {
    const base = { PATH: "/usr/bin" };
    const runtime: ProviderRuntimeSettings = { env: { PATH: "/custom/path" } };

    const env = createProviderEnv({ baseEnv: base, runtimeSettings: runtime });

    expect(env.PATH).toBe("/custom/path");
  });

  test("strips parent Claude Code session env vars without removing SDK child flags", () => {
    const base = {
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CODE_SSE_PORT: "11803",
      CLAUDE_AGENT_SDK_VERSION: "0.2.71",
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true",
    };

    const env = createProviderEnv({ baseEnv: base });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(env.CLAUDE_AGENT_SDK_VERSION).toBeUndefined();
    expect(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe("true");
  });
});

describe("ProviderOverrideSchema", () => {
  test("accepts built-in override fields", () => {
    const parsed = ProviderOverrideSchema.parse({
      command: ["custom-claude", "--json"],
      env: {
        FOO: "bar",
      },
      enabled: false,
      order: 2,
    });

    expect(parsed.command).toEqual(["custom-claude", "--json"]);
    expect(parsed.env?.FOO).toBe("bar");
    expect(parsed.enabled).toBe(false);
    expect(parsed.order).toBe(2);
  });

  test("accepts models with thinking options", () => {
    const parsed = ProviderOverrideSchema.parse({
      models: [
        {
          id: "zai-fast",
          label: "ZAI Fast",
          isDefault: true,
          thinkingOptions: [
            {
              id: "deep",
              label: "Deep",
              description: "Higher effort",
            },
          ],
        },
      ],
    });

    expect(parsed.models).toEqual([
      {
        id: "zai-fast",
        label: "ZAI Fast",
        isDefault: true,
        thinkingOptions: [
          {
            id: "deep",
            label: "Deep",
            description: "Higher effort",
          },
        ],
      },
    ]);
  });
});

describe("migrateProviderSettings", () => {
  const builtinProviderIds = ["claude", "codex", "copilot", "opencode", "pi"];

  test("passes through entries already in the new format", () => {
    const migrated = migrateProviderSettings(
      {
        zai: {
          extends: "claude",
          label: "ZAI",
          command: ["zai"],
          env: {
            ZAI_KEY: "secret",
          },
        },
      },
      builtinProviderIds,
    );

    expect(migrated).toEqual({
      zai: {
        extends: "claude",
        label: "ZAI",
        command: ["zai"],
        env: {
          ZAI_KEY: "secret",
        },
      },
    });
  });

  test("migrates mode replace to command argv", () => {
    const migrated = migrateProviderSettings(
      {
        claude: {
          command: {
            mode: "replace",
            argv: ["docker", "run", "--rm", "claude"],
          },
        },
      },
      builtinProviderIds,
    );

    expect(migrated).toEqual({
      claude: {
        command: ["docker", "run", "--rm", "claude"],
      },
    });
  });

  test("migrates mode default by dropping command", () => {
    const migrated = migrateProviderSettings(
      {
        codex: {
          command: {
            mode: "default",
          },
          env: {
            FOO: "bar",
          },
        },
      },
      builtinProviderIds,
    );

    expect(migrated).toEqual({
      codex: {
        env: {
          FOO: "bar",
        },
      },
    });
  });

  test("drops append mode entries because they cannot be auto-migrated", () => {
    const migrated = migrateProviderSettings(
      {
        claude: {
          command: {
            mode: "append",
            args: ["--debug"],
          },
          env: {
            FOO: "bar",
          },
        },
      },
      builtinProviderIds,
    );

    expect(migrated).toEqual({});
  });

  test("preserves legacy env while migrating old entries", () => {
    const migrated = migrateProviderSettings(
      {
        opencode: {
          command: {
            mode: "replace",
            argv: ["opencode"],
          },
          env: {
            PATH: "/custom/bin",
          },
        },
      },
      builtinProviderIds,
    );

    expect(migrated).toEqual({
      opencode: {
        command: ["opencode"],
        env: {
          PATH: "/custom/bin",
        },
      },
    });
  });
});
