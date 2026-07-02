import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import { findAgentIdForProviderSession } from "./find-agent-for-provider-session";
import { useSessionStore, type Agent } from "@/stores/session-store";

const SERVER_ID = "server-1";
const AGENT_TIMESTAMP = new Date("2026-03-08T10:00:00.000Z");

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: "agent",
  provider: "opencode",
  status: "idle",
  createdAt: AGENT_TIMESTAMP,
  updatedAt: AGENT_TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: AGENT_TIMESTAMP,
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
  features: undefined,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  parentAgentId: null,
  labels: {},
  projectPlacement: null,
};

function makeAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  return { ...AGENT_DEFAULTS, ...input };
}

function initializeSession(): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
});

describe("findAgentIdForProviderSession", () => {
  it("finds the agent bound to the session id via its persistence handle", () => {
    initializeSession();
    useSessionStore.getState().setAgents(
      SERVER_ID,
      new Map([
        [
          "parent",
          makeAgent({ id: "parent", persistence: { provider: "opencode", sessionId: "ses_root" } }),
        ],
        [
          "imported",
          makeAgent({
            id: "imported",
            persistence: { provider: "opencode", sessionId: "ses_child" },
          }),
        ],
      ]),
    );

    expect(
      findAgentIdForProviderSession(useSessionStore.getState(), {
        serverId: SERVER_ID,
        sessionId: "ses_child",
      }),
    ).toBe("imported");
  });

  it("falls back to agentDetails when the agent is not in the list map", () => {
    initializeSession();
    useSessionStore.getState().setAgentDetails(
      SERVER_ID,
      new Map([
        [
          "detail",
          makeAgent({
            id: "detail",
            persistence: { provider: "opencode", sessionId: "ses_detail" },
          }),
        ],
      ]),
    );

    expect(
      findAgentIdForProviderSession(useSessionStore.getState(), {
        serverId: SERVER_ID,
        sessionId: "ses_detail",
      }),
    ).toBe("detail");
  });

  it("returns null when no agent is bound to the session id", () => {
    initializeSession();
    useSessionStore.getState().setAgents(
      SERVER_ID,
      new Map([
        [
          "parent",
          makeAgent({ id: "parent", persistence: { provider: "opencode", sessionId: "ses_root" } }),
        ],
        ["no-handle", makeAgent({ id: "no-handle" })],
      ]),
    );

    expect(
      findAgentIdForProviderSession(useSessionStore.getState(), {
        serverId: SERVER_ID,
        sessionId: "ses_missing",
      }),
    ).toBe(null);
    expect(
      findAgentIdForProviderSession(useSessionStore.getState(), {
        serverId: "unknown-server",
        sessionId: "ses_root",
      }),
    ).toBe(null);
  });
});
