import { describe, expect, test } from "vitest";

import { buildOmpLaunch } from "./runtime.js";
import { OmpHarness } from "./test-utils/omp-harness.js";

test("falls back to progress when the event subscription is unavailable", async () => {
  const omp = new OmpHarness();
  omp.failEventSubscription(new Error("events unsupported"));
  await omp.start();

  await expect(omp.waitForSubscriptionFallback()).resolves.toEqual(["events", "progress"]);
});

describe("buildOmpLaunch env", () => {
  test("marks inherited askpass helpers and parent-session markers for deletion", () => {
    const launch = buildOmpLaunch({
      command: ["omp"],
      session: { cwd: "/workspace/project" },
    });

    expect(launch.env?.SUDO_ASKPASS).toBeUndefined();
    expect(launch.env?.SSH_ASKPASS).toBeUndefined();
    expect(launch.env?.GIT_ASKPASS).toBeUndefined();
    expect(launch.env?.CLAUDECODE).toBeUndefined();
    expect(Object.keys(launch.env ?? {})).toEqual(
      expect.arrayContaining(["SUDO_ASKPASS", "SSH_ASKPASS", "GIT_ASKPASS", "CLAUDECODE"]),
    );
  });

  test("keeps an explicitly configured askpass helper", () => {
    const launch = buildOmpLaunch({
      command: ["omp"],
      runtimeSettings: { env: { SUDO_ASKPASS: "/opt/paseo/bin/paseo-askpass" } },
      session: { cwd: "/workspace/project" },
    });

    expect(launch.env?.SUDO_ASKPASS).toBe("/opt/paseo/bin/paseo-askpass");
  });
});
