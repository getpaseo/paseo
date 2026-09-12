import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PluginAttachmentSearchPayloadSchema } from "@getpaseo/plugin";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("the agent context example snapshots a real daemon timeline through its plugin RPC", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-agent-context-"));
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.8.0",
    agentClients: { codex: createTestAgentClient("codex") },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.8.0",
  });

  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(
      fileURLToPath(new URL("../../../../../plugin-examples/agent-context", import.meta.url)),
    );
    const created = await client.createWorkspace({
      source: { kind: "directory", path: directory },
      title: "Snapshot workspace",
    });
    expect(created.error).toBeNull();
    const workspace = created.workspace!;
    const agent = await client.createAgent({
      provider: "codex",
      cwd: workspace.workspaceDirectory,
      workspaceId: workspace.id,
      title: "Snapshot source",
    });
    await client.sendMessage(agent.id, "Respond with exactly: SNAPSHOT_READY");
    await client.waitForFinish(agent.id);

    const output = PluginAttachmentSearchPayloadSchema.parse(
      await client.invokePluginRpc("agent-context", "agent-context.search", {
        query: "snapshot source",
      }),
    );

    expect(output.items).toHaveLength(1);
    expect(output.items[0]).toMatchObject({
      id: agent.id,
      title: "Snapshot source",
      resourceType: "agent transcript",
    });
    expect(output.items[0]?.subtitle).toContain("Snapshot workspace");
    expect(output.items[0]?.subtitle).toContain(path.basename(directory));
    expect(output.items[0]?.text).toContain("[User] Respond with exactly: SNAPSHOT_READY");
    expect(output.items[0]?.text).toContain("[Assistant] SNAPSHOT_READY");
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
