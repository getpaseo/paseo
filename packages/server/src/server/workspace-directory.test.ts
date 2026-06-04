import { describe, expect, test } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestLogger } from "../test-utils/test-logger.js";
import type { AgentSnapshotPayload, WorkspaceDescriptorPayload } from "./messages.js";
import { WorkspaceDirectory } from "./workspace-directory.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "./workspace-registry.js";

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

  private readonly workspaces = [this.workspace];

  private readonly agents: AgentSnapshotPayload[] = [];
  private readonly directory = new WorkspaceDirectory({
    logger: createTestLogger(),
    projectRegistry: { list: async () => [this.project] },
    workspaceRegistry: { list: async () => this.workspaces },
    listAgentPayloads: async () => this.agents,
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
}

interface AgentState {
  id: string;
  status: AgentSnapshotPayload["status"];
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentSnapshotPayload["attentionReason"];
}

function createAgent(input: AgentState & { cwd: string; labels?: Record<string, string> }) {
  const pendingPermissionCount = input.pendingPermissionCount ?? 0;
  return {
    id: input.id,
    provider: "codex",
    cwd: input.cwd,
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
});
