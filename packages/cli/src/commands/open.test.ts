import { afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  exists: vi.fn(() => true),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));
vi.mock("@getpaseo/server/process", () => ({ spawnProcess: mocks.spawn }));
import { openDesktopWithAgent } from "./open";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
test.skipIf(process.platform !== "darwin")(
  "the bundled enhanced CLI routes tasks to its own application and protocol",
  async () => {
    vi.stubEnv("PASEO_DESKTOP_APP_PATH", "/tmp/Paseo Enhanced.app");
    vi.stubEnv("PASEO_DEEP_LINK_SCHEME", "paseo-enhanced");
    vi.stubEnv("PASEO_DESKTOP_CLI", "");
    await openDesktopWithAgent({ serverId: "host", agentId: "task" });
    expect(mocks.spawn).toHaveBeenCalledWith(
      "open",
      ["-n", "-g", "-a", "/tmp/Paseo Enhanced.app", "--args", "paseo-enhanced://h/host/agent/task"],
      expect.any(Object),
    );
  },
);
