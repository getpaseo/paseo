import { afterEach, expect, test, vi } from "vitest";
import { createPaseoClient } from "./index.js";
import type { PaseoAgent, PaseoClient, PaseoProviderConfig, PaseoWorkspace } from "./index.js";

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
    this.onmessage?.(data);
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

async function connectClient(): Promise<{ client: PaseoClient; ws: FakeWebSocket }> {
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

  const opened = await openPromise;
  const workspace = opened.workspace;
  expect(workspace?.id).toBe("workspace_sdk");
  expect(workspace?.latest()).toEqual(openedWorkspace);

  const refreshedWorkspace = createWorkspace({ name: "sdk refreshed" });
  const refetchPromise = workspace?.refetch({ requestId: "workspace-refetch-request" });
  expect(parseSentSessionMessage(ws.sent.at(-1))).toMatchObject({
    type: "fetch_workspaces_request",
    requestId: "workspace-refetch-request",
    page: { limit: 25 },
  });

  ws.message(
    sessionMessage({
      type: "fetch_workspaces_response",
      payload: {
        requestId: "workspace-refetch-request",
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
  expect(workspace?.latest()).toEqual(refreshedWorkspace);

  const updates: string[] = [];
  const unsubscribe = workspace?.subscribe((update) => {
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
  expect(workspace?.latest()).toEqual(pushedWorkspace);

  unsubscribe?.();
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

test("agent handles delegate create, send, timeline refetch, archive, and local updates", async () => {
  const { client, ws } = await connectClient();
  const createdAgent = createAgent();

  const createPromise = client.agents.create({
    provider: "codex",
    cwd: "/repo/sdk",
    initialPrompt: "ship it",
  });
  const createRequest = parseSentSessionMessage(ws.sent.at(-1));
  expect(createRequest).toMatchObject({
    type: "create_agent_request",
    config: {
      provider: "codex",
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
  expect(agent.latest()).toEqual(createdAgent);

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
  expect(agent.latest()).toEqual(updatedAgent);

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
  expect(agent.latest()).toEqual(timelineAgent);

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
  expect(agent.latest()?.archivedAt).toBe("2026-05-16T01:00:00.000Z");

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
      provider: "codex",
      cwd: "/repo/sdk",
      modeId: "full-access",
      model: "gpt-5.4",
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

test("provider config builders shape existing create-agent config fields", async () => {
  const { client, ws } = await connectClient();
  const provider = client.providers.codex({
    model: "gpt-5.4",
    modeId: "full-access",
    thinkingOptionId: "high",
    featureValues: { webSearch: true },
  });
  const expectedProviderConfig = {
    provider: "codex",
    model: "gpt-5.4",
    modeId: "full-access",
    thinkingOptionId: "high",
    featureValues: { webSearch: true },
  } satisfies PaseoProviderConfig;

  expect(provider).toEqual(expectedProviderConfig);

  const createdAgent = createAgent({
    model: "gpt-5.4",
    currentModeId: "full-access",
  });
  const createPromise = client.agents.create({
    config: {
      ...provider,
      cwd: "/repo/sdk",
    },
    initialPrompt: "use configured provider",
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
  expect(agent.latest()).toEqual(createdAgent);

  await client.close();
});
