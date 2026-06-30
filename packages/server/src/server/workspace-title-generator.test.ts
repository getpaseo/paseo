import { describe, expect, it } from "vitest";
import {
  generateWorkspaceTitleFromActivity,
  isStructuredGenerationFailure,
} from "./workspace-title-generator.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentTimelineRow } from "./agent/agent-timeline-store-types.js";
import type { AgentSnapshot } from "./agent/agent-snapshot.js";
import { createTestLogger } from "../test-utils/test-logger.js";

function agentSnapshot(input: {
  id: string;
  workspaceId: string;
  title?: string;
  internal?: boolean;
  provider?: string;
  model?: string;
  updatedAt?: Date;
}): AgentSnapshot {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    title: input.title ?? input.id,
    internal: input.internal ?? false,
    cwd: "/repo",
    provider: input.provider ?? "claude",
    modeId: null,
    model: input.model ?? "claude-sonnet-4-20250514",
    lifecycle: "idle",
    status: "idle",
    createdAt: new Date(),
    updatedAt: input.updatedAt ?? new Date(),
    lastError: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    parentAgentId: null,
    labels: {},
    config: {
      provider: input.provider ?? "claude",
      cwd: "/repo",
      title: input.title ?? input.id,
      model: input.model ?? "claude-sonnet-4-20250514",
    },
  } as AgentSnapshot;
}

function createMockAgentManager(input: {
  agents?: AgentSnapshot[];
  rowsByAgentId?: Record<string, AgentTimelineRow[]>;
}): AgentManager {
  const agents = input.agents ?? [];
  const rowsByAgentId = input.rowsByAgentId ?? {};
  return {
    listAgents: () => agents,
    getAgent: (agentId: string) => agents.find((a) => a.id === agentId) ?? null,
    getTimelineRows: async (agentId: string) => rowsByAgentId[agentId] ?? [],
  } as unknown as AgentManager;
}

function baseOptions(input: {
  workspaceId?: string;
  agentManager: AgentManager;
  generator?: () => Promise<{ title: string }>;
}): Parameters<typeof generateWorkspaceTitleFromActivity>[0] {
  return {
    workspaceId: input.workspaceId ?? "ws-1",
    cwd: "/repo",
    agentManager: input.agentManager,
    logger: createTestLogger(),
    ...(input.generator
      ? { deps: { generateStructuredAgentResponseWithFallback: input.generator } }
      : {}),
  };
}

describe("generateWorkspaceTitleFromActivity", () => {
  it("returns null when there are no agents in the workspace", async () => {
    const title = await generateWorkspaceTitleFromActivity(
      baseOptions({ agentManager: createMockAgentManager({ agents: [] }) }),
    );
    expect(title).toBeNull();
  });

  it("returns null when there is no curatable activity", async () => {
    const title = await generateWorkspaceTitleFromActivity(
      baseOptions({
        agentManager: createMockAgentManager({
          agents: [agentSnapshot({ id: "agent-1", workspaceId: "ws-1" })],
          rowsByAgentId: { "agent-1": [] },
        }),
      }),
    );
    expect(title).toBeNull();
  });

  it("returns the generated title from curated activity", async () => {
    const title = await generateWorkspaceTitleFromActivity(
      baseOptions({
        agentManager: createMockAgentManager({
          agents: [agentSnapshot({ id: "agent-1", workspaceId: "ws-1" })],
          rowsByAgentId: {
            "agent-1": [
              {
                seq: 1,
                timestamp: "2026-06-28T00:00:00.000Z",
                item: { type: "user_message", text: "Fix the sidebar icon" },
              },
            ],
          },
        }),
        generator: async () => ({ title: "Sidebar icon fix" }),
      }),
    );
    expect(title).toBe("Sidebar icon fix");
  });

  it("uses the most recently active agent's provider and model", async () => {
    let capturedProvider: string | undefined;
    let capturedModel: string | undefined;
    const generator = async (options: {
      providers: readonly { provider: string; model?: string }[];
    }) => {
      capturedProvider = options.providers[0]?.provider;
      capturedModel = options.providers[0]?.model;
      return { title: "Derived title" };
    };

    await generateWorkspaceTitleFromActivity(
      baseOptions({
        agentManager: createMockAgentManager({
          agents: [
            agentSnapshot({
              id: "agent-old",
              workspaceId: "ws-1",
              provider: "claude",
              model: "claude-old",
              updatedAt: new Date("2026-06-28T00:00:00.000Z"),
            }),
            agentSnapshot({
              id: "agent-new",
              workspaceId: "ws-1",
              provider: "codex",
              model: "codex-new",
              updatedAt: new Date("2026-06-29T00:00:00.000Z"),
            }),
          ],
          rowsByAgentId: {
            "agent-old": [
              {
                seq: 1,
                timestamp: "2026-06-28T00:00:00.000Z",
                item: { type: "user_message", text: "old" },
              },
            ],
            "agent-new": [
              {
                seq: 1,
                timestamp: "2026-06-29T00:00:00.000Z",
                item: { type: "user_message", text: "new" },
              },
            ],
          },
        }),
        generator: generator as unknown as () => Promise<{ title: string }>,
      }),
    );

    expect(capturedProvider).toBe("codex");
    expect(capturedModel).toBe("codex-new");
  });

  it("ignores internal agents", async () => {
    const title = await generateWorkspaceTitleFromActivity(
      baseOptions({
        agentManager: createMockAgentManager({
          agents: [agentSnapshot({ id: "agent-1", workspaceId: "ws-1", internal: true })],
          rowsByAgentId: {
            "agent-1": [
              {
                seq: 1,
                timestamp: "2026-06-28T00:00:00.000Z",
                item: { type: "user_message", text: "Fix the sidebar icon" },
              },
            ],
          },
        }),
      }),
    );
    expect(title).toBeNull();
  });

  it("returns null when structured generation fails", async () => {
    const title = await generateWorkspaceTitleFromActivity(
      baseOptions({
        agentManager: createMockAgentManager({
          agents: [agentSnapshot({ id: "agent-1", workspaceId: "ws-1" })],
          rowsByAgentId: {
            "agent-1": [
              {
                seq: 1,
                timestamp: "2026-06-28T00:00:00.000Z",
                item: { type: "user_message", text: "Fix the sidebar icon" },
              },
            ],
          },
        }),
        generator: async () => {
          throw new Error("generation failed");
        },
      }),
    );
    expect(title).toBeNull();
  });
});

describe("isStructuredGenerationFailure", () => {
  it("returns false for plain errors", () => {
    expect(isStructuredGenerationFailure(new Error("plain"))).toBe(false);
  });
});
