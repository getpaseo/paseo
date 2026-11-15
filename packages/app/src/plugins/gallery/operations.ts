import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  PluginListItem,
  PluginUpdatePreview,
  PluginUpdateProposal,
} from "@getpaseo/protocol/messages";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { pluginListQueryKey } from "@/plugins/plugin-list";
import { pluginErrorText } from "./error-text";

/**
 * Installs and updates outlive the screen that started them: leaving Plugins and coming back
 * mid-run still shows the run on its row. A finished run leaves no entry; the plugin list says
 * what changed.
 */
export type PluginOperation =
  | { kind: "install" | "update"; status: "running" }
  | { kind: "install" | "update"; status: "failed"; error: string };

type Listener = () => void;

const operations = new Map<string, PluginOperation>();
const listeners = new Set<Listener>();

function operationKey(serverId: string, subject: string): string {
  return `${serverId}\n${subject}`;
}

function setOperation(serverId: string, subject: string, operation: PluginOperation | null) {
  const key = operationKey(serverId, subject);
  if (operation) operations.set(key, operation);
  else operations.delete(key);
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The install or update running or failed for a plugin, keyed by listing ID or plugin ID. */
export function usePluginOperation(serverId: string, subject: string | undefined) {
  const read = useCallback(
    () => (subject ? operations.get(operationKey(serverId, subject)) : undefined),
    [serverId, subject],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/** Forgets a failed run once its error has been read. A running one keeps going. */
export function dismissFailedOperation(serverId: string, subject: string) {
  if (operations.get(operationKey(serverId, subject))?.status === "failed")
    setOperation(serverId, subject, null);
}

export function pluginUpdatesQueryKey(serverId: string) {
  return ["plugin-updates", serverId] as const;
}

function upsertPlugin(queryClient: QueryClient, serverId: string, plugin: PluginListItem) {
  queryClient.setQueryData<PluginListItem[]>(pluginListQueryKey(serverId), (plugins = []) => {
    const others = plugins.filter((candidate) => candidate.id !== plugin.id);
    return [...others, plugin].sort((left, right) => left.id.localeCompare(right.id));
  });
}

interface HostContext {
  client: DaemonClient;
  queryClient: QueryClient;
  serverId: string;
}

export interface InstallRequest extends HostContext {
  /** A registry ID such as `acme/example`, or any source the CLI accepts. */
  source: string;
  /** Where the run shows: the listing ID, or the source for an install from source. */
  subject: string;
  /** Plugins are off on the host; the confirmation said installing turns them on. */
  enablePlugins: boolean;
  onInstalled(plugin: PluginListItem): void;
}

export async function installPlugin(request: InstallRequest): Promise<void> {
  const { client, queryClient, serverId, subject } = request;
  if (operations.get(operationKey(serverId, subject))?.status === "running") return;
  setOperation(serverId, subject, { kind: "install", status: "running" });
  try {
    if (request.enablePlugins) {
      const result = await client.patchDaemonConfig({ pluginsEnabled: true });
      queryClient.setQueryData(daemonConfigQueryKey(serverId), result.config);
    }
    const plugin = await client.installPluginSource({ source: request.source });
    // Write the result before clearing the run, so the row goes straight to Installed.
    upsertPlugin(queryClient, serverId, plugin);
    setOperation(serverId, subject, null);
    request.onInstalled(plugin);
  } catch (error) {
    setOperation(serverId, subject, {
      kind: "install",
      status: "failed",
      error: pluginErrorText(error),
    });
  }
}

export interface UpdateRequest extends HostContext {
  proposals: PluginUpdateProposal[];
  onUpdated(plugins: PluginListItem[]): void;
}

export async function updatePlugins(request: UpdateRequest): Promise<void> {
  const { client, queryClient, serverId } = request;
  const proposals = request.proposals.filter(
    (proposal) => operations.get(operationKey(serverId, proposal.id))?.status !== "running",
  );
  if (proposals.length === 0) return;
  for (const proposal of proposals)
    setOperation(serverId, proposal.id, { kind: "update", status: "running" });
  try {
    const results = await client.applyPluginUpdates(proposals);
    const updated: PluginListItem[] = [];
    for (const result of results) {
      if (result.outcome === "updated" && result.plugin) {
        upsertPlugin(queryClient, serverId, result.plugin);
        updated.push(result.plugin);
        setOperation(serverId, result.id, null);
      } else {
        setOperation(serverId, result.id, {
          kind: "update",
          status: "failed",
          error: result.error ?? "Update failed",
        });
      }
    }
    const updatedIds = new Set(updated.map((plugin) => plugin.id));
    queryClient.setQueryData<PluginUpdatePreview[]>(pluginUpdatesQueryKey(serverId), (previews) =>
      previews?.filter((preview) => !updatedIds.has(preview.id)),
    );
    if (updated.length) request.onUpdated(updated);
    if (updated.length < results.length) recheckUpdates(request);
  } catch (error) {
    for (const proposal of proposals)
      setOperation(serverId, proposal.id, {
        kind: "update",
        status: "failed",
        error: pluginErrorText(error),
      });
    recheckUpdates(request);
  }
}

// A proposal fails when the plugin changed since it was reviewed; Retry needs a fresh one.
function recheckUpdates({ queryClient, serverId }: HostContext): void {
  void queryClient.invalidateQueries({ queryKey: pluginUpdatesQueryKey(serverId) });
}
