import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { resolveAgentModelSelection } from "@/composer/agent-controls/utils";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { providersSnapshotQueryRoot } from "@/data/providers-snapshot";
import { agentComposer, createAgentComposer } from "./index";

const serverId = "host-1";
const agentId = "agent-1";
const draftKey = buildDraftStoreKey({ serverId, agentId });

const entries: ProviderSnapshotEntry[] = [
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    models: [
      {
        provider: "claude",
        id: "opus",
        label: "Opus",
        isDefault: true,
        defaultThinkingOptionId: "high",
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
      {
        provider: "claude",
        id: "claude-sonnet-4",
        label: "Sonnet 4",
        aliases: ["sonnet"],
        thinkingOptions: [{ id: "low", label: "Low" }],
      },
    ],
  },
];

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    serverId,
    id: agentId,
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-11-04T10:00:00.000Z"),
    updatedAt: new Date("2026-11-04T10:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-11-04T10:00:00.000Z"),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: "default",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo",
    workspaceId: "workspace-1",
    model: null,
    parentAgentId: null,
    labels: {},
    ...overrides,
  };
}

function fakeClient() {
  const calls: string[] = [];
  const client = {
    async getProvidersSnapshot() {
      if (hostCatalog.failing) throw new Error("The host is busy.");
      return {
        entries: hostCatalog.entries,
        generatedAt: "2026-11-04T10:00:00.000Z",
        requestId: "snapshot",
      };
    },
    async setAgentModel(id: string, model: string | null) {
      calls.push(`model:${id}:${model}`);
      if (model === "nope") throw new Error("The provider refused model 'nope'");
    },
    async setAgentMetadata(id: string, patch: unknown) {
      calls.push(`metadata:${id}:${JSON.stringify(patch)}`);
    },
    async setAgentOptions(id: string, patch: unknown) {
      calls.push(`options:${id}:${JSON.stringify(patch)}`);
    },
    async setAgentMode(id: string, mode: string) {
      calls.push(`mode:${id}:${mode}`);
      return null;
    },
    async setAgentThinkingOption(id: string, thinking: string) {
      calls.push(`thinking:${id}:${thinking}`);
      return null;
    },
  };
  return { client: client as unknown as DaemonClient, calls };
}

/** What the host answers the next catalog request with. */
const hostCatalog: { entries: ProviderSnapshotEntry[]; failing: boolean } = {
  entries,
  failing: false,
};

function openSession(running: Agent) {
  const { client, calls } = fakeClient();
  const store = useSessionStore.getState();
  store.initializeSession(serverId, client);
  store.updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: null,
    features: { providersSnapshot: true },
  } as never);
  store.setAgents(serverId, new Map([[running.id, running]]));
  return calls;
}

async function until(read: () => unknown, expected: unknown) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (Object.is(read(), expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(read()).toBe(expected);
}

let queryClient: QueryClient;

function runtimeModel(model: string): Agent["runtimeInfo"] {
  return { provider: "claude", sessionId: null, model };
}

function composer() {
  return createAgentComposer(serverId, agentId, { queryClient });
}

beforeEach(() => {
  queryClient = new QueryClient();
  hostCatalog.entries = entries;
  hostCatalog.failing = false;
  useDraftStore.setState({ drafts: {}, textReplacementRequestByDraftKey: {} });
});

afterEach(() => {
  useSessionStore.getState().clearSession(serverId);
});

describe("agent composer", () => {
  it("reads without notifying anyone, so a read during a render updates no other component", () => {
    const running = agent();
    const other = agent({ id: "agent-2", cwd: "/other-repo" });
    openSession(running);
    useSessionStore.getState().setAgents(
      serverId,
      new Map([
        [running.id, running],
        [other.id, other],
      ]),
    );
    const watched = createAgentComposer(serverId, running.id, { queryClient });
    const reader = createAgentComposer(serverId, other.id, { queryClient });
    let notifications = 0;
    const stop = watched.subscribe(() => {
      notifications += 1;
    });
    const before = notifications;
    // The first read of another catalog creates its query in the shared cache.
    reader.getState();
    expect(notifications).toBe(before);
    stop();
  });

  it("keeps the prompt in the stored draft while no composer is mounted", () => {
    openSession(agent());
    const model = composer();
    model.insertText("Review ");
    model.insertText("this diff.\n");
    expect(model.getState().prompt).toBe("Review this diff.\n");
    expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe("Review this diff.\n");
    model.setPrompt("Start over");
    expect(model.getState().prompt).toBe("Start over");
  });

  it("sends prompt commands through the mounted composer while it is mounted", () => {
    openSession(agent());
    const model = composer();
    const mounted: string[] = [];
    const detach = model.attachInput({
      isLive: () => true,
      setText: (text) => mounted.push(`set:${text}`),
      insertText: (text) => mounted.push(`insert:${text}`),
    });
    model.insertText("at the cursor");
    model.setPrompt("replaced");
    expect(mounted).toEqual(["insert:at the cursor", "set:replaced"]);
    expect(useDraftStore.getState().getDraftInput(draftKey)).toBeUndefined();
    detach();
    model.insertText("stored");
    expect(model.getState().prompt).toBe("stored");
  });

  it("stores the prompt and asks the draft's input to show it while the composer is mounted off screen", () => {
    openSession(agent());
    const model = composer();
    const mounted: string[] = [];
    model.attachInput({
      isLive: () => false,
      setText: (text) => mounted.push(`set:${text}`),
      insertText: (text) => mounted.push(`insert:${text}`),
    });
    model.insertText("while away");
    expect(mounted).toEqual([]);
    expect(model.getState().prompt).toBe("while away");
    expect(useDraftStore.getState().textReplacementRequestByDraftKey[draftKey]).toBe(1);
    model.setPrompt("replaced");
    expect(model.getState().prompt).toBe("replaced");
    expect(useDraftStore.getState().textReplacementRequestByDraftKey[draftKey]).toBe(2);
  });

  it("notifies subscribers of a stored prompt and returns the same state until something changes", () => {
    openSession(agent());
    const model = composer();
    let notified = 0;
    const stop = model.subscribe(() => {
      notified += 1;
    });
    const before = model.getState();
    expect(model.getState()).toBe(before);
    model.insertText("x");
    expect(notified).toBeGreaterThan(0);
    expect(model.getState()).not.toBe(before);
    stop();
  });

  it("adds and removes attachments in the stored draft", () => {
    openSession(agent());
    const model = composer();
    const attachment = {
      kind: "plugin_resource" as const,
      pluginId: "review",
      sourceId: "issues",
      sourceTitle: "Issues",
      sourceIcon: "CircleDot",
      item: {
        id: "1",
        identifier: "ENG-1",
        title: "Title",
        subtitle: "Open",
        url: "https://example.com/1",
        text: "Issue ENG-1: Title",
        resourceType: "issue",
      },
    };
    model.changeAttachments((current) => [...current, attachment]);
    expect(model.getState().attachments).toHaveLength(1);
    model.changeAttachments(() => []);
    expect(model.getState().attachments).toHaveLength(0);
  });

  it("reads mode, options and metadata from the agent, and sends commands to the daemon", async () => {
    const calls = openSession(
      agent({ currentModeId: "plan", options: { effort: "high" }, metadata: { flag: true } }),
    );
    const model = composer();
    expect(model.getState()).toMatchObject({
      context: "agent",
      provider: "claude",
      mode: "plan",
      options: { effort: "high" },
      metadata: { flag: true },
    });
    await model.setMetadata({ flag: null });
    await model.setOptions({ effort: "low" });
    await model.setMode("default");
    expect(calls).toEqual([
      'metadata:agent-1:{"flag":null}',
      'options:agent-1:{"effort":"low"}',
      "mode:agent-1:default",
    ]);
    await expect(model.setProvider("codex")).rejects.toThrow(
      "A running agent cannot change provider.",
    );
  });

  it("rejects a model the provider refuses with the provider's message", async () => {
    openSession(agent());
    await expect(composer().setModel("nope")).rejects.toThrow("The provider refused model 'nope'");
  });

  it("takes the catalog the host changed while the picker was not open, once the host reconnects", async () => {
    openSession(agent({ runtimeInfo: runtimeModel("opus") }));
    const model = composer();
    const stop = model.subscribe(() => {});
    await until(() => model.getState().thinking, "high");

    // The host changes the catalog while the client is away. Reconnecting invalidates the provider
    // catalogs, which refetches the ones something is watching.
    hostCatalog.entries = [
      {
        ...entries[0],
        models: [{ ...entries[0].models![0], defaultThinkingOptionId: "low" }],
      },
    ] as ProviderSnapshotEntry[];
    await queryClient.invalidateQueries({ queryKey: providersSnapshotQueryRoot(serverId) });

    await until(() => model.getState().thinking, "low");
    stop();
  });

  it("asks for the catalog again after a failed load once the host reconnects", async () => {
    hostCatalog.failing = true;
    openSession(agent({ runtimeInfo: runtimeModel("opus") }));
    const model = composer();
    const stop = model.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(model.getState().thinking).toBeNull();

    hostCatalog.failing = false;
    await queryClient.invalidateQueries({ queryKey: providersSnapshotQueryRoot(serverId) });

    await until(() => model.getState().thinking, "high");
    stop();
  });

  it("watches the stores once however many components watch the composer, and only for its own draft", () => {
    openSession(agent());
    const model = composer();
    const calls = [0, 0, 0];
    const stops: Array<() => void> = [];
    for (const index of calls.keys()) {
      stops.push(model.subscribe(() => void (calls[index] += 1)));
    }
    const before = [...calls];
    model.insertText("typed");
    expect(calls.map((count, index) => count - before[index])).toEqual([1, 1, 1]);

    const unrelated = [...calls];
    useDraftStore.getState().replaceDraftText({
      draftKey: buildDraftStoreKey({ serverId, agentId: "agent-2" }),
      text: "elsewhere",
    });
    expect(calls).toEqual(unrelated);
    for (const stop of stops) stop();
  });

  function pickerShows(running: Agent, catalog: ProviderSnapshotEntry[] | null) {
    const picker = resolveAgentModelSelection({
      models: filterSelectableModels(catalog?.[0]?.models ?? null),
      runtimeModelId: running.runtimeInfo?.model ?? null,
      configuredModelId: running.model,
      runtimeThinkingOptionId: running.runtimeInfo?.thinkingOptionId ?? null,
      explicitThinkingOptionId: running.thinkingOptionId,
    });
    return { model: picker.activeModelId, thinking: picker.selectedThinkingId };
  }

  it.each([
    [
      "an alias of a listed model",
      { runtimeInfo: { model: "sonnet" } },
      "sonnet",
      "claude-sonnet-4",
      "low",
    ],
    ["no reported model", { model: null }, null, "opus", "high"],
    ["the configured model", { model: "opus", thinkingOptionId: "low" }, "opus", "opus", "low"],
  ] as const)(
    "shows what the picker shows for %s, before the catalog and after it loads",
    async (_name, overrides, modelBefore, modelAfter, thinkingAfter) => {
      const running = agent(overrides as unknown as Partial<Agent>);
      openSession(running);
      const model = composer();
      // No catalog yet: the picker resolves with no models.
      expect(model.getState()).toMatchObject(pickerShows(running, null));
      expect(model.getState().model).toBe(modelBefore);
      const stop = model.subscribe(() => {});
      await until(() => model.getState().model, modelAfter);
      expect(model.getState()).toMatchObject(pickerShows(running, entries));
      expect(model.getState().thinking).toBe(thinkingAfter);
      stop();
    },
  );

  it("is shared while its agent is in the session, across closing and reopening its tab", () => {
    openSession(agent());
    const shared = agentComposer(serverId, agentId);
    const detach = shared.attachInput({ isLive: () => true, setText() {}, insertText() {} });
    detach();
    expect(agentComposer(serverId, agentId)).toBe(shared);
    const stop = shared.subscribe(() => {});
    stop();
    expect(agentComposer(serverId, agentId)).toBe(shared);
  });

  it("is released when the last holder lets go of a composer whose agent was removed meanwhile", () => {
    openSession(agent());
    const mounted = agentComposer(serverId, agentId);
    const detach = mounted.attachInput({ isLive: () => true, setText() {}, insertText() {} });
    useSessionStore.getState().setAgents(serverId, new Map());
    // Held, so the session change did not release it, and nothing changes in the session after.
    expect(agentComposer(serverId, agentId)).toBe(mounted);
    detach();
    expect(agentComposer(serverId, agentId)).not.toBe(mounted);

    useSessionStore.getState().setAgents(serverId, new Map([[agentId, agent()]]));
    const watched = agentComposer(serverId, agentId);
    const stop = watched.subscribe(() => {});
    useSessionStore.getState().clearSession(serverId);
    expect(agentComposer(serverId, agentId)).toBe(watched);
    stop();
    expect(agentComposer(serverId, agentId)).not.toBe(watched);
  });

  it("is released when its agent is archived and nothing holds it", () => {
    openSession(agent());
    const idle = agentComposer(serverId, agentId);
    useSessionStore
      .getState()
      .setAgents(serverId, new Map([[agentId, agent({ archivedAt: new Date() })]]));
    expect(agentComposer(serverId, agentId)).not.toBe(idle);
  });
});
