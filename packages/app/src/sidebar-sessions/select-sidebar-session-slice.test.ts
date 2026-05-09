import { afterEach, describe, expect, it } from "vitest";
import { shallow } from "zustand/shallow";
import type { DaemonClient } from "@server/client/daemon-client";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { selectSidebarSessionSlice } from "./select-sidebar-session-slice";

const TIMESTAMP = new Date("2026-05-08T10:00:00.000Z");

const AGENT_DEFAULTS: Agent = {
  serverId: "server-1",
  id: "agent-1",
  provider: "codex",
  status: "running",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: TIMESTAMP,
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
  runtimeInfo: undefined,
  lastUsage: undefined,
  lastError: null,
  title: "Agent",
  cwd: "/tmp/project",
  model: null,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  labels: {},
  projectPlacement: null,
};

function makeAgent(input: Partial<Agent> = {}): Agent {
  return { ...AGENT_DEFAULTS, ...input };
}

function seedAgent(agent: Agent) {
  useSessionStore.getState().initializeSession("server-1", {} as unknown as DaemonClient);
  useSessionStore.getState().setAgents("server-1", new Map([[agent.id, agent]]));
}

afterEach(() => {
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
});

describe("selectSidebarSessionSlice", () => {
  it("returns a shallow-equal slice when the agent state is unchanged", () => {
    seedAgent(makeAgent());

    const first = selectSidebarSessionSlice(useSessionStore.getState(), "server-1", "agent-1");
    const second = selectSidebarSessionSlice(useSessionStore.getState(), "server-1", "agent-1");

    expect(shallow(first, second)).toBe(true);
    expect(first).toEqual({
      title: "Agent",
      cwd: "/tmp/project",
      provider: "codex",
      lastActivityAt: TIMESTAMP,
      archivedAt: null,
    });
  });

  it("changes the row slice when lastActivityAt changes", () => {
    seedAgent(makeAgent());
    const before = selectSidebarSessionSlice(useSessionStore.getState(), "server-1", "agent-1");

    useSessionStore.getState().setAgents(
      "server-1",
      new Map([
        [
          "agent-1",
          makeAgent({
            lastActivityAt: new Date("2026-05-08T11:00:00.000Z"),
          }),
        ],
      ]),
    );

    const after = selectSidebarSessionSlice(useSessionStore.getState(), "server-1", "agent-1");

    expect(shallow(before, after)).toBe(false);
    expect(after?.lastActivityAt).toEqual(new Date("2026-05-08T11:00:00.000Z"));
  });
});
