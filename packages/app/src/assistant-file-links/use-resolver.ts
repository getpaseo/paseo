import { useCallback, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@server/client/daemon-client";
import type { ToastApi } from "@/components/toast-host";
import {
  getAssistantFileLinkToken,
  resolveAssistantFileLink,
  resolveAssistantFileLinkSync,
  type AssistantFileLinkContext,
  type AssistantFileLinkSource,
  type GetDirectorySuggestions,
  type ResolvedAssistantFileLink,
} from "./resolver";
import type { InlinePathTarget } from "./parse";
import type { OpenFileDisposition } from "@/workspace/file-open";
import { openExternalUrl } from "@/utils/open-external-url";

function assistantFileLinkQueryKey(
  serverId: string | undefined,
  workspaceRoot: string | undefined,
  token: string,
) {
  return ["assistantFileLink", serverId ?? null, workspaceRoot ?? null, token] as const;
}

function makeGetDirectorySuggestions(
  client: DaemonClient | null | undefined,
): GetDirectorySuggestions {
  return async (input) => {
    if (!client) {
      return { entries: [], error: null };
    }
    const result = await client.getDirectorySuggestions(input);
    return { entries: result.entries, error: result.error };
  };
}

function synchronousResolution(
  source: AssistantFileLinkSource,
  context: AssistantFileLinkContext,
): ResolvedAssistantFileLink | undefined {
  const sync = resolveAssistantFileLinkSync({ source, context });
  return sync.kind === "resolved" ? sync.resolved : undefined;
}

export interface UseAssistantFileLinkTargetOptions {
  source: AssistantFileLinkSource;
  client?: DaemonClient | null;
  serverId?: string;
  workspaceRoot?: string;
}

export interface UseAssistantFileLinkTargetResult {
  target: InlinePathTarget | null;
  prefetch: () => void;
}

export function useAssistantFileLinkTarget({
  source,
  client,
  serverId,
  workspaceRoot,
}: UseAssistantFileLinkTargetOptions): UseAssistantFileLinkTargetResult {
  const queryClient = useQueryClient();

  // Memo keys reference primitives, not source identity, so identical-content
  // sources reconstructed each render do not bust the memo.
  const href = source.href;
  const text = source.text;
  const markup = source.markup;
  const sourceInfo = source.sourceInfo;
  const sourceType = source.sourceType;

  const stableSource = useMemo<AssistantFileLinkSource>(
    () => ({ href, text, markup, sourceInfo, sourceType }),
    [href, text, markup, sourceInfo, sourceType],
  );

  const token = useMemo(() => getAssistantFileLinkToken(stableSource).trim(), [stableSource]);

  const context = useMemo<AssistantFileLinkContext>(
    () => ({ serverId, workspaceRoot }),
    [serverId, workspaceRoot],
  );

  const initialData = useMemo(
    () => synchronousResolution(stableSource, context),
    [stableSource, context],
  );

  const queryKey = useMemo(
    () => assistantFileLinkQueryKey(serverId, workspaceRoot, token),
    [serverId, workspaceRoot, token],
  );

  const clientRef = useRef(client);
  clientRef.current = client;

  // Subscribe to the cache without auto-firing the queryFn. prefetch() (on hover)
  // and the click action (via queryClient.fetchQuery) are the only paths that
  // trigger the RPC. initialData seeds the cache for synchronously-resolvable
  // references (directFile / external / ignored) so they render immediately.
  const { data } = useQuery({
    queryKey,
    queryFn: () =>
      resolveAssistantFileLink({
        source: stableSource,
        context,
        getDirectorySuggestions: makeGetDirectorySuggestions(clientRef.current),
      }),
    enabled: false,
    initialData,
    staleTime: Infinity,
  });

  const prefetch = useCallback(() => {
    if (!token || initialData) {
      return;
    }
    void queryClient.prefetchQuery({
      queryKey,
      queryFn: () =>
        resolveAssistantFileLink({
          source: stableSource,
          context,
          getDirectorySuggestions: makeGetDirectorySuggestions(clientRef.current),
        }),
      staleTime: Infinity,
    });
  }, [queryClient, queryKey, token, initialData, stableSource, context]);

  const target = useMemo(() => (data?.kind === "file" ? data.target : null), [data]);

  return useMemo(() => ({ target, prefetch }), [target, prefetch]);
}

export interface UseAssistantFileLinkResolverOptions {
  client?: DaemonClient | null;
  serverId?: string;
  workspaceRoot?: string;
  onOpenWorkspaceFile?: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
  toast?: ToastApi | null;
}

export interface AssistantFileLinkOpenInput {
  source: AssistantFileLinkSource;
  disposition: OpenFileDisposition;
}

export interface AssistantFileLinkActions {
  open(input: AssistantFileLinkOpenInput): void;
}

export function useAssistantFileLinkResolver({
  client,
  serverId,
  workspaceRoot,
  onOpenWorkspaceFile,
  toast,
}: UseAssistantFileLinkResolverOptions): AssistantFileLinkActions {
  const queryClient = useQueryClient();
  const depsRef = useRef({ client, serverId, workspaceRoot, onOpenWorkspaceFile, toast });
  depsRef.current = { client, serverId, workspaceRoot, onOpenWorkspaceFile, toast };

  const open = useCallback(
    ({ source, disposition }: AssistantFileLinkOpenInput) => {
      const startDeps = depsRef.current;
      const token = getAssistantFileLinkToken(source).trim();
      if (!token) return;

      const startServerId = startDeps.serverId;
      const startWorkspaceRoot = startDeps.workspaceRoot;
      const queryKey = assistantFileLinkQueryKey(startServerId, startWorkspaceRoot, token);
      const context: AssistantFileLinkContext = {
        serverId: startServerId,
        workspaceRoot: startWorkspaceRoot,
      };

      const run = async () => {
        const resolved: ResolvedAssistantFileLink = await queryClient.fetchQuery({
          queryKey,
          queryFn: () =>
            resolveAssistantFileLink({
              source,
              context,
              getDirectorySuggestions: makeGetDirectorySuggestions(startDeps.client),
            }),
          staleTime: Infinity,
        });

        const current = depsRef.current;
        if (current.serverId !== startServerId || current.workspaceRoot !== startWorkspaceRoot) {
          return;
        }
        if (resolved.kind === "file") {
          current.onOpenWorkspaceFile?.(resolved.target, disposition);
        } else if (resolved.kind === "external") {
          await openExternalUrl(resolved.url);
        } else if (resolved.kind === "unresolvedFileCandidate") {
          current.toast?.show(`No file found for ${resolved.token}`, {
            variant: "error",
            testID: "assistant-file-link-not-found-toast",
          });
        }
      };

      void run();
    },
    [queryClient],
  );

  return useMemo(() => ({ open }), [open]);
}
