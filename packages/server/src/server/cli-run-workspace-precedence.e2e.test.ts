import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";

// The daemon-level workspace contract that `paseo run` depends on: each
// local-backed createWorkspace for a cwd mints a fresh, distinct workspace,
// createAgent stamps the agent with the workspaceId it is given, and attaching
// to an existing workspace by id creates no new record. The CLI's own flag
// precedence (--workspace > $PASEO_WORKSPACE_ID > --worktree > bare) is covered
// in packages/cli/src/commands/agent/run.test.ts; this test only proves the
// daemon behaviors the CLI builds on.

async function workspaceIds(client: DaemonClient): Promise<Set<string>> {
  const workspaces = await client.fetchWorkspaces();
  return new Set(workspaces.entries.map((entry) => entry.id));
}

async function mintLocalWorkspace(client: DaemonClient, cwd: string): Promise<string> {
  const result = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
  if (!result.workspace) {
    throw new Error(result.error ?? "Failed to create workspace");
  }
  return result.workspace.id;
}

test("daemon mints a distinct local workspace per run and stamps agents by id", async () => {
  const daemon = await createTestPaseoDaemon();
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-cwd-"));
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "test" } });

    // A bare run mints a fresh local workspace for the cwd, then the agent is
    // stamped with that workspace's id.
    const firstWorkspaceId = await mintLocalWorkspace(client, cwd);

    const firstAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      workspaceId: firstWorkspaceId,
      title: "First run agent",
    });
    expect(firstAgent.workspaceId).toBe(firstWorkspaceId);
    expect(await workspaceIds(client)).toContain(firstWorkspaceId);

    const fetchedFirst = await client.fetchAgent(firstAgent.id);
    expect(fetchedFirst?.agent.workspaceId).toBe(firstWorkspaceId);

    // A second bare run in the SAME cwd mints a DISTINCT workspace; each run
    // owns its own workspace rather than reattaching to the first.
    const secondWorkspaceId = await mintLocalWorkspace(client, cwd);
    expect(secondWorkspaceId).not.toBe(firstWorkspaceId);

    const secondAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      workspaceId: secondWorkspaceId,
      title: "Second run agent",
    });
    expect(secondAgent.workspaceId).toBe(secondWorkspaceId);
    expect(secondAgent.workspaceId).not.toBe(firstAgent.workspaceId);

    const idsAfterTwoMints = await workspaceIds(client);
    expect(idsAfterTwoMints).toContain(firstWorkspaceId);
    expect(idsAfterTwoMints).toContain(secondWorkspaceId);

    // Attaching to an existing workspace by id (how --workspace and
    // $PASEO_WORKSPACE_ID land a run) creates no new workspace record: the
    // agent lands in the named workspace and the workspace set is unchanged.
    const idsBeforeAttach = await workspaceIds(client);
    const attachedAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      workspaceId: firstWorkspaceId,
      title: "Attached agent",
    });
    expect(attachedAgent.workspaceId).toBe(firstWorkspaceId);
    expect(await workspaceIds(client)).toEqual(idsBeforeAttach);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);
