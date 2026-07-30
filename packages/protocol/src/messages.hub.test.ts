import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  HubMessageCorrelationError,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  parseHubExecutionOutboundMessage,
} from "./messages.js";

const agent = {
  id: "agent-1",
  provider: "codex",
  cwd: "/workspace",
  model: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: false,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
    supportsRewindConversation: false,
    supportsRewindFiles: false,
    supportsRewindBoth: false,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: null,
  labels: {},
};

// Frozen at the Hub create request shape shipped before worktree.
const PreviousHubAgentCreateRequestSchema = z.object({
  type: z.literal("hub.execution.agent.create.request"),
  requestId: z.string(),
  executionId: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
  prompt: z.string(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

// Frozen at the Hub create request shape that temporarily carried turn-based auto-archive policy.
const PreviousHubAgentCreateWithAutoArchiveRequestSchema =
  PreviousHubAgentCreateRequestSchema.extend({
    worktree: z
      .object({
        mode: z.literal("branch-off"),
        newBranch: z.string(),
        base: z.string().optional(),
      })
      .optional(),
    autoArchive: z.boolean().optional(),
  });

describe("Hub session protocol", () => {
  test("accepts the Hub execution create request", () => {
    const message = {
      type: "hub.execution.agent.create.request",
      requestId: "request-1",
      executionId: "execution-1",
      provider: "codex",
      cwd: "/workspace",
      prompt: "Implement the requested change",
      modeId: "code",
    };

    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  test.each([
    undefined,
    { mode: "branch-off", newBranch: "hub-work", base: "main" },
    { mode: "checkout-branch", branch: "existing-work" },
    { mode: "checkout-pr", prNumber: 42 },
  ])("accepts Hub create worktree target %#", (worktree) => {
    const message = {
      type: "hub.execution.agent.create.request",
      requestId: "hub-worktree",
      executionId: "execution-worktree",
      provider: "codex",
      cwd: "/repo",
      prompt: "Work in the requested target",
      ...(worktree ? { worktree } : {}),
    };

    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  test("accepts old Hub creates while ignoring their removed auto-archive policy", () => {
    const oldRequest = {
      type: "hub.execution.agent.create.request" as const,
      requestId: "hub-old-policy",
      executionId: "execution-old-policy",
      provider: "codex",
      cwd: "/repo",
      prompt: "Work in the requested target",
      worktree: { mode: "branch-off" as const, newBranch: "hub-work", base: "main" },
      autoArchive: true,
    };

    expect(PreviousHubAgentCreateWithAutoArchiveRequestSchema.parse(oldRequest)).toEqual(
      oldRequest,
    );
    expect(SessionInboundMessageSchema.parse(oldRequest)).toEqual({
      type: "hub.execution.agent.create.request",
      requestId: "hub-old-policy",
      executionId: "execution-old-policy",
      provider: "codex",
      cwd: "/repo",
      prompt: "Work in the requested target",
      worktree: { mode: "branch-off", newBranch: "hub-work", base: "main" },
    });
  });

  test.each(["interrupt", "archive"] as const)(
    "round-trips the Hub execution %s command",
    (action) => {
      const request = {
        type: "hub.execution.control.request" as const,
        requestId: `control-${action}`,
        executionId: "execution-1",
        action,
      };
      const response = {
        type: "hub.execution.control.response" as const,
        payload: {
          requestId: request.requestId,
          executionId: request.executionId,
          action,
          success: true,
          error: null,
        },
      };

      expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
      expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
      expect(parseHubExecutionOutboundMessage(response)).toEqual(response);
    },
  );

  test("the previous Hub create parser ignores additive worktree and auto-archive fields", () => {
    const newRequest = {
      type: "hub.execution.agent.create.request" as const,
      requestId: "hub-worktree",
      executionId: "execution-worktree",
      provider: "codex",
      cwd: "/repo",
      prompt: "Work in the requested target",
      worktree: { mode: "branch-off", newBranch: "hub-work", base: "main" },
      autoArchive: true,
    };

    expect(PreviousHubAgentCreateRequestSchema.parse(newRequest)).toEqual({
      type: "hub.execution.agent.create.request",
      requestId: "hub-worktree",
      executionId: "execution-worktree",
      provider: "codex",
      cwd: "/repo",
      prompt: "Work in the requested target",
    });
  });

  test.each([
    {
      type: "hub.execution.agent.create.response",
      payload: {
        requestId: "request-1",
        executionId: "execution-1",
        agentId: "agent-1",
        agent,
        success: true,
        error: null,
      },
    },
    {
      type: "hub.execution.control.response",
      payload: {
        requestId: "control-1",
        executionId: "execution-1",
        action: "archive",
        success: false,
        error: "Execution not found",
      },
    },
    {
      type: "hub.execution.agent.update",
      payload: { executionId: "execution-1", agentId: "agent-1", agent },
    },
    {
      type: "hub.execution.agent.stream",
      payload: {
        executionId: "execution-1",
        agentId: "agent-1",
        event: { type: "turn_started", provider: "codex" },
      },
    },
  ])("accepts outbound variant $type", (message) => {
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    expect(parseHubExecutionOutboundMessage(message)).toEqual(message);
  });

  test("rejects a Hub update whose correlated agent ids disagree", () => {
    const malformed = {
      type: "hub.execution.agent.update",
      payload: { executionId: "execution-1", agentId: "agent-2", agent },
    };

    expect(SessionOutboundMessageSchema.safeParse(malformed).success).toBe(true);
    expect(() => parseHubExecutionOutboundMessage(malformed)).toThrow(HubMessageCorrelationError);
  });

  test.each([
    {
      type: "hub.management.daemon.connect.request",
      requestId: "r1",
      hubUrl: "https://hub.example",
      token: "token",
    },
    { type: "hub.management.daemon.get_status.request", requestId: "r2" },
    { type: "hub.management.daemon.disconnect.request", requestId: "r3", force: true },
  ])("accepts trusted management request $type", (message) => {
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  test.each([
    {
      type: "hub.management.daemon.connect.response",
      payload: {
        requestId: "r1",
        status: {
          state: "connected",
          daemonId: "daemon-1",
          hubOrigin: "https://hub.example",
          scopes: ["hub.execution.*"],
          connectedAt: "2026-07-13T00:00:00.000Z",
          lastError: null,
        },
      },
    },
    {
      type: "hub.management.daemon.get_status.response",
      payload: {
        requestId: "r2",
        status: {
          state: "not_connected",
          daemonId: null,
          hubOrigin: null,
          scopes: [],
          connectedAt: null,
          lastError: null,
        },
      },
    },
    {
      type: "hub.management.daemon.disconnect.response",
      payload: {
        requestId: "r3",
        status: {
          state: "disconnecting",
          daemonId: "daemon-1",
          hubOrigin: "https://hub.example",
          scopes: ["hub.execution.*"],
          connectedAt: null,
          lastError: "offline",
        },
        warning: "pending",
      },
    },
  ])("accepts trusted management response $type", (message) => {
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });
});
