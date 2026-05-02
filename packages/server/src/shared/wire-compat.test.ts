import pino from "pino";
import { z } from "zod";
import { describe, expect, test, vi } from "vitest";

import { CLIENT_CAPS } from "./client-capabilities.js";
import {
  AgentTimelineItemPayloadSchema,
  FetchAgentTimelineResponseMessageSchema,
  SessionInboundMessageSchema,
  type SessionOutboundMessage,
} from "./messages.js";
import { Session, type SessionOptions } from "../server/session.js";
import type { AgentTimelineRow } from "../server/agent/agent-manager.js";
import { handleCreatePaseoWorktreeRequest } from "../server/worktree-session.js";

const LegacyTimelineEntryPayloadSchema = z.object({
  provider: z.enum(["claude", "codex", "opencode"]),
  item: AgentTimelineItemPayloadSchema,
  timestamp: z.string(),
  seqStart: z.number().int().nonnegative(),
  seqEnd: z.number().int().nonnegative(),
  sourceSeqRanges: z.array(
    z.object({
      startSeq: z.number().int().nonnegative(),
      endSeq: z.number().int().nonnegative(),
    }),
  ),
  // Copied from v0.1.65-beta.3: no reasoning_merge on the wire yet.
  collapsed: z.array(z.enum(["assistant_merge", "tool_lifecycle"])),
});

const LegacyFetchAgentTimelineResponseMessageSchema = z.object({
  type: z.literal("fetch_agent_timeline_response"),
  payload: FetchAgentTimelineResponseMessageSchema.shape.payload.extend({
    entries: z.array(LegacyTimelineEntryPayloadSchema),
  }),
});

const LegacySubAgentToolCallSchema = z.object({
  type: z.literal("tool_call"),
  callId: z.string(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  error: z.unknown().nullable(),
  detail: z.object({
    type: z.literal("sub_agent"),
    subAgentType: z.string().optional(),
    description: z.string().optional(),
    log: z.string(),
    // Copied from v0.1.65-beta.3: actions was required even though the UI ignored it.
    actions: z.array(
      z.object({
        index: z.number().int().positive(),
        toolName: z.string(),
        summary: z.string().optional(),
      }),
    ),
  }),
});

interface SessionInternals {
  buildAgentPayload: (snapshot: unknown) => Promise<null>;
  handleFetchAgentTimelineRequest: (
    message: Extract<
      z.infer<typeof SessionInboundMessageSchema>,
      { type: "fetch_agent_timeline_request" }
    >,
  ) => Promise<void>;
}

function createSessionForWireCompatTest(options?: {
  clientCapabilities?: Record<string, unknown> | null;
  messages?: SessionOutboundMessage[];
}): Session {
  const messages = options?.messages ?? [];
  const snapshot = { id: "agent-1", provider: "codex" };
  const rows: AgentTimelineRow[] = [
    {
      seq: 1,
      timestamp: "2026-05-02T00:00:00.000Z",
      item: { type: "reasoning", text: "Step " },
    },
    {
      seq: 2,
      timestamp: "2026-05-02T00:00:00.100Z",
      item: { type: "reasoning", text: "by step" },
    },
    {
      seq: 3,
      timestamp: "2026-05-02T00:00:00.200Z",
      item: { type: "assistant_message", text: "done" },
    },
  ];

  const session = new Session({
    clientId: "wire-compat-client",
    clientCapabilities: options?.clientCapabilities ?? null,
    onMessage: (message) => messages.push(message),
    logger: pino({ level: "silent" }),
    downloadTokenStore: {} as SessionOptions["downloadTokenStore"],
    pushTokenStore: {} as SessionOptions["pushTokenStore"],
    paseoHome: "/tmp/paseo-home",
    agentManager: {
      getAgent: vi.fn(() => snapshot),
      fetchTimeline: vi.fn(() => ({
        epoch: "epoch-1",
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
        rows,
        hasOlder: false,
        hasNewer: false,
      })),
      listAgents: vi.fn(() => []),
      subscribe: vi.fn(() => () => {}),
    } as unknown as SessionOptions["agentManager"],
    agentStorage: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    } as unknown as SessionOptions["agentStorage"],
    projectRegistry: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      upsert: vi.fn(),
      archive: vi.fn(),
      remove: vi.fn(),
      initialize: vi.fn(),
      existsOnDisk: vi.fn(),
    } as unknown as SessionOptions["projectRegistry"],
    workspaceRegistry: {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
    } as unknown as SessionOptions["workspaceRegistry"],
    chatService: {} as SessionOptions["chatService"],
    scheduleService: {} as SessionOptions["scheduleService"],
    loopService: {} as SessionOptions["loopService"],
    checkoutDiffManager: {
      scheduleRefreshForCwd: vi.fn(),
    } as unknown as SessionOptions["checkoutDiffManager"],
    github: {
      invalidate: vi.fn(),
      searchIssuesAndPrs: vi.fn(),
      createPullRequest: vi.fn(),
    } as unknown as SessionOptions["github"],
    workspaceGitService: {
      getCheckoutDiff: vi.fn(),
      getSnapshot: vi.fn(),
      suggestBranchesForCwd: vi.fn(),
      listStashes: vi.fn(),
      peekSnapshot: vi.fn(),
      validateBranchRef: vi.fn(),
      hasLocalBranch: vi.fn(),
      resolveRepoRemoteUrl: vi.fn(),
      getWorkspaceGitMetadata: vi.fn(),
    } as unknown as SessionOptions["workspaceGitService"],
    daemonConfigStore: {
      get: vi.fn(() => ({
        mcp: { injectIntoAgents: false },
        providers: {},
      })),
      onChange: vi.fn(() => () => {}),
    } as unknown as SessionOptions["daemonConfigStore"],
    stt: null,
    tts: null,
    terminalManager: null,
  });

  const internals = session as unknown as SessionInternals;
  internals.buildAgentPayload = vi.fn(async () => null);
  return session;
}

async function emitTimelineResponse(
  clientCapabilities?: Record<string, unknown> | null,
): Promise<Extract<SessionOutboundMessage, { type: "fetch_agent_timeline_response" }>> {
  const messages: SessionOutboundMessage[] = [];
  const session = createSessionForWireCompatTest({ clientCapabilities, messages });
  const internals = session as unknown as SessionInternals;

  await internals.handleFetchAgentTimelineRequest({
    type: "fetch_agent_timeline_request",
    requestId: "req-timeline",
    agentId: "agent-1",
    projection: "projected",
  });

  const response = messages[0];
  expect(response?.type).toBe("fetch_agent_timeline_response");
  if (!response || response.type !== "fetch_agent_timeline_response") {
    throw new Error("Expected fetch_agent_timeline_response");
  }
  return response;
}

describe("wire compatibility", () => {
  test("downgrades reasoning_merge for clients that do not declare the capability", async () => {
    const response = await emitTimelineResponse();

    const currentParsed = FetchAgentTimelineResponseMessageSchema.parse(response);
    expect(currentParsed.payload.entries[0]?.collapsed).not.toContain("reasoning_merge");

    const legacyParsed = LegacyFetchAgentTimelineResponseMessageSchema.parse(response);
    expect(legacyParsed.payload.entries[0]?.collapsed).toEqual([]);
  });

  test("preserves reasoning_merge for clients that declare the capability", async () => {
    const response = await emitTimelineResponse({
      [CLIENT_CAPS.reasoningMergeEnum]: true,
    });

    const currentParsed = FetchAgentTimelineResponseMessageSchema.parse(response);
    expect(currentParsed.payload.entries[0]?.collapsed).toContain("reasoning_merge");
  });

  test("sub_agent tool-call payload still parses against the v0.1.65-beta.3 schema", () => {
    const parsed = LegacySubAgentToolCallSchema.parse({
      type: "tool_call",
      callId: "call-sub-agent-1",
      name: "Task",
      status: "completed",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Explore",
        description: "Inspect repository structure",
        childSessionId: "child-session-1",
        log: "[Read] README.md",
        actions: [],
      },
    });

    expect(parsed.detail.actions).toEqual([]);
  });

  test("legacy worktree request shape normalizes to the same internal input as the new shape", async () => {
    const captured: unknown[] = [];

    const dependencies = {
      paseoHome: "/tmp/paseo-home",
      describeWorkspaceRecord: async () =>
        ({
          id: "ws-1",
          projectId: "proj-1",
          projectDisplayName: "repo",
          projectRootPath: "/tmp/repo",
          projectKind: "directory",
          workspaceKind: "checkout",
          name: "repo",
          cwd: "/tmp/repo",
          status: "ready",
          activityAt: null,
          scripts: [],
        }) as never,
      emit: vi.fn(),
      sessionLogger: pino({ level: "silent" }),
      createPaseoWorktreeWorkflow: async (input: unknown) => {
        captured.push(input);
        return {} as never;
      },
    };

    const legacyRequest = SessionInboundMessageSchema.parse({
      type: "create_paseo_worktree_request",
      requestId: "req-legacy",
      cwd: "/tmp/repo",
      worktreeSlug: "legacy-worktree",
      nameContext: "Investigate flaky test",
      attachments: [
        {
          type: "github_issue",
          mimeType: "application/github-issue",
          number: 55,
          title: "Improve startup error details",
          url: "https://github.com/getpaseo/paseo/issues/55",
        },
      ],
    });

    const newRequest = SessionInboundMessageSchema.parse({
      type: "create_paseo_worktree_request",
      requestId: "req-new",
      cwd: "/tmp/repo",
      worktreeSlug: "legacy-worktree",
      firstAgentContext: {
        prompt: "Investigate flaky test",
        attachments: [
          {
            type: "github_issue",
            mimeType: "application/github-issue",
            number: 55,
            title: "Improve startup error details",
            url: "https://github.com/getpaseo/paseo/issues/55",
          },
        ],
      },
    });

    if (legacyRequest.type !== "create_paseo_worktree_request") {
      throw new Error("Expected legacy worktree request");
    }
    if (newRequest.type !== "create_paseo_worktree_request") {
      throw new Error("Expected new worktree request");
    }

    await handleCreatePaseoWorktreeRequest(dependencies, legacyRequest);
    await handleCreatePaseoWorktreeRequest(dependencies, newRequest);

    expect(captured).toHaveLength(2);
    expect(captured[0]).toEqual(captured[1]);
    expect(captured[0]).toEqual({
      cwd: "/tmp/repo",
      worktreeSlug: "legacy-worktree",
      firstAgentContext: {
        prompt: "Investigate flaky test",
        attachments: [
          {
            type: "github_issue",
            mimeType: "application/github-issue",
            number: 55,
            title: "Improve startup error details",
            url: "https://github.com/getpaseo/paseo/issues/55",
          },
        ],
      },
      refName: undefined,
      action: undefined,
      githubPrNumber: undefined,
      runSetup: false,
      paseoHome: "/tmp/paseo-home",
    });
  });
});
