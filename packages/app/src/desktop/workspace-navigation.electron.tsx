import { useCallback, useEffect, useRef, useState } from "react";
import {
  readWorkspaceDeepLinkTarget,
  type WorkspaceDeepLinkTarget,
} from "@getpaseo/protocol/workspace-deep-link";
import { getDesktopHost } from "@/desktop/host";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { useAddHost } from "@/hosts/add-host";
import { useOpenProject } from "@/hooks/use-open-project";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { useToast } from "@/contexts/toast-context";
import { useHostRegistryLoaded, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  registerLinkedProject,
  resolveWorkspaceDeepLinkAction,
} from "./workspace-navigation-model";

function WorkspaceTargetResolver({
  target,
  isCurrent,
  onHandled,
}: {
  target: WorkspaceDeepLinkTarget;
  isCurrent: () => boolean;
  onHandled: () => void;
}) {
  const isConnected = useHostRuntimeIsConnected(target.serverId);
  const hasLiveDirectory = useSessionStore(
    (state) => state.sessions[target.serverId]?.hasLiveWorkspaceDirectory ?? false,
  );
  useDirectoryDemand(target.serverId);
  const workspaces = useSessionStore(
    (state) => state.sessions[target.serverId]?.workspaces ?? EMPTY_WORKSPACES,
  );
  const openProject = useStableEvent(useOpenProject(target.serverId));
  const toast = useToast();
  const attemptRef = useRef<WorkspaceDeepLinkTarget | null>(null);
  const action = resolveWorkspaceDeepLinkAction({
    target,
    hostExists: true,
    directoryReady: isConnected && hasLiveDirectory,
    workspaces: workspaces.values(),
  });
  const workspaceId = action.kind === "open-workspace" ? action.workspaceId : null;

  useEffect(() => {
    if (!isCurrent()) return;
    if (workspaceId) {
      navigateToWorkspace({ serverId: target.serverId, workspaceId });
      onHandled();
      return;
    }
    if (action.kind !== "register-project") return;
    if (attemptRef.current === target) return;
    attemptRef.current = target;
    void (async () => {
      try {
        const result = await registerLinkedProject({
          confirm: () =>
            confirmDialog({
              title: "Add project from link?",
              message: `Host: ${target.serverId}\nDirectory: ${target.path}`,
              confirmLabel: "Add project",
              defaultToCancel: true,
            }),
          isCurrent,
          register: async () => {
            const latest = useSessionStore.getState().sessions[target.serverId];
            const latestAction = resolveWorkspaceDeepLinkAction({
              target,
              hostExists: !!latest,
              directoryReady: latest?.hasLiveWorkspaceDirectory === true,
              workspaces: latest?.workspaces.values() ?? [],
            });
            if (latestAction.kind === "open-workspace") {
              navigateToWorkspace({
                serverId: target.serverId,
                workspaceId: latestAction.workspaceId,
              });
              return null;
            }
            if (latestAction.kind === "register-project") return openProject(target.path);
            toast.error("The workspace directory changed. Open the link again to retry.");
            return null;
          },
        });
        if (result && !result.ok) toast.error(result.error ?? "Could not open the linked project.");
      } catch {
        toast.error("Could not open the linked project.");
      } finally {
        onHandled();
      }
    })();
  }, [action.kind, isCurrent, onHandled, openProject, target, toast, workspaceId]);

  return null;
}

const EMPTY_WORKSPACES = new Map();

export function WorkspaceNavigationListener() {
  const hosts = useHosts();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const [target, setTarget] = useState<WorkspaceDeepLinkTarget | null>(null);
  const currentTarget = useRef<WorkspaceDeepLinkTarget | null>(null);
  const isCurrent = useCallback(() => currentTarget.current === target, [target]);
  const connectionRequest = useRef<{ target: WorkspaceDeepLinkTarget; close: () => void } | null>(
    null,
  );
  const toast = useToast();
  const updateTarget = useCallback((next: WorkspaceDeepLinkTarget | null) => {
    currentTarget.current = next;
    const previousRequest = connectionRequest.current;
    connectionRequest.current = null;
    previousRequest?.close();
    setTarget(next);
  }, []);
  const handleTargetHandled = useCallback(() => {
    if (isCurrent()) updateTarget(null);
  }, [isCurrent, updateTarget]);
  const handleAddedHost = useCallback(
    (serverId: string) => {
      if (!target || !isCurrent()) return;
      if (serverId !== target.serverId) {
        toast.error("The connected host does not match the workspace link.");
        handleTargetHandled();
        return;
      }
      updateTarget({ ...target });
    },
    [handleTargetHandled, isCurrent, target, toast, updateTarget],
  );
  const addRemoteSshHost = useAddHost({
    method: "ssh",
    onAdded: handleAddedHost,
    onDismiss: handleTargetHandled,
  });
  const hostExists = !!target && hosts.some((host) => host.serverId === target.serverId);

  useEffect(() => {
    if (!hostRegistryLoaded || !target || !isCurrent()) return;
    if (hostExists || connectionRequest.current?.target === target) return;
    connectionRequest.current = { target, close: addRemoteSshHost() };
  }, [addRemoteSshHost, hostExists, hostRegistryLoaded, isCurrent, target]);

  useEffect(() => {
    const host = getDesktopHost();
    const ready = host?.workspaceNavigation?.ready;
    if (typeof host?.events?.on !== "function" || typeof ready !== "function") return;

    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const accept = (payload: unknown) => {
      if (disposed) return;
      if (payload === null) {
        updateTarget(null);
        return;
      }
      const next = readWorkspaceDeepLinkTarget(payload);
      if (!next) return;
      const current = currentTarget.current;
      if (current?.serverId === next.serverId && current.path === next.path) return;
      updateTarget(next);
    };

    void (async () => {
      const dispose = await listenToDesktopEvent("open-workspace", accept);
      if (disposed) {
        dispose();
        return;
      }
      unsubscribe = dispose;
      await ready();
    })().catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe?.();
      const request = connectionRequest.current;
      connectionRequest.current = null;
      currentTarget.current = null;
      request?.close();
    };
  }, [updateTarget]);

  if (!target || !hostRegistryLoaded || !hostExists || connectionRequest.current?.target === target)
    return null;
  return (
    <WorkspaceTargetResolver
      key={`${target.serverId}\u0000${target.path}`}
      target={target}
      isCurrent={isCurrent}
      onHandled={handleTargetHandled}
    />
  );
}
