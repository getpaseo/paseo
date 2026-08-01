import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildElectronFlags,
  resolveDevRuntime,
  resolveDevUserDataDir,
} from "./dev-runtime-config.mjs";

describe("desktop dev runtime isolation", () => {
  test("scopes inherited user data to the explicitly selected dev root", () => {
    expect(
      resolveDevUserDataDir({
        devRoot: "/worktrees/feature-a",
        inheritedUserDataDir: "/checkouts/paseo/.dev/user-data",
      }),
    ).toBe(path.join("/worktrees/feature-a", ".dev", "user-data"));
  });

  test("keeps an explicit user data override outside a managed dev root", () => {
    expect(
      resolveDevUserDataDir({
        inheritedUserDataDir: "/tmp/paseo-user-data",
        fallbackRoot: "/checkouts/paseo",
      }),
    ).toBe("/tmp/paseo-user-data");
  });

  test("replaces an inherited CDP flag with this instance's selected port", () => {
    expect(buildElectronFlags("--disable-gpu --remote-debugging-port=9223", 43127)).toBe(
      "--disable-gpu --remote-debugging-port=43127",
    );
  });

  test("lets Chromium atomically allocate the default CDP port", async () => {
    const runtime = await resolveDevRuntime({
      PASEO_DEV_RUNTIME_FALLBACK_ROOT: "/checkouts/paseo",
    });

    expect(runtime.electronFlags).toBe("--remote-debugging-port=0");
  });

  test("honors an explicit CDP port without silently changing it", async () => {
    const runtime = await resolveDevRuntime({
      PASEO_DEV_RUNTIME_FALLBACK_ROOT: "/checkouts/paseo",
      PASEO_ELECTRON_REMOTE_DEBUGGING_PORT: "9333",
    });

    expect(runtime.electronFlags).toBe("--remote-debugging-port=9333");
  });
});
