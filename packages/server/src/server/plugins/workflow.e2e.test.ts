import path from "node:path";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("the first-party workflow compiles in a real subprocess and installs profiles only by explicit RPC", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const custom = {
    id: "paseo-workflow-router",
    name: "My Router",
    provider: "codex",
    model: "custom-model",
    foreign: { preserve: true },
  };
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true, agentProfiles: [custom] });
    await client.installDirectoryPlugin(path.resolve("plugins/paseo-workflow"));
    expect((await client.getDaemonConfig()).config.agentProfiles).toEqual([custom]);
    const result = await client.invokePluginRpc(
      "paseo-workflow",
      "workflow.profiles.install.request",
      {},
    );
    expect(result).toMatchObject({ type: "workflow.profiles.install.response", count: 9 });
    expect((await client.getDaemonConfig()).config.agentProfiles?.[0]).toEqual(custom);
    await client.reloadPlugin("paseo-workflow");
    await client.invokePluginRpc("paseo-workflow", "workflow.profiles.install.request", {});
    expect((await client.getDaemonConfig()).config.agentProfiles).toHaveLength(9);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
