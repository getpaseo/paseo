/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import type { DaemonClient } from "@server/client/daemon-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { useVisibleSidebarSessionFilterProjects } from "./use-sidebar-session-workspaces";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

const TIMESTAMP = new Date("2026-05-08T10:00:00.000Z");

const WORKSPACE: WorkspaceDescriptor = {
  id: "workspace-1",
  projectId: "project-a",
  projectDisplayName: "Project A",
  projectRootPath: "/abs/path/to/repo",
  workspaceDirectory: "/abs/path/to/repo",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "feat-foo",
  status: "done",
  archivingAt: null,
  diffStat: null,
  scripts: [],
};

const AGENT: Agent = {
  serverId: "server-1",
  id: "agent-1",
  provider: "codex",
  status: "idle",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: TIMESTAMP,
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
  pendingPermissions: [],
  persistence: null,
  runtimeInfo: undefined,
  lastUsage: undefined,
  lastError: null,
  title: "Agent",
  cwd: "/abs/path/to/repo",
  model: null,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  labels: {},
  projectPlacement: null,
};

const PROJECTS: SidebarProjectEntry[] = [
  {
    projectKey: "project-a",
    projectName: "Project A",
    projectKind: "git",
    iconWorkingDir: "/abs/path/to/repo",
    workspaces: [
      {
        workspaceKey: "server-1:workspace-1",
        serverId: "server-1",
        workspaceId: "workspace-1",
        projectKey: "project-a",
        projectRootPath: "/abs/path/to/repo",
        workspaceDirectory: "/abs/path/to/repo",
        projectKind: "git",
        workspaceKind: "worktree",
        name: "/abs/path/to/repo",
        statusBucket: "done",
        archivingAt: null,
        diffStat: null,
        scripts: [],
        hasRunningScripts: false,
      },
    ],
  },
];

afterEach(() => {
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
});

describe("useVisibleSidebarSessionFilterProjects", () => {
  it("returns projects with mapped active sessions", () => {
    act(() => {
      useSessionStore.getState().initializeSession("server-1", {} as unknown as DaemonClient);
      useSessionStore.getState().setWorkspaces("server-1", new Map([["workspace-1", WORKSPACE]]));
      useSessionStore.getState().setAgents("server-1", new Map([["agent-1", AGENT]]));
    });

    const { result } = renderHook(() =>
      useVisibleSidebarSessionFilterProjects({
        serverId: "server-1",
        projects: PROJECTS,
      }),
    );

    expect(result.current.map((project) => project.projectKey)).toEqual(["project-a"]);
  });
});
