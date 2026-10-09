import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("closing and archiving agents publish their distinct lifecycle hooks once", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-archive-hooks-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(
      fileURLToPath(new URL("../../../../../plugin-examples/lifecycle-logger", import.meta.url)),
    );
    const created = await client.createWorkspace({
      source: { kind: "directory", path: directory },
    });
    expect(created.error).toBeNull();
    const workspace = created.workspace!;
    const live = await client.createAgent({
      provider: "claude",
      cwd: directory,
      workspaceId: workspace.id,
    });
    const closed = await client.createAgent({
      provider: "claude",
      cwd: directory,
      workspaceId: workspace.id,
    });
    await daemon.daemon.agentManager.closeAgent(closed.id);
    await daemon.daemon.agentManager.closeAgent(closed.id);
    expect(daemon.daemon.agentManager.getAgent(closed.id)).toBeNull();
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("lifecycle-logger");
        return logs
          .filter((entry) => entry.message.startsWith('{"hook":"agent.closed"'))
          .map((entry) => JSON.parse(entry.message).data.agent.id);
      })
      .toEqual([closed.id]);
    await client.archiveWorkspace(workspace.id);
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("lifecycle-logger");
        return logs
          .filter((entry) => {
            return entry.message.startsWith('{"hook":"agent.archived"');
          })
          .map((entry) => {
            return JSON.parse(entry.message).data.agent.id;
          })
          .sort();
      })
      .toEqual([live.id, closed.id].sort());
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("lifecycle-logger");
        return logs
          .filter((entry) => entry.message.startsWith('{"hook":"agent.closed"'))
          .map((entry) => JSON.parse(entry.message).data.agent.id)
          .sort();
      })
      .toEqual([live.id, closed.id].sort());
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("daemon shutdown lets agent close hooks finish before stopping plugins", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-close-hook-shutdown-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const completedFile = path.join(directory, "closed.txt");
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "close-hook-shutdown", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
export default function contribute(server) {
  server.on("agent.closed", async (event, context) => {
    await setTimeout(200, undefined, { signal: context.signal });
    await writeFile(${JSON.stringify(completedFile)}, event.agent.id);
  });
  return () => {};
}`,
    );
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const agent = await client.createAgent({ provider: "claude", cwd: directory });
    await daemon.close();
    expect(await readFile(completedFile, "utf8")).toBe(agent.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
