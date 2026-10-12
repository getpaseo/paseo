import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { OpenFileDisposition } from "@/workspace/file-open";
import { openExternalUrl } from "@/utils/open-external-url";
import { useSessionStore } from "@/stores/session-store";
import { loadAppSettingsFromStorage } from "@/hooks/use-settings";
import { canPreviewFile, resolveFileOpenMode, resolveFileOpenRule } from "@/file-access/types";
import { performFileAction } from "@/file-access/actions";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { i18n } from "@/i18n/i18next";
import type { InlinePathTarget } from "./parse";
import {
  useAssistantFileLinkResolverContext,
  type AssistantFileLinkResolverContextValue,
} from "./provider";
import {
  classifyForResolution,
  AmbiguousFileLinkError,
  fetchDaemonResolution,
  type AssistantFileLinkResolution,
  type AssistantFileLinkSource,
} from "./resolver";

export interface UseFileLinkResult {
  target: InlinePathTarget | null;
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
      disposition: input.disposition,
      capturedServerId: capturedConfig.serverId,
      capturedWorkspaceRoot: capturedConfig.workspaceRoot,
      context: input.context,
    }).catch((error) =>
      capturedConfig.toast?.show(
        error instanceof Error ? error.message : i18n.t("fileAccess.failed"),
        { variant: "error" },
      ),
    );
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
      if (error instanceof AmbiguousFileLinkError) {
        const path = await input.context.chooseOption({
          title: i18n.t("fileAccess.chooseFile"),
          options: error.candidates.map((candidate) => ({
            value: candidate.path,
            label: candidate.path,
          })),
        });
        const target = error.candidates.find((candidate) => candidate.path === path);
        if (target)
          await dispatchFileTarget({
            target,
            disposition: input.disposition,
            capturedServerId: capturedConfig.serverId,
            capturedWorkspaceRoot: capturedConfig.workspaceRoot,
            context: input.context,
          });
        return;
      }
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
  if (input.disposition === "preferred" && !input.target.lineStart && input.capturedServerId) {
    const settings = await loadAppSettingsFromStorage();
    const rule = resolveFileOpenRule(input.target.path, settings.fileOpening);
    let mode = resolveFileOpenMode(input.target.path, rule.mode);
    const previewable = canPreviewFile(input.target.path);
    if (mode === "ask") {
      const choice = await input.context.chooseOption({
        title: i18n.t("fileAccess.chooseHow"),
        options: [
          ...(previewable ? [{ value: "preview", label: i18n.t("fileAccess.preview") }] : []),
          { value: "external", label: i18n.t("fileAccess.external") },
        ],
      });
      if (!choice) return;
      mode = choice === "external" ? "external" : "preview";
    }
    const latest = input.context.configRef.current;
    if (
      latest.serverId !== input.capturedServerId ||
      latest.workspaceRoot !== input.capturedWorkspaceRoot
    )
      return;
    if (
      mode === "external" &&
      (await tryOpenExternalFile({
        target: input.target,
        serverId: input.capturedServerId,
        workspaceRoot: input.capturedWorkspaceRoot,
        context: input.context,
        application: rule.application,
      }))
    )
      return;
  }
  const latest = input.context.configRef.current;
  if (
    latest.serverId === input.capturedServerId &&
    latest.workspaceRoot === input.capturedWorkspaceRoot
  ) {
    latest.onOpenWorkspaceFile?.(input.target, input.disposition);
  }
}

async function tryOpenExternalFile(input: {
  target: InlinePathTarget;
  serverId: string;
  workspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
  application?: string;
}): Promise<boolean> {
  const client = useSessionStore.getState().sessions[input.serverId]?.client;
  const target = resolveFilePreviewReadTarget({
    path: input.target.path,
    workspaceRoot: input.workspaceRoot,
  });
  if (!client || !target) return false;
  const toast = input.context.configRef.current.toast;
  toast?.show(i18n.t("fileAccess.preparing"));
  try {
    await performFileAction({
      client,
      target: { serverId: input.serverId, ...target },
      action: "external",
      application: input.application,
    });
    return true;
  } catch (error) {
    toast?.show(error instanceof Error ? error.message : i18n.t("fileAccess.failed"), {
      variant: "error",
    });
    return false;
  }
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
