import { z } from "zod";
import { describe, expect, test } from "vitest";
import {
  RecentProviderSessionDescriptorPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WorkspaceCreateRequestSchema,
  WorkspaceDescriptorPayloadSchema,
  WorkspaceScriptPayloadSchema,
} from "./messages.js";

describe("workspace message schemas", () => {
  test("parses fetch_workspaces_request", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "fetch_workspaces_request",
      requestId: "req-1",
      filter: {
        query: "repo",
        projectId: "proj-12",
        idPrefix: "/Users/me",
      },
      sort: [{ key: "activity_at", direction: "desc" }],
      page: { limit: 50 },
      subscribe: {},
    });

    expect(parsed.type).toBe("fetch_workspaces_request");
  });

  test("parses project.add request and response", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "project.add.request",
        requestId: "req-add-project",
        cwd: "/repo",
      }),
    ).toEqual({
      type: "project.add.request",
      requestId: "req-add-project",
      cwd: "/repo",
    });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "project.add.response",
        payload: {
          requestId: "req-add-project",
          project: {
            projectId: "/repo",
            projectDisplayName: "repo",
            projectCustomName: null,
            projectRootPath: "/repo",
            projectKind: "git",
          },
          error: null,
        },
      }),
    ).toEqual({
      type: "project.add.response",
      payload: {
        requestId: "req-add-project",
        project: {
          projectId: "/repo",
          projectDisplayName: "repo",
          projectCustomName: null,
          projectRootPath: "/repo",
          projectKind: "git",
        },
        error: null,
      },
    });
  });

  test("parses active-scoped fetch_agents_request as an optional extension", () => {
    const legacy = SessionInboundMessageSchema.parse({
      type: "fetch_agents_request",
      requestId: "req-agents-legacy",
      page: { limit: 50 },
    });
    const activeScoped = SessionInboundMessageSchema.parse({
      type: "fetch_agents_request",
      requestId: "req-agents-active",
      scope: "active",
      page: { limit: 50 },
      subscribe: {},
    });

    expect(legacy.type).toBe("fetch_agents_request");
    expect(activeScoped.type).toBe("fetch_agents_request");
    if (activeScoped.type !== "fetch_agents_request") {
      throw new Error("Expected fetch_agents_request");
    }
    expect(activeScoped.scope).toBe("active");
  });

  test("parses agent_update without project placement", () => {
    const result = SessionOutboundMessageSchema.safeParse({
      type: "agent_update",
      payload: {
        kind: "upsert",
        agent: {
          id: "agent-1",
          provider: "codex",
          cwd: "/tmp/repo",
          model: null,
          features: [],
          thinkingOptionId: null,
          effectiveThinkingOptionId: null,
          createdAt: "2026-04-04T00:00:00.000Z",
          updatedAt: "2026-04-04T00:00:00.000Z",
          lastUserMessageAt: null,
          status: "running",
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
          title: null,
          labels: {},
          requiresAttention: false,
          attentionReason: null,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test("parses paginated fetch_agent_history_request and response", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "fetch_agent_history_request",
      requestId: "req-history",
      page: { limit: 25, cursor: "cursor-1" },
      sort: [{ key: "updated_at", direction: "desc" }],
    });
    const response = SessionOutboundMessageSchema.parse({
      type: "fetch_agent_history_response",
      payload: {
        requestId: "req-history",
        entries: [],
        pageInfo: {
          nextCursor: "cursor-2",
          prevCursor: "cursor-1",
          hasMore: true,
        },
      },
    });

    expect(request.type).toBe("fetch_agent_history_request");
    expect(response.type).toBe("fetch_agent_history_response");
  });

  test("parses recent provider session descriptors without legacy handle fields", () => {
    const parsed = RecentProviderSessionDescriptorPayloadSchema.parse({
      providerId: "custom-codex",
      providerLabel: "Custom Codex",
      providerHandleId: "thread-1",
      cwd: "/tmp/repo",
      title: "Resume this",
      firstPromptPreview: "first prompt",
      lastPromptPreview: "last prompt",
      lastActivityAt: "2026-04-30T12:34:56.000Z",
    });

    expect(parsed).toEqual({
      providerId: "custom-codex",
      providerLabel: "Custom Codex",
      providerHandleId: "thread-1",
      cwd: "/tmp/repo",
      title: "Resume this",
      firstPromptPreview: "first prompt",
      lastPromptPreview: "last prompt",
      lastActivityAt: "2026-04-30T12:34:56.000Z",
    });
  });

  test("parses fetch_recent_provider_sessions request and response", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "fetch_recent_provider_sessions_request",
      requestId: "req-recent-provider-sessions",
      cwd: "/tmp/repo",
      providers: ["my-claude"],
      since: "2026-04-30T00:00:00.000Z",
      limit: 25,
    });
    const response = SessionOutboundMessageSchema.parse({
      type: "fetch_recent_provider_sessions_response",
      payload: {
        requestId: "req-recent-provider-sessions",
        entries: [
          {
            providerId: "my-claude",
            providerLabel: "My Claude",
            providerHandleId: "thread-1",
            cwd: "/tmp/repo",
            title: "Resume this",
            firstPromptPreview: "first prompt",
            lastPromptPreview: "last prompt",
            lastActivityAt: "2026-04-30T12:34:56.000Z",
          },
        ],
      },
    });

    expect(request.type).toBe("fetch_recent_provider_sessions_request");
    expect(request.providers).toEqual(["my-claude"]);
    expect(response.payload).toEqual({
      requestId: "req-recent-provider-sessions",
      entries: [
        {
          providerId: "my-claude",
          providerLabel: "My Claude",
          providerHandleId: "thread-1",
          cwd: "/tmp/repo",
          title: "Resume this",
          firstPromptPreview: "first prompt",
          lastPromptPreview: "last prompt",
          lastActivityAt: "2026-04-30T12:34:56.000Z",
        },
      ],
    });
  });

  test("parses fetch_recent_provider_sessions response with filteredAlreadyImportedCount", () => {
    const response = SessionOutboundMessageSchema.parse({
      type: "fetch_recent_provider_sessions_response",
      payload: {
        requestId: "req-recent-provider-sessions",
        entries: [],
        filteredAlreadyImportedCount: 3,
      },
    });

    if (response.type !== "fetch_recent_provider_sessions_response") {
      throw new Error("expected fetch_recent_provider_sessions_response");
    }
    expect(response.payload.filteredAlreadyImportedCount).toBe(3);
  });

  test("parses new and legacy import agent requests", () => {
    const newRequest = SessionInboundMessageSchema.parse({
      type: "import_agent_request",
      requestId: "req-import-new",
      providerId: "custom-codex",
      providerHandleId: "thread-1",
      cwd: "/tmp/repo",
    });
    const legacyRequest = SessionInboundMessageSchema.parse({
      type: "import_agent_request",
      requestId: "req-import-legacy",
      provider: "custom-codex",
      sessionId: "thread-1",
      cwd: "/tmp/repo",
    });

    expect(newRequest).toEqual({
      type: "import_agent_request",
      requestId: "req-import-new",
      providerId: "custom-codex",
      providerHandleId: "thread-1",
      cwd: "/tmp/repo",
    });
    expect(legacyRequest).toEqual({
      type: "import_agent_request",
      requestId: "req-import-legacy",
      provider: "custom-codex",
      sessionId: "thread-1",
      cwd: "/tmp/repo",
    });
  });

  test("parses open_project_request", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "open_project_request",
      cwd: "/tmp/repo",
      requestId: "req-open",
    });

    expect(parsed.type).toBe("open_project_request");
  });

  test("parses legacy editor RPC messages for compatibility", () => {
    const listRequest = SessionInboundMessageSchema.parse({
      type: "list_available_editors_request",
      requestId: "req-editors",
    });
    const openRequest = SessionInboundMessageSchema.parse({
      type: "open_in_editor_request",
      requestId: "req-open-editor",
      editorId: "unknown-editor",
      path: "/tmp/repo",
      mode: "reveal",
      cwd: "/tmp",
    });
    const listResponse = SessionOutboundMessageSchema.parse({
      type: "list_available_editors_response",
      payload: {
        requestId: "req-editors",
        editors: [{ id: "unknown-editor", label: "Unknown Editor" }],
        error: null,
      },
    });
    const openResponse = SessionOutboundMessageSchema.parse({
      type: "open_in_editor_response",
      payload: {
        requestId: "req-open-editor",
        error: "Editor opening moved to the desktop app",
      },
    });

    expect(listRequest.type).toBe("list_available_editors_request");
    expect(openRequest.type).toBe("open_in_editor_request");
    expect(listResponse.type).toBe("list_available_editors_response");
    expect(openResponse.type).toBe("open_in_editor_response");
  });

  test("rejects empty legacy editor ids", () => {
    const result = SessionInboundMessageSchema.safeParse({
      type: "open_in_editor_request",
      requestId: "req-open-empty",
      editorId: "",
      path: "/tmp/repo",
    });

    expect(result.success).toBe(false);
  });

  test("rejects invalid workspace update payload", () => {
    const result = SessionOutboundMessageSchema.safeParse({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: {
          id: "ws-invalid",
          projectId: "proj-invalid",
          projectDisplayName: "repo",
          projectRootPath: "/repo",
          projectKind: "directory",
          workspaceKind: "checkout",
          name: "",
          status: "not-a-bucket",
          activityAt: null,
          scripts: [],
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("parses workspace descriptors with scripts", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: {
          id: "ws-1",
          projectId: "proj-1",
          projectDisplayName: "repo",
          projectRootPath: "/repo",
          workspaceDirectory: "/repo",
          projectKind: "directory",
          workspaceKind: "checkout",
          name: "repo",
          status: "done",
          activityAt: null,
          scripts: [
            {
              scriptName: "web",
              hostname: "web.paseo.localhost",
              port: 3000,
              proxyUrl: "http://web.paseo.localhost:6767",
              lifecycle: "running",
              health: "healthy",
            },
          ],
        },
      },
    });

    expect(parsed.type).toBe("workspace_update");
    if (parsed.type !== "workspace_update" || parsed.payload.kind !== "upsert") {
      throw new Error("Expected workspace_update upsert payload");
    }
    expect(parsed.payload.workspace.scripts).toEqual([
      {
        scriptName: "web",
        type: "service",
        hostname: "web.paseo.localhost",
        port: 3000,
        proxyUrl: "http://web.paseo.localhost:6767",
        lifecycle: "running",
        health: "healthy",
        exitCode: null,
        terminalId: null,
      },
    ]);
  });

  test("parses legacy workspace descriptors without workspaceDirectory", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: {
          id: "legacy-workspace",
          projectId: "legacy-project",
          projectDisplayName: "repo",
          projectRootPath: "/repo",
          projectKind: "git",
          workspaceKind: "local_checkout",
          name: "repo",
          status: "done",
          activityAt: null,
          scripts: [],
        },
      },
    });

    expect(parsed.type).toBe("workspace_update");
    if (parsed.type !== "workspace_update" || parsed.payload.kind !== "upsert") {
      throw new Error("Expected workspace_update upsert payload");
    }
    expect(parsed.payload.workspace.workspaceDirectory).toBe("/repo");
  });

  test("defaults omitted workspace archiving state and preserves present timestamps", () => {
    const baseWorkspace = {
      id: "ws-archiving",
      projectId: "proj-archiving",
      projectDisplayName: "repo",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "worktree",
      name: "feature",
      status: "done",
      activityAt: null,
      scripts: [],
    } as const;
    const archivingAt = "2026-04-30T20:45:00.000Z";

    expect(WorkspaceDescriptorPayloadSchema.parse(baseWorkspace).archivingAt).toBeNull();
    expect(
      WorkspaceDescriptorPayloadSchema.parse({
        ...baseWorkspace,
        archivingAt,
      }).archivingAt,
    ).toBe(archivingAt);
  });

  // The protocol `statusEnteredAt` field is optional and defaults to null.
  // Old daemons omit it entirely and old clients must keep accepting that.
  test("defaults statusEnteredAt to null for legacy descriptors", () => {
    const baseWorkspace = {
      id: "ws-status-entered",
      projectId: "proj",
      projectDisplayName: "repo",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "worktree",
      name: "feature",
      status: "running",
      activityAt: null,
      scripts: [],
    } as const;
    expect(WorkspaceDescriptorPayloadSchema.parse(baseWorkspace).statusEnteredAt).toBeNull();
  });

  test("preserves statusEnteredAt when present", () => {
    const baseWorkspace = {
      id: "ws-status-entered",
      projectId: "proj",
      projectDisplayName: "repo",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "worktree",
      name: "feature",
      status: "running",
      activityAt: null,
      scripts: [],
    } as const;
    const statusEnteredAt = "2026-05-12T10:00:00.000Z";
    expect(
      WorkspaceDescriptorPayloadSchema.parse({
        ...baseWorkspace,
        statusEnteredAt,
      }).statusEnteredAt,
    ).toBe(statusEnteredAt);
  });

  test("preserves explicit statusEnteredAt: null for empty workspaces", () => {
    // The server emits `statusEnteredAt: null` for workspaces with no
    // contributing agents (the "done with no agents" case). The client must
    // distinguish this from "field omitted" — both parse to null, but the
    // round-trip must not lose the explicit null.
    const baseWorkspace = {
      id: "ws-status-entered",
      projectId: "proj",
      projectDisplayName: "repo",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "worktree",
      name: "feature",
      status: "done",
      activityAt: null,
      scripts: [],
    } as const;
    const parsed = WorkspaceDescriptorPayloadSchema.parse({
      ...baseWorkspace,
      statusEnteredAt: null,
    });
    expect(parsed.statusEnteredAt).toBeNull();
  });

  test("parses legacy workspace descriptor enum values", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: {
          id: "legacy-workspace",
          projectId: "legacy-project",
          projectDisplayName: "repo",
          projectRootPath: "/repo",
          workspaceDirectory: "/repo",
          projectKind: "non_git",
          workspaceKind: "directory",
          name: "repo",
          status: "done",
          activityAt: null,
          scripts: [],
        },
      },
    });

    expect(parsed.type).toBe("workspace_update");
    if (parsed.type !== "workspace_update" || parsed.payload.kind !== "upsert") {
      throw new Error("Expected workspace_update upsert payload");
    }
    expect(parsed.payload.workspace.projectKind).toBe("non_git");
    expect(parsed.payload.workspace.workspaceKind).toBe("directory");
  });

  test("parses script_status_update payload", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "script_status_update",
      payload: {
        workspaceId: "ws-repo",
        scripts: [
          {
            scriptName: "web",
            hostname: "web.paseo.localhost",
            port: null,
            proxyUrl: null,
            lifecycle: "stopped",
            health: null,
          },
        ],
      },
    });

    expect(parsed.type).toBe("script_status_update");
    expect(parsed.payload.workspaceId).toBe("ws-repo");
    expect(parsed.payload.scripts[0]).toMatchObject({
      type: "service",
      exitCode: null,
    });
  });

  test("parses workspace service payloads from old daemons without split proxy URLs", () => {
    const parsed = WorkspaceScriptPayloadSchema.parse({
      scriptName: "web",
      type: "service",
      hostname: "web--repo.localhost",
      port: 3000,
      proxyUrl: "http://web--repo.localhost:6767",
      lifecycle: "running",
      health: "healthy",
    });

    expect(parsed.localProxyUrl).toBeUndefined();
    expect(parsed.publicProxyUrl).toBeUndefined();
    expect(parsed.proxyUrl).toBe("http://web--repo.localhost:6767");
  });

  test("parses workspace service payloads with split local and public proxy URLs", () => {
    const parsed = WorkspaceScriptPayloadSchema.parse({
      scriptName: "web",
      type: "service",
      hostname: "web--repo.localhost",
      port: 3000,
      localProxyUrl: "http://web--repo.localhost:6767",
      publicProxyUrl: "https://web--repo.services.example.com",
      proxyUrl: "https://web--repo.services.example.com",
      lifecycle: "running",
      health: "healthy",
    });

    expect(parsed.localProxyUrl).toBe("http://web--repo.localhost:6767");
    expect(parsed.publicProxyUrl).toBe("https://web--repo.services.example.com");
    expect(parsed.proxyUrl).toBe("https://web--repo.services.example.com");
  });

  test("defaults omitted workspace script proxyUrl to null", () => {
    const parsed = WorkspaceScriptPayloadSchema.parse({
      scriptName: "typecheck",
      type: "script",
      hostname: "typecheck",
      port: null,
      lifecycle: "stopped",
      health: null,
    });

    expect(parsed.proxyUrl).toBeNull();
  });

  test("parses workspace_setup_progress payload", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "workspace_setup_progress",
      payload: {
        workspaceId: "ws-feature-a",
        status: "completed",
        detail: {
          type: "worktree_setup",
          worktreePath: "/repo/.paseo/worktrees/feature-a",
          branchName: "feature-a",
          log: "done",
          commands: [
            {
              index: 1,
              command: "npm install",
              cwd: "/repo/.paseo/worktrees/feature-a",
              log: "done",
              status: "completed",
              exitCode: 0,
              durationMs: 100,
            },
          ],
        },
        error: null,
      },
    });

    expect(parsed.type).toBe("workspace_setup_progress");
  });

  test("parses workspace_setup_status_request", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "workspace_setup_status_request",
      workspaceId: "ws-feature-a",
      requestId: "req-status",
    });

    expect(parsed.type).toBe("workspace_setup_status_request");
  });

  test("parses workspace_setup_status_response payload", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "workspace_setup_status_response",
      payload: {
        requestId: "req-status",
        workspaceId: "ws-feature-a",
        snapshot: {
          status: "completed",
          detail: {
            type: "worktree_setup",
            worktreePath: "/repo/.paseo/worktrees/feature-a",
            branchName: "feature-a",
            log: "done",
            commands: [],
          },
          error: null,
        },
      },
    });

    expect(parsed.type).toBe("workspace_setup_status_response");
  });

  test("parses fetch_workspaces_response with optional runtime fields", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "fetch_workspaces_response",
      payload: {
        requestId: "req-workspaces",
        entries: [
          {
            id: "ws-main",
            projectId: "remote:github.com/acme/repo",
            projectDisplayName: "acme/repo",
            projectRootPath: "/tmp/repo",
            workspaceDirectory: "/tmp/repo",
            projectKind: "git",
            workspaceKind: "local_checkout",
            name: "main",
            status: "done",
            activityAt: null,
            diffStat: {
              additions: 3,
              deletions: 1,
            },
            gitRuntime: {
              currentBranch: "main",
              remoteUrl: "https://github.com/acme/repo.git",
              isPaseoOwnedWorktree: false,
              isDirty: true,
              aheadBehind: {
                ahead: 2,
                behind: 1,
              },
              aheadOfOrigin: 2,
              behindOfOrigin: 1,
            },
            githubRuntime: {
              featuresEnabled: true,
              pullRequest: {
                url: "https://github.com/acme/repo/pull/123",
                title: "Runtime payloads",
                state: "open",
                baseRefName: "main",
                headRefName: "workspace-git-service",
                isMerged: false,
              },
              error: null,
              refreshedAt: "2026-04-12T00:00:00.000Z",
            },
          },
        ],
        pageInfo: {
          nextCursor: null,
          prevCursor: null,
          hasMore: false,
        },
      },
    });

    expect(parsed.type).toBe("fetch_workspaces_response");
    expect(parsed.payload.entries[0]?.gitRuntime).toMatchObject({
      currentBranch: "main",
      isDirty: true,
      aheadOfOrigin: 2,
    });
    expect(parsed.payload.entries[0]?.githubRuntime?.pullRequest?.title).toBe("Runtime payloads");
  });

  test("older workspace parsers ignore additive runtime fields", () => {
    const message = {
      type: "fetch_workspaces_response",
      payload: {
        requestId: "req-workspaces",
        entries: [
          {
            id: "ws-main",
            projectId: "remote:github.com/acme/repo",
            projectDisplayName: "acme/repo",
            projectRootPath: "/tmp/repo",
            projectKind: "git",
            workspaceKind: "local_checkout",
            name: "main",
            status: "done",
            activityAt: null,
            diffStat: null,
            gitRuntime: {
              currentBranch: "main",
              remoteUrl: "https://github.com/acme/repo.git",
              isPaseoOwnedWorktree: false,
              isDirty: false,
              aheadBehind: {
                ahead: 0,
                behind: 0,
              },
              aheadOfOrigin: 0,
              behindOfOrigin: 0,
            },
            githubRuntime: {
              featuresEnabled: true,
              pullRequest: null,
              error: null,
              refreshedAt: "2026-04-12T00:00:00.000Z",
            },
          },
        ],
        pageInfo: {
          nextCursor: null,
          prevCursor: null,
          hasMore: false,
        },
      },
    };

    const legacyWorkspaceSchema = z.object({
      id: z.string(),
      projectId: z.string(),
      projectDisplayName: z.string(),
      projectRootPath: z.string(),
      projectKind: z.enum(["git", "non_git"]),
      workspaceKind: z.enum(["local_checkout", "worktree", "directory"]),
      name: z.string(),
      status: z.enum(["needs_input", "failed", "running", "attention", "done"]),
      activityAt: z.string().nullable(),
      diffStat: z
        .object({
          additions: z.number(),
          deletions: z.number(),
        })
        .nullable()
        .optional(),
    });
    const legacyMessageSchema = z.object({
      type: z.literal("fetch_workspaces_response"),
      payload: z.object({
        requestId: z.string(),
        entries: z.array(legacyWorkspaceSchema),
        pageInfo: z.object({
          nextCursor: z.string().nullable(),
          prevCursor: z.string().nullable(),
          hasMore: z.boolean(),
        }),
      }),
    });

    const parsed = legacyMessageSchema.parse(message);

    expect(parsed.payload.entries[0]).toEqual({
      id: "ws-main",
      projectId: "remote:github.com/acme/repo",
      projectDisplayName: "acme/repo",
      projectRootPath: "/tmp/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: null,
    });
  });

  test("parses legacy fetch_agents_response checkout payloads without worktreeRoot", () => {
    const result = SessionOutboundMessageSchema.safeParse({
      type: "fetch_agents_response",
      payload: {
        requestId: "req-1",
        entries: [
          {
            agent: {
              id: "agent-1",
              provider: "codex",
              cwd: "C:\\repo",
              model: null,
              features: [],
              thinkingOptionId: null,
              effectiveThinkingOptionId: null,
              createdAt: "2026-04-04T00:00:00.000Z",
              updatedAt: "2026-04-04T00:00:00.000Z",
              lastUserMessageAt: null,
              status: "running",
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
              title: "Agent 1",
              labels: {},
              requiresAttention: false,
              attentionReason: null,
            },
            project: {
              projectKey: "remote:github.com/acme/repo",
              projectName: "acme/repo",
              checkout: {
                cwd: "C:\\repo",
                isGit: true,
                currentBranch: "main",
                remoteUrl: "https://github.com/acme/repo.git",
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              },
            },
          },
        ],
        pageInfo: {
          nextCursor: null,
          prevCursor: null,
          hasMore: false,
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    const checkout = result.data.payload.entries[0]?.project.checkout;
    expect(checkout?.worktreeRoot).toBe("C:\\repo");
  });

  test("workspace.create.request rejects old flat backing shape and accepts new source envelope", () => {
    // Old flat shape with backing enum must be rejected.
    const oldFlat = WorkspaceCreateRequestSchema.safeParse({
      type: "workspace.create.request",
      requestId: "req-old",
      backing: "worktree",
      cwd: "/tmp/repo",
      branch: "feat/my-feature",
    });
    expect(oldFlat.success).toBe(false);

    // New envelope shape with source discriminated union must be accepted.
    const newWorktree = WorkspaceCreateRequestSchema.parse({
      type: "workspace.create.request",
      requestId: "req-worktree",
      source: {
        kind: "worktree",
        cwd: "/tmp/repo",
        action: "checkout",
        refName: "feat/my-feature",
      },
    });
    expect(newWorktree.type).toBe("workspace.create.request");
    expect(newWorktree.source.kind).toBe("worktree");

    // Directory source must also be accepted.
    const newDirectory = WorkspaceCreateRequestSchema.parse({
      type: "workspace.create.request",
      requestId: "req-dir",
      source: {
        kind: "directory",
        path: "/tmp/repo",
      },
    });
    expect(newDirectory.type).toBe("workspace.create.request");
    expect(newDirectory.source.kind).toBe("directory");
  });
});
