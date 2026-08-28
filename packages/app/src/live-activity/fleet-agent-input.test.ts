import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import type { TodoEntry } from "@/types/stream";
import { deriveFleetAgentInputs } from "./fleet-agent-input";

const NOW = new Date("2026-04-01T03:00:00.000Z");

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    serverId: "server-a",
    id: "agent-12345678",
    provider: "codex",
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    lastUserMessageAt: null,
    lastActivityAt: NOW,
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
    title: "My Agent",
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels: {},
    archivedAt: null,
    ...overrides,
    activeTurn: overrides.activeTurn ?? null,
  };
}

function derive(agents: Agent[], agentTasks: ReadonlyMap<string, TodoEntry[]> = new Map()) {
  return deriveFleetAgentInputs(new Map(agents.map((agent) => [agent.id, agent])), agentTasks);
}

describe("deriveFleetAgentInputs", () => {
  it("excludes archived agents", () => {
    const agent = makeAgent({ archivedAt: NOW });
    expect(derive([agent])).toEqual([]);
  });

  it("excludes closed agents", () => {
    const agent = makeAgent({ status: "closed" });
    expect(derive([agent])).toEqual([]);
  });

  it("excludes initializing agents", () => {
    const agent = makeAgent({ status: "initializing" });
    expect(derive([agent])).toEqual([]);
  });

  it("marks running agents and reads runningSinceMs from activeTurn.startedAt", () => {
    const startedAt = new Date("2026-04-01T02:00:00.000Z");
    const agent = makeAgent({ status: "running", activeTurn: { turnId: "t1", startedAt } });
    const [input] = derive([agent]);
    expect(input?.running).toBe(true);
    expect(input?.runningSinceMs).toBe(startedAt.getTime());
  });

  it("falls back to lastUserMessageAt when activeTurn.startedAt is unavailable", () => {
    const lastUserMessageAt = new Date("2026-04-01T01:00:00.000Z");
    const agent = makeAgent({ status: "running", activeTurn: null, lastUserMessageAt });
    const [input] = derive([agent]);
    expect(input?.runningSinceMs).toBe(lastUserMessageAt.getTime());
  });

  it("falls back to updatedAt when activeTurn and lastUserMessageAt are unavailable", () => {
    const updatedAt = new Date("2026-04-01T00:30:00.000Z");
    const agent = makeAgent({
      status: "running",
      activeTurn: null,
      lastUserMessageAt: null,
      updatedAt,
    });
    const [input] = derive([agent]);
    expect(input?.runningSinceMs).toBe(updatedAt.getTime());
  });

  it("omits runningSinceMs and marks running false for non-running agents", () => {
    const agent = makeAgent({ status: "idle", activeTurn: { turnId: "t1", startedAt: NOW } });
    const [input] = derive([agent]);
    expect(input?.running).toBe(false);
    expect(input?.runningSinceMs).toBeUndefined();
  });

  it("marks error agents from status", () => {
    const agent = makeAgent({ status: "error" });
    const [input] = derive([agent]);
    expect(input?.error).toBe(true);
  });

  it("maps a pending permission, preferring title over name for toolName", () => {
    const attentionTimestamp = new Date("2026-04-01T02:45:00.000Z");
    const agent = makeAgent({
      status: "idle",
      attentionTimestamp,
      pendingPermissions: [
        {
          id: "p1",
          provider: "codex",
          name: "bash",
          kind: "tool",
          title: "Run bash",
          description: "ls -la\nmore",
        },
      ],
    });
    const [input] = derive([agent]);
    expect(input?.pendingPermission).toEqual({
      toolName: "Run bash",
      detail: "ls -la",
      sinceMs: attentionTimestamp.getTime(),
    });
  });

  it("falls back to name when a pending permission has no title", () => {
    const agent = makeAgent({
      pendingPermissions: [{ id: "p1", provider: "codex", name: "bash", kind: "tool" }],
    });
    const [input] = derive([agent]);
    expect(input?.pendingPermission?.toolName).toBe("bash");
  });

  it("falls back to the input's first line when a pending permission has no description", () => {
    const agent = makeAgent({
      pendingPermissions: [
        {
          id: "p1",
          provider: "codex",
          name: "bash",
          kind: "tool",
          input: { command: "rm -rf /tmp\nnext" },
        },
      ],
    });
    const [input] = derive([agent]);
    expect(input?.pendingPermission?.detail).toBe(JSON.stringify({ command: "rm -rf /tmp\nnext" }));
  });

  it("falls back to lastActivityAt for a pending permission's sinceMs when attentionTimestamp is unset", () => {
    const lastActivityAt = new Date("2026-04-01T02:10:00.000Z");
    const agent = makeAgent({
      lastActivityAt,
      attentionTimestamp: null,
      pendingPermissions: [{ id: "p1", provider: "codex", name: "bash", kind: "tool" }],
    });
    const [input] = derive([agent]);
    expect(input?.pendingPermission?.sinceMs).toBe(lastActivityAt.getTime());
  });

  it("sets needsAttentionSinceMs when requiresAttention is true and the reason is not finished", () => {
    const attentionTimestamp = new Date("2026-04-01T02:50:00.000Z");
    const agent = makeAgent({
      requiresAttention: true,
      attentionReason: "error",
      attentionTimestamp,
    });
    const [input] = derive([agent]);
    expect(input?.needsAttentionSinceMs).toBe(attentionTimestamp.getTime());
  });

  it("omits needsAttentionSinceMs when the attention reason is finished", () => {
    const agent = makeAgent({
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: NOW,
    });
    const [input] = derive([agent]);
    expect(input?.needsAttentionSinceMs).toBeUndefined();
  });

  it("omits needsAttentionSinceMs when requiresAttention is not set", () => {
    const agent = makeAgent({ requiresAttention: undefined, attentionTimestamp: NOW });
    const [input] = derive([agent]);
    expect(input?.needsAttentionSinceMs).toBeUndefined();
  });

  it("reads phase and todo progress from agentTasks when present", () => {
    const agent = makeAgent({ id: "agent-1" });
    const tasks: TodoEntry[] = [
      { text: "Read file", completed: true, status: "completed" },
      { text: "Edit file", activeForm: "Editing file", completed: false, status: "in_progress" },
      { text: "Run tests", completed: false, status: "pending" },
    ];
    const [input] = derive([agent], new Map([["agent-1", tasks]]));
    expect(input?.phase).toBe("Editing file");
    expect(input?.todoDone).toBe(1);
    expect(input?.todoTotal).toBe(3);
  });

  it("omits phase and todo progress when the agent has no entry in agentTasks", () => {
    const agent = makeAgent({ id: "agent-1" });
    const [input] = derive([agent], new Map());
    expect(input?.phase).toBeUndefined();
    expect(input?.todoDone).toBeUndefined();
    expect(input?.todoTotal).toBeUndefined();
  });

  it("sets errorSinceMs from attentionTimestamp, falling back to lastActivityAt and updatedAt", () => {
    const attentionTimestamp = new Date("2026-04-01T02:55:00.000Z");
    const lastActivityAt = new Date("2026-04-01T02:10:00.000Z");
    const updatedAt = new Date("2026-04-01T01:00:00.000Z");

    const withAttention = makeAgent({ status: "error", attentionTimestamp });
    const withLastActivity = makeAgent({
      status: "error",
      attentionTimestamp: null,
      lastActivityAt,
    });
    const withUpdatedAt = makeAgent({
      status: "error",
      attentionTimestamp: null,
      lastActivityAt: updatedAt,
      updatedAt,
    });

    expect(derive([withAttention])[0]?.errorSinceMs).toBe(attentionTimestamp.getTime());
    expect(derive([withLastActivity])[0]?.errorSinceMs).toBe(lastActivityAt.getTime());
    expect(derive([withUpdatedAt])[0]?.errorSinceMs).toBe(updatedAt.getTime());
  });

  it("falls back to the agent's title, or 'Agent <shortId>' when title is null", () => {
    const titled = makeAgent({ id: "agent-1", title: "Named agent" });
    const untitled = makeAgent({ id: "agent-abcdefgh12345", title: null });
    const [titledInput, untitledInput] = derive([titled, untitled]);
    expect(titledInput?.title).toBe("Named agent");
    expect(untitledInput?.title).toBe("Agent agent-ab");
  });
});
