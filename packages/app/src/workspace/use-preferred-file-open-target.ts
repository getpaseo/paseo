import { useMemo } from "react";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { resolvePreferredEditorId, usePreferredEditor } from "@/hooks/use-preferred-editor";
import { useStableEvent } from "@/hooks/use-stable-event";
import { isWeb } from "@/constants/platform";
import { isAbsolutePath } from "@/utils/path";
import { openExternalUrl } from "@/utils/open-external-url";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import {
  planWorkspaceOpenTargets,
  type PlannedWorkspaceOpenTarget,
} from "@/workspace/open-target-planner";

export function resolvePreferredWorkspaceOpenTarget(
  targets: readonly PlannedWorkspaceOpenTarget[],
  preferredTargetId: string | null | undefined,
): PlannedWorkspaceOpenTarget | null {
  const targetId = resolvePreferredEditorId(
    targets.map((target) => target.id),
    preferredTargetId,
  );
  return targets.find((target) => target.id === targetId) ?? null;
}

export function usePreferredFileOpenTarget(input: {
  serverId: string;
  workspaceDirectory: string;
}): (file: WorkspaceFileLocation) => Promise<boolean> {
  const canResolveWorkspace =
    isWeb &&
    input.serverId.trim().length > 0 &&
    input.workspaceDirectory.trim().length > 0 &&
    isAbsolutePath(input.workspaceDirectory);
  const isLocalDaemon = useIsLocalDaemon(input.serverId);
  const { preferredEditorId } = usePreferredEditor();
  const { targets: desktopOpenTargets, isAvailable: isDesktopOpenAvailable } =
    useDesktopOpenTargets({
      isLocalExecution: isLocalDaemon,
    });
  const { status: checkoutStatus } = useCheckoutStatusQuery({
    serverId: input.serverId,
    cwd: canResolveWorkspace ? input.workspaceDirectory : "",
  });
  const { resolvedForge } = useCheckoutPrStatusQuery({
    serverId: input.serverId,
    cwd: canResolveWorkspace ? input.workspaceDirectory : "",
  });

  const planningContext = useMemo(
    () => ({
      workspaceDirectory: input.workspaceDirectory,
      desktopTargets: desktopOpenTargets,
      canUseDesktopBridge: isDesktopOpenAvailable,
      isLocalExecution: isLocalDaemon,
      checkoutStatus,
      forge: resolvedForge,
    }),
    [
      checkoutStatus,
      desktopOpenTargets,
      input.workspaceDirectory,
      isDesktopOpenAvailable,
      isLocalDaemon,
      resolvedForge,
    ],
  );

  return useStableEvent(async (file: WorkspaceFileLocation) => {
    if (!canResolveWorkspace) {
      return false;
    }
    const target = resolvePreferredWorkspaceOpenTarget(
      planWorkspaceOpenTargets({
        ...planningContext,
        activeFile: file,
      }),
      preferredEditorId,
    );
    if (!target) {
      return false;
    }
    if (target.source === "desktop") {
      await openDesktopTarget(target.openInput);
    } else {
      await openExternalUrl(target.url);
    }
    return true;
  });
}
