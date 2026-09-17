import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AgentSnapshotPayloadSchema,
  AgentTimelineItemPayloadSchema,
  ServerInfoStatusPayloadSchema,
  SessionOutboundMessageSchema,
  WSHelloMessageSchema,
  WorkspaceSetupSnapshotSchema,
  WorkspaceSetupProgressMessageSchema,
  AgentTimelineEntryPayloadSchema,
} from "./messages.js";

test("terminal listings accept older rows and retain new per-terminal directories", () => {
  const response = {
    type: "list_terminals_response",
    payload: {
      requestId: "terminal-list",
      cwd: "/workspace",
      terminals: [{ id: "terminal", name: "Shell", workspaceId: "workspace" }],
    },
  };
  expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  const withDirectory = {
    ...response,
    payload: {
      ...response.payload,
      terminals: [{ ...response.payload.terminals[0], cwd: "/workspace/subdirectory" }],
    },
  };
  expect(SessionOutboundMessageSchema.parse(withDirectory)).toEqual(withDirectory);
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

const LegacyAgentCapabilityFlagsSchema = z.object({
  supportsStreaming: z.boolean(),
  supportsSessionPersistence: z.boolean(),
  supportsDynamicModes: z.boolean(),
  supportsMcpServers: z.boolean(),
  supportsReasoningStream: z.boolean(),
  supportsToolInvocations: z.boolean(),
});

const LegacyAgentSnapshotPayloadSchema = AgentSnapshotPayloadSchema.extend({
  capabilities: LegacyAgentCapabilityFlagsSchema,
});

describe("wire schema compatibility", () => {
  test("hello parses with and without the project update capability", () => {
    const legacy = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "legacy-client",
      clientType: "mobile",
      protocolVersion: 1,
    });
    const capable = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "capable-client",
      clientType: "mobile",
      protocolVersion: 1,
      capabilities: { project_updates: true },
    });

    expect([legacy, capable]).toEqual([
      {
        type: "hello",
        clientId: "legacy-client",
        clientType: "mobile",
        protocolVersion: 1,
      },
      {
        type: "hello",
        clientId: "capable-client",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { project_updates: true },
      },
    ]);
  });

  test("timeline replacement invalidation is opt-in and carries no timeline rows", () => {
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "capable-client",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { timeline_replacement_invalidation: true },
      }).capabilities,
    ).toEqual({ timeline_replacement_invalidation: true });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.timeline.replacement",
        payload: { agentId: "agent-1", epoch: "epoch-2" },
      }),
    ).toEqual({
      type: "agent.timeline.replacement",
      payload: { agentId: "agent-1", epoch: "epoch-2" },
    });
  });

  test("server info strips unknown legacy features while accepting former turn identity", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "legacy-server",
      features: {
        workspaceGithubClone: true,
        agentTurnIdentity: true,
      },
    });

    expect(parsed).toEqual({
      status: "server_info",
      serverId: "legacy-server",
      hostname: null,
      version: null,
      features: { agentTurnIdentity: true },
    });
  });

  test("assistant timeline message ids are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "old daemon shape",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "old daemon shape",
    });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "new daemon shape",
        messageId: "msg-1",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "new daemon shape",
      messageId: "msg-1",
    });
  });

  test("task progress fields are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "todo",
        items: [{ text: "Legacy task", completed: false }],
      }),
    ).toEqual({ type: "todo", items: [{ text: "Legacy task", completed: false }] });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "todo",
        items: [
          {
            id: "task-1",
            text: "Current task",
            activeForm: "Working on current task",
            status: "in_progress",
            completed: false,
          },
        ],
      }),
    ).toEqual({
      type: "todo",
      items: [
        {
          id: "task-1",
          text: "Current task",
          activeForm: "Working on current task",
          status: "in_progress",
          completed: false,
        },
      ],
    });
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

  test("old clients parse agent snapshots with rewind capabilities", () => {
    const parsed = LegacyAgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
        supportsRewindConversation: true,
        supportsRewindFiles: true,
        supportsRewindBoth: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities).toEqual({
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    });
  });

  test("new clients parse agent snapshots without rewind capabilities", () => {
    const parsed = AgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
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
    });

    expect(parsed.capabilities.supportsRewindConversation).toBe(false);
    expect(parsed.capabilities.supportsRewindFiles).toBe(false);
    expect(parsed.capabilities.supportsRewindBoth).toBe(false);
  });

  test("notification timeline items parse their level and message", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "notification",
        level: "warning",
        message: "Command blocked by user",
      }),
    ).toEqual({
      type: "notification",
      level: "warning",
      message: "Command blocked by user",
    });
  });
});

test("0.8 timeline and setup capabilities remain optional in the hello", () => {
  const hello = { type: "hello", clientId: "compat", clientType: "mobile", protocolVersion: 1 };
  expect(WSHelloMessageSchema.safeParse(hello).success).toBe(true);
  expect(
    WSHelloMessageSchema.parse({
      ...hello,
      capabilities: { plugin_timeline_items: true, workspace_setup_blocked: true },
    }).capabilities,
  ).toEqual({ plugin_timeline_items: true, workspace_setup_blocked: true });
});

test("plugin rows and identity merges require a capable receiver", () => {
  const item = {
    type: "plugin",
    id: "task",
    pluginId: "tasks",
    kind: "tasks",
    version: 1,
    data: { text: "Working" },
  };
  expect(AgentTimelineItemPayloadSchema.parse(item)).toEqual(item);
  const legacyItems = z.object({
    type: z.enum([
      "user_message",
      "assistant_message",
      "reasoning",
      "tool_call",
      "todo",
      "error",
      "notification",
      "compaction",
    ]),
  });
  expect(legacyItems.safeParse(item).success).toBe(false);
  const entry = {
    provider: "codex",
    item,
    timestamp: "2026-09-07T00:00:00.000Z",
    seqStart: 1,
    seqEnd: 2,
    sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
    collapsed: ["identity"],
  };
  expect(AgentTimelineEntryPayloadSchema.parse(entry)).toEqual(entry);
  const legacyCollapsed = z.array(z.enum(["assistant_merge", "reasoning_merge", "tool_lifecycle"]));
  expect(legacyCollapsed.safeParse(entry.collapsed).success).toBe(false);
});

test("blocked setup preserves the legacy failed shape and optional provenance", () => {
  const snapshot = {
    status: "blocked",
    error: null,
    detail: {
      type: "worktree_setup",
      worktreePath: "/workspace",
      branchName: "fork",
      log: "",
      commands: [],
    },
    blockedSource: {
      kind: "change_request",
      forge: "github",
      number: 42,
      headRepository: "contributor/project",
    },
  };
  expect(WorkspaceSetupSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  const legacyStatus = z.enum(["running", "completed", "failed"]);
  const legacySnapshot = WorkspaceSetupSnapshotSchema.omit({ blockedSource: true }).extend({
    status: legacyStatus,
  });
  expect(legacySnapshot.safeParse(snapshot).success).toBe(false);
  const failed = { ...snapshot, status: "failed", error: "Update Paseo to review and run setup." };
  expect(legacySnapshot.safeParse(failed).success).toBe(true);
  const progress = {
    type: "workspace_setup_progress",
    payload: { ...failed, workspaceId: "workspace" },
  };
  expect(WorkspaceSetupProgressMessageSchema.parse(progress)).toEqual(progress);
  expect(WorkspaceSetupSnapshotSchema.parse(legacySnapshot.parse(failed))).toEqual(
    legacySnapshot.parse(failed),
  );
});
