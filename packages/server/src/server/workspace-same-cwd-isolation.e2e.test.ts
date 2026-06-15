import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { getAskModeConfig } from "./daemon-e2e/agent-configs.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";

const WORKSPACE_A = "wks_same_cwd_a";
const WORKSPACE_B = "wks_same_cwd_b";

// Seed two active workspaces that share one cwd, so we can prove Phase 1
// attributes agents, terminals, and status by workspaceId rather than by
// directory. Both registry files must exist on disk before the daemon starts:
// bootstrapWorkspaceRegistries skips materialization when both files are
// present, leaving these seeded records untouched.
function seedSameCwdWorkspaces(): { paseoHomeRoot: string; cwd: string } {
  const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "paseo-same-cwd-home-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-same-cwd-dir-"));
  const projectsDir = path.join(paseoHomeRoot, ".paseo", "projects");
  mkdirSync(projectsDir, { recursive: true });

  const project = createPersistedProjectRecord({
    projectId: "prj_same_cwd",
    rootPath: cwd,
    kind: "non_git",
    displayName: path.basename(cwd),
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  const workspaceA = createPersistedWorkspaceRecord({
    workspaceId: WORKSPACE_A,
    projectId: project.projectId,
    cwd,
    kind: "directory",
    displayName: "workspace-a",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  // Created later so the deterministic-oldest cwd fallback would never pick B:
  // any correct attribution to B must follow the stamped workspaceId.
  const workspaceB = createPersistedWorkspaceRecord({
    workspaceId: WORKSPACE_B,
    projectId: project.projectId,
    cwd,
    kind: "directory",
    displayName: "workspace-b",
    createdAt: "2026-03-02T00:00:00.000Z",
    updatedAt: "2026-03-02T00:00:00.000Z",
  });

  writeFileSync(path.join(projectsDir, "projects.json"), JSON.stringify([project]));
  writeFileSync(
    path.join(projectsDir, "workspaces.json"),
    JSON.stringify([workspaceA, workspaceB]),
  );

  return { paseoHomeRoot, cwd };
}

async function statusByWorkspaceId(client: DaemonClient): Promise<Map<string, string>> {
  const workspaces = await client.fetchWorkspaces();
  return new Map(workspaces.entries.map((entry) => [entry.id, entry.status]));
}

test("two workspaces sharing one cwd stay isolated by workspaceId", async () => {
  const { paseoHomeRoot, cwd } = seedSameCwdWorkspaces();
  const daemon = await createTestPaseoDaemon({ paseoHomeRoot });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();

    // Both seeded workspaces are visible and start with no contributing agents.
    expect(await statusByWorkspaceId(client)).toEqual(
      new Map([
        [WORKSPACE_A, "done"],
        [WORKSPACE_B, "done"],
      ]),
    );

    // 1. Agent created in workspace A carries workspaceId A and only moves A's
    //    status. Ask mode + a write parks the agent on a pending permission,
    //    which is the deterministic "needs_input" signal for A.
    const agentA = await client.createAgent({
      ...getAskModeConfig("codex"),
      cwd,
      workspaceId: WORKSPACE_A,
      title: "Workspace A agent",
    });
    expect(agentA.workspaceId).toBe(WORKSPACE_A);

    await client.sendMessage(
      agentA.id,
      'Use your shell tool to run: `printf "ok" > a.txt`. Request permission and wait.',
    );
    const parkedA = await client.waitForFinish(agentA.id, 60000);
    expect(parkedA.status).toBe("permission");

    const fetchedA = await client.fetchAgent(agentA.id);
    expect(fetchedA?.agent.workspaceId).toBe(WORKSPACE_A);

    expect(await statusByWorkspaceId(client)).toEqual(
      new Map([
        [WORKSPACE_A, "needs_input"],
        [WORKSPACE_B, "done"],
      ]),
    );

    // 2. Terminal created in A is delivered to A's directory subscription and to
    //    A's list, but never to B's — exercises the workspaceId terminal filter.
    const terminalSnapshotsByWorkspace = new Map<string | undefined, Set<string>>();
    const unsubscribeTerminals = client.on("terminals_changed", (message) => {
      if (message.type !== "terminals_changed") {
        return;
      }
      for (const terminal of message.payload.terminals) {
        const seen = terminalSnapshotsByWorkspace.get(terminal.workspaceId) ?? new Set<string>();
        seen.add(terminal.id);
        terminalSnapshotsByWorkspace.set(terminal.workspaceId, seen);
      }
    });

    client.subscribeTerminals({ cwd, workspaceId: WORKSPACE_A });
    client.subscribeTerminals({ cwd, workspaceId: WORKSPACE_B });

    const createdTerminal = await client.createTerminal(cwd, "A terminal", undefined, {
      workspaceId: WORKSPACE_A,
    });
    expect(createdTerminal.terminal?.workspaceId).toBe(WORKSPACE_A);
    const terminalId = createdTerminal.terminal?.id;
    if (!terminalId) {
      throw new Error("Expected a created terminal id");
    }

    // A's directory subscription receives a snapshot attributing the terminal
    // to A. Poll the observed snapshot state instead of sleeping for a fixed
    // window, so the assertion never races the daemon's snapshot push.
    await expect
      .poll(() => terminalSnapshotsByWorkspace.get(WORKSPACE_A)?.has(terminalId) ?? false)
      .toBe(true);
    unsubscribeTerminals();

    // No snapshot ever attributed the terminal to B (the only other same-cwd
    // workspace).
    expect(terminalSnapshotsByWorkspace.get(WORKSPACE_B)?.has(terminalId) ?? false).toBe(false);

    const listForA = await client.listTerminals(cwd, undefined, { workspaceId: WORKSPACE_A });
    expect(listForA.terminals.some((terminal) => terminal.id === terminalId)).toBe(true);

    const listForB = await client.listTerminals(cwd, undefined, { workspaceId: WORKSPACE_B });
    expect(listForB.terminals.some((terminal) => terminal.id === terminalId)).toBe(false);

    // 3. Agent created in workspace B carries workspaceId B and moves only B's
    //    status. A keeps its own pending-permission state independently.
    const agentB = await client.createAgent({
      ...getAskModeConfig("codex"),
      cwd,
      workspaceId: WORKSPACE_B,
      title: "Workspace B agent",
    });
    expect(agentB.workspaceId).toBe(WORKSPACE_B);

    await client.sendMessage(
      agentB.id,
      'Use your shell tool to run: `printf "ok" > b.txt`. Request permission and wait.',
    );
    const parkedB = await client.waitForFinish(agentB.id, 60000);
    expect(parkedB.status).toBe("permission");

    const fetchedB = await client.fetchAgent(agentB.id);
    expect(fetchedB?.agent.workspaceId).toBe(WORKSPACE_B);

    expect(await statusByWorkspaceId(client)).toEqual(
      new Map([
        [WORKSPACE_A, "needs_input"],
        [WORKSPACE_B, "needs_input"],
      ]),
    );

    await client.killTerminal(terminalId);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);
