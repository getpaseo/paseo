import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { CodePosition } from "@getpaseo/protocol/messages";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { createWorkspaceFileTabTarget } from "@/workspace/file-open";
import { openWorkspaceTargetAtLocation } from "@/workspace-tabs/open-beside";
import type { DefinitionTarget, GoToDefinitionCallbacks } from "./go-to-definition";

interface UseGoToDefinitionInput {
  serverId: string;
  workspaceId: string;
  cwd: string;
  /** Workspace-relative path of the file being viewed. */
  path: string;
}

/**
 * Wire the source view to the daemon's code navigation. Returns null when the host does not
 * support the feature, so the view never renders an affordance that cannot work.
 */
export function useGoToDefinition(input: UseGoToDefinitionInput): GoToDefinitionCallbacks | null {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  // COMPAT(codeNavigation): added in v0.7.1, remove gate after 2027-09-01.
  const supported = useSessionStore(
    (state) => state.sessions[input.serverId]?.serverInfo?.features?.codeNavigation === true,
  );
  // One notice per view: a missing binary does not become less missing on the next click.
  const noticeShown = useRef(false);

  const resolve = useCallback(
    async (position: CodePosition) => {
      if (!client) {
        return null;
      }
      const result = await client.getCodeDefinition({
        cwd: input.cwd,
        path: input.path,
        position,
      });

      if (result.status === "server_not_installed") {
        if (!noticeShown.current) {
          noticeShown.current = true;
          toast.show(t("panels.file.goToDefinition.serverMissing", { command: result.command }), {
            durationMs: 6000,
          });
        }
        return null;
      }
      if (result.status === "failed") {
        toast.error(result.message);
        return null;
      }
      const target = result.status === "ok" ? result.targets[0] : undefined;
      if (!target) {
        return null;
      }
      return {
        originRange: target.originRange,
        target: { path: target.path, line: target.selectionRange.start.line + 1 },
      };
    },
    [client, input.cwd, input.path, t, toast],
  );

  const navigate = useCallback(
    (target: DefinitionTarget) => {
      openWorkspaceTargetAtLocation({
        workspaceKey: buildWorkspaceTabPersistenceKey({
          serverId: input.serverId,
          workspaceId: input.workspaceId,
        }),
        target: createWorkspaceFileTabTarget({ path: target.path, lineStart: target.line }),
        isCompact,
        location: "main",
      });
    },
    [input.serverId, input.workspaceId, isCompact],
  );

  return useMemo(
    () => (supported && client ? { resolve, navigate } : null),
    [client, navigate, resolve, supported],
  );
}
