import type { PluginSubmissionCheckInput } from "@getpaseo/plugin/client";
import { pluginRegistry } from "./registry";
import { runSubmissionChecks } from "./submission-checks";
import { presentSubmissionDecision } from "./submission-decision";
import type { InstalledPlugin } from "./types";

export function hasInstalledSubmissionChecks(serverId: string) {
  return pluginRegistry
    .getSnapshot()
    .some(
      (plugin) =>
        plugin.serverId === serverId &&
        !plugin.lifetime.signal.aborted &&
        plugin.submissionChecks?.length,
    );
}

export function runInstalledSubmissionChecks(
  serverId: string,
  input: PluginSubmissionCheckInput,
  options: { signal?: AbortSignal; caller?: InstalledPlugin } = {},
) {
  return runSubmissionChecks({
    plugins: pluginRegistry.getSnapshot(),
    serverId,
    input,
    signal: options.signal ?? new AbortController().signal,
    caller: options.caller,
    present: presentSubmissionDecision,
  });
}
