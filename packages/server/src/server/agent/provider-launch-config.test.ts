import { describe, expect, test, vi } from "vitest";

import {
  resolveProviderCommandPrefix,
  applyProviderEnv,
  resolveModelViaMap,
  reverseResolveModelViaMap,
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

describe("applyProviderEnv", () => {
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

describe("resolveModelViaMap", () => {
  const modelMap = {
    "claude-opus-4-6": "qwen3.6-plus",
    "claude-sonnet-4-6": "qwen3.5-plus",
    "claude-haiku-4-5": "qwen3-coder-plus",
  };

  test("translates a known model ID", () => {
    expect(resolveModelViaMap("claude-opus-4-6", modelMap)).toBe("qwen3.6-plus");
    expect(resolveModelViaMap("claude-sonnet-4-6", modelMap)).toBe("qwen3.5-plus");
  });

  test("passes through an unmapped model ID", () => {
    expect(resolveModelViaMap("unknown-model", modelMap)).toBe("unknown-model");
  });

  test("returns null/undefined as-is when modelId is empty", () => {
    expect(resolveModelViaMap(null, modelMap)).toBeNull();
    expect(resolveModelViaMap(undefined, modelMap)).toBeUndefined();
  });

  test("returns modelId as-is when modelMap is undefined", () => {
    expect(resolveModelViaMap("claude-opus-4-6", undefined)).toBe("claude-opus-4-6");
  });
});

describe("reverseResolveModelViaMap", () => {
  const modelMap = {
    "claude-opus-4-6": "qwen3.6-plus",
    "claude-sonnet-4-6": "qwen3.5-plus",
  };

  test("reverse-maps a runtime model to Paseo model ID", () => {
    expect(reverseResolveModelViaMap("qwen3.6-plus", modelMap)).toBe("claude-opus-4-6");
    expect(reverseResolveModelViaMap("qwen3.5-plus", modelMap)).toBe("claude-sonnet-4-6");
  });

  test("returns null for an unknown runtime model", () => {
    expect(reverseResolveModelViaMap("unknown-runtime", modelMap)).toBeNull();
  });

  test("returns null when modelMap is undefined", () => {
    expect(reverseResolveModelViaMap("qwen3.6-plus", undefined)).toBeNull();
  });
});
