import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OpenFileDisposition } from "@/workspace/file-open";
import { openExternalUrl } from "@/utils/open-external-url";
import type { InlinePathTarget } from "./parse";
import {
  useAssistantFileLinkResolverContext,
  type AssistantFileLinkResolverContextValue,
} from "./provider";
import {
  classifyForResolution,
  fetchDaemonResolution,
  UnresolvedFileLinkError,
  type AssistantFileLinkResolution,
  type AssistantFileLinkSource,
} from "./resolver";

export interface UseFileLinkResult {
  target: InlinePathTarget | null;
  onHoverIn: () => void;
  onPress: () => void;
  onAuxPress: () => void;
  open: (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => void;
}

export interface AssistantFileLinkActions {
  open(source: AssistantFileLinkSource, disposition: OpenFileDisposition): void;
  canOpen(source: AssistantFileLinkSource): boolean;
  canResolveFile(source: AssistantFileLinkSource): boolean;
}

type AssistantFileLinkQueryKey = readonly [
  "assistantFileLink",
  string | null,
  string | null,
  string,
];

const DISABLED_QUERY_KEY = ["assistantFileLink", null, null, ""] as const;

export function useFileLink(source: AssistantFileLinkSource): UseFileLinkResult {
  const context = useAssistantFileLinkResolverContext();
  const queryClient = useQueryClient();
  const stableSource = useStableSource(source);
  const resolution = useMemo(
    () =>
      classifyForResolution(stableSource, {
        workspaceRoot: context.config.workspaceRoot,
      }),
    [stableSource, context.config.workspaceRoot],
  );
  const queryKey = useMemo(
    () =>
      resolution.kind === "needsLookup"
        ? assistantFileLinkQueryKey({
            serverId: context.config.serverId,
            workspaceRoot: context.config.workspaceRoot,
            ambiguousQuery: resolution.ambiguousQuery,
          })
        : DISABLED_QUERY_KEY,
    [resolution, context.config.serverId, context.config.workspaceRoot],
  );

  const query = useQuery({
    queryKey,
    queryFn: () => {
      if (resolution.kind !== "needsLookup") {
        throw new Error("Assistant file link lookup requested for a sync link.");
      }
      return fetchDaemonResolution({
        ambiguousQuery: resolution.ambiguousQuery,
        token: resolution.token,
        target: resolution.target,
        workspaceRoot: context.config.workspaceRoot,
        getDirectorySuggestions: context.getDirectorySuggestions,
      });
    },
    enabled: false,
    retry: 0,
    staleTime: Infinity,
  });

  const open = useCallback(
    (nextSource: AssistantFileLinkSource, disposition: OpenFileDisposition) => {
      const capturedConfig = context.configRef.current;
      const capturedResolution = classifyForResolution(nextSource, {
        workspaceRoot: capturedConfig.workspaceRoot,
      });

      if (capturedResolution.kind === "resolved") {
        void dispatchResolvedLink({
          resolution: capturedResolution,
          disposition,
          capturedServerId: capturedConfig.serverId,
          capturedWorkspaceRoot: capturedConfig.workspaceRoot,
          context,
        });
        return;
      }

      const capturedQueryKey = assistantFileLinkQueryKey({
        serverId: capturedConfig.serverId,
        workspaceRoot: capturedConfig.workspaceRoot,
        ambiguousQuery: capturedResolution.ambiguousQuery,
      });

      const run = async () => {
        try {
          const target = await queryClient.fetchQuery({
            queryKey: capturedQueryKey,
            queryFn: () =>
              fetchDaemonResolution({
                ambiguousQuery: capturedResolution.ambiguousQuery,
                token: capturedResolution.token,
                target: capturedResolution.target,
                workspaceRoot: capturedConfig.workspaceRoot,
                getDirectorySuggestions: context.getDirectorySuggestions,
              }),
            retry: 0,
            staleTime: Infinity,
          });
          await dispatchFileTarget({
            target,
            disposition,
            capturedServerId: capturedConfig.serverId,
            capturedWorkspaceRoot: capturedConfig.workspaceRoot,
            context,
          });
        } catch (error) {
          await dispatchUnresolvedError({
            error,
            fallbackToken: capturedResolution.token,
            capturedServerId: capturedConfig.serverId,
            capturedWorkspaceRoot: capturedConfig.workspaceRoot,
            context,
          });
        }
      };

      void run();
    },
    [context, queryClient],
  );

  const onHoverIn = useCallback(() => {
    if (resolution.kind !== "needsLookup") {
      return;
    }

    void queryClient.prefetchQuery({
      queryKey,
      queryFn: () =>
        fetchDaemonResolution({
          ambiguousQuery: resolution.ambiguousQuery,
          token: resolution.token,
          target: resolution.target,
          workspaceRoot: context.config.workspaceRoot,
          getDirectorySuggestions: context.getDirectorySuggestions,
        }),
      retry: 0,
      staleTime: Infinity,
    });
  }, [
    context.config.workspaceRoot,
    context.getDirectorySuggestions,
    queryClient,
    queryKey,
    resolution,
  ]);

  const onPress = useCallback(() => {
    open(stableSource, "main");
  }, [open, stableSource]);
  const onAuxPress = useCallback(() => {
    open(stableSource, "side");
  }, [open, stableSource]);

  const target = useMemo(() => {
    if (resolution.kind === "resolved") {
      return resolution.value.kind === "file" ? resolution.value.target : null;
    }
    return query.data ?? null;
  }, [query.data, resolution]);

  return useMemo(
    () => ({ target, onHoverIn, onPress, onAuxPress, open }),
    [target, onHoverIn, onPress, onAuxPress, open],
  );
}

export function useAssistantFileLinkActions(): AssistantFileLinkActions {
  const context = useAssistantFileLinkResolverContext();
  const actionLink = useFileLink(ACTION_LINK_SOURCE);
  const workspaceRoot = context.config.workspaceRoot;

  const open = useCallback(
    (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => {
      actionLink.open(source, disposition);
    },
    [actionLink],
  );
  const canOpen = useCallback(
    (source: AssistantFileLinkSource) => {
      const resolution = classifyForResolution(source, { workspaceRoot });
      return resolution.kind === "needsLookup" || resolution.value.kind !== "ignored";
    },
    [workspaceRoot],
  );
  const canResolveFile = useCallback(
    (source: AssistantFileLinkSource) => {
      const resolution = classifyForResolution(source, { workspaceRoot });
      return resolution.kind === "needsLookup" || resolution.value.kind === "file";
    },
    [workspaceRoot],
  );

  return useMemo(() => ({ open, canOpen, canResolveFile }), [open, canOpen, canResolveFile]);
}

function useStableSource(source: AssistantFileLinkSource): AssistantFileLinkSource {
  const { href, text, markup, sourceInfo, sourceType } = source;
  return useMemo(
    () => ({ href, text, markup, sourceInfo, sourceType }),
    [href, text, markup, sourceInfo, sourceType],
  );
}

function assistantFileLinkQueryKey(input: {
  serverId?: string;
  workspaceRoot?: string;
  ambiguousQuery: string;
}): AssistantFileLinkQueryKey {
  return [
    "assistantFileLink",
    input.serverId ?? null,
    input.workspaceRoot ?? null,
    input.ambiguousQuery,
  ];
}

async function dispatchResolvedLink(input: {
  resolution: Extract<AssistantFileLinkResolution, { kind: "resolved" }>;
  disposition: OpenFileDisposition;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const { value } = input.resolution;
  if (value.kind === "file") {
    await dispatchFileTarget({
      target: value.target,
      disposition: input.disposition,
      capturedServerId: input.capturedServerId,
      capturedWorkspaceRoot: input.capturedWorkspaceRoot,
      context: input.context,
    });
    return;
  }
  if (value.kind === "external") {
    await dispatchExternalUrl({
      url: value.url,
      capturedServerId: input.capturedServerId,
      capturedWorkspaceRoot: input.capturedWorkspaceRoot,
      context: input.context,
    });
  }
}

async function dispatchFileTarget(input: {
  target: InlinePathTarget;
  disposition: OpenFileDisposition;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const current = input.context.configRef.current;
  if (
    current.serverId !== input.capturedServerId ||
    current.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  current.onOpenWorkspaceFile?.(input.target, input.disposition);
}

async function dispatchExternalUrl(input: {
  url: string;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const current = input.context.configRef.current;
  if (
    current.serverId !== input.capturedServerId ||
    current.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  await openExternalUrl(input.url);
}

async function dispatchUnresolvedError(input: {
  error: unknown;
  fallbackToken: string;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const current = input.context.configRef.current;
  if (
    current.serverId !== input.capturedServerId ||
    current.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  const token =
    input.error instanceof UnresolvedFileLinkError ? input.error.token : input.fallbackToken;
  current.toast?.show(`No file found for ${token}`, {
    variant: "error",
    testID: "assistant-file-link-not-found-toast",
  });
}

const ACTION_LINK_SOURCE: AssistantFileLinkSource = {
  href: "",
};
