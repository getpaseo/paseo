import { describe, expect, test, vi } from "vitest";

import {
  resolveProviderCommandPrefix,
  applyProviderEnv,
  type ProviderRuntimeSettings,
} from "./provider-launch-config.js";

describe("resolveProviderCommandPrefix", () => {
  test("uses resolved default command in default mode", () => {
    const resolveDefault = vi.fn(() => "/usr/local/bin/claude");

    const resolved = resolveProviderCommandPrefix(undefined, resolveDefault);

    expect(resolveDefault).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({ command: "/usr/local/bin/claude", args: [] });
  });

  test("appends args in append mode", () => {
    const resolveDefault = vi.fn(() => "/usr/local/bin/claude");

    const resolved = resolveProviderCommandPrefix(
      {
        mode: "append",
        args: ["--chrome"],
      },
      resolveDefault
    );

    expect(resolveDefault).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({
      command: "/usr/local/bin/claude",
      args: ["--chrome"],
    });
  });

  test("replaces command in replace mode without resolving default", () => {
    const resolveDefault = vi.fn(() => "/usr/local/bin/claude");

    const resolved = resolveProviderCommandPrefix(
      {
        mode: "replace",
        argv: ["docker", "run", "--rm", "my-wrapper"],
      },
      resolveDefault
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

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/custom/home",
      FOO: "bar",
    });
  });
});
