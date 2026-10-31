import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { OpenFileDisposition } from "@/workspace/file-open";
import { openExternalUrl } from "@/utils/open-external-url";
import { formatFileLinkTooltipPath } from "./tooltip-path";
import type { InlinePathTarget } from "./parse";
import {
  useAssistantFileLinkResolverContext,
  type AssistantFileLinkResolverContextValue,
} from "./provider";
import {
  classifyForResolution,
  fetchDaemonResolution,
  type AssistantFileLinkResolution,
  type AssistantFileLinkSource,
  type AssistantFileLinkContext,
} from "./resolver";

export interface UseFileLinkResult {
  target: InlinePathTarget | null;
  tooltipPath: string | null;
  onHoverIn: () => void;
  onPress: () => void;
  open: (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => void;
}

export interface AssistantFileLinkActions {
  open(source: AssistantFileLinkSource, disposition: OpenFileDisposition): void;
  canOpen(source: AssistantFileLinkSource): boolean;
  canResolveFile(source: AssistantFileLinkSource): boolean;
}

interface AssistantFileLinkLookupKey {
  query: string;
  path: string;
  lineStart: number | null;
  lineEnd: number | null;
}

type AssistantFileLinkQueryKey = readonly [
  "assistantFileLink",
  string | null,
  string | null,
  AssistantFileLinkLookupKey | null,
];

const DISABLED_QUERY_KEY = ["assistantFileLink", null, null, null] as const;

export function useFileLink(source: AssistantFileLinkSource): UseFileLinkResult {
  const { t } = useTranslation();
  const context = useAssistantFileLinkResolverContext();
  const queryClient = useQueryClient();
  const stableSource = useStableSource(source);
  const activeConfig = context.configRef.current;
  const workspaceRoot = activeConfig.workspaceRoot;
  const relativePathBase = activeConfig.relativePathBase;
  const serverId = activeConfig.serverId;
  const resolution = useMemo(
    () =>
      classifyForResolution(stableSource, {
        workspaceRoot,
        relativePathBase,
      }),
    [stableSource, workspaceRoot, relativePathBase],
  );
  const queryKey = useMemo(
    () =>
      resolution.kind === "needsLookup"
        ? assistantFileLinkQueryKey({
            serverId,
            workspaceRoot,
            resolution,
          })
        : DISABLED_QUERY_KEY,
    [resolution, serverId, workspaceRoot],
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
        workspaceRoot,
        getDirectorySuggestions: context.getDirectorySuggestions,
      });
    },
    enabled: false,
    retry: 0,
    staleTime: Infinity,
  });

  const open = useStableEvent(
    (nextSource: AssistantFileLinkSource, disposition: OpenFileDisposition) => {
      openAssistantFileLink({
        source: nextSource,
        disposition,
        context,
        queryClient,
        formatNoFileFoundMessage: (token) => t("common.errors.noFileFound", { token }),
      });
    },
  );

  const onHoverIn = useStableEvent(() => {
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
          workspaceRoot,
          getDirectorySuggestions: context.getDirectorySuggestions,
        }),
      retry: 0,
      staleTime: Infinity,
    });
  });

  const onPress = useStableEvent(() => {
    open(stableSource, "preferred");
  });

  const target = useMemo(() => {
    if (resolution.kind === "resolved") {
      return resolution.value.kind === "file" ? resolution.value.target : null;
    }
    return query.data ?? null;
  }, [query.data, resolution]);

  const tooltipPath = target ? formatFileLinkTooltipPath({ target, workspaceRoot }) : null;
  return useMemo(
    () => ({ target, tooltipPath, onHoverIn, onPress, open }),
    [target, tooltipPath, onHoverIn, onPress, open],
  );
}

export function useAssistantFileLinkActions(): AssistantFileLinkActions {
  const context = useAssistantFileLinkResolverContext();
  const actionLink = useFileLink(ACTION_LINK_SOURCE);

  const open = useStableEvent(
    (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => {
      actionLink.open(source, disposition);
    },
  );
  const canOpen = useCallback(
    (source: AssistantFileLinkSource) =>
      canOpenAssistantFileLink(source, context.configRef.current),
    [context.configRef],
  );
  const canResolveFile = useCallback(
    (source: AssistantFileLinkSource) =>
      canResolveAssistantFileLinkToFile(source, context.configRef.current),
    [context.configRef],
  );

  return useMemo(() => ({ open, canOpen, canResolveFile }), [open, canOpen, canResolveFile]);
}

function openAssistantFileLink(input: {
  source: AssistantFileLinkSource;
  disposition: OpenFileDisposition;
  context: AssistantFileLinkResolverContextValue;
  queryClient: ReturnType<typeof useQueryClient>;
  formatNoFileFoundMessage: (token: string) => string;
}): void {
  const capturedConfig = input.context.configRef.current;
  const capturedResolution = classifyForResolution(input.source, {
    workspaceRoot: capturedConfig.workspaceRoot,
    relativePathBase: capturedConfig.relativePathBase,
  });

  if (capturedResolution.kind === "resolved") {
    void dispatchResolvedLink({
      resolution: capturedResolution,
      disposition: input.disposition,
      capturedServerId: capturedConfig.serverId,
      capturedWorkspaceRoot: capturedConfig.workspaceRoot,
      context: input.context,
    });
    return;
  }

  const capturedQueryKey = assistantFileLinkQueryKey({
    serverId: capturedConfig.serverId,
    workspaceRoot: capturedConfig.workspaceRoot,
    resolution: capturedResolution,
  });

  const run = async () => {
    try {
      const target = await input.queryClient.fetchQuery({
        queryKey: capturedQueryKey,
        queryFn: () =>
          fetchDaemonResolution({
            ambiguousQuery: capturedResolution.ambiguousQuery,
            token: capturedResolution.token,
            target: capturedResolution.target,
            workspaceRoot: capturedConfig.workspaceRoot,
            getDirectorySuggestions: input.context.getDirectorySuggestions,
          }),
        retry: 0,
        staleTime: Infinity,
      });
      await dispatchFileTarget({
        target,
        disposition: input.disposition,
        capturedServerId: capturedConfig.serverId,
        capturedWorkspaceRoot: capturedConfig.workspaceRoot,
        context: input.context,
      });
    } catch (error) {
      await dispatchUnresolvedError({
        error,
        noFileFoundMessage: input.formatNoFileFoundMessage(capturedResolution.token),
        capturedServerId: capturedConfig.serverId,
        capturedWorkspaceRoot: capturedConfig.workspaceRoot,
        context: input.context,
      });
    }
  };

  void run();
}

function canOpenAssistantFileLink(
  source: AssistantFileLinkSource,
  context: AssistantFileLinkContext,
): boolean {
  const resolution = classifyForResolution(source, context);
  return resolution.kind === "needsLookup" || resolution.value.kind !== "ignored";
}

function canResolveAssistantFileLinkToFile(
  source: AssistantFileLinkSource,
  context: AssistantFileLinkContext,
): boolean {
  const resolution = classifyForResolution(source, context);
  return resolution.kind === "needsLookup" || resolution.value.kind === "file";
}

function useStableSource(source: AssistantFileLinkSource): AssistantFileLinkSource {
  const { href, text, title, markup, sourceInfo, sourceType } = source;
  return useMemo(
    () => ({ href, text, title, markup, sourceInfo, sourceType }),
    [href, text, title, markup, sourceInfo, sourceType],
  );
}

function assistantFileLinkQueryKey(input: {
  serverId?: string;
  workspaceRoot?: string;
  resolution: Extract<AssistantFileLinkResolution, { kind: "needsLookup" }>;
}): AssistantFileLinkQueryKey {
  return [
    "assistantFileLink",
    input.serverId ?? null,
    input.workspaceRoot ?? null,
    {
      query: input.resolution.ambiguousQuery,
      path: input.resolution.target.path,
      lineStart: input.resolution.target.lineStart ?? null,
      lineEnd: input.resolution.target.lineEnd ?? null,
    },
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
  noFileFoundMessage: string;
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
  current.toast?.show(input.noFileFoundMessage, {
    variant: "error",
    testID: "assistant-file-link-not-found-toast",
  });
}

const ACTION_LINK_SOURCE: AssistantFileLinkSource = {
  href: "",
};
