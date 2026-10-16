import { useCallback, useMemo } from "react";
import type { PluginAssistantFileLinkInput } from "@getpaseo/plugin/client";
import { useInstalledPlugins } from "../registry";
import type { InstalledPlugin } from "../types";

export type AssistantFileLinkHandlerInput = Omit<PluginAssistantFileLinkInput, "serverId">;

function dispatchAssistantFileLink(input: {
  plugins: readonly InstalledPlugin[];
  request: PluginAssistantFileLinkInput;
}): boolean {
  for (const plugin of input.plugins) {
    for (const handler of plugin.assistantFileLinkHandlers) {
      try {
        if (handler.handle(input.request)) return true;
      } catch (error) {
        console.warn(
          `[Plugins] Assistant file link handler failed: ${plugin.id}/${handler.id}`,
          error,
        );
      }
    }
  }
  return false;
}

export function useAssistantFileLinkHandler(serverId: string) {
  const installed = useInstalledPlugins();
  const plugins = useMemo(
    () => installed.filter((plugin) => plugin.serverId === serverId),
    [installed, serverId],
  );
  return useCallback(
    (request: AssistantFileLinkHandlerInput) =>
      dispatchAssistantFileLink({
        plugins,
        request: { ...request, serverId },
      }),
    [plugins, serverId],
  );
}
