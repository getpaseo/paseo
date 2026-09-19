import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DaemonClient,
  WorkspaceLabelListPayload,
} from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLabels } from "@/workspace-labels";
import { DirectorySync } from "./index";

type WorkspaceFetchResult = Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>;
type ProjectListResult = Awaited<ReturnType<DaemonClient["listProjects"]>>;
type AgentFetchResult = Awaited<ReturnType<DaemonClient["fetchAgents"]>>;

class SupportedDirectoryClient {
  listWorkspaceLabelsCalls = 0;
  private readonly handlers = new Map<
    SessionOutboundMessage["type"],
    Set<(message: SessionOutboundMessage) => void>
  >();

  on<TType extends SessionOutboundMessage["type"]>(
    type: TType,
    handler: (message: Extract<SessionOutboundMessage, { type: TType }>) => void,
  ): () => void {
    const handlers = this.handlers.get(type) ?? new Set();
    const registered = handler as unknown as (message: SessionOutboundMessage) => void;
    handlers.add(registered);
    this.handlers.set(type, handlers);
    return () => handlers.delete(registered);
  }

  async fetchAgents(): Promise<AgentFetchResult> {
    return {
      requestId: "agents",
      entries: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    };
  }

  async fetchWorkspaces(): Promise<WorkspaceFetchResult> {
    return {
      requestId: "workspaces",
      entries: [],
      emptyProjects: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    };
  }

  async listProjects(): Promise<ProjectListResult> {
    return { requestId: "projects", projects: [] };
  }

  async listWorkspaceLabels(): Promise<WorkspaceLabelListPayload> {
    this.listWorkspaceLabelsCalls += 1;
    return {
      requestId: "workspace-labels",
      labels: [{ name: "Urgent", color: "red" }],
      sync: { mode: "snapshot", removals: [], generation: "generation-1", headSeq: 0 },
    };
  }

  getLastServerInfoMessage() {
    return { features: { workspaceLabels: true } };
  }
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await vi.runAllTimersAsync();
  }
}

function createDirectory(serverId: string): {
  client: SupportedDirectoryClient;
  directory: DirectorySync;
} {
  const client = new SupportedDirectoryClient();
  const directory = new DirectorySync(serverId, {
    onAgentStoppedRunning: () => undefined,
    markAgentLoading: () => undefined,
    markAgentReady: () => undefined,
    markAgentError: () => undefined,
  });
  directory.connectionChanged({
    client: client as unknown as DaemonClient,
    status: "online",
    source: { clientGeneration: 1, connectionEpoch: 1 },
  });
  const store = useSessionStore.getState();
  store.initializeSession(serverId, client as unknown as DaemonClient, 1);
  store.updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: "test",
    features: {
      directorySync: true,
      projectList: true,
      workspaceLabels: true,
      workspaceMultiplicity: true,
    },
  });
  return { client, directory };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  useWorkspaceLabels.setState({ hosts: {} });
});

describe("DirectorySync workspace label attachment", () => {
  it("attaches labels after route-only demand is followed by full demand", async () => {
    const serverId = "workspace-labels-route-then-full";
    const { client, directory } = createDirectory(serverId);

    directory.setAgentRouteDemand(["agent-1"]);
    await flushAsyncWork();
    directory.setDemand({}, true);
    await flushAsyncWork();

    expect(client.listWorkspaceLabelsCalls).toBeGreaterThan(0);
    expect(useWorkspaceLabels.getState().hosts[serverId]?.status).toBe("online");
    directory.dispose();
  });

  it("attaches labels when full demand is requested first", async () => {
    const serverId = "workspace-labels-full-first";
    const { client, directory } = createDirectory(serverId);

    directory.setDemand({}, true);
    await flushAsyncWork();

    expect(client.listWorkspaceLabelsCalls).toBeGreaterThan(0);
    expect(useWorkspaceLabels.getState().hosts[serverId]?.status).toBe("online");
    directory.dispose();
  });
});
