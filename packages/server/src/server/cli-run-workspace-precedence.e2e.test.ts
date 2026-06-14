import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";

// `paseo run` resolves a workspace before creating any agent, then passes that
// workspaceId to createAgent. This mirrors run.ts's resolveRunWorkspace
// precedence (--workspace > $PASEO_WORKSPACE_ID > --worktree > bare-local) so
// the daemon-level contract the CLI depends on stays covered without spawning
// the built binary: explicit ids attach to an existing workspace, while a bare
// run always mints a fresh local workspace for the cwd.
interface RunFlags {
  workspace?: string;
  worktree?: string;
  base?: string;
}

interface ResolvedRunWorkspace {
  id: string;
  cwd: string;
  created: boolean;
}

async function resolveRunWorkspace(
  client: DaemonClient,
  flags: RunFlags,
  env: { PASEO_WORKSPACE_ID?: string },
  cwd: string,
): Promise<ResolvedRunWorkspace> {
  const explicit = flags.worktree
    ? undefined
    : flags.workspace?.trim() || env.PASEO_WORKSPACE_ID?.trim();
  if (explicit) {
    return { id: explicit, cwd, created: false };
  }

  const result = flags.worktree
    ? await client.createWorkspace({
        backing: "worktree",
        cwd,
        branch: flags.worktree,
        baseBranch: flags.base,
      })
    : await client.createWorkspace({ backing: "local", cwd });

  if (!result.workspace) {
    throw new Error(result.error ?? "Failed to create workspace for this run");
  }

  return {
    id: result.workspace.id,
    cwd: result.workspace.workspaceDirectory ?? cwd,
    created: true,
  };
}

async function workspaceIds(client: DaemonClient): Promise<Set<string>> {
  const workspaces = await client.fetchWorkspaces();
  return new Set(workspaces.entries.map((entry) => entry.id));
}

test("paseo run workspace precedence: bare, same-cwd, --workspace, env", async () => {
  const daemon = await createTestPaseoDaemon();
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-cwd-"));
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "test" } });

    // 1. BARE run: no --workspace, no env. Resolution mints a fresh local
    //    workspace for the cwd, then the agent is stamped with that id.
    const bareWorkspace = await resolveRunWorkspace(client, {}, {}, cwd);
    expect(bareWorkspace.created).toBe(true);

    const bareAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: bareWorkspace.cwd,
      workspaceId: bareWorkspace.id,
      title: "Bare run agent",
    });
    expect(bareAgent.workspaceId).toBe(bareWorkspace.id);

    // The workspace the run created is real and visible.
    expect(await workspaceIds(client)).toContain(bareWorkspace.id);

    const fetchedBare = await client.fetchAgent(bareAgent.id);
    expect(fetchedBare?.agent.workspaceId).toBe(bareWorkspace.id);

    // 2. A SECOND bare run in the SAME cwd mints a DISTINCT workspace; each
    //    bare run owns its own workspace rather than reattaching to the first.
    const secondBareWorkspace = await resolveRunWorkspace(client, {}, {}, cwd);
    expect(secondBareWorkspace.created).toBe(true);
    expect(secondBareWorkspace.id).not.toBe(bareWorkspace.id);

    const secondBareAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: secondBareWorkspace.cwd,
      workspaceId: secondBareWorkspace.id,
      title: "Second bare run agent",
    });
    expect(secondBareAgent.workspaceId).toBe(secondBareWorkspace.id);
    expect(secondBareAgent.workspaceId).not.toBe(bareAgent.workspaceId);

    const idsAfterTwoBare = await workspaceIds(client);
    expect(idsAfterTwoBare).toContain(bareWorkspace.id);
    expect(idsAfterTwoBare).toContain(secondBareWorkspace.id);

    // 3. --workspace <id>: resolution attaches to an existing workspace and
    //    creates nothing new. The next agent lands in the first bare workspace.
    const idsBeforeAttach = await workspaceIds(client);
    const explicitWorkspace = await resolveRunWorkspace(
      client,
      { workspace: bareWorkspace.id },
      {},
      cwd,
    );
    expect(explicitWorkspace.created).toBe(false);
    expect(explicitWorkspace.id).toBe(bareWorkspace.id);

    const attachedAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      workspaceId: explicitWorkspace.id,
      title: "Attached via --workspace",
    });
    expect(attachedAgent.workspaceId).toBe(bareWorkspace.id);
    // No new workspace record was created by the attach.
    expect(await workspaceIds(client)).toEqual(idsBeforeAttach);

    // 4. $PASEO_WORKSPACE_ID: same attach behavior, sourced from the env.
    const idsBeforeEnv = await workspaceIds(client);
    const envWorkspace = await resolveRunWorkspace(
      client,
      {},
      { PASEO_WORKSPACE_ID: secondBareWorkspace.id },
      cwd,
    );
    expect(envWorkspace.created).toBe(false);
    expect(envWorkspace.id).toBe(secondBareWorkspace.id);

    const envAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      workspaceId: envWorkspace.id,
      title: "Attached via env",
    });
    expect(envAgent.workspaceId).toBe(secondBareWorkspace.id);
    expect(await workspaceIds(client)).toEqual(idsBeforeEnv);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);
