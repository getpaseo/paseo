import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildElectronFlags,
  resolveDevUserDataDir,
  selectRemoteDebuggingPort,
} from "./dev-runtime.mjs";

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

  test("selects another CDP port when the default is occupied", async () => {
    const selectedPort = await selectRemoteDebuggingPort({
      preferredPort: 9223,
      findAvailablePort: async (preferredPort) => {
        expect(preferredPort).toBe(9223);
        return 43127;
      },
    });

    expect(selectedPort).toBe(43127);
  });

  test("honors an explicit CDP port without silently changing it", async () => {
    const selectedPort = await selectRemoteDebuggingPort({
      configuredPort: "9333",
      findAvailablePort: async () => {
        throw new Error("must not probe an explicit port");
      },
    });

    expect(selectedPort).toBe(9333);
  });
});
