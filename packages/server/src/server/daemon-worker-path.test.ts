import { describe, expect, test, vi } from "vitest";

import { refreshWindowsPathForStartup } from "./daemon-worker.js";

describe("Windows PATH refresh at startup", () => {
  test("keeps the inherited PATH when the registry query cannot run", async () => {
    // A registry query that could not run — a timeout, a denied key, a
    // missing reg.exe — must not stop the daemon from starting. The inherited
    // PATH is what the daemon runs with.
    const logger = { info: vi.fn(), warn: vi.fn() };

    await expect(
      refreshWindowsPathForStartup(logger, async () => {
        throw new Error("reg.exe timed out");
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  test("logs the PATH entries it added", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    await refreshWindowsPathForStartup(logger, async () => ({
      added: ["C:\\Users\\paseo\\.kimi-code\\bin"],
    }));

    expect(logger.info).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
