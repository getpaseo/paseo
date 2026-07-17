import { describe, expect, test } from "vitest";
import {
  FileExplorerRequestSchema,
  PaseoWorktreeArchiveRequestSchema,
  parseServerInfoStatusPayload,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

function workspaceDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    projectId: "remote:github.com/acme/app",
    projectDisplayName: "acme/app",
    projectRootPath: "/repo/app",
    workspaceDirectory: "/repo/app",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "app",
    status: "done",
    activityAt: null,
    diffStat: null,
    scripts: [],
    ...overrides,
  };
}

function fetchWorkspacesResponse(workspace: Record<string, unknown>) {
  return {
    type: "fetch_workspaces_response",
    payload: {
      requestId: "req-1",
      entries: [workspace],
      pageInfo: {
        nextCursor: null,
        prevCursor: null,
        hasMore: false,
      },
    },
  };
}

describe("workspace descriptor message compatibility", () => {
  test("old-shaped fetch_workspaces_response without project still parses", () => {
    const parsed = SessionOutboundMessageSchema.parse(
      fetchWorkspacesResponse(workspaceDescriptor()),
    );

    expect(parsed.type).toBe("fetch_workspaces_response");
    if (parsed.type !== "fetch_workspaces_response") {
      throw new Error("Expected fetch_workspaces_response");
    }
    expect(parsed.payload.entries[0]?.project).toBeUndefined();
  });

  test("new-shaped fetch_workspaces_response with project placement parses", () => {
    const parsed = SessionOutboundMessageSchema.parse(
      fetchWorkspacesResponse(
        workspaceDescriptor({
          project: {
            projectKey: "remote:github.com/acme/app",
            projectName: "acme/app",
            checkout: {
              cwd: "/repo/app",
              isGit: true,
              currentBranch: "main",
              remoteUrl: "https://github.com/acme/app.git",
              worktreeRoot: "/repo/app",
              isPaseoOwnedWorktree: false,
              mainRepoRoot: null,
            },
          },
        }),
      ),
    );

    expect(parsed.type).toBe("fetch_workspaces_response");
    if (parsed.type !== "fetch_workspaces_response") {
      throw new Error("Expected fetch_workspaces_response");
    }
    expect(parsed.payload.entries[0]?.project).toEqual({
      projectKey: "remote:github.com/acme/app",
      projectName: "acme/app",
      checkout: {
        cwd: "/repo/app",
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/app.git",
        worktreeRoot: "/repo/app",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    });
  });

  test("adding project does not narrow existing descriptor fields", () => {
    const parsed = SessionOutboundMessageSchema.parse(
      fetchWorkspacesResponse(
        workspaceDescriptor({
          workspaceDirectory: undefined,
          projectKind: "non_git",
          workspaceKind: "directory",
          gitRuntime: null,
          githubRuntime: null,
          project: {
            projectKey: "/repo/local",
            projectName: "local",
            checkout: {
              cwd: "/repo/local",
              isGit: false,
              currentBranch: null,
              remoteUrl: null,
              worktreeRoot: null,
              isPaseoOwnedWorktree: false,
              mainRepoRoot: null,
            },
          },
        }),
      ),
    );

    expect(parsed.type).toBe("fetch_workspaces_response");
    if (parsed.type !== "fetch_workspaces_response") {
      throw new Error("Expected fetch_workspaces_response");
    }
    expect(parsed.payload.entries[0]).toMatchObject({
      projectKind: "non_git",
      workspaceKind: "directory",
      workspaceDirectory: "/repo/app",
      gitRuntime: null,
      githubRuntime: null,
    });
  });
});

describe("provider usage list message contract", () => {
  test("accepts the usage list request as a namespaced correlated RPC", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "provider.usage.list.request",
      requestId: "usage-1",
    });

    expect(parsed).toEqual({
      type: "provider.usage.list.request",
      requestId: "usage-1",
    });
  });

  test("accepts new providers and new usage windows as normalized data", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "provider.usage.list.response",
      payload: {
        requestId: "usage-2",
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "glm",
            displayName: "GLM coding plan",
            status: "available",
            planLabel: "GLM coding plan",
            fetchedAt: "2026-06-19T00:00:00.000Z",
            windows: [
              {
                id: "biweekly",
                label: "Biweekly",
                usedPct: 23,
                remainingPct: 77,
                resetsAt: "2026-07-03T00:00:00.000Z",
                tone: "ok",
              },
            ],
            balances: [
              {
                id: "credits",
                label: "Credits",
                remaining: 120,
                unit: "credits",
              },
            ],
            details: [{ id: "region", label: "Region", value: "US" }],
            error: null,
          },
        ],
      },
    });

    expect(parsed.type).toBe("provider.usage.list.response");
    if (parsed.type !== "provider.usage.list.response") {
      throw new Error("Expected provider.usage.list.response");
    }
    expect(parsed.payload.providers[0]?.providerId).toBe("glm");
    expect(parsed.payload.providers[0]?.windows[0]?.label).toBe("Biweekly");
  });

  test("keeps protocol numbers strict after API boundary normalization", () => {
    const parsed = SessionOutboundMessageSchema.safeParse({
      type: "provider.usage.list.response",
      payload: {
        requestId: "usage-3",
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "claude",
            displayName: "Claude",
            status: "available",
            planLabel: "Max 20x",
            windows: [
              {
                id: "session",
                label: "Session",
                usedPct: "7",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("diagnostics message contract", () => {
  test("accepts the diagnostics request as a simple namespaced RPC", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "diagnostics.request",
      requestId: "diag-1",
    });

    expect(parsed).toEqual({
      type: "diagnostics.request",
      requestId: "diag-1",
    });
  });

  test("accepts a copyable diagnostics response", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "diagnostics.response",
      payload: {
        requestId: "diag-2",
        diagnostic: "Paseo diagnostics\n  Status: ok",
      },
    });

    expect(parsed.type).toBe("diagnostics.response");
    if (parsed.type !== "diagnostics.response") {
      throw new Error("Expected diagnostics.response");
    }
    expect(parsed.payload.diagnostic).toContain("Status: ok");
  });
});

describe("agent detach RPC", () => {
  test("parses the namespaced detach request", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "agent.detach.request",
      agentId: "child-agent",
      requestId: "req-detach",
    });

    expect(parsed).toEqual({
      type: "agent.detach.request",
      agentId: "child-agent",
      requestId: "req-detach",
    });
  });

  test("parses the namespaced detach response", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "agent.detach.response",
      payload: {
        requestId: "req-detach",
        agentId: "child-agent",
        accepted: true,
        error: null,
      },
    });

    expect(parsed.type).toBe("agent.detach.response");
  });

  test("parses the agentDetach server feature gate", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "srv-test",
      features: {
        agentDetach: true,
      },
    });

    if (!parsed) {
      throw new Error("Expected server info payload to parse");
    }
    expect(parsed.features?.agentDetach).toBe(true);
  });

  test("parses the workspace-targeted session import feature gate", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "srv-test",
      features: {
        importSessionWorkspaceTarget: true,
      },
    });

    if (!parsed) {
      throw new Error("Expected server info payload to parse");
    }
    expect(parsed.features?.importSessionWorkspaceTarget).toBe(true);
  });
});

describe("agent setting action responses", () => {
  test("parses optional provider notices on mode and thinking responses", () => {
    const mode = SessionOutboundMessageSchema.parse({
      type: "set_agent_mode_response",
      payload: {
        requestId: "req-mode",
        agentId: "agent-1",
        accepted: true,
        error: null,
        notice: {
          type: "info",
          message: "This change applies next turn.",
        },
      },
    });
    const thinking = SessionOutboundMessageSchema.parse({
      type: "set_agent_thinking_response",
      payload: {
        requestId: "req-thinking",
        agentId: "agent-1",
        accepted: true,
        error: null,
      },
    });

    expect(mode.type).toBe("set_agent_mode_response");
    if (mode.type !== "set_agent_mode_response") {
      throw new Error("Expected set_agent_mode_response");
    }
    expect(mode.payload.notice).toEqual({
      type: "info",
      message: "This change applies next turn.",
    });
    expect(thinking.type).toBe("set_agent_thinking_response");
    if (thinking.type !== "set_agent_thinking_response") {
      throw new Error("Expected set_agent_thinking_response");
    }
    expect(thinking.payload.notice).toBeUndefined();
  });
});

describe("file explorer request compatibility", () => {
  test("acceptBinary is optional for old clients and accepted for new clients", () => {
    expect(
      FileExplorerRequestSchema.parse({
        type: "file_explorer_request",
        cwd: "/repo/app",
        path: "image.png",
        mode: "file",
        requestId: "req-old",
      }),
    ).toEqual({
      type: "file_explorer_request",
      cwd: "/repo/app",
      path: "image.png",
      mode: "file",
      requestId: "req-old",
    });

    expect(
      FileExplorerRequestSchema.parse({
        type: "file_explorer_request",
        cwd: "/repo/app",
        path: "image.png",
        mode: "file",
        requestId: "req-new",
        acceptBinary: true,
      }),
    ).toMatchObject({
      type: "file_explorer_request",
      requestId: "req-new",
      acceptBinary: true,
    });
  });
});

describe("paseo worktree archive request compatibility", () => {
  test("omitted scope defaults to workspace", () => {
    const parsed = PaseoWorktreeArchiveRequestSchema.parse({
      type: "paseo_worktree_archive_request",
      worktreePath: "/repo/app",
      requestId: "req-old-scope",
    });
    expect(parsed.scope).toBe("workspace");
  });

  test("scope worktree parses", () => {
    const parsed = PaseoWorktreeArchiveRequestSchema.parse({
      type: "paseo_worktree_archive_request",
      worktreePath: "/repo/app",
      scope: "worktree",
      requestId: "req-worktree-scope",
    });
    expect(parsed.scope).toBe("worktree");
  });

  test("unknown extra field is still accepted", () => {
    const parsed = PaseoWorktreeArchiveRequestSchema.parse({
      type: "paseo_worktree_archive_request",
      worktreePath: "/repo/app",
      requestId: "req-extra",
      extraField: "ignored",
    });
    expect(parsed).not.toHaveProperty("extraField");
    expect(parsed.scope).toBe("workspace");
  });
});

describe("daemon update messages", () => {
  test("daemon update progress is a scoped outbound message", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "daemon.update.progress",
      payload: {
        requestId: "update-1",
        phase: "installing",
      },
    });

    expect(parsed).toEqual({
      type: "daemon.update.progress",
      payload: {
        requestId: "update-1",
        phase: "installing",
      },
    });
  });
});

describe("viewed timeline subscription messages", () => {
  test("parses a complete viewed-agent set and its acknowledgement", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "agent.timeline.set_subscription.request",
      agentIds: ["agent-a", "agent-b"],
      requestId: "timeline-subscription-1",
    });
    const response = SessionOutboundMessageSchema.parse({
      type: "agent.timeline.set_subscription.response",
      payload: {
        agentIds: ["agent-a", "agent-b"],
        requestId: "timeline-subscription-1",
      },
    });

    expect({ request, response }).toEqual({
      request: {
        type: "agent.timeline.set_subscription.request",
        agentIds: ["agent-a", "agent-b"],
        requestId: "timeline-subscription-1",
      },
      response: {
        type: "agent.timeline.set_subscription.response",
        payload: {
          agentIds: ["agent-a", "agent-b"],
          requestId: "timeline-subscription-1",
        },
      },
    });
  });
});
