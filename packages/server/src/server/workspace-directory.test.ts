import { describe, expect, test } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestLogger } from "../test-utils/test-logger.js";
import type { AgentSnapshotPayload, WorkspaceDescriptorPayload } from "./messages.js";
import { WorkspaceDirectory } from "./workspace-directory.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "./workspace-registry.js";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";

const NOW = "2026-03-01T12:00:00.000Z";

class WorkspaceStatus {
  private readonly project: PersistedProjectRecord = {
    projectId: "project-1",
    rootPath: "/workspace/project",
    kind: "git",
    displayName: "project",
    customName: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  };

  private readonly workspace: PersistedWorkspaceRecord = {
    workspaceId: "workspace-1",
    projectId: this.project.projectId,
    cwd: this.project.rootPath,
    kind: "local_checkout",
    displayName: "main",
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  };

  private readonly worktreeWorkspace: PersistedWorkspaceRecord = {
    workspaceId: "workspace-worktree",
    projectId: this.project.projectId,
    cwd: "/workspace/project/.paseo/worktrees/feature",
    kind: "worktree",
    displayName: "feature",
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  };

  // Second workspace sharing the SAME cwd as `workspace`. Created later so the
  // deterministic-oldest fallback never attributes a stamped agent to it by cwd.
  private readonly sameCwdWorkspace: PersistedWorkspaceRecord = {
    workspaceId: "workspace-1-sibling",
    projectId: this.project.projectId,
    cwd: this.project.rootPath,
    kind: "local_checkout",
    displayName: "main-2",
    createdAt: "2026-03-02T12:00:00.000Z",
    updatedAt: "2026-03-02T12:00:00.000Z",
    archivedAt: null,
  };

  private readonly workspaces = [this.workspace];

  private readonly agents: AgentSnapshotPayload[] = [];
  private readonly terminals: Array<{
    cwd: string;
    workspaceId?: string;
    activity: TerminalActivity | null;
  }> = [];
  private readonly directory = new WorkspaceDirectory({
    logger: createTestLogger(),
    projectRegistry: { list: async () => [this.project] },
    workspaceRegistry: { list: async () => this.workspaces },
    listAgentPayloads: async () => this.agents,
    listTerminalActivityContributions: async () => this.terminals,
    isProviderVisibleToClient: () => true,
    buildWorkspaceDescriptor: async ({ workspace }) => ({
      id: workspace.workspaceId,
      projectId: workspace.projectId,
      projectDisplayName: "project",
      projectCustomName: null,
      projectRootPath: this.project.rootPath,
      workspaceDirectory: workspace.cwd,
      projectKind: "git",
      workspaceKind: workspace.kind,
      name: workspace.displayName,
      archivingAt: null,
      status: "done",
      activityAt: null,
      diffStat: null,
      scripts: [],
      gitRuntime: null,
      githubRuntime: null,
    }),
  });

  hasRootAgent(input: AgentState): void {
    this.agents.push(createAgent({ ...input, cwd: this.workspace.cwd }));
  }

  hasSiblingWorkspaceSameCwd(): void {
    this.workspaces.push(this.sameCwdWorkspace);
  }

  // A root agent owned by a specific workspace, even though both same-cwd
  // workspaces share the directory. Attribution must follow workspaceId.
  hasStampedRootAgent(input: AgentState & { workspaceId: string }): void {
    this.agents.push(
      createAgent({ ...input, cwd: this.workspace.cwd, workspaceId: input.workspaceId }),
    );
  }

  hasDelegatedAgent(input: AgentState): void {
    this.agents.push(
      createAgent({
        ...input,
        cwd: this.workspace.cwd,
        labels: { [PARENT_AGENT_ID_LABEL]: "parent-agent" },
      }),
    );
  }

  hasWorktreeWorkspace(): void {
    this.workspaces.push(this.worktreeWorkspace);
  }

  hasDelegatedAgentInWorktree(input: AgentState): void {
    this.agents.push(
      createAgent({
        ...input,
        cwd: this.worktreeWorkspace.cwd,
        labels: { [PARENT_AGENT_ID_LABEL]: "parent-agent" },
      }),
    );
  }

  async workspaceStatus(): Promise<WorkspaceDescriptorPayload["status"]> {
    const entries = await this.directory.listFetchEntries({
      type: "fetch_workspaces_request",
      requestId: "workspace-status",
    });
    return entries.entries[0]?.status ?? "done";
  }

  async workspaceStatuses(): Promise<Record<string, WorkspaceDescriptorPayload["status"]>> {
    const entries = await this.directory.listFetchEntries({
      type: "fetch_workspaces_request",
      requestId: "workspace-statuses",
    });
    return Object.fromEntries(entries.entries.map((entry) => [entry.id, entry.status]));
  }

  hasWorkingTerminal(changedAt: number): void {
    this.terminals.push({
      cwd: this.workspace.cwd,
      activity: { state: "working", changedAt },
    });
  }

  // A working terminal owned by a specific same-cwd workspace. Attribution must
  // follow workspaceId, not the deterministic-oldest cwd fallback.
  hasStampedWorkingTerminal(input: { workspaceId: string; changedAt: number }): void {
    this.terminals.push({
      cwd: this.workspace.cwd,
      workspaceId: input.workspaceId,
      activity: { state: "working", changedAt: input.changedAt },
    });
  }

  hasWorkingTerminalInSubdirectory(changedAt: number): void {
    this.terminals.push({
      cwd: `${this.workspace.cwd}/packages/app`,
      activity: { state: "working", changedAt },
    });
  }

  hasIdleTerminal(changedAt: number): void {
    this.terminals.push({
      cwd: this.workspace.cwd,
      activity: { state: "idle", changedAt },
    });
  }

  hasFinishedTerminal(changedAt: number): void {
    this.terminals.push({
      cwd: this.workspace.cwd,
      activity: { state: "idle", attentionReason: "finished", changedAt },
    });
  }

  hasUnknownTerminal(): void {
    this.terminals.push({
      cwd: this.workspace.cwd,
      activity: null,
    });
  }

  async workspaceDescriptor(): Promise<WorkspaceDescriptorPayload> {
    const entries = await this.directory.listFetchEntries({
      type: "fetch_workspaces_request",
      requestId: "workspace-descriptor",
    });
    const entry = entries.entries[0];
    if (!entry) {
      throw new Error("No workspace descriptor found");
    }
    return entry;
  }
}

interface AgentState {
  id: string;
  status: AgentSnapshotPayload["status"];
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentSnapshotPayload["attentionReason"];
}

function createAgent(
  input: AgentState & { cwd: string; labels?: Record<string, string>; workspaceId?: string },
) {
  const pendingPermissionCount = input.pendingPermissionCount ?? 0;
  return {
    id: input.id,
    provider: "codex",
    cwd: input.cwd,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    model: null,
    thinkingOptionId: null,
    effectiveThinkingOptionId: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastUserMessageAt: null,
    status: input.status,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: Array.from({ length: pendingPermissionCount }, (_, index) => ({
      id: `permission-${input.id}-${index}`,
      provider: "codex",
      name: "tool",
      kind: "tool" as const,
    })),
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: null,
    },
    title: null,
    labels: input.labels ?? {},
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: input.attentionReason ?? null,
    attentionTimestamp: null,
    archivedAt: null,
  } satisfies AgentSnapshotPayload;
}

describe("WorkspaceDirectory", () => {
  test("uses root agent activity, not delegated child activity, for workspace status", async () => {
    const workspace = new WorkspaceStatus();

    workspace.hasRootAgent({ id: "root-agent", status: "running" });
    workspace.hasDelegatedAgent({
      id: "child-needs-input",
      status: "idle",
      pendingPermissionCount: 1,
    });
    workspace.hasDelegatedAgent({
      id: "child-error",
      status: "error",
      requiresAttention: true,
      attentionReason: "error",
    });

    await expect(workspace.workspaceStatus()).resolves.toBe("running");
  });

  test("two same-cwd workspaces keep independent status, attributed by workspaceId", async () => {
    const workspace = new WorkspaceStatus();

    workspace.hasSiblingWorkspaceSameCwd();
    // The running agent is stamped to the SIBLING. A cwd-only fallback would
    // attribute it to the older `workspace-1` and leave the sibling "done", so
    // this asserts the running status follows workspaceId, not directory.
    workspace.hasStampedRootAgent({
      id: "agent-a",
      status: "running",
      workspaceId: "workspace-1-sibling",
    });
    workspace.hasStampedRootAgent({
      id: "agent-b",
      status: "idle",
      workspaceId: "workspace-1",
    });

    await expect(workspace.workspaceStatuses()).resolves.toEqual({
      "workspace-1": "done",
      "workspace-1-sibling": "running",
    });
  });

  test("two same-cwd workspaces keep independent terminal status, attributed by workspaceId", async () => {
    const workspace = new WorkspaceStatus();
    const changedAt = new Date(NOW).getTime();

    workspace.hasSiblingWorkspaceSameCwd();
    // The working terminal is owned by the SIBLING. A cwd-only resolver would
    // attribute it to the older `workspace-1`, so this asserts the running
    // status follows the terminal's workspaceId, not the directory.
    workspace.hasStampedWorkingTerminal({ workspaceId: "workspace-1-sibling", changedAt });

    await expect(workspace.workspaceStatuses()).resolves.toEqual({
      "workspace-1": "done",
      "workspace-1-sibling": "running",
    });
  });

  test("running delegated child contributes running to the parent workspace, not its worktree", async () => {
    const workspace = new WorkspaceStatus();

    workspace.hasWorktreeWorkspace();
    workspace.hasRootAgent({ id: "parent-agent", status: "idle" });
    workspace.hasDelegatedAgentInWorktree({ id: "child-agent", status: "running" });

    await expect(workspace.workspaceStatuses()).resolves.toEqual({
      "workspace-1": "running",
      "workspace-worktree": "done",
    });
  });

  test("working terminal contributes running status, beating done", async () => {
    const workspace = new WorkspaceStatus();
    const changedAt = new Date(NOW).getTime();

    workspace.hasWorkingTerminal(changedAt);

    await expect(workspace.workspaceStatus()).resolves.toBe("running");
  });

  test("working terminal in a subdirectory contributes to the parent workspace", async () => {
    const workspace = new WorkspaceStatus();
    const changedAt = new Date(NOW).getTime();

    workspace.hasWorkingTerminalInSubdirectory(changedAt);

    await expect(workspace.workspaceStatus()).resolves.toBe("running");
  });

  test("finished terminal contributes attention to workspace status", async () => {
    const workspace = new WorkspaceStatus();
    const changedAt = new Date(NOW).getTime();

    workspace.hasFinishedTerminal(changedAt);

    await expect(workspace.workspaceStatus()).resolves.toBe("attention");
  });

  test("idle terminal contributes nothing to workspace status", async () => {
    const workspace = new WorkspaceStatus();
    const changedAt = new Date(NOW).getTime();

    workspace.hasIdleTerminal(changedAt);

    await expect(workspace.workspaceStatus()).resolves.toBe("done");
  });

  test("unknown terminal contributes nothing to workspace status", async () => {
    const workspace = new WorkspaceStatus();

    workspace.hasUnknownTerminal();

    await expect(workspace.workspaceStatus()).resolves.toBe("done");
  });

  test("working terminal does not override a higher-priority needs_input agent", async () => {
    const workspace = new WorkspaceStatus();
    const changedAt = new Date(NOW).getTime();

    workspace.hasRootAgent({ id: "agent-needs-input", status: "idle", pendingPermissionCount: 1 });
    workspace.hasWorkingTerminal(changedAt);

    await expect(workspace.workspaceStatus()).resolves.toBe("needs_input");
  });

  test("working terminal statusEnteredAt uses terminal changedAt", async () => {
    const workspace = new WorkspaceStatus();
    const changedAt = new Date("2026-05-01T10:00:00.000Z").getTime();

    workspace.hasWorkingTerminal(changedAt);

    const descriptor = await workspace.workspaceDescriptor();
    expect(descriptor.status).toBe("running");
    expect(descriptor.statusEnteredAt).toBe("2026-05-01T10:00:00.000Z");
  });

  test("statusEnteredAt picks the newest between agent updatedAt and terminal changedAt", async () => {
    const workspace = new WorkspaceStatus();
    // The createAgent helper uses NOW for updatedAt; use a terminal timestamp
    // that is newer to confirm it wins.
    const terminalChangedAt = new Date("2027-01-01T00:00:00.000Z").getTime();

    workspace.hasRootAgent({ id: "running-agent", status: "running" });
    workspace.hasWorkingTerminal(terminalChangedAt);

    const descriptor = await workspace.workspaceDescriptor();
    expect(descriptor.status).toBe("running");
    // terminal timestamp (2027) is newer than agent updatedAt (NOW = 2026-03-01)
    expect(descriptor.statusEnteredAt).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("WorkspaceDirectory empty projects", () => {
  function makeDirectory(input: {
    projects: PersistedProjectRecord[];
    workspaces: PersistedWorkspaceRecord[];
  }): WorkspaceDirectory {
    return new WorkspaceDirectory({
      logger: createTestLogger(),
      projectRegistry: { list: async () => input.projects },
      workspaceRegistry: { list: async () => input.workspaces },
      listAgentPayloads: async () => [],
      listTerminalActivityContributions: async () => [],
      isProviderVisibleToClient: () => true,
      buildWorkspaceDescriptor: async ({ workspace }) => ({
        id: workspace.workspaceId,
        projectId: workspace.projectId,
        projectDisplayName: "project",
        projectCustomName: null,
        projectRootPath: "/workspace/project",
        workspaceDirectory: workspace.cwd,
        projectKind: "non_git",
        workspaceKind: workspace.kind,
        name: workspace.displayName,
        archivingAt: null,
        status: "done",
        activityAt: null,
        diffStat: null,
        gitRuntime: null,
        githubRuntime: null,
      }),
    });
  }

  function project(input: Partial<PersistedProjectRecord> & { projectId: string }) {
    return {
      rootPath: `/workspace/${input.projectId}`,
      kind: "non_git",
      displayName: input.projectId,
      customName: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      ...input,
    } satisfies PersistedProjectRecord;
  }

  test("surfaces a project with no active workspaces as an empty project", async () => {
    const directory = makeDirectory({
      projects: [project({ projectId: "empty", customName: "Renamed" })],
      workspaces: [],
    });

    const result = await directory.listFetchEntries({
      type: "fetch_workspaces_request",
      requestId: "r1",
    });

    expect(result.entries).toEqual([]);
    expect(result.emptyProjects).toEqual([
      {
        projectId: "empty",
        projectDisplayName: "Renamed",
        projectCustomName: "Renamed",
        projectRootPath: "/workspace/empty",
        projectKind: "non_git",
      },
    ]);
  });

  test("excludes projects that still have an active workspace", async () => {
    const directory = makeDirectory({
      projects: [project({ projectId: "with-ws" }), project({ projectId: "empty" })],
      workspaces: [
        {
          workspaceId: "ws-1",
          projectId: "with-ws",
          cwd: "/workspace/with-ws",
          kind: "directory",
          displayName: "main",
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
        },
      ],
    });

    const result = await directory.listFetchEntries({
      type: "fetch_workspaces_request",
      requestId: "r1",
    });

    expect(result.emptyProjects.map((p) => p.projectId)).toEqual(["empty"]);
  });
});
