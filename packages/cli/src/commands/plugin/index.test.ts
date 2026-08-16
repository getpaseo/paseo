import { describe, expect, it, vi } from "vitest";

const listPlugins = vi.fn(async () => []);
const close = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    getLastServerInfoMessage: () => ({ features: { pluginManagement: false } }),
    listPlugins,
    close,
  })),
}));

import { runPluginListCommand } from "./index.js";

describe("plugin management commands", () => {
  it("requires host support before attempting a management RPC", async () => {
    await expect(runPluginListCommand({}, {} as never)).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to use plugin management.",
    });
    expect(listPlugins).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
