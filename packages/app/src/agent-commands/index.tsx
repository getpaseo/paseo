import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ComposerEditingSession } from "@/composer/editing-session";
import { agentCommandsQueryKey } from "./cache";
import {
  useAgentCommandsQuery,
  type AgentSlashCommand,
  type DraftCommandConfig,
} from "./use-query";

export type {
  AgentSlashCommand,
  DraftCommandConfig,
  DraftCommandTarget,
  AgentCommandsClient,
} from "./use-query";
export { fetchAgentCommands } from "./use-query";

type CommandQuery = ReturnType<typeof useAgentCommandsQuery>;
const QueryContext = createContext<CommandQuery | null>(null);
export interface CommandHints {
  names: ReadonlySet<string>;
  insert(command: string): void;
}
const HintsContext = createContext<CommandHints | null>(null);

function useLiveAgentCommands() {
  return useContext(QueryContext);
}
export function useAutocompleteCommands(input: {
  serverId: string;
  agentId: string;
  enabled: boolean;
  draftConfig?: DraftCommandConfig;
}) {
  const live = useLiveAgentCommands();
  const fallback = useAgentCommandsQuery({
    serverId: input.serverId,
    agentId: input.agentId,
    enabled: !live && input.enabled,
    draftConfig: input.draftConfig,
  });
  return live ?? fallback;
}
export function useAgentCommandHints() {
  return useContext(HintsContext);
}
export function matchCommandLink(
  url: string,
  sourceType: "markdown" | "text" | "inline-code" | undefined,
  names: ReadonlySet<string>,
): string | null {
  return (sourceType === "markdown" || sourceType === "inline-code") &&
    url.startsWith("/") &&
    names.has(url.slice(1))
    ? url
    : null;
}

export function AgentCommandsProvider({
  serverId,
  agentId,
  editingSession,
  enabled,
  children,
}: {
  serverId: string;
  agentId: string;
  editingSession: ComposerEditingSession;
  enabled: boolean;
  children: ReactNode;
}) {
  const query = useAgentCommandsQuery({ serverId, agentId, enabled });
  const queryClient = useQueryClient();
  const namesKey = JSON.stringify(
    [...new Set(query.commands.map((command) => command.name))].sort(),
  );
  const names = useMemo<ReadonlySet<string>>(
    () => new Set(JSON.parse(namesKey) as string[]),
    [namesKey],
  );
  const insert = useCallback(
    (token: string) => {
      const commands = queryClient.getQueryData<AgentSlashCommand[]>(
        agentCommandsQueryKey({ serverId, agentId }),
      );
      if (token.startsWith("/") && commands?.some((command) => `/${command.name}` === token)) {
        editingSession.insertCommand(token);
      }
    },
    [agentId, editingSession, queryClient, serverId],
  );
  const hints = useMemo(() => ({ names, insert }), [names, insert]);
  return (
    <QueryContext.Provider value={enabled ? query : null}>
      <HintsContext.Provider value={enabled ? hints : null}>{children}</HintsContext.Provider>
    </QueryContext.Provider>
  );
}
