import { afterEach, expect, test, vi } from "vitest";
import { createPaseoApi, createPaseoClient } from "./index.js";
import { DaemonClient } from "./daemon-client.js";
import type { PaseoAgent, PaseoClient, PaseoWorkspace } from "./index.js";

type FakeWebSocketHandler = (...args: unknown[]) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readyState = 1;
  sent: Array<string | ArrayBuffer | Uint8Array> = [];
  onopen: FakeWebSocketHandler | null = null;
  onmessage: FakeWebSocketHandler | null = null;
  onclose: FakeWebSocketHandler | null = null;
  onerror: FakeWebSocketHandler | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.onopen?.();
  }

  message(data: string): void {
    this.onmessage?.({ data });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.instances.length = 0;
});

function sessionMessage(message: object): string {
  return JSON.stringify({
    type: "session",
    message,
  });
}

function parseSentSessionMessage(data: string | ArrayBuffer | Uint8Array | undefined): {
  type: string;
  requestId?: string;
  agentId?: string;
  workspaceId?: string;
  provider?: string;
  providers?: string[];
  cwd?: string;
  config?: unknown;
  draftConfig?: unknown;
  filter?: unknown;
  page?: unknown;
  text?: string;
} {
  if (typeof data !== "string") {
    throw new Error("Expected string WebSocket frame");
  }
  const parsed = JSON.parse(data);
  return parsed.message;
}

function parseSentFrame(
  data: string | ArrayBuffer | Uint8Array | undefined,
): Record<string, unknown> {
  if (typeof data !== "string") {
    throw new Error("Expected string WebSocket frame");
  }
  return JSON.parse(data);
}

async function connectClient(
  features: Record<string, boolean> = { providersSnapshotCwd: true },
): Promise<{ client: PaseoClient; ws: FakeWebSocket }> {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const client = createPaseoClient({
    url: "ws://daemon.test",
    reconnect: { enabled: false },
  });

  const connectPromise = client.connect();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  const hello = parseSentFrame(ws.sent.at(-1));
  expect(hello).toMatchObject({
    type: "hello",
    clientType: "cli",
    protocolVersion: 1,
  });
  expect(hello.clientId).toEqual(expect.stringMatching(/^paseo-sdk-/));
  ws.message(
    sessionMessage({
      type: "status",
      payload: {
        status: "server_info",
        serverId: "srv_sdk_test",
        hostname: null,
        version: null,
        features,
      },
    }),
  );
  await connectPromise;

  return { client, ws };
}

function createWorkspace(input: Partial<PaseoWorkspace> = {}): PaseoWorkspace {
  return {
    id: "workspace_sdk",
    projectId: "project_sdk",
    projectDisplayName: "SDK",
    projectRootPath: "/repo/sdk",
    workspaceDirectory: "/repo/sdk",
    projectKind: "git",
    workspaceKind: "directory",
    name: "sdk",
    archivingAt: null,
    status: "done",
    statusEnteredAt: null,
    activityAt: "2026-05-16T00:00:00.000Z",
    scripts: [],
    gitRuntime: null,
    githubRuntime: null,
    ...input,
  };
}

function createAgent(input: Partial<PaseoAgent> = {}): PaseoAgent {
  return {
    id: "agent_sdk",
    provider: "codex",
    cwd: "/repo/sdk",
    model: null,
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsRewindBoth: false,
      supportsRewindConversation: false,
      supportsRewindFiles: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
    archivedAt: null,
    ...input,
  };
}

test("createPaseoClient exposes workspace list through the daemon client", async () => {
  const { client, ws } = await connectClient();

  const listPromise = client.workspaces.list({
    filter: { query: "sdk" },
    page: { limit: 10 },
  });
  const request = parseSentSessionMessage(ws.sent.at(-1));

  expect(request).toMatchObject({
    type: "fetch_workspaces_request",
    filter: { query: "sdk" },
    page: { limit: 10 },
  });

  ws.message(
    sessionMessage({
      type: "fetch_workspaces_response",
      payload: {
        requestId: request.requestId,
        entries: [],
        pageInfo: {
          nextCursor: null,
          prevCursor: null,
          hasMore: false,
        },
      },
    }),
  );

  await expect(listPromise).resolves.toEqual({
    requestId: request.requestId,
    entries: [],
    emptyProjects: [],
    pageInfo: {
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
    },
  });
  expect(client.getConnectionState()).toEqual({ status: "connected" });

  await client.close();
});

test("createPaseoApi borrows daemon capabilities without exposing connection ownership", () => {
  const daemonClient = new DaemonClient({
    url: "ws://daemon.test",
    clientId: "borrowed-api",
    reconnect: { enabled: false },
  });

  const paseo = createPaseoApi(daemonClient);

  expect(Object.keys(paseo).sort()).toEqual(["agents", "config", "providers", "workspaces"]);
  expect("connect" in paseo).toBe(false);
  expect("close" in paseo).toBe(false);
  expect("skills" in paseo.agents).toBe(false);
});

test("agent actions list the daemon directory without exposing the low-level client", async () => {
  const { client, ws } = await connectClient();
  const listedAgent = createAgent({ title: "Planner" });

  const listPromise = client.agents.list({
    filter: { includeArchived: false },
    page: { limit: 10 },
  });
  const request = parseSentSessionMessage(ws.sent.at(-1));
  expect(request).toMatchObject({
    type: "fetch_agents_request",
    filter: { includeArchived: false },
    page: { limit: 10 },
  });

  ws.message(
    sessionMessage({
      type: "fetch_agents_response",
      payload: {
        requestId: request.requestId,
        entries: [
          {
            agent: listedAgent,
            project: {
              projectKey: "project_sdk",
              projectName: "SDK",
              workspaceName: "main",
              checkout: {
                cwd: "/repo/sdk",
                isGit: false,
                currentBranch: null,
                remoteUrl: null,
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              },
            },
          },
        ],
        pageInfo: {
          nextCursor: null,
          prevCursor: null,
          hasMore: false,
        },
      },
    }),
  );

  await expect(listPromise).resolves.toMatchObject({
    entries: [{ agent: { id: "agent_sdk", title: "Planner" } }],
  });
  await client.close();
});

test("workspace handles keep identity and refresh snapshots through existing driver calls", async () => {
  const { client, ws } = await connectClient();
  const openedWorkspace = createWorkspace();

  const openPromise = client.workspaces.open("/repo/sdk", "open-workspace-request");
  expect(parseSentSessionMessage(ws.sent.at(-1))).toMatchObject({
    type: "open_project_request",
    cwd: "/repo/sdk",
  });

  ws.message(
    sessionMessage({
      type: "open_project_response",
      payload: {
        requestId: "open-workspace-request",
        workspace: openedWorkspace,
        error: null,
      },
    }),
  );

  const workspace = await openPromise;
  expect(workspace.id).toBe("workspace_sdk");
  expect(workspace.projectId).toBe("project_sdk");
  expect(workspace.directory).toBe("/repo/sdk");
  expect(workspace.current()).toEqual(openedWorkspace);

  const refreshedWorkspace = createWorkspace({ name: "sdk refreshed" });
  const refetchPromise = workspace.refresh({ requestId: "workspace-refetch-request" });
  expect(parseSentSessionMessage(ws.sent.at(-1))).toMatchObject({
    type: "fetch_workspaces_request",
    requestId: "workspace-refetch-request",
    page: { limit: 200 },
  });

  ws.message(
    sessionMessage({
      type: "fetch_workspaces_response",
      payload: {
        requestId: "workspace-refetch-request",
        entries: [],
        pageInfo: {
          nextCursor: "workspace-page-2",
          prevCursor: null,
          hasMore: true,
        },
      },
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  const secondPageRequest = parseSentSessionMessage(ws.sent.at(-1));
  expect(secondPageRequest).toMatchObject({
    type: "fetch_workspaces_request",
    page: { limit: 200, cursor: "workspace-page-2" },
  });
  ws.message(
    sessionMessage({
      type: "fetch_workspaces_response",
      payload: {
        requestId: secondPageRequest.requestId,
        entries: [refreshedWorkspace],
        pageInfo: {
          nextCursor: null,
          prevCursor: null,
          hasMore: false,
        },
      },
    }),
  );

  await expect(refetchPromise).resolves.toEqual(refreshedWorkspace);
  expect(workspace.current()).toEqual(refreshedWorkspace);

  const updates: string[] = [];
  const unsubscribe = workspace.subscribe((update) => {
    if (update.kind === "upsert") {
      updates.push(update.workspace.name);
    }
  });
  const pushedWorkspace = createWorkspace({ name: "sdk pushed" });
  ws.message(
    sessionMessage({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: pushedWorkspace,
      },
    }),
  );
  expect(updates).toEqual(["sdk pushed"]);
  expect(workspace.current()).toEqual(pushedWorkspace);

  const titlePromise = workspace.setTitle("SDK review", "workspace-title-request");
  expect(parseSentSessionMessage(ws.sent.at(-1))).toMatchObject({
    type: "workspace.title.set.request",
    requestId: "workspace-title-request",
    workspaceId: "workspace_sdk",
    title: "SDK review",
  });
  ws.message(
    sessionMessage({
      type: "workspace.title.set.response",
      payload: {
        requestId: "workspace-title-request",
        workspaceId: "workspace_sdk",
        accepted: true,
        title: "SDK review",
        error: null,
      },
    }),
  );
  await expect(titlePromise).resolves.toEqual({ title: "SDK review" });

  unsubscribe();
  ws.message(
    sessionMessage({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: createWorkspace({ name: "sdk after unsubscribe" }),
      },
    }),
  );
  expect(updates).toEqual(["sdk pushed"]);

  await client.close();
});

test("plugin-shaped PR workspace create and agent create use the existing daemon RPCs", async () => {
  const { client, ws } = await connectClient();
  const createdWorkspace = createWorkspace({ id: "workspace_fresh", name: "Issue 42" });

  const workspacePromise = client.workspaces.create({
    source: {
      kind: "worktree",
      cwd: "/repo/sdk",
      action: "checkout",
      checkoutSource: { kind: "change_request", forge: "github", number: 42 },
    },
    title: "Issue 42",
  });
  const workspaceRequest = parseSentSessionMessage(ws.sent.at(-1));
  expect(workspaceRequest).toMatchObject({
    type: "workspace.create.request",
    source: {
      kind: "worktree",
      cwd: "/repo/sdk",
      action: "checkout",
      checkoutSource: { kind: "change_request", forge: "github", number: 42 },
    },
    title: "Issue 42",
  });
  ws.message(
    sessionMessage({
      type: "workspace.create.response",
      payload: {
        requestId: workspaceRequest.requestId,
        workspace: createdWorkspace,
        setupTerminalId: null,
        error: null,
      },
    }),
  );

  const workspace = await workspacePromise;
  const agentPromise = workspace.agents.create({
    config: { provider: "codex/gpt-5.4" },
    parent: client.agents.ref("parent_sdk"),
    prompt: "Implement issue 42.",
  });
  const agentRequest = parseSentSessionMessage(ws.sent.at(-1));
  expect(agentRequest).toMatchObject({
    type: "create_agent_request",
    config: { provider: "codex", model: "gpt-5.4", cwd: "/repo/sdk" },
    workspaceId: "workspace_fresh",
    callerAgentId: "parent_sdk",
    initialPrompt: "Implement issue 42.",
  });
  ws.message(
    sessionMessage({
      type: "status",
      payload: {
        status: "agent_created",
        requestId: agentRequest.requestId,
        agentId: "agent_sdk",
        agent: createAgent({ workspaceId: "workspace_fresh" }),
      },
    }),
  );

  const agent = await agentPromise;
  expect(agent.workspaceId).toBe("workspace_fresh");
  expect(agent.cwd).toBe("/repo/sdk");
  await client.close();
});

test("agent handles delegate create, send, timeline refetch, archive, and local updates", async () => {
  const { client, ws } = await connectClient();
  const createdAgent = createAgent();

  const createPromise = client.agents.create({
    config: { provider: "codex/gpt-5.4" },
    cwd: "/repo/sdk",
    prompt: "ship it",
  });
  const createRequest = parseSentSessionMessage(ws.sent.at(-1));
  expect(createRequest).toMatchObject({
    type: "create_agent_request",
    config: {
      provider: "codex",
      model: "gpt-5.4",
      cwd: "/repo/sdk",
    },
    initialPrompt: "ship it",
  });

  ws.message(
    sessionMessage({
      type: "status",
      payload: {
        status: "agent_created",
        requestId: createRequest.requestId,
        agentId: "agent_sdk",
        agent: createdAgent,
      },
    }),
  );

  const agent = await createPromise;
  expect(agent.id).toBe("agent_sdk");
  expect(agent.current()).toEqual(createdAgent);

  const updatedAgents: string[] = [];
  const unsubscribe = agent.subscribe((update) => {
    if (update.kind === "upsert") {
      updatedAgents.push(update.agent.title ?? "");
    }
  });
  const updatedAgent = createAgent({ title: "Updated" });
  ws.message(
    sessionMessage({
      type: "agent_update",
      payload: {
        kind: "upsert",
        agent: updatedAgent,
        project: null,
      },
    }),
  );
  expect(updatedAgents).toEqual(["Updated"]);
  expect(agent.current()).toEqual(updatedAgent);

  const sendPromise = agent.send("hello", { messageId: "message-sdk" });
  const sendRequest = parseSentSessionMessage(ws.sent.at(-1));
  expect(sendRequest).toMatchObject({
    type: "send_agent_message_request",
    agentId: "agent_sdk",
    text: "hello",
    messageId: "message-sdk",
  });

  ws.message(
    sessionMessage({
      type: "send_agent_message_response",
      payload: {
        requestId: sendRequest.requestId,
        agentId: "agent_sdk",
        accepted: true,
        error: null,
      },
    }),
  );
  await sendPromise;

  const runPromise = agent.run("finish the task", {
    messageId: "run-message-sdk",
    timeoutMs: 30_000,
  });
  const runSendRequest = parseSentSessionMessage(ws.sent.at(-1));
  expect(runSendRequest).toMatchObject({
    type: "send_agent_message_request",
    agentId: "agent_sdk",
    text: "finish the task",
    messageId: "run-message-sdk",
  });
  ws.message(
    sessionMessage({
      type: "send_agent_message_response",
      payload: {
        requestId: runSendRequest.requestId,
        agentId: "agent_sdk",
        accepted: true,
        error: null,
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const waitRequest = parseSentSessionMessage(ws.sent.at(-1));
  expect(waitRequest).toMatchObject({
    type: "wait_for_finish_request",
    agentId: "agent_sdk",
    timeoutMs: 30_000,
  });
  const finishedAgent = createAgent({ title: "Finished" });
  ws.message(
    sessionMessage({
      type: "wait_for_finish_response",
      payload: {
        requestId: waitRequest.requestId,
        agentId: "agent_sdk",
        status: "idle",
        final: finishedAgent,
        error: null,
        lastMessage: "DONE",
      },
    }),
  );
  await expect(runPromise).resolves.toMatchObject({ status: "idle", lastMessage: "DONE" });
  expect(agent.current()).toEqual(finishedAgent);

  const defaultWaitPromise = agent.waitForFinish();
  const defaultWaitRequest = parseSentSessionMessage(ws.sent.at(-1));
  expect(defaultWaitRequest).toMatchObject({
    type: "wait_for_finish_request",
    agentId: "agent_sdk",
    timeoutMs: 10 * 60_000,
  });
  ws.message(
    sessionMessage({
      type: "wait_for_finish_response",
      payload: {
        requestId: defaultWaitRequest.requestId,
        agentId: "agent_sdk",
        status: "idle",
        final: finishedAgent,
        error: null,
        lastMessage: "DONE",
      },
    }),
  );
  await expect(defaultWaitPromise).resolves.toMatchObject({ status: "idle" });

  const timelineAgent = createAgent({ title: "Timeline" });
  const timelinePromise = agent.timeline.refetch({ limit: 5 });
  const timelineRequest = parseSentSessionMessage(ws.sent.at(-1));
  expect(timelineRequest).toMatchObject({
    type: "fetch_agent_timeline_request",
    agentId: "agent_sdk",
    limit: 5,
  });
  ws.message(
    sessionMessage({
      type: "fetch_agent_timeline_response",
      payload: {
        requestId: timelineRequest.requestId,
        agentId: "agent_sdk",
        agent: timelineAgent,
        direction: "tail",
        projection: "projected",
        epoch: "epoch-sdk",
        reset: false,
        staleCursor: false,
        gap: false,
        window: {
          minSeq: 0,
          maxSeq: 0,
          nextSeq: 0,
        },
        startCursor: null,
        endCursor: null,
        hasOlder: false,
        hasNewer: false,
        entries: [],
        error: null,
      },
    }),
  );
  await timelinePromise;
  expect(agent.current()).toEqual(timelineAgent);

  const archivePromise = agent.archive();
  const archiveRequest = parseSentSessionMessage(ws.sent.at(-1));
  expect(archiveRequest).toMatchObject({
    type: "archive_agent_request",
    agentId: "agent_sdk",
  });
  ws.message(
    sessionMessage({
      type: "agent_archived",
      payload: {
        requestId: archiveRequest.requestId,
        agentId: "agent_sdk",
        archivedAt: "2026-05-16T01:00:00.000Z",
      },
    }),
  );
  await expect(archivePromise).resolves.toEqual({
    archivedAt: "2026-05-16T01:00:00.000Z",
  });
  expect(agent.current()?.archivedAt).toBe("2026-05-16T01:00:00.000Z");

  unsubscribe();
  await client.close();
});

test("provider actions delegate to existing provider RPCs and local snapshot updates", async () => {
  const { client, ws } = await connectClient();

  const modelsPromise = client.providers.listModels("codex", {
    cwd: "/repo/sdk",
    requestId: "provider-models-request",
  });
  expect(parseSentSessionMessage(ws.sent.at(-1))).toMatchObject({
    type: "list_provider_models_request",
    requestId: "provider-models-request",
    provider: "codex",
    cwd: "/repo/sdk",
  });
  ws.message(
    sessionMessage({
      type: "list_provider_models_response",
      payload: {
        requestId: "provider-models-request",
        provider: "codex",
        models: [{ provider: "codex", id: "gpt-5.4", label: "GPT-5.4" }],
        error: null,
        fetchedAt: "2026-05-16T00:00:00.000Z",
      },
    }),
  );
  await expect(modelsPromise).resolves.toMatchObject({
    provider: "codex",
    models: [{ provider: "codex", id: "gpt-5.4", label: "GPT-5.4" }],
  });

  const modesPromise = client.providers.listModes("codex", {
    cwd: "/repo/sdk",
    requestId: "provider-modes-request",
  });
  expect(parseSentSessionMessage(ws.sent.at(-1))).toMatchObject({
    type: "list_provider_modes_request",
    requestId: "provider-modes-request",
    provider: "codex",
    cwd: "/repo/sdk",
  });
  ws.message(
    sessionMessage({
      type: "list_provider_modes_response",
      payload: {
        requestId: "provider-modes-request",
        provider: "codex",
        modes: [{ id: "full-access", label: "Full Access" }],
        error: null,
        fetchedAt: "2026-05-16T00:00:00.000Z",
      },
    }),
  );
  await expect(modesPromise).resolves.toMatchObject({
    provider: "codex",
    modes: [{ id: "full-access", label: "Full Access" }],
  });

  const featuresPromise = client.providers.listFeatures(
    {
      provider: "codex/gpt-5.4",
      cwd: "/repo/sdk",
      modeId: "full-access",
      thinkingOptionId: "high",
      featureValues: { webSearch: true },
    },
    { requestId: "provider-features-request" },
  );
  expect(parseSentSessionMessage(ws.sent.at(-1))).toMatchObject({
    type: "list_provider_features_request",
    requestId: "provider-features-request",
    draftConfig: {
      provider: "codex",
      cwd: "/repo/sdk",
      modeId: "full-access",
      model: "gpt-5.4",
      thinkingOptionId: "high",
      featureValues: { webSearch: true },
    },
  });
  ws.message(
    sessionMessage({
      type: "list_provider_features_response",
      payload: {
        requestId: "provider-features-request",
        provider: "codex",
        features: [{ type: "toggle", id: "webSearch", label: "Web Search", value: true }],
        error: null,
        fetchedAt: "2026-05-16T00:00:00.000Z",
      },
    }),
  );
  await expect(featuresPromise).resolves.toMatchObject({
    provider: "codex",
    features: [{ type: "toggle", id: "webSearch", label: "Web Search", value: true }],
  });

  const availablePromise = client.providers.listAvailable({
    requestId: "providers-available-request",
  });
  expect(parseSentSessionMessage(ws.sent.at(-1))).toMatchObject({
    type: "list_available_providers_request",
    requestId: "providers-available-request",
  });
  ws.message(
    sessionMessage({
      type: "list_available_providers_response",
      payload: {
        requestId: "providers-available-request",
        providers: [{ provider: "codex", available: true, error: null }],
        error: null,
        fetchedAt: "2026-05-16T00:00:00.000Z",
      },
    }),
  );
  await expect(availablePromise).resolves.toMatchObject({
    providers: [{ provider: "codex", available: true, error: null }],
  });

  const snapshotPromise = client.providers.snapshot({
    cwd: "/repo/sdk",
    requestId: "providers-snapshot-request",
  });
  expect(parseSentSessionMessage(ws.sent.at(-1))).toMatchObject({
    type: "get_providers_snapshot_request",
    requestId: "providers-snapshot-request",
    cwd: "/repo/sdk",
  });
  ws.message(
    sessionMessage({
      type: "get_providers_snapshot_response",
      payload: {
        requestId: "providers-snapshot-request",
        entries: [{ provider: "codex", status: "ready", enabled: true }],
        generatedAt: "2026-05-16T00:00:00.000Z",
      },
    }),
  );
  await expect(snapshotPromise).resolves.toMatchObject({
    entries: [{ provider: "codex", status: "ready", enabled: true }],
  });

  const readyPromise = client.providers.waitForReady({ cwd: "/repo/sdk", timeoutMs: 5_000 });
  const readyRequest = parseSentSessionMessage(ws.sent.at(-1));
  expect(readyRequest).toMatchObject({
    type: "get_providers_snapshot_request",
    cwd: "/repo/sdk",
  });
  ws.message(
    sessionMessage({
      type: "get_providers_snapshot_response",
      payload: {
        requestId: readyRequest.requestId,
        cwd: "/repo/sdk",
        entries: [{ provider: "codex", status: "loading", enabled: true }],
        generatedAt: "2026-05-16T00:00:00.000Z",
      },
    }),
  );
  ws.message(
    sessionMessage({
      type: "providers_snapshot_update",
      payload: {
        cwd: "/repo/other",
        entries: [{ provider: "codex", status: "ready", enabled: true }],
        generatedAt: "2026-05-16T00:00:30.000Z",
      },
    }),
  );
  ws.message(
    sessionMessage({
      type: "providers_snapshot_update",
      payload: {
        cwd: "/repo/sdk",
        entries: [{ provider: "codex", status: "ready", enabled: true }],
        generatedAt: "2026-05-16T00:00:01.000Z",
      },
    }),
  );
  await expect(readyPromise).resolves.toMatchObject({
    requestId: readyRequest.requestId,
    entries: [{ provider: "codex", status: "ready", enabled: true }],
    generatedAt: "2026-05-16T00:00:01.000Z",
  });

  const canonicalReadyPromise = client.providers.waitForReady({
    cwd: "/repo/./sdk",
    timeoutMs: 5_000,
  });
  const canonicalReadyRequest = parseSentSessionMessage(ws.sent.at(-1));
  ws.message(
    sessionMessage({
      type: "providers_snapshot_update",
      payload: {
        cwd: "/repo/sdk",
        entries: [{ provider: "codex", status: "ready", enabled: true }],
        generatedAt: "2026-05-16T00:00:02.000Z",
      },
    }),
  );
  ws.message(
    sessionMessage({
      type: "get_providers_snapshot_response",
      payload: {
        requestId: canonicalReadyRequest.requestId,
        cwd: "/repo/sdk",
        entries: [{ provider: "codex", status: "loading", enabled: true }],
        generatedAt: "2026-05-16T00:00:01.000Z",
      },
    }),
  );
  await expect(canonicalReadyPromise).resolves.toMatchObject({
    requestId: canonicalReadyRequest.requestId,
    cwd: "/repo/sdk",
    entries: [{ provider: "codex", status: "ready", enabled: true }],
  });

  const refreshPromise = client.providers.refresh({
    cwd: "/repo/sdk",
    providers: ["codex"],
    requestId: "providers-refresh-request",
  });
  expect(parseSentSessionMessage(ws.sent.at(-1))).toMatchObject({
    type: "refresh_providers_snapshot_request",
    requestId: "providers-refresh-request",
    cwd: "/repo/sdk",
    providers: ["codex"],
  });
  ws.message(
    sessionMessage({
      type: "refresh_providers_snapshot_response",
      payload: {
        requestId: "providers-refresh-request",
        acknowledged: true,
      },
    }),
  );
  await expect(refreshPromise).resolves.toEqual({
    requestId: "providers-refresh-request",
    acknowledged: true,
  });

  const diagnosticPromise = client.providers.diagnostic("codex", {
    requestId: "provider-diagnostic-request",
  });
  expect(parseSentSessionMessage(ws.sent.at(-1))).toMatchObject({
    type: "provider_diagnostic_request",
    requestId: "provider-diagnostic-request",
    provider: "codex",
  });
  ws.message(
    sessionMessage({
      type: "provider_diagnostic_response",
      payload: {
        requestId: "provider-diagnostic-request",
        provider: "codex",
        diagnostic: "Codex is ready.",
      },
    }),
  );
  await expect(diagnosticPromise).resolves.toEqual({
    requestId: "provider-diagnostic-request",
    provider: "codex",
    diagnostic: "Codex is ready.",
  });

  const snapshotUpdates: string[] = [];
  const snapshotModelDefaults: Array<string | undefined> = [];
  const unsubscribe = client.providers.subscribe((update) => {
    snapshotUpdates.push(update.generatedAt);
    snapshotModelDefaults.push(update.entries[0]?.models?.[0]?.defaultThinkingOptionId);
  });
  ws.message(
    sessionMessage({
      type: "providers_snapshot_update",
      payload: {
        cwd: "/repo/sdk",
        entries: [
          {
            provider: "codex",
            status: "ready",
            enabled: true,
            models: [
              {
                provider: "codex",
                id: "gpt-5.5",
                label: "GPT-5.5",
                thinkingOptions: [{ id: "high", label: "High", isDefault: true }],
              },
            ],
          },
        ],
        generatedAt: "2026-05-16T01:00:00.000Z",
      },
    }),
  );
  expect(snapshotUpdates).toEqual(["2026-05-16T01:00:00.000Z"]);
  expect(snapshotModelDefaults).toEqual(["high"]);

  unsubscribe();
  await client.close();
});

test("waitForReady requires canonical provider snapshot identity from the host", async () => {
  const { client, ws } = await connectClient({});
  const sentBeforeWait = ws.sent.length;

  await expect(client.providers.waitForReady({ cwd: "/repo/./sdk" })).rejects.toThrow(
    "Update the host to wait for provider discovery.",
  );
  expect(ws.sent).toHaveLength(sentBeforeWait);

  await client.close();
});

test("config actions delegate to existing daemon config RPCs", async () => {
  const { client, ws } = await connectClient();

  const getPromise = client.config.get("config-get-request");
  expect(parseSentSessionMessage(ws.sent.at(-1))).toMatchObject({
    type: "get_daemon_config_request",
    requestId: "config-get-request",
  });
  ws.message(
    sessionMessage({
      type: "get_daemon_config_response",
      payload: {
        requestId: "config-get-request",
        config: {
          mcp: { injectIntoAgents: true },
          providers: {},
          autoArchiveAfterMerge: false,
        },
      },
    }),
  );
  await expect(getPromise).resolves.toEqual({
    requestId: "config-get-request",
    config: {
      mcp: { injectIntoAgents: true },
      providers: {},
      browserTools: { enabled: false },
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    },
  });

  const patchPromise = client.config.patch(
    {
      providers: {
        codex: {
          enabled: false,
        },
      },
    },
    "config-patch-request",
  );
  expect(parseSentSessionMessage(ws.sent.at(-1))).toMatchObject({
    type: "set_daemon_config_request",
    requestId: "config-patch-request",
    config: {
      providers: {
        codex: {
          enabled: false,
        },
      },
    },
  });
  ws.message(
    sessionMessage({
      type: "set_daemon_config_response",
      payload: {
        requestId: "config-patch-request",
        config: {
          mcp: { injectIntoAgents: true },
          providers: {
            codex: {
              enabled: false,
            },
          },
          autoArchiveAfterMerge: false,
        },
      },
    }),
  );
  await expect(patchPromise).resolves.toEqual({
    requestId: "config-patch-request",
    config: {
      mcp: { injectIntoAgents: true },
      providers: {
        codex: {
          enabled: false,
        },
      },
      browserTools: { enabled: false },
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    },
  });

  await client.close();
});

test("agent config maps provider/model and provider-native options to the daemon", async () => {
  const { client, ws } = await connectClient();
  const createdAgent = createAgent({
    model: "gpt-5.4",
    currentModeId: "full-access",
  });
  const createPromise = client.agents.create({
    config: {
      provider: "codex/gpt-5.4",
      modeId: "full-access",
      thinkingOptionId: "high",
      featureValues: { webSearch: true },
      options: {
        approval_policy: "never",
        sandbox_mode: "workspace-write",
        sandbox_workspace_write: {
          writable_roots: ["/repo/sdk"],
          network_access: false,
        },
      },
    },
    cwd: "/repo/sdk",
    prompt: "use configured provider",
  });
  const request = parseSentSessionMessage(ws.sent.at(-1));
  expect(request).toMatchObject({
    type: "create_agent_request",
    config: {
      provider: "codex",
      cwd: "/repo/sdk",
      model: "gpt-5.4",
      modeId: "full-access",
      thinkingOptionId: "high",
      featureValues: { webSearch: true },
      providerOptions: {
        approval_policy: "never",
        sandbox_mode: "workspace-write",
        sandbox_workspace_write: {
          writable_roots: ["/repo/sdk"],
          network_access: false,
        },
      },
    },
    initialPrompt: "use configured provider",
  });

  ws.message(
    sessionMessage({
      type: "status",
      payload: {
        status: "agent_created",
        requestId: request.requestId,
        agentId: "agent_sdk",
        agent: createdAgent,
      },
    }),
  );

  const agent = await createPromise;
  expect(agent.current()).toEqual(createdAgent);

  await client.close();
});

test("agent config requires provider/model syntax", async () => {
  const { client } = await connectClient();

  await expect(
    client.agents.create({
      config: { provider: "codex" },
      cwd: "/repo/sdk",
    }),
  ).rejects.toThrow('Expected config.provider in "provider/model" format');

  await client.close();
});
