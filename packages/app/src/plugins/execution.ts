import type {
  PluginExecutionModeContribution,
  PluginExecutionStartInput,
} from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "./types";

export interface InstalledExecutionMode {
  id: string;
  plugin: InstalledPlugin;
  contribution: PluginExecutionModeContribution;
}

export function getExecutionModes(
  plugins: readonly InstalledPlugin[],
  serverId: string,
): InstalledExecutionMode[] {
  return plugins
    .filter((plugin) => plugin.serverId === serverId && !plugin.lifetime.signal.aborted)
    .flatMap((plugin) =>
      (plugin.executionModes ?? []).map((contribution) => ({
        id: `${plugin.id}:${contribution.id}`,
        plugin,
        contribution,
      })),
    );
}

const pending = new Map<string, Promise<{ agentId: string }>>();

export function startPluginExecution(
  mode: InstalledExecutionMode,
  input: PluginExecutionStartInput,
): Promise<{ agentId: string }> {
  if (
    mode.plugin.lifetime.signal.aborted ||
    !mode.plugin.executionModes.includes(mode.contribution)
  )
    return Promise.reject(
      new Error("Execution mode is unavailable. Enable the plugin or choose Direct."),
    );
  const key = `${mode.plugin.serverId}:${mode.id}:${input.idempotencyKey}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const request = Promise.resolve()
    .then(() => mode.contribution.start(input))
    .then((result) => {
      if (!result.agentId?.trim()) throw new Error("Execution mode returned no agent.");
      return result;
    });
  pending.set(key, request);
  void request
    .finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    })
    .catch(() => undefined);
  return request;
}
