import { createRequire } from "node:module";
import { describe, expect, test, vi } from "vitest";

const require = createRequire(import.meta.url);
const { stopCliDaemonAndVerify, waitForProcessExit } = require("../e2e/packaged-app-smoke.js");

describe("packaged desktop daemon cleanup", () => {
  test("fails when the CLI fallback cannot stop the isolated daemon", async () => {
    const stopError = new Error("stop failed");
    const waitForDaemonExit = vi.fn(async () => undefined);

    await expect(
      stopCliDaemonAndVerify({
        appPath: "/tmp/Paseo.app",
        env: {},
        daemonPid: 42,
        stopDaemon: async () => {
          throw stopError;
        },
        waitForDaemonExit,
      }),
    ).rejects.toBe(stopError);
    expect(waitForDaemonExit).not.toHaveBeenCalled();
  });

  test("fails when the exact isolated daemon remains after a successful stop command", async () => {
    const processIsRunning = vi.fn(() => true);

    await expect(
      waitForProcessExit({
        pid: 42,
        label: "Isolated daemon",
        timeoutMs: 1,
        processIsRunning,
      }),
    ).rejects.toThrow("Isolated daemon PID 42 remained running");
    expect(processIsRunning).toHaveBeenCalledWith(42);
  });

  test("accepts a daemon that exits during the final polling delay", async () => {
    const processIsRunning = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);

    await expect(
      waitForProcessExit({
        pid: 42,
        label: "Isolated daemon",
        timeoutMs: 1,
        processIsRunning,
      }),
    ).resolves.toBeUndefined();
    expect(processIsRunning).toHaveBeenCalledTimes(2);
  });
});
