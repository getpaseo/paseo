import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { OpenFileDisposition } from "@/workspace/file-open";
import { openWebUrl as openExternalUrl, type WebUrlClick } from "@/utils/open-web-url";
import type { InlinePathTarget } from "./parse";
import { dispatchFileTarget } from "./open-path";
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
  onPress: (event?: WebUrlClick) => void;
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
  const { t } = useTranslation();
  const context = useAssistantFileLinkResolverContext();
  const queryClient = useQueryClient();
  const stableSource = useStableSource(source);
  const activeConfig = context.configRef.current;
  const workspaceRoot = activeConfig.workspaceRoot;
  const serverId = activeConfig.serverId;
  const resolution = useMemo(
    () =>
      classifyForResolution(stableSource, {
        workspaceRoot,
      }),
    [stableSource, workspaceRoot],
  );
  const queryKey = useMemo(
    () =>
      resolution.kind === "needsLookup"
        ? assistantFileLinkQueryKey({
            serverId,
            workspaceRoot,
            token: resolution.token,
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
    (
      nextSource: AssistantFileLinkSource,
      disposition: OpenFileDisposition,
      event?: WebUrlClick,
    ) => {
      openAssistantFileLink({
        source: nextSource,
        event,
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

  const onPress = useStableEvent((event?: WebUrlClick) => {
    open(stableSource, "preferred", event);
  });

  const target = useMemo(() => {
    if (resolution.kind === "resolved") {
      return resolution.value.kind === "file" ? resolution.value.target : null;
    }
    return query.data ?? null;
  }, [query.data, resolution]);

  return useMemo(() => ({ target, onHoverIn, onPress, open }), [target, onHoverIn, onPress, open]);
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
      canOpenAssistantFileLink(source, context.configRef.current.workspaceRoot),
    [context.configRef],
  );
  const canResolveFile = useCallback(
    (source: AssistantFileLinkSource) =>
      canResolveAssistantFileLinkToFile(source, context.configRef.current.workspaceRoot),
    [context.configRef],
  );

  return useMemo(() => ({ open, canOpen, canResolveFile }), [open, canOpen, canResolveFile]);
}

function openAssistantFileLink(input: {
  event?: WebUrlClick;
  source: AssistantFileLinkSource;
  disposition: OpenFileDisposition;
  context: AssistantFileLinkResolverContextValue;
  queryClient: ReturnType<typeof useQueryClient>;
  formatNoFileFoundMessage: (token: string) => string;
}): void {
  const capturedConfig = input.context.configRef.current;
  const capturedResolution = classifyForResolution(input.source, {
    workspaceRoot: capturedConfig.workspaceRoot,
  });

  if (capturedResolution.kind === "resolved") {
    void dispatchResolvedLink({
      resolution: capturedResolution,
      event: {
        metaKey:
          input.event?.metaKey === true ||
          (input.event?.nativeEvent as { metaKey?: boolean } | undefined)?.metaKey === true,
      },
      disposition: input.disposition,
      capturedServerId: capturedConfig.serverId,
      capturedWorkspaceRoot: capturedConfig.workspaceRoot,
      context: input.context,
    }).catch((error: unknown) =>
      dispatchUnresolvedError({
        error,
        noFileFoundMessage: input.formatNoFileFoundMessage(input.source.href),
        capturedServerId: capturedConfig.serverId,
        capturedWorkspaceRoot: capturedConfig.workspaceRoot,
        context: input.context,
      }),
    );
    return;
  }

  const capturedQueryKey = assistantFileLinkQueryKey({
    serverId: capturedConfig.serverId,
    workspaceRoot: capturedConfig.workspaceRoot,
    token: capturedResolution.token,
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
  workspaceRoot: string | undefined,
): boolean {
  const resolution = classifyForResolution(source, { workspaceRoot });
  return resolution.kind === "needsLookup" || resolution.value.kind !== "ignored";
}

function canResolveAssistantFileLinkToFile(
  source: AssistantFileLinkSource,
  workspaceRoot: string | undefined,
): boolean {
  const resolution = classifyForResolution(source, { workspaceRoot });
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
  token: string;
}): AssistantFileLinkQueryKey {
  return ["assistantFileLink", input.serverId ?? null, input.workspaceRoot ?? null, input.token];
}

async function dispatchResolvedLink(input: {
  event?: WebUrlClick;
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
      event: input.event,
      capturedServerId: input.capturedServerId,
      capturedWorkspaceRoot: input.capturedWorkspaceRoot,
      context: input.context,
    });
  }
}

async function dispatchExternalUrl(input: {
  event?: WebUrlClick;
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
  await openExternalUrl(input.url, input.event);
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
  const message =
    input.error instanceof Error && !(input.error instanceof UnresolvedFileLinkError)
      ? input.error.message
      : input.noFileFoundMessage;
  current.toast?.show(message, {
    variant: "error",
    testID: "assistant-file-link-not-found-toast",
  });
}

const ACTION_LINK_SOURCE: AssistantFileLinkSource = {
  href: "",
};
