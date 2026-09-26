import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import contribute from "./test-fixtures/internal-seam/index.server.js";

const directory = fileURLToPath(new URL("./test-fixtures/internal-seam/", import.meta.url));

test("internal and directory plugins share RPC and lifecycle behavior while internal plugins stay hidden and enabled", async () => {
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "paseo-internal-seam-"));
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.8.0",
    pluginsEnabled: false,
    internalPlugins: [{ id: "internal-seam", directory, contribute }],
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await client.connect();
    expect(await client.listPlugins()).toEqual([]);
    expect(await client.invokePluginRpc("internal-seam", "state", {})).toEqual({ workspaces: 0 });
    expect((await client.getPluginLogs("internal-seam")).map(({ message }) => message)).toContain(
      "[paseo] Plugin ready",
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory, "directory-seam");
    expect((await client.listPlugins()).map(({ id }) => id)).toEqual(["directory-seam"]);
    expect(await client.invokePluginRpc("directory-seam", "state", {})).toEqual({ workspaces: 0 });
    await client.createWorkspace({
      idempotencyKey: "internal-seam-workspace",
      source: { kind: "directory", path: workspaceDirectory },
    });
    await expect
      .poll(() => client.invokePluginRpc("internal-seam", "state", {}))
      .toEqual({ workspaces: 1 });
    await expect
      .poll(() => client.invokePluginRpc("directory-seam", "state", {}))
      .toEqual({ workspaces: 1 });
    await expect
      .poll(async () =>
        (await client.getPluginLogs("internal-seam")).some(
          ({ message }) => message === "workspace created by seam fixture",
        ),
      )
      .toBe(true);
    await client.patchDaemonConfig({ pluginsEnabled: false });
    expect(await client.invokePluginRpc("internal-seam", "state", {})).toEqual({ workspaces: 1 });
    expect(await client.listPlugins()).toMatchObject([
      { id: "directory-seam", status: "disabled" },
    ]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(workspaceDirectory, { recursive: true, force: true });
  }
}, 60_000);
