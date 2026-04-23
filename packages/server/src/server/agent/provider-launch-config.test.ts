import { afterEach, describe, expect, test, vi } from "vitest";

import {
  applyProviderEnv,
  buildProxyEnv,
  migrateProviderSettings,
  ProviderOverrideSchema,
  resolveProviderCommandPrefix,
  setGlobalAgentEnv,
  type ProviderRuntimeSettings,
} from "./provider-launch-config.js";

describe("resolveProviderCommandPrefix", () => {
  test("uses resolved default command in default mode", async () => {
    const resolveDefault = vi.fn(() => "/usr/local/bin/claude");

    const resolved = await resolveProviderCommandPrefix(undefined, resolveDefault);

    expect(resolveDefault).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({ command: "/usr/local/bin/claude", args: [] });
  });

  test("appends args in append mode", async () => {
    const resolveDefault = vi.fn(() => "/usr/local/bin/claude");

    const resolved = await resolveProviderCommandPrefix(
      {
        mode: "append",
        args: ["--chrome"],
      },
      resolveDefault,
    );

    expect(resolveDefault).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({
      command: "/usr/local/bin/claude",
      args: ["--chrome"],
    });
  });

  test("replaces command in replace mode without resolving default", async () => {
    const resolveDefault = vi.fn(() => "/usr/local/bin/claude");

    const resolved = await resolveProviderCommandPrefix(
      {
        mode: "replace",
        argv: ["docker", "run", "--rm", "my-wrapper"],
      },
      resolveDefault,
    );

    expect(resolveDefault).not.toHaveBeenCalled();
    expect(resolved).toEqual({
      command: "docker",
      args: ["run", "--rm", "my-wrapper"],
    });
  });
});

describe("buildProxyEnv", () => {
  test("returns empty env when proxy is undefined", () => {
    expect(buildProxyEnv(undefined)).toEqual({});
  });

  test("returns empty env when proxy is disabled", () => {
    expect(
      buildProxyEnv({
        enabled: false,
        httpsUrl: "http://127.0.0.1:7890",
      }),
    ).toEqual({});
  });

  test("sets both upper- and lower-case HTTPS_PROXY/ALL_PROXY when httpsUrl is set", () => {
    const env = buildProxyEnv({
      enabled: true,
      httpsUrl: "http://user:pass@127.0.0.1:7890",
    });
    expect(env.HTTPS_PROXY).toBe("http://user:pass@127.0.0.1:7890");
    expect(env.https_proxy).toBe("http://user:pass@127.0.0.1:7890");
    expect(env.ALL_PROXY).toBe("http://user:pass@127.0.0.1:7890");
    expect(env.all_proxy).toBe("http://user:pass@127.0.0.1:7890");
    expect(env.HTTP_PROXY).toBeUndefined();
  });

  test("sets HTTP_PROXY when httpUrl is set", () => {
    const env = buildProxyEnv({
      enabled: true,
      httpUrl: "http://127.0.0.1:7890",
    });
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.http_proxy).toBe("http://127.0.0.1:7890");
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  test("sets NO_PROXY when noProxy is set", () => {
    const env = buildProxyEnv({
      enabled: true,
      noProxy: "localhost,127.0.0.1",
    });
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.no_proxy).toBe("localhost,127.0.0.1");
  });

  test("ignores empty/whitespace URL strings", () => {
    const env = buildProxyEnv({
      enabled: true,
      httpsUrl: "   ",
      httpUrl: "",
    });
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
  });
});

describe("applyProviderEnv", () => {
  afterEach(() => {
    setGlobalAgentEnv({});
  });

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

    const env = applyProviderEnv(base, runtime);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/custom/home");
    expect(env.FOO).toBe("bar");
    expect(Object.keys(env).length).toBeGreaterThanOrEqual(3);
  });

  test("runtimeSettings env wins over base env", () => {
    const base = { PATH: "/usr/bin" };
    const runtime: ProviderRuntimeSettings = { env: { PATH: "/custom/path" } };

    const env = applyProviderEnv(base, runtime);

    expect(env.PATH).toBe("/custom/path");
  });

  test("merges the global agent env (proxy) into provider env", () => {
    setGlobalAgentEnv({ HTTPS_PROXY: "http://127.0.0.1:7890" });
    const base = { PATH: "/usr/bin" };

    const env = applyProviderEnv(base);

    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("global agent env overrides baseEnv of the same name", () => {
    setGlobalAgentEnv({ HTTPS_PROXY: "http://proxy.config:7890" });
    const base = {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://shell.env:1111",
    };

    const env = applyProviderEnv(base);

    expect(env.HTTPS_PROXY).toBe("http://proxy.config:7890");
  });

  test("per-provider runtimeSettings env beats global agent env", () => {
    setGlobalAgentEnv({ HTTPS_PROXY: "http://global:7890" });
    const base = { PATH: "/usr/bin" };
    const runtime: ProviderRuntimeSettings = {
      env: { HTTPS_PROXY: "http://per-provider:1234" },
    };

    const env = applyProviderEnv(base, runtime);

    expect(env.HTTPS_PROXY).toBe("http://per-provider:1234");
  });

  test("no global env and disabled proxy leaves base env untouched", () => {
    setGlobalAgentEnv({});
    const base = { PATH: "/usr/bin" };

    const env = applyProviderEnv(base);

    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("strips parent Claude Code session env vars", () => {
    const base = {
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CODE_SSE_PORT: "11803",
      CLAUDE_AGENT_SDK_VERSION: "0.2.71",
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true",
    };

    const env = applyProviderEnv(base);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(env.CLAUDE_AGENT_SDK_VERSION).toBeUndefined();
    expect(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBeUndefined();
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
