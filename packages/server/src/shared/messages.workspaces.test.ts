import { z } from "zod";
import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("workspace message schemas", () => {
  test("parses fetch_workspaces_request", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "fetch_workspaces_request",
      requestId: "req-1",
      filter: {
        query: "repo",
        projectId: "remote:github.com/acme/repo",
        idPrefix: "/Users/me",
      },
      sort: [{ key: "activity_at", direction: "desc" }],
      page: { limit: 50 },
      subscribe: {},
    });

    expect(parsed.type).toBe("fetch_workspaces_request");
  });

  test("parses open_project_request", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "open_project_request",
      cwd: "/tmp/repo",
      requestId: "req-open",
    });

    expect(parsed.type).toBe("open_project_request");
  });

  test("parses list_available_editors_request", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "list_available_editors_request",
      requestId: "req-editors",
    });

    expect(parsed.type).toBe("list_available_editors_request");
  });

  test("parses open_in_editor_request with flexible editor ids", () => {
    const knownEditor = SessionInboundMessageSchema.parse({
      type: "open_in_editor_request",
      requestId: "req-open-webstorm",
      editorId: "webstorm",
      path: "/tmp/repo",
    });
    const unknownEditor = SessionInboundMessageSchema.parse({
      type: "open_in_editor_request",
      requestId: "req-open-custom",
      editorId: "unknown-editor",
      path: "/tmp/repo",
    });

    expect(knownEditor.type).toBe("open_in_editor_request");
    expect(unknownEditor.type).toBe("open_in_editor_request");
  });

  test("parses open_in_editor_response", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "open_in_editor_response",
      payload: {
        requestId: "req-open-editor",
        error: null,
      },
    });

    expect(parsed.type).toBe("open_in_editor_response");
  });

  test("parses list_available_editors_response with unknown editor ids", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "list_available_editors_response",
      payload: {
        requestId: "req-editors",
        editors: [
          { id: "cursor", label: "Cursor" },
          { id: "unknown-editor", label: "Unknown Editor" },
        ],
        error: null,
      },
    });

    expect(parsed.type).toBe("list_available_editors_response");
  });

  test("rejects empty editor ids", () => {
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
          id: "/repo",
          projectId: "/repo",
          projectDisplayName: "repo",
          projectRootPath: "/repo",
          projectKind: "non_git",
          workspaceKind: "directory",
          name: "",
          status: "not-a-bucket",
          activityAt: null,
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test("parses fetch_workspaces_response with optional runtime fields", () => {
    const parsed = SessionOutboundMessageSchema.parse({
      type: "fetch_workspaces_response",
      payload: {
        requestId: "req-workspaces",
        entries: [
          {
            id: "/tmp/repo",
            projectId: "remote:github.com/acme/repo",
            projectDisplayName: "acme/repo",
            projectRootPath: "/tmp/repo",
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
            id: "/tmp/repo",
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
      id: "/tmp/repo",
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
});
