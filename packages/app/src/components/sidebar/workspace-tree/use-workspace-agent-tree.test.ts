import { describe, expect, it } from "vitest";
import {
  selectPaseoAgentNodes,
  selectProviderSubagentNodesForWorkspace,
} from "./use-workspace-agent-tree";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { Agent, SessionState } from "@/stores/session-store";

const SERVER_ID = "srv";
const EMPTY_DESCRIPTORS = new Map<string, ProviderSubagentDescriptorPayload>();
const EMPTY_HIDDEN = new Set<string>();

function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id">): Agent {
  return {
    serverId: SERVER_ID,
    provider: "claude",
    status: "idle",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels: {},
    archivedAt: null,
    ...overrides,
  } as Agent;
}

function makeSession(agents: Agent[]): { sessions: Record<string, SessionState | undefined> } {
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  return {
    sessions: {
      [SERVER_ID]: {
        serverId: SERVER_ID,
        client: null,
        clientGeneration: 0,
        viewedTimelineSync: null,
        serverInfo: null,
        hasHydratedAgents: true,
        hasHydratedWorkspaces: true,
        isPlayingAudio: false,
        focusedAgentId: null,
        focusedTerminalId: null,
        messages: [],
        currentAssistantMessage: "",
        agentStreamTail: new Map(),
        agentStreamHead: new Map(),
        agentTimelineCursor: new Map(),
        agentTimelineHasOlder: new Map(),
        agentTimelineOlderFetchInFlight: new Map(),
        historySyncGeneration: 0,
        agentHistorySyncGeneration: new Map(),
        agentAuthoritativeHistoryApplied: new Map(),
        initializingAgents: new Map(),
        agents: agentMap,
        workspaceAgentActivity: new Map(),
        agentDetails: new Map(),
        workspaces: new Map(),
        emptyProjects: new Map(),
        restoringWorkspaces: new Map(),
        pendingPermissions: new Map(),
        fileExplorer: new Map(),
        queuedMessages: new Map(),
      },
    },
  };
}

const WORKSPACE_ID = "wks_test";

function callPaseo(state: ReturnType<typeof makeSession>) {
  return selectPaseoAgentNodes(state.sessions, SERVER_ID, WORKSPACE_ID);
}

function callProvider(
  state: ReturnType<typeof makeSession>,
  descriptors: Map<string, ProviderSubagentDescriptorPayload> = EMPTY_DESCRIPTORS,
  hidden: Set<string> = EMPTY_HIDDEN,
) {
  const paseoNodes = callPaseo(state);
  return selectProviderSubagentNodesForWorkspace(
    descriptors,
    hidden,
    SERVER_ID,
    new Set(paseoNodes.map((n) => n.id)),
  );
}

describe("selectPaseoAgentNodes", () => {
  it("returns root agents whose workspaceId matches", () => {
    const state = makeSession([
      makeAgent({ id: "root", workspaceId: WORKSPACE_ID }),
      makeAgent({ id: "other", workspaceId: "wks_other" }),
    ]);
    const nodes = callPaseo(state);
    expect(nodes.map((n) => n.id)).toEqual(["root"]);
  });

  it("includes same-workspace subagents", () => {
    const state = makeSession([
      makeAgent({ id: "parent", workspaceId: WORKSPACE_ID }),
      makeAgent({ id: "child", workspaceId: WORKSPACE_ID, parentAgentId: "parent" }),
    ]);
    const nodes = callPaseo(state);
    expect(nodes.map((n) => n.id).sort()).toEqual(["child", "parent"]);
  });

  it("includes subagents whose workspaceId is unset", () => {
    const state = makeSession([
      makeAgent({ id: "parent", workspaceId: WORKSPACE_ID }),
      makeAgent({ id: "child", workspaceId: undefined, parentAgentId: "parent" }),
    ]);
    const nodes = callPaseo(state);
    expect(nodes.map((n) => n.id).sort()).toEqual(["child", "parent"]);
  });

  it("includes subagents whose workspaceId differs from the parent", () => {
    const state = makeSession([
      makeAgent({ id: "parent", workspaceId: WORKSPACE_ID }),
      makeAgent({ id: "cross-child", workspaceId: "wks_other", parentAgentId: "parent" }),
    ]);
    const nodes = callPaseo(state);
    expect(nodes.map((n) => n.id).sort()).toEqual(["cross-child", "parent"]);
  });

  it("includes nested subagents to arbitrary depth by parentage", () => {
    const state = makeSession([
      makeAgent({ id: "root", workspaceId: WORKSPACE_ID }),
      makeAgent({ id: "child", workspaceId: undefined, parentAgentId: "root" }),
      makeAgent({ id: "grandchild", workspaceId: undefined, parentAgentId: "child" }),
    ]);
    const nodes = callPaseo(state);
    expect(nodes.map((n) => n.id).sort()).toEqual(["child", "grandchild", "root"]);
  });

  it("excludes archived agents", () => {
    const state = makeSession([
      makeAgent({ id: "live", workspaceId: WORKSPACE_ID }),
      makeAgent({
        id: "archived",
        workspaceId: WORKSPACE_ID,
        archivedAt: new Date("2026-01-02T00:00:00.000Z"),
      }),
    ]);
    const nodes = callPaseo(state);
    expect(nodes.map((n) => n.id)).toEqual(["live"]);
  });

  it("returns empty for an unknown server", () => {
    const state = makeSession([]);
    const nodes = selectPaseoAgentNodes(state.sessions, "unknown", WORKSPACE_ID);
    expect(nodes).toEqual([]);
  });

  it("degrades an unparseable createdAt to 0 rather than NaN", () => {
    // NaN here would silently randomize sibling ordering in the tree sort.
    const state = makeSession([
      makeAgent({ id: "bad-date", workspaceId: WORKSPACE_ID, createdAt: new Date("nope") }),
    ]);
    const nodes = callPaseo(state);
    expect(nodes.map((n) => n.createdAt)).toEqual([0]);
  });

  it("collects a deep subagent chain in one pass", () => {
    const state = makeSession([
      makeAgent({ id: "root", workspaceId: WORKSPACE_ID }),
      makeAgent({ id: "d1", workspaceId: undefined, parentAgentId: "root" }),
      makeAgent({ id: "d2", workspaceId: undefined, parentAgentId: "d1" }),
      makeAgent({ id: "d3", workspaceId: undefined, parentAgentId: "d2" }),
      makeAgent({ id: "d4", workspaceId: undefined, parentAgentId: "d3" }),
      makeAgent({ id: "unrelated", workspaceId: "wks_other" }),
    ]);
    const nodes = callPaseo(state);
    expect(nodes.map((n) => n.id).sort()).toEqual(["d1", "d2", "d3", "d4", "root"]);
  });
});

describe("selectProviderSubagentNodesForWorkspace", () => {
  it("includes provider subagents parented to a Paseo agent in the workspace", () => {
    const state = makeSession([
      makeAgent({ id: "parent", workspaceId: WORKSPACE_ID, provider: "omp" }),
    ]);
    const descriptors = new Map<string, ProviderSubagentDescriptorPayload>([
      [
        `${SERVER_ID}\0parent\0prov-child`,
        {
          id: "prov-child",
          parentAgentId: "parent",
          provider: "omp",
          title: "Explore repo",
          description: null,
          status: "running",
          createdAt: "2026-01-01T00:01:00.000Z",
          updatedAt: "2026-01-01T00:02:00.000Z",
          toolCallId: null,
        },
      ],
    ]);
    const nodes = callProvider(state, descriptors);
    expect(nodes.map((n) => n.id)).toEqual(["prov-child"]);
    expect(nodes[0]!.kind).toBe("provider");
    expect(nodes[0]!.parentAgentId).toBe("parent");
    expect(nodes[0]!.status).toBe("running");
  });

  it("excludes provider subagents whose parent is not in the workspace", () => {
    const state = makeSession([makeAgent({ id: "parent", workspaceId: WORKSPACE_ID })]);
    const descriptors = new Map<string, ProviderSubagentDescriptorPayload>([
      [
        `${SERVER_ID}\0other-agent\0prov-child`,
        {
          id: "prov-child",
          parentAgentId: "other-agent",
          provider: "omp",
          title: "Orphan",
          description: null,
          status: "running",
          createdAt: "2026-01-01T00:01:00.000Z",
          updatedAt: "2026-01-01T00:02:00.000Z",
          toolCallId: null,
        },
      ],
    ]);
    const nodes = callProvider(state, descriptors);
    expect(nodes).toEqual([]);
  });

  it("excludes hidden provider subagents", () => {
    const state = makeSession([makeAgent({ id: "parent", workspaceId: WORKSPACE_ID })]);
    const key = `${SERVER_ID}\0parent\0hidden-child`;
    const descriptors = new Map<string, ProviderSubagentDescriptorPayload>([
      [
        key,
        {
          id: "hidden-child",
          parentAgentId: "parent",
          provider: "omp",
          title: "Finished",
          description: null,
          status: "completed",
          createdAt: "2026-01-01T00:01:00.000Z",
          updatedAt: "2026-01-01T00:02:00.000Z",
          toolCallId: null,
        },
      ],
    ]);
    const nodes = callProvider(state, descriptors, new Set([key]));
    expect(nodes).toEqual([]);
  });

  it("returns empty when there are no descriptors", () => {
    const state = makeSession([makeAgent({ id: "parent", workspaceId: WORKSPACE_ID })]);
    const nodes = callProvider(state);
    expect(nodes).toEqual([]);
  });
});
