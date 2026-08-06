import { describe, expect, it, vi } from "vitest";

import { runInstallCommand } from "./install.js";
import { connectPluginClient } from "./shared.js";

const pluginsInstall = vi.fn(
  () => new Promise<never>(() => {}), // an old daemon never answers; the gate must fire first
);
const close = vi.fn(async () => undefined);
let features: Record<string, boolean> = {};

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    getLastServerInfoMessage: () => ({ features }),
    pluginsInstall,
    close,
  })),
  getDaemonHost: vi.fn(() => "localhost:6767"),
}));

describe("connectPluginClient", () => {
  it("rejects a daemon that does not advertise the plugins feature", async () => {
    features = { relayConfig: true };

    await expect(connectPluginClient(undefined)).rejects.toMatchObject({
      code: "PLUGINS_UNSUPPORTED",
      details: expect.stringContaining("Update the daemon"),
    });
    expect(close).toHaveBeenCalled();
  });

  it("returns the client when the daemon advertises plugins", async () => {
    features = { plugins: true };

    const client = await connectPluginClient(undefined);

    expect(client).toBeDefined();
  });
});

describe("plugin commands against an old daemon", () => {
  it("reports the unsupported daemon instead of waiting for an RPC timeout", async () => {
    features = {};
    pluginsInstall.mockClear();

    await expect(runInstallCommand("csv-table", {}, {} as never)).rejects.toMatchObject({
      code: "PLUGINS_UNSUPPORTED",
    });
    expect(pluginsInstall).not.toHaveBeenCalled();
  });
});
