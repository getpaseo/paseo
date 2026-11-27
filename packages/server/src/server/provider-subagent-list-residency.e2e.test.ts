import { expect, test } from "vitest";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

// #9295 / #10450: on reconnect the app lists provider subagents for every chat it tracks.
// Listing must not start a provider runtime for an agent the daemon has closed.
test("listing provider subagents does not resume a closed parent agent", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.17.5",
  });
  try {
    await client.connect();
    const workspace = (
      await client.createWorkspace({ source: { kind: "directory", path: daemon.staticDir } })
    ).workspace;
    if (!workspace) throw new Error("Workspace creation failed");
    const agent = await client.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      workspaceId: workspace.id,
    });
    await daemon.daemon.agentManager.closeAgent(agent.id);
    expect(daemon.daemon.agentManager.getAgent(agent.id)).toBeNull();

    await client.listProviderSubagents(agent.id);

    expect(daemon.daemon.agentManager.getAgent(agent.id)).toBeNull();
  } finally {
    await client.close();
    await daemon.close();
  }
});
