import { expect, test } from "vitest";
import { createDaemonTestContext } from "../test-utils/index.js";
import { MockLoadTestAgentClient } from "../agent/providers/mock-load-test-agent.js";
import type { AgentSnapshotPayload } from "../messages.js";

test("creation never regresses a running subscription to the pre-prompt idle snapshot", async () => {
  const ctx = await createDaemonTestContext({
    agentClients: { mock: new MockLoadTestAgentClient() },
    mcpEnabled: false,
    isDev: true,
  });
  try {
    const workspace = await ctx.client.createWorkspace({
      source: { kind: "directory", path: ctx.daemon.staticDir },
    });
    if (!workspace.workspace) throw new Error(workspace.error ?? "Missing workspace");
    const observations: {
      list: string;
      kind: string;
      agent?: AgentSnapshotPayload;
      agentId?: string;
    }[] = [];
    for (const [list, statuses] of [
      ["running", ["running", "initializing", "error"]],
      ["done", ["idle", "closed"]],
    ] as const) {
      const result = await ctx.client.fetchAgents({
        filter: { statuses: [...statuses] },
        subscribe: {},
      });
      result.subscription.subscribe({
        snapshot() {},
        update(message) {
          observations.push({ list, ...message.payload });
        },
      });
    }
    const agent = await ctx.client.createAgent({
      workspaceId: workspace.workspace.id,
      provider: "mock",
      cwd: ctx.daemon.staticDir,
      initialPrompt: "Work on this task",
    });
    await expect
      .poll(() => observations.filter((row) => row.agent?.id === agent.id).length)
      .toBeGreaterThan(1);
    // Fetching provides a round trip after creation so its queued update reaches the client.
    expect((await ctx.client.fetchAgent({ agentId: agent.id }))?.agent.status).toBe("running");
    const relevant = observations.filter(
      (row) => row.agent?.id === agent.id || row.agentId === agent.id,
    );
    const firstRunning = relevant.findIndex((row) => row.agent?.status === "running");
    expect(firstRunning).toBeGreaterThanOrEqual(0);
    expect(
      relevant.slice(firstRunning).filter((row) => row.list === "done" && row.kind === "upsert"),
    ).toEqual([]);
    const timestamps = relevant.flatMap((row) =>
      row.agent ? [Date.parse(row.agent.updatedAt)] : [],
    );
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  } finally {
    await ctx.cleanup();
  }
}, 60_000);
