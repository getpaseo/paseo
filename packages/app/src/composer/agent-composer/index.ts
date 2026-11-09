import { QueryObserver, type QueryClient } from "@tanstack/react-query";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { providersSnapshotQuery } from "@/data/providers-snapshot";
import { replicaQueryOptions } from "@/data/query";
import { queryClient as singletonQueryClient } from "@/data/query-client";
import type { ProviderSnapshotCache } from "@/data/provider-snapshot-cache";
import {
  resolveAgentModelSelection,
  resolveProviderSnapshotEntry,
} from "@/composer/agent-controls/utils";
import type { ComposerModel, ComposerState } from "@/composer/model";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { toDraftInputIfReady, type DraftRecord } from "@/stores/draft-store/state";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { UserComposerAttachment } from "@/attachments/types";

/** The mounted composer's input. While attached, prompt commands go through it. */
export interface MountedComposerInput {
  /** False while the composer is retained but its input is not on screen. */
  isLive(): boolean;
  setText(text: string): void;
  /** Inserts at the cursor, replacing the selection. */
  insertText(text: string): void;
}

/**
 * The composer of a running agent. It exists whether or not the agent's tab is open: the prompt
 * and attachments are the agent's draft in the draft store, its settings are the session store's
 * agent, and the model and thinking level resolve through the provider catalog exactly as the
 * model picker does.
 */
export interface AgentComposer extends ComposerModel {
  /** The mounted composer plugs in cursor-aware prompt commands for as long as it is mounted. */
  attachInput(input: MountedComposerInput): () => void;
}

interface AgentComposerDeps {
  queryClient: QueryClient;
  cache?: ProviderSnapshotCache;
  /** The last watcher or mounted composer let go, so the composer may be releasable. */
  onUnheld?: () => void;
}

type Catalog = { status: "loading" } | { status: "ready"; entries: ProviderSnapshotEntry[] | null };

const NO_VALUES = Object.freeze({});
const NO_ATTACHMENTS: readonly UserComposerAttachment[] = Object.freeze([]);

interface ManagedAgentComposer extends AgentComposer {
  /** The agent is gone or archived, and nothing watches the composer or has one mounted. */
  isReleasable(): boolean;
}

export function createAgentComposer(
  serverId: string,
  agentId: string,
  deps: AgentComposerDeps,
): ManagedAgentComposer {
  const draftKey = buildDraftStoreKey({ serverId, agentId });
  const listeners = new Set<() => void>();
  // While something watches, the catalog has an observer: it fetches the catalog, and it is what
  // makes the catalog an active query that reconnect repair refetches, a failed one included.
  let observing: { cwd: string; stop: () => void } | null = null;
  // One pair of store subscriptions serves every listener, from the first to the last.
  let stopWatchingStores: (() => void) | null = null;
  let mounted: MountedComposerInput | null = null;
  let last: {
    agent: Agent | null;
    draft: DraftRecord | undefined;
    catalog: Catalog;
    state: ComposerState;
  } | null = null;

  function readAgent(): Agent | null {
    const session = useSessionStore.getState().sessions[serverId];
    return session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null;
  }

  function client() {
    const connected = useSessionStore.getState().sessions[serverId]?.client;
    if (!connected) throw new Error("The host is not connected.");
    return connected;
  }

  function catalogQuery(cwd: string) {
    return replicaQueryOptions(
      providersSnapshotQuery({
        serverId,
        cwd,
        client,
        queryClient: deps.queryClient,
        cache: deps.cache,
      }),
    );
  }

  function notify() {
    for (const listener of listeners) listener();
  }

  function observeCatalog() {
    const agent = listeners.size > 0 ? readAgent() : null;
    const session = useSessionStore.getState().sessions[serverId];
    const cwd =
      agent && session?.client && session.serverInfo?.features?.providersSnapshot === true
        ? agent.cwd
        : null;
    if ((observing?.cwd ?? null) === cwd) return;
    observing?.stop();
    observing = null;
    if (cwd === null) return;
    // Watching again after the catalog was invalidated or failed while nothing watched refreshes it.
    const options = { ...catalogQuery(cwd), refetchOnMount: true };
    observing = { cwd, stop: new QueryObserver(deps.queryClient, options).subscribe(notify) };
  }

  function watchStores() {
    const stops = [
      useSessionStore.subscribe(() => {
        observeCatalog();
        notify();
      }),
      useDraftStore.subscribe((state, previous) => {
        if (state.drafts[draftKey] !== previous.drafts[draftKey]) notify();
      }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }

  function readCatalog(agent: Agent): Catalog {
    const session = useSessionStore.getState().sessions[serverId];
    // The picker never loads a catalog from a host without it and shows the configured model.
    if (session?.serverInfo?.features?.providersSnapshot !== true) {
      return { status: "ready", entries: null };
    }
    const query = catalogQuery(agent.cwd);
    const state = deps.queryClient.getQueryState<{ entries: ProviderSnapshotEntry[] }>(
      query.queryKey,
    );
    // Nothing observes while nothing watches, so a read starts the one deduplicated load or
    // refresh it needs and shows the cached catalog meanwhile. A read can run in another
    // component's render and creating the query tells every query-cache subscriber, so it starts
    // after the render.
    const loads = state?.isInvalidated === true || (!state?.data && state?.status !== "error");
    if (loads && !observing && session.client) {
      queueMicrotask(() => void deps.queryClient.prefetchQuery(query));
    }
    if (state?.data) return { status: "ready", entries: state.data.entries };
    if (state?.status === "error") return { status: "ready", entries: null };
    return { status: "loading" };
  }

  function selectModel(agent: Agent, catalog: Catalog) {
    // Until the catalog lands there are no models, which is what the picker resolves with too.
    const entries = catalog.status === "ready" ? catalog.entries : null;
    return resolveAgentModelSelection({
      models: filterSelectableModels(
        resolveProviderSnapshotEntry(entries ?? undefined, agent.provider)?.models ?? null,
      ),
      runtimeModelId: agent.runtimeInfo?.model ?? null,
      configuredModelId: agent.model,
      runtimeThinkingOptionId: agent.runtimeInfo?.thinkingOptionId ?? null,
      explicitThinkingOptionId: agent.thinkingOptionId,
    });
  }

  function buildState(
    agent: Agent | null,
    catalog: Catalog,
    record: DraftRecord | undefined,
  ): ComposerState {
    const draft = toDraftInputIfReady(record);
    const selection = agent ? selectModel(agent, catalog) : null;
    return {
      context: "agent",
      prompt: draft?.text ?? "",
      attachments: draft?.attachments ?? NO_ATTACHMENTS,
      provider: agent?.provider ?? null,
      model: selection?.activeModelId ?? null,
      mode: agent?.currentModeId ?? null,
      thinking: selection?.selectedThinkingId ?? null,
      options: agent?.options ?? NO_VALUES,
      metadata: agent?.metadata ?? NO_VALUES,
    };
  }

  function readDraft(): DraftRecord | undefined {
    const record = useDraftStore.getState().drafts[draftKey];
    return record?.lifecycle === "active" ? record : undefined;
  }

  function getState(): ComposerState {
    const agent = readAgent();
    const draft = readDraft();
    const catalog = agent ? readCatalog(agent) : ({ status: "loading" } as const);
    if (
      last &&
      last.agent === agent &&
      last.draft === draft &&
      sameCatalog(last.catalog, catalog)
    ) {
      return last.state;
    }
    last = { agent, draft, catalog, state: buildState(agent, catalog, draft) };
    return last.state;
  }

  function unheld() {
    if (listeners.size === 0 && mounted === null) deps.onUnheld?.();
  }

  return {
    isReleasable() {
      if (listeners.size > 0 || mounted !== null) return false;
      const agent = readAgent();
      return agent === null || agent.archivedAt != null;
    },
    getState,
    subscribe(listener) {
      listeners.add(listener);
      stopWatchingStores ??= watchStores();
      observeCatalog();
      getState();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopWatchingStores?.();
          stopWatchingStores = null;
        }
        observeCatalog();
        unheld();
      };
    },
    attachInput(input) {
      mounted = input;
      return () => {
        if (mounted === input) mounted = null;
        unheld();
      };
    },
    setPrompt(text) {
      if (mounted?.isLive()) mounted.setText(text);
      else useDraftStore.getState().replaceDraftText({ draftKey, text });
    },
    insertText(text) {
      if (mounted?.isLive()) mounted.insertText(text);
      else {
        const current = useDraftStore.getState().getDraftInput(draftKey)?.text ?? "";
        useDraftStore.getState().replaceDraftText({ draftKey, text: current + text });
      }
    },
    changeAttachments(updater) {
      useDraftStore.getState().updateDraftInput({
        draftKey,
        update: (current) => ({ ...current, attachments: updater(current.attachments) }),
      });
    },
    async setProvider() {
      throw new Error("A running agent cannot change provider.");
    },
    async setModel(modelId) {
      await client().setAgentModel(agentId, modelId);
    },
    async setMode(modeId) {
      await client().setAgentMode(agentId, modeId);
    },
    async setThinking(thinkingOptionId) {
      await client().setAgentThinkingOption(agentId, thinkingOptionId);
    },
    async setOptions(patch) {
      await client().setAgentOptions(agentId, patch);
    },
    async setMetadata(patch) {
      await client().setAgentMetadata(agentId, patch);
    },
  };
}

function sameCatalog(left: Catalog, right: Catalog): boolean {
  return (
    left.status === right.status &&
    (left.status === "loading" || left.entries === (right as typeof left).entries)
  );
}

const composers = new Map<string, ManagedAgentComposer>();
let stopReleasing: (() => void) | null = null;

/**
 * The composer of a running agent; the same one for every caller for as long as the agent is in the
 * session and not archived, so a command a plugin saved keeps reaching the composer a later tab
 * mounts. It is released when the agent is gone or archived and nothing holds it, checked when the
 * session changes and when the last holder lets go.
 */
export function agentComposer(serverId: string, agentId: string): AgentComposer {
  stopReleasing ??= useSessionStore.subscribe(releaseReleasableComposers);
  const key = `${serverId}:${agentId}`;
  let composer = composers.get(key);
  if (!composer) {
    composer = createAgentComposer(serverId, agentId, {
      queryClient: singletonQueryClient,
      onUnheld: releaseReleasableComposers,
    });
    composers.set(key, composer);
  }
  return composer;
}

function releaseReleasableComposers() {
  for (const [key, composer] of composers) {
    if (composer.isReleasable()) composers.delete(key);
  }
}
