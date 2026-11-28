import { describe, expect, test } from "vitest";
import {
  AgentTimelineItemPayloadSchema,
  SendAgentMessageRequestSchema,
  FileExplorerRequestSchema,
  PaseoWorktreeArchiveRequestSchema,
  parseServerInfoStatusPayload,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WSOutboundMessageSchema,
  WorkspaceProjectDescriptorPayloadSchema,
} from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";
import { MAX_WORKSPACE_SHARED_TABS } from "./workspace-tab-layout.js";

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

describe("project icon message security", () => {
  test("rejects URL sources at the daemon boundary", () => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: "project.icon.set.request",
      projectId: "project-1",
      source: { type: "url", url: "http://127.0.0.1/private" },
      requestId: "request-1",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("project icon revision compatibility", () => {
  const project = {
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo/project",
    projectKind: "git" as const,
  };

  test("accepts an old project snapshot without an effective icon revision", () => {
    expect(WorkspaceProjectDescriptorPayloadSchema.parse(project)).toEqual(project);
  });

  test("accepts an effective icon revision on a new project snapshot", () => {
    expect(
      WorkspaceProjectDescriptorPayloadSchema.parse({
        ...project,
        projectIconRevision: "automatic:none:v1",
      }),
    ).toEqual({ ...project, projectIconRevision: "automatic:none:v1" });
  });
});

describe("workspace tab layout messages", () => {
  const state = {
    revision: 2,
    tabs: [{ tabId: "file_readme.md", target: { kind: "file", path: "readme.md" } }],
    hiddenAgentIds: ["agent-1"],
    pinnedAgentIds: [],
  };
  const request = {
    type: "workspace.tabs.apply.request",
    requestId: "apply-1",
    workspaceId: "ws-1",
    desktop: false,
    operations: [{ kind: "move", tabId: "file_readme.md", after: "agent_a" }],
  };

  const applyResponse = (layout: unknown) => ({
    type: "workspace.tabs.apply.response",
    payload: { requestId: "apply-1", state: layout, error: null },
  });

  test("round-trips the request, acknowledgement, and optional workspace snapshot", () => {
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    const response = applyResponse(state);
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
    for (const layout of [undefined, state]) {
      const result = SessionOutboundMessageSchema.parse(
        fetchWorkspacesResponse(workspaceDescriptor({ tabLayout: layout })),
      );
      if (result.type !== "fetch_workspaces_response")
        throw new Error("Expected workspace snapshot");
      expect(result.payload.entries[0]?.tabLayout).toEqual(layout);
    }
  });

  test.each([{ context: "workspace" }, { context: "agent", agentId: "agent-1" }])(
    "generated validation matches Zod for a $context plugin tab",
    (context) => {
      const layout = {
        ...state,
        tabs: [
          ...state.tabs,
          {
            tabId: "plugin-tab",
            target: { kind: "plugin", pluginId: "test-plugin", panelId: "details", ...context },
          },
        ],
      };
      for (const message of [
        fetchWorkspacesResponse(workspaceDescriptor({ tabLayout: layout })),
        applyResponse(layout),
      ]) {
        const envelope = { type: "session", message };
        const plain = WSOutboundMessageSchema.parse(envelope);
        expect(validateWSOutboundMessage(envelope)).toEqual({ success: true, data: plain });
      }
    },
  );

  test("skips future tab kinds and plugin contexts in workspace replies and updates", () => {
    const futureTabs = [
      { tabId: "future", target: { kind: "future", spec: "whatever" } },
      {
        tabId: "new-plugin-context",
        target: { kind: "plugin", pluginId: "test-plugin", panelId: "details", context: "file" },
      },
    ];
    const layout = {
      ...state,
      tabs: [...futureTabs, ...state.tabs],
      split: {
        rootId: "pane",
        nodes: [
          {
            kind: "pane",
            id: "pane",
            tabIds: [...futureTabs, ...state.tabs].map((tab) => tab.tabId),
          },
        ],
      },
    };
    const filtered = {
      ...state,
      split: {
        ...layout.split,
        nodes: [{ ...layout.split.nodes[0], tabIds: state.tabs.map((tab) => tab.tabId) }],
      },
    };
    const list = fetchWorkspacesResponse(workspaceDescriptor({ tabLayout: layout }));
    list.payload.entries.push(workspaceDescriptor({ id: "ws-2" }));
    const update = (tabLayout: unknown) => ({
      type: "workspace_update",
      payload: { kind: "upsert", workspace: workspaceDescriptor({ tabLayout }) },
    });
    const expectedList = fetchWorkspacesResponse(workspaceDescriptor({ tabLayout: filtered }));
    expectedList.payload.entries.push(workspaceDescriptor({ id: "ws-2" }));

    for (const [message, expected] of [
      [list, expectedList],
      [applyResponse(layout), applyResponse(filtered)],
      [update(layout), update(filtered)],
    ]) {
      const warnings: string[] = [];
      const envelope = { type: "session", message };
      expect(WSOutboundMessageSchema.safeParse(envelope).success).toBe(false);
      expect(validateWSOutboundMessage(envelope, (type) => warnings.push(type))).toMatchObject({
        success: true,
        data: WSOutboundMessageSchema.parse({ type: "session", message: expected }),
      });
      expect(warnings).toEqual([message.type]);
    }
  });

  test("keeps known tab validation strict even when a future tab is present", () => {
    const layout = {
      ...state,
      tabs: [
        { tabId: "future", target: { kind: "future" } },
        {
          tabId: "plugin-without-agent",
          target: { kind: "plugin", pluginId: "test-plugin", panelId: "details", context: "agent" },
        },
      ],
    };
    const envelope = { type: "session", message: applyResponse(layout) };
    expect(WSOutboundMessageSchema.safeParse(envelope).success).toBe(false);
    expect(validateWSOutboundMessage(envelope).success).toBe(false);
  });

  test("keeps the wire size limit when skipping future tabs", () => {
    const layout = {
      ...state,
      tabs: Array.from({ length: MAX_WORKSPACE_SHARED_TABS + 1 }, (_, index) => ({
        tabId: `future-${index}`,
        target: { kind: "future" },
      })),
    };
    const envelope = { type: "session", message: applyResponse(layout) };
    expect(validateWSOutboundMessage(envelope).success).toBe(false);
  });

  test("rejects local tab kinds, per-tab state, and split focus on the wire", () => {
    for (const tab of [
      { tabId: "draft-a", target: { kind: "draft", draftId: "a" } },
      { tabId: "browser-a", target: { kind: "browser", browserId: "a" } },
      { ...state.tabs[0], state: { scrollY: 10 } },
    ]) {
      expect(
        SessionInboundMessageSchema.safeParse({
          ...request,
          operations: [{ kind: "open", tab }],
        }).success,
      ).toBe(false);
    }
    expect(
      SessionInboundMessageSchema.safeParse({
        ...request,
        operations: [
          {
            kind: "split",
            split: {
              rootId: "pane",
              nodes: [{ kind: "pane", id: "pane", tabIds: [], focusedTabId: "a" }],
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

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

  test("parses the session import search feature gate", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "srv-test",
      features: {
        importSessionSearch: true,
      },
    });

    if (!parsed) {
      throw new Error("Expected server info payload to parse");
    }
    expect(parsed.features?.importSessionSearch).toBe(true);
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
  test("carries a cursor per chat and a freshness answer per chat", () => {
    const cursors = { "agent-a": { epoch: "epoch-1", seq: 42 } };
    const timelines = { "agent-a": "current", "agent-b": "behind" };

    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.timeline.set_subscription.request",
        agentIds: ["agent-a"],
        requestId: "timeline-subscription-2",
        cursors,
      }),
    ).toMatchObject({ cursors });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.timeline.set_subscription.response",
        payload: { agentIds: ["agent-a"], requestId: "timeline-subscription-2", timelines },
      }),
    ).toMatchObject({ payload: { timelines } });
  });

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

test("agent messages are an optional semantic payload on existing tool rows", () => {
  const legacy = {
    type: "tool_call",
    callId: "delivery",
    name: "agent_message",
    status: "completed",
    error: null,
    detail: { type: "plain_text", text: "Done" },
  };
  const agentMessage = {
    event: "finished",
    sender: { id: "server::worker", title: "Reviewer" },
    text: "Done",
  };
  expect(AgentTimelineItemPayloadSchema.parse(legacy)).toEqual(legacy);
  expect(AgentTimelineItemPayloadSchema.parse({ ...legacy, agentMessage })).toEqual({
    ...legacy,
    agentMessage,
  });
  expect(
    AgentTimelineItemPayloadSchema.safeParse({
      ...legacy,
      agentMessage: { ...agentMessage, sender: { id: 42 } },
    }).success,
  ).toBe(false);
});

test.each(["all", "base", "uncommitted"] as const)(
  "preserves %s review attachments while ignoring unknown attachments",
  (mode) => {
    const attachment = {
      type: "review",
      mimeType: "application/paseo-review",
      cwd: "/repo",
      mode,
      baseRef: "main",
      comments: [],
    };
    const parsed = SendAgentMessageRequestSchema.parse({
      type: "send_agent_message_request",
      requestId: "review",
      agentId: "agent",
      text: "Review",
      attachments: [{ type: "future_attachment" }, attachment],
    });
    expect(parsed.attachments).toEqual([attachment]);
  },
);

describe("terminal collection protocol compatibility", () => {
  test("accepts released directory observations and their snapshots", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "subscribe_terminals_request",
        cwd: "/repo",
        requestId: "old",
      }),
    ).toMatchObject({ cwd: "/repo" });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "terminals_changed",
        payload: { cwd: "/repo", terminals: [{ id: "terminal", name: "Shell" }] },
      }),
    ).toMatchObject({ payload: { cwd: "/repo" } });
  });
  test("accepts capability-gated host observations and additive metadata", () => {
    expect(
      SessionInboundMessageSchema.parse({ type: "subscribe_terminals_request", requestId: "host" }),
    ).toMatchObject({ requestId: "host" });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "terminals_changed",
        payload: {
          terminals: [
            {
              id: "terminal",
              name: "Shell",
              cwd: "/repo",
              workspaceId: "workspace",
              createdAt: null,
              isScript: true,
            },
          ],
        },
      }),
    ).toMatchObject({ payload: { terminals: [{ isScript: true, createdAt: null }] } });
  });
});
