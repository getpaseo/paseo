import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { OpenFileDisposition } from "@/workspace/file-open";
import { shouldRouteWorkspaceUrlToProxiedBrowser } from "@/desktop/browser/proxy";
import { openExternalUrl } from "@/utils/open-external-url";
import { formatFileLinkTooltipPath } from "./tooltip-path";
import { normalizeInlinePathTarget, type InlinePathTarget } from "./parse";
import { resolveInlinePathDestination } from "./path-open";
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
  /** What a link names, for offering actions on it. Null when Paseo does nothing with it. */
  inspect(source: AssistantFileLinkSource): AssistantFileLinkInspection | null;
}

export interface AssistantFileLinkPath {
  /** Workspace-relative inside the workspace, absolute or `~/` outside it. */
  path: string;
  kind: "file" | "directory";
}

export type AssistantFileLinkInspection =
  | { kind: "url"; url: string }
  | {
      kind: "path";
      /** What the link says, before the host has been asked. */
      written: AssistantFileLinkPath;
      /** Where it actually leads, or null when nothing matches. */
      lookup(): Promise<AssistantFileLinkPath | null>;
      /** Tells the user `lookup` found nothing. */
      reportNotFound(): void;
    };

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

  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const inspect = useStableEvent((source: AssistantFileLinkSource) =>
    inspectAssistantFileLink({
      source,
      context,
      queryClient,
      formatNoFileFoundMessage: (token) => t("common.errors.noFileFound", { token }),
    }),
  );

  return useMemo(
    () => ({ open, canOpen, canResolveFile, inspect }),
    [open, canOpen, canResolveFile, inspect],
  );
}

function inspectAssistantFileLink(input: {
  source: AssistantFileLinkSource;
  context: AssistantFileLinkResolverContextValue;
  queryClient: ReturnType<typeof useQueryClient>;
  formatNoFileFoundMessage: (token: string) => string;
}): AssistantFileLinkInspection | null {
  const { serverId, workspaceRoot, relativePathBase, client } = input.context.configRef.current;
  const resolution = classifyForResolution(input.source, { workspaceRoot, relativePathBase });
  if (resolution.kind === "resolved" && resolution.value.kind !== "file") {
    return resolution.value.kind === "external" ? { kind: "url", url: resolution.value.url } : null;
  }
  const target =
    resolution.kind === "needsLookup"
      ? resolution.target
      : (resolution.value as { kind: "file"; target: InlinePathTarget }).target;
  const written = normalizeInlinePathTarget(target.path, workspaceRoot);
  if (!written) return null;

  const lookup = async (): Promise<AssistantFileLinkPath | null> => {
    try {
      const found =
        resolution.kind === "needsLookup"
          ? await fetchLookup({
              resolution,
              serverId,
              workspaceRoot,
              context: input.context,
              queryClient: input.queryClient,
            })
          : target;
      const destination = await resolveInlinePathDestination({
        target: found,
        workspaceRoot: workspaceRoot ?? "",
        resolveRelativeFiles: true,
        client: client?.listDirectory
          ? {
              listDirectory: client.listDirectory.bind(client),
              getDirectorySuggestions: input.context.getDirectorySuggestions,
            }
          : null,
      });
      if (!destination) return null;
      return destination.kind === "file"
        ? { path: destination.location.path, kind: "file" }
        : { path: destination.path, kind: "directory" };
    } catch {
      return null;
    }
  };

  return {
    kind: "path",
    // Parsing drops a trailing slash from the path; the link as written still has it.
    written: {
      path: written.file ?? written.directory,
      kind: written.file && !target.raw.endsWith("/") ? "file" : "directory",
    },
    lookup,
    reportNotFound: () => {
      void dispatchUnresolvedError({
        error: null,
        noFileFoundMessage: input.formatNoFileFoundMessage(
          resolution.kind === "needsLookup" ? resolution.token : target.raw,
        ),
        capturedServerId: serverId,
        capturedWorkspaceRoot: workspaceRoot,
        context: input.context,
      });
    },
  };
}

function fetchLookup(input: {
  resolution: Extract<AssistantFileLinkResolution, { kind: "needsLookup" }>;
  serverId?: string;
  workspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
  queryClient: ReturnType<typeof useQueryClient>;
}): Promise<InlinePathTarget> {
  const { resolution, serverId, workspaceRoot } = input;
  return input.queryClient.fetchQuery({
    queryKey: assistantFileLinkQueryKey({ serverId, workspaceRoot, resolution }),
    queryFn: () =>
      fetchDaemonResolution({
        ambiguousQuery: resolution.ambiguousQuery,
        token: resolution.token,
        target: resolution.target,
        workspaceRoot,
        getDirectorySuggestions: input.context.getDirectorySuggestions,
      }),
    retry: 0,
    staleTime: Infinity,
  });
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

  const run = async () => {
    try {
      const target = await fetchLookup({
        resolution: capturedResolution,
        serverId: capturedConfig.serverId,
        workspaceRoot: capturedConfig.workspaceRoot,
        context: input.context,
        queryClient: input.queryClient,
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
  if (
    current.onOpenBrowserUrl &&
    current.serverId &&
    shouldRouteWorkspaceUrlToProxiedBrowser({ serverId: current.serverId, url: input.url })
  ) {
    current.onOpenBrowserUrl(input.url);
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
