import { useMemo, useRef } from "react";
import type { DaemonClient } from "@server/client/daemon-client";
import type { ToastApi } from "@/components/toast-host";
import {
  createAssistantFileLinkResolver,
  type AssistantFileLinkContext,
  type AssistantFileLinkOpenInput,
  type AssistantFileLinkPrefetchInput,
} from "@/utils/assistant-file-link-resolver";
import type { InlinePathTarget } from "@/utils/inline-path";
import type { OpenFileDisposition } from "@/utils/workspace-file-open";
import { openExternalUrl } from "@/utils/open-external-url";

export interface UseAssistantFileLinkResolverOptions {
  client?: DaemonClient | null;
  serverId?: string;
  workspaceRoot?: string;
  onOpenWorkspaceFile?: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
  toast?: ToastApi | null;
}

export interface AssistantFileLinkActions {
  prefetch(input: Omit<AssistantFileLinkPrefetchInput, "context">): void;
  open(input: Omit<AssistantFileLinkOpenInput, "context">): void;
}

export function useAssistantFileLinkResolver({
  client,
  serverId,
  workspaceRoot,
  onOpenWorkspaceFile,
  toast,
}: UseAssistantFileLinkResolverOptions): AssistantFileLinkActions {
  const context: AssistantFileLinkContext = useMemo(
    () => ({
      serverId,
      workspaceRoot,
    }),
    [serverId, workspaceRoot],
  );
  const latestContextRef = useRef(context);
  latestContextRef.current = context;

  const resolver = useMemo(
    () =>
      createAssistantFileLinkResolver({
        async getDirectorySuggestions(input) {
          if (!client) {
            return { entries: [], error: null };
          }

          const result = await client.getDirectorySuggestions(input);
          return {
            entries: result.entries,
            error: result.error,
          };
        },
        openWorkspaceFile(target, disposition) {
          onOpenWorkspaceFile?.(target, disposition);
        },
        openExternalUrl,
        onUnresolvedFileCandidate(token) {
          toast?.show(`No file found for ${token}`, {
            variant: "error",
            testID: "assistant-file-link-not-found-toast",
          });
        },
        isCurrentContext(candidate) {
          const current = latestContextRef.current;
          return (
            current.serverId === candidate.serverId &&
            current.workspaceRoot === candidate.workspaceRoot
          );
        },
      }),
    [client, onOpenWorkspaceFile, toast],
  );

  return useMemo(
    () => ({
      prefetch(input) {
        void resolver.prefetch({ ...input, context });
      },
      open(input) {
        void resolver.open({ ...input, context });
      },
    }),
    [context, resolver],
  );
}
