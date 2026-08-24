import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

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

test("daemon resolves human and managed CLI workspace ownership", async () => {
  const daemon = await createTestPaseoDaemon();
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-cwd-"));
  const otherCwd = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-other-cwd-"));
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

    const fetchedFirst = await client.fetchAgent({ agentId: firstAgent.id });
    expect(fetchedFirst?.agent.workspaceId).toBe(firstWorkspaceId);

    // A second bare run mints a distinct workspace with its own authoritative cwd.
    const secondWorkspaceId = await mintLocalWorkspace(client, otherCwd);
    expect(secondWorkspaceId).not.toBe(firstWorkspaceId);

    const secondAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: otherCwd,
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
      cwd: path.join(otherCwd, "stale-client-directory"),
      workspaceId: firstWorkspaceId,
      title: "Attached agent",
    });
    expect(attachedAgent.workspaceId).toBe(firstWorkspaceId);
    expect(attachedAgent.cwd).toBe(cwd);
    expect(await workspaceIds(client)).toEqual(idsBeforeAttach);

    await expect(
      client.createAgent({
        ...getFullAccessConfig("codex"),
        cwd,
        workspaceId: "wks_missing",
        title: "Missing workspace agent",
      }),
    ).rejects.toThrow("Workspace wks_missing not found");

    const sameWorkspaceChild = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: otherCwd,
      callerAgentId: firstAgent.id,
      title: "Same workspace child",
    });
    expect(sameWorkspaceChild.workspaceId).toBe(firstWorkspaceId);
    expect(sameWorkspaceChild.cwd).toBe(firstAgent.cwd);
    expect(sameWorkspaceChild.labels[PARENT_AGENT_ID_LABEL]).toBe(firstAgent.id);
    expect(await workspaceIds(client)).toEqual(idsBeforeAttach);

    const crossWorkspaceChild = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      workspaceId: secondWorkspaceId,
      callerAgentId: firstAgent.id,
      title: "Cross workspace child",
    });
    expect(crossWorkspaceChild.workspaceId).toBe(secondWorkspaceId);
    expect(crossWorkspaceChild.cwd).toBe(otherCwd);
    expect(crossWorkspaceChild.labels[PARENT_AGENT_ID_LABEL]).toBe(firstAgent.id);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  }
}, 180000);
