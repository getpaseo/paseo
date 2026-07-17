import { afterEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { DirectoryRefreshSupersededError, DirectorySync } from "./index";

type WorkspaceFetchResult = Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>;

class FakeDirectoryClient {
  fetchAgentsCalls = 0;
  fetchWorkspacesCalls = 0;
  private pendingWorkspaceFetch: Promise<WorkspaceFetchResult> | null = null;
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

  emit<TType extends SessionOutboundMessage["type"]>(
    message: Extract<SessionOutboundMessage, { type: TType }>,
  ): void {
    for (const handler of this.handlers.get(message.type) ?? []) handler(message);
  }

  holdWorkspaceFetch(): (result: WorkspaceFetchResult) => void {
    let complete!: (result: WorkspaceFetchResult) => void;
    this.pendingWorkspaceFetch = new Promise((resolve) => {
      complete = resolve;
    });
    return complete;
  }

  async fetchAgents(): Promise<Awaited<ReturnType<DaemonClient["fetchAgents"]>>> {
    this.fetchAgentsCalls += 1;
    return {
      requestId: "agents",
      entries: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    };
  }

  async fetchWorkspaces(): Promise<WorkspaceFetchResult> {
    this.fetchWorkspacesCalls += 1;
    if (this.pendingWorkspaceFetch) {
      const pending = this.pendingWorkspaceFetch;
      this.pendingWorkspaceFetch = null;
      return pending;
    }
    return {
      requestId: "workspaces",
      entries: [],
      emptyProjects: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    };
  }
}

const serverIds = new Set<string>();

function createDirectory(serverId: string): {
  client: FakeDirectoryClient;
  directory: DirectorySync;
} {
  serverIds.add(serverId);
  const client = new FakeDirectoryClient();
  const directory = new DirectorySync(serverId, {
    drainQueuedAgentMessage: () => undefined,
    markAgentLoading: () => undefined,
    markAgentReady: () => undefined,
    markAgentError: () => undefined,
  });
  directory.connectionChanged({
    client: client as unknown as DaemonClient,
    status: "online",
    source: { clientGeneration: 1, connectionEpoch: 1 },
  });
  return { client, directory };
}

afterEach(() => {
  for (const serverId of serverIds) useSessionStore.getState().clearSession(serverId);
  serverIds.clear();
});

describe("DirectorySync session readiness", () => {
  it("waits for workspace capability metadata before choosing the workspace protocol", async () => {
    const serverId = "workspace-metadata";
    const { client, directory } = createDirectory(serverId);

    const refresh = directory.refreshWorkspaces({ subscribe: true });
    await Promise.resolve();
    expect(client.fetchWorkspacesCalls).toBe(0);

    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    await Promise.resolve();
    expect(client.fetchWorkspacesCalls).toBe(0);

    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true },
    });
    await refresh;

    expect(client.fetchWorkspacesCalls).toBe(1);
    expect(useSessionStore.getState().sessions[serverId]?.hasHydratedWorkspaces).toBe(true);
    directory.dispose();
  });

  it("rejects a session wait on disconnect so the reconnect can refresh", async () => {
    const serverId = "session-wait-reconnect";
    const { client, directory } = createDirectory(serverId);
    const staleRefresh = directory.refreshAgents();
    await Promise.resolve();

    directory.connectionChanged({
      client: null,
      status: "offline",
      source: { clientGeneration: 1, connectionEpoch: 1 },
    });
    await expect(staleRefresh).rejects.toBeInstanceOf(DirectoryRefreshSupersededError);

    directory.connectionChanged({
      client: client as unknown as DaemonClient,
      status: "online",
      source: { clientGeneration: 1, connectionEpoch: 2 },
    });
    const currentRefresh = directory.refreshAgents();
    useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient, 1);
    await currentRefresh;

    expect(client.fetchAgentsCalls).toBe(1);
    directory.dispose();
  });

  it("buffers workspace and project updates in the same hydration transaction", async () => {
    const serverId = "workspace-project-transaction";
    const { client, directory } = createDirectory(serverId);
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true },
    });
    const completeFetch = client.holdWorkspaceFetch();

    const refresh = directory.refreshWorkspaces({ subscribe: true });
    await Promise.resolve();
    client.emit({
      type: "workspace_update",
      payload: {
        kind: "remove",
        id: "removed-workspace",
        emptyProject: {
          projectId: "workspace-project",
          projectDisplayName: "Project from workspace update",
          projectRootPath: "/repo/workspace-project",
          projectKind: "git",
        },
      },
    });
    client.emit({
      type: "project.update",
      payload: {
        kind: "upsert",
        project: {
          projectId: "snapshot-project",
          projectDisplayName: "Renamed during hydration",
          projectRootPath: "/moved/snapshot-project",
          projectKind: "directory",
        },
      },
    });
    completeFetch({
      requestId: "workspaces",
      entries: [],
      emptyProjects: [
        {
          projectId: "snapshot-project",
          projectDisplayName: "Stale snapshot project",
          projectRootPath: "/repo/snapshot-project",
          projectKind: "git",
        },
      ],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
    });
    await refresh;

    const emptyProjects = useSessionStore.getState().sessions[serverId]?.emptyProjects;
    expect(Array.from(emptyProjects?.keys() ?? [])).toEqual([
      "snapshot-project",
      "workspace-project",
    ]);
    expect(emptyProjects?.get("snapshot-project")).toMatchObject({
      projectDisplayName: "Renamed during hydration",
      projectRootPath: "/moved/snapshot-project",
      projectKind: "directory",
    });
    expect(emptyProjects?.get("workspace-project")).toMatchObject({
      projectDisplayName: "Project from workspace update",
    });
    directory.dispose();
  });

  it("buffers project updates from the online epoch before workspace hydration starts", async () => {
    const serverId = "project-before-workspace-hydration";
    const { client, directory } = createDirectory(serverId);
    const store = useSessionStore.getState();
    store.initializeSession(serverId, client as unknown as DaemonClient, 1);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "test",
      features: { workspaceMultiplicity: true },
    });

    client.emit({
      type: "project.update",
      payload: {
        kind: "upsert",
        project: {
          projectId: "early-project",
          projectDisplayName: "Early project",
          projectRootPath: "/repo/early-project",
          projectKind: "git",
        },
      },
    });

    expect(useSessionStore.getState().sessions[serverId]?.hasHydratedWorkspaces).toBe(false);

    await directory.refreshWorkspaces({ subscribe: true });

    expect(useSessionStore.getState().sessions[serverId]?.hasHydratedWorkspaces).toBe(true);
    expect(
      useSessionStore.getState().sessions[serverId]?.emptyProjects.get("early-project"),
    ).toMatchObject({
      projectDisplayName: "Early project",
      projectRootPath: "/repo/early-project",
    });
    directory.dispose();
  });
});
