import { defineRpc } from "@getpaseo/plugin";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providersSnapshotQueryRoot } from "@/data/providers-snapshot";
import { queryClient } from "@/data/query-client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { createPluginClientStateSource } from "../client-state/source";
import { buildPluginCommandCenterContributions } from "../command-center/contributions";
import { publishFocusedAgent } from "../focused-agent";
import type { InstalledPlugin } from "../types";
import { pluginComposersSource } from "./source";

const serverId = "host-1";

function plugin(): InstalledPlugin {
  return {
    id: "review",
    serverId,
    clientBundle: "bundle",
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    queryClient: new QueryClient(),
    paseo: createPaseoApi(
      new DaemonClient({
        url: "ws://127.0.0.1:1",
        clientId: "plugin-composer-test",
        clientType: "cli",
      }),
    ),
    invoke: async () => undefined,
    subscribe: () => {
      throw new Error("Subscriptions are not used here");
    },
    cleanup: () => {},
    settingsScreens: [],
    surfaces: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    sidebarViews: [],
    filePanels: [],
    composerItems: [],
    newWorkspaceItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [
      {
        id: "issues",
        title: "Issues",
        pickerTitle: "Issues",
        searchPlaceholder: "Search",
        icon: "Bug",
        search: defineRpc({
          name: "issues.search",
          input: z.object({}),
          output: z.array(z.object({})),
        }),
      },
    ],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

function agent(id: string, archivedAt: Date | null = null): Agent {
  return {
    serverId,
    id,
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date(),
    updatedAt: new Date(),
    lastUserMessageAt: null,
    lastActivityAt: new Date(),
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
    archivedAt,
  };
}

beforeEach(() => {
  useDraftStore.setState({ drafts: {}, textReplacementRequestByDraftKey: {} });
  const store = useSessionStore.getState();
  store.initializeSession(serverId, {} as never);
  store.setAgents(
    serverId,
    new Map([
      ["agent-1", agent("agent-1")],
      ["agent-2", agent("agent-2", new Date())],
    ]),
  );
});

afterEach(() => {
  publishFocusedAgent(null);
  useSessionStore.getState().clearSession(serverId);
});

describe("a plugin's composers by reference", () => {
  it("names a running agent by id, and nothing for an unknown or archived one", () => {
    const source = pluginComposersSource(plugin());
    expect(source.resolve({ agentId: "agent-1" })).toHaveLength(1);
    expect(source.resolve({ agentId: "nope" })).toEqual([]);
    expect(source.resolve({ agentId: "agent-2" })).toEqual([]);
  });

  it("follows the agent the Command Center hands out, and is empty when there is none", () => {
    const source = pluginComposersSource(plugin());
    let notified = 0;
    const stop = source.subscribe({ focused: true }, () => {
      notified += 1;
    });
    expect(source.resolve({ focused: true })).toEqual([]);

    publishFocusedAgent({ serverId, agentId: "agent-1" });
    const [focused] = source.resolve({ focused: true });
    expect(focused?.context).toBe("agent");
    expect(notified).toBeGreaterThan(0);

    // Leaving the workspace for a plugin screen or New workspace publishes no agent.
    publishFocusedAgent(null);
    expect(source.resolve({ focused: true })).toEqual([]);

    // Another host's focused agent is not this plugin's.
    publishFocusedAgent({ serverId: "host-2", agentId: "agent-1" });
    expect(source.resolve({ focused: true })).toEqual([]);
    stop();
  });

  it("is not told when another component creates a query while it renders", () => {
    const source = pluginComposersSource(plugin());
    let notified = 0;
    const stop = source.subscribe({ agentId: "agent-1" }, () => {
      notified += 1;
    });
    // `useQuery` does this during a render, and a subscriber that updates then makes React warn
    // that one component updated another while rendering.
    queryClient.getQueryCache().build(queryClient, { queryKey: ["created-during-a-render"] });
    expect(notified).toBe(0);
    stop();
  });

  it("delivers a draft change once to each of several components watching the same agent", () => {
    const source = pluginComposersSource(plugin());
    const delivered = [0, 0, 0];
    const stops: Array<() => void> = [];
    for (const index of delivered.keys()) {
      stops.push(source.subscribe({ agentId: "agent-1" }, () => void (delivered[index] += 1)));
    }
    const before = [...delivered];
    source.resolve({ agentId: "agent-1" })[0]?.insertText("typed");
    expect(delivered.map((count, index) => count - before[index])).toEqual([1, 1, 1]);
    for (const stop of stops) stop();
  });

  it("returns the same array until a composer changes", () => {
    const source = pluginComposersSource(plugin());
    const first = source.resolve({ agentId: "agent-1" });
    expect(source.resolve({ agentId: "agent-1" })).toBe(first);
    first[0]?.insertText("hello");
    const next = source.resolve({ agentId: "agent-1" });
    expect(next).not.toBe(first);
    expect(next[0]?.prompt).toBe("hello");
  });
});

describe("a plugin component watching a composer by reference", () => {
  const catalog = (defaultThinkingOptionId: string): ProviderSnapshotEntry[] => [
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
          defaultThinkingOptionId,
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
      ],
    },
  ];

  afterEach(() => {
    queryClient.clear();
  });

  async function until(read: () => unknown, expected: unknown) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (Object.is(read(), expected)) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(read()).toBe(expected);
  }

  function hostWithDefaultThinking(initial: string) {
    const host = { defaultThinking: initial };
    const client = {
      async getProvidersSnapshot() {
        return {
          entries: catalog(host.defaultThinking),
          generatedAt: "2026-11-04T10:00:00.000Z",
          requestId: "snapshot",
        };
      },
    } as unknown as DaemonClient;
    const store = useSessionStore.getState();
    store.clearSession(serverId);
    store.initializeSession(serverId, client);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: null,
      features: { providersSnapshot: true },
    } as never);
    store.setAgents(serverId, new Map([["agent-1", agent("agent-1")]]));
    return host;
  }

  it("refreshes a catalog that was invalidated while nothing watched, when watching resumes", async () => {
    const host = hostWithDefaultThinking("high");
    const source = pluginComposersSource(plugin());
    const stopFirst = source.subscribe({ agentId: "agent-1" }, () => {});
    await until(() => source.resolve({ agentId: "agent-1" })[0]?.agent.thinking, "high");
    stopFirst();

    // Reconnect repair only refetches what is watched, so this catalog is invalidated and kept.
    host.defaultThinking = "low";
    await queryClient.invalidateQueries({ queryKey: providersSnapshotQueryRoot(serverId) });

    const stopAgain = source.subscribe({ agentId: "agent-1" }, () => {});
    await until(() => source.resolve({ agentId: "agent-1" })[0]?.agent.thinking, "low");
    stopAgain();
  });

  it("refreshes an invalidated catalog for a command that reads once", async () => {
    const host = hostWithDefaultThinking("high");
    const source = pluginComposersSource(plugin());
    const stopFirst = source.subscribe({ agentId: "agent-1" }, () => {});
    await until(() => source.resolve({ agentId: "agent-1" })[0]?.agent.thinking, "high");
    stopFirst();
    host.defaultThinking = "low";
    await queryClient.invalidateQueries({ queryKey: providersSnapshotQueryRoot(serverId) });

    // A command cannot wait, so this read still shows the old catalog and starts the refresh.
    source.resolve({ agentId: "agent-1" });
    await until(() => source.resolve({ agentId: "agent-1" })[0]?.agent.thinking, "low");
  });

  it("sees the catalog the host changed while away once the host reconnects, with no picker open", async () => {
    let hostDefault = "high";
    const client = {
      async getProvidersSnapshot() {
        return {
          entries: catalog(hostDefault),
          generatedAt: "2026-11-04T10:00:00.000Z",
          requestId: "snapshot",
        };
      },
    } as unknown as DaemonClient;
    const store = useSessionStore.getState();
    store.clearSession(serverId);
    store.initializeSession(serverId, client);
    store.updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: null,
      features: { providersSnapshot: true },
    } as never);
    store.setAgents(serverId, new Map([["agent-1", agent("agent-1")]]));

    const source = pluginComposersSource(plugin());
    const stop = source.subscribe({ agentId: "agent-1" }, () => {});
    await until(() => source.resolve({ agentId: "agent-1" })[0]?.agent.thinking, "high");

    // Reconnecting invalidates the provider catalogs, which refetches the ones something watches.
    hostDefault = "low";
    await queryClient.invalidateQueries({ queryKey: providersSnapshotQueryRoot(serverId) });

    await until(() => source.resolve({ agentId: "agent-1" })[0]?.agent.thinking, "low");
    stop();
  });
});

describe("a Command Center item reaching an agent's composer by id", () => {
  // The real client-state source reads these stores. A lookup that came back empty would make the
  // Command Center return before calling the item, and nothing would be reported.
  const workspace: WorkspaceDescriptor = {
    createdAt: null,
    lastUserMessageAt: null,
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName: "Repo",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "checkout",
    name: "Repo",
    title: null,
    pinnedAt: null,
    status: "running",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };

  function markForReview(rejection?: Error) {
    const patches: unknown[] = [];
    const client = {
      async setAgentMetadata(_agentId: string, patch: unknown) {
        patches.push(patch);
        if (rejection) throw rejection;
      },
    } as unknown as DaemonClient;
    useSessionStore.getState().clearSession(serverId);
    useSessionStore.getState().initializeSession(serverId, client);
    useSessionStore.getState().setAgents(serverId, new Map([["agent-1", agent("agent-1")]]));
    useSessionStore.getState().setWorkspaces(serverId, new Map([[workspace.id, workspace]]));
    const installed = plugin();
    installed.commandCenterItems = [
      {
        id: "mark",
        title: "Mark for review",
        icon: "Flag",
        context: "agent",
        async onSelect({ agent: handed, composers }) {
          for (const composer of composers({ agentId: handed.id })) {
            await composer.setMetadata({ needsReview: true });
          }
        },
      },
    ];
    const reported: unknown[] = [];
    const [item] = buildPluginCommandCenterContributions({
      plugins: [installed],
      state: createPluginClientStateSource(serverId),
      workspaceId: "workspace-1",
      agentId: "agent-1",
      navigation: {
        openSettings() {},
        openSurface() {},
        openWorkspacePanel() {},
        openAgentPanel() {},
      },
      reportError: (error) => reported.push(error),
    });
    return { run: item?.run, patches, reported };
  }

  it("changes the agent's metadata through the daemon", async () => {
    const { run, patches, reported } = markForReview();
    await run?.();
    expect(patches).toEqual([{ needsReview: true }]);
    expect(reported).toEqual([]);
  });

  it("reports what the daemon rejected", async () => {
    const { run, reported } = markForReview(new Error("metadata refused"));
    await run?.();
    expect(reported).toEqual([new Error("metadata refused")]);
  });
});
