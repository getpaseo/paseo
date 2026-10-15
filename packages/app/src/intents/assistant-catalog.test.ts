import { describe, expect, it } from "vitest";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { buildAssistantCatalog } from "./assistant-catalog";

function agent(overrides: Partial<Agent> & Pick<Agent, "id" | "lastActivityAt">): Agent {
  return {
    serverId: "laptop",
    provider: "claude",
    status: "idle",
    turn: "idle",
    createdAt: new Date(0),
    updatedAt: overrides.lastActivityAt,
    lastUserMessageAt: null,
    capabilities: {} as Agent["capabilities"],
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/home/me/paseo",
    model: null,
    parentAgentId: null,
    labels: {},
    ...overrides,
  } as Agent;
}

function workspace(overrides: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id">) {
  return {
    projectId: "prj_1",
    projectDisplayName: "paseo",
    projectRootPath: "/home/me/paseo",
    workspaceDirectory: "/home/me/paseo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: overrides.id,
    status: "idle",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    ...overrides,
  } as WorkspaceDescriptor;
}

describe("buildAssistantCatalog", () => {
  it("names workspaces and agents without exposing paths and orders them by activity", () => {
    const catalog = buildAssistantCatalog({
      now: new Date("2026-09-14T10:00:00Z"),
      hosts: [{ serverId: "laptop", label: "  Laptop ", status: "online" }],
      workspaces: [
        workspace({ id: "ws-old", name: "old-branch" }),
        workspace({
          id: "ws-new",
          name: "sidebar-fix",
          title: "Sidebar crash",
          gitRuntime: { remoteUrl: "https://secret@github.com/team/paseo.git" },
        }),
      ],
      agents: [
        agent({
          id: "a-old",
          workspaceId: "ws-old",
          lastActivityAt: new Date("2026-09-13T00:00:00Z"),
        }),
        agent({
          id: "a-new",
          workspaceId: "ws-new",
          title: "Fix the sidebar crash",
          lastActivityAt: new Date("2026-09-14T09:00:00Z"),
        }),
        agent({
          id: "a-child",
          parentAgentId: "a-new",
          lastActivityAt: new Date("2026-09-14T09:30:00Z"),
        }),
      ],
      serverIdOfWorkspace: () => "laptop",
    });

    expect(catalog.hosts).toEqual([{ serverId: "laptop", label: "Laptop", status: "online" }]);
    expect(catalog.workspaces.map((entry) => entry.id)).toEqual(["ws-new", "ws-old"]);
    expect(catalog.workspaces[0]).toEqual({
      id: "ws-new",
      serverId: "laptop",
      name: "Sidebar crash",
      project: "paseo",
      repository: "github.com/team/paseo",
      branch: null,
      status: "idle",
      agentCount: 1,
      lastActivityAt: "2026-09-14T09:00:00.000Z",
    });
    expect(catalog.agents.map((entry) => entry.id)).toEqual(["a-new", "a-old"]);
    expect(catalog.agents[1].name).toBe("paseo");
    expect(JSON.stringify(catalog)).not.toContain("/home/me");
    expect(JSON.stringify(catalog)).not.toContain("secret");
    expect(catalog.truncated).toBe(false);
  });

  it("flags truncation once the bounded lists overflow", () => {
    const agents = Array.from({ length: 201 }, (_, index) =>
      agent({ id: `a-${index}`, lastActivityAt: new Date(index * 1000) }),
    );
    const catalog = buildAssistantCatalog({
      now: new Date(0),
      hosts: [],
      workspaces: [],
      agents,
      serverIdOfWorkspace: () => "laptop",
    });

    expect(catalog.agents).toHaveLength(200);
    expect(catalog.agents[0].id).toBe("a-200");
    expect(catalog.truncated).toBe(true);
  });
});
