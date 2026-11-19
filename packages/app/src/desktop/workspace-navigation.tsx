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
  const attemptRef = useRef<string | null>(null);
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
    const attemptKey = `${target.serverId}\u0000${target.path}`;
    if (attemptRef.current === attemptKey) return;
    attemptRef.current = attemptKey;
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
  const requestedConnectionRef = useRef<WorkspaceDeepLinkTarget | null>(null);
  const toast = useToast();
  const handleTargetHandled = useCallback(() => {
    if (!isCurrent()) return;
    currentTarget.current = null;
    setTarget(null);
  }, [isCurrent]);
  const handleAddedHost = useCallback(
    (serverId: string) => {
      if (!target || !isCurrent()) return;
      if (serverId !== target.serverId) {
        toast.error("The connected host does not match the workspace link.");
        handleTargetHandled();
        return;
      }
      requestedConnectionRef.current = null;
      const connectedTarget = { ...target };
      currentTarget.current = connectedTarget;
      setTarget(connectedTarget);
    },
    [handleTargetHandled, isCurrent, target, toast],
  );
  const addRemoteSshHost = useAddHost({
    method: "ssh",
    onAdded: handleAddedHost,
    onDismiss: handleTargetHandled,
  });
  const hostExists = !!target && hosts.some((host) => host.serverId === target.serverId);

  useEffect(() => {
    if (!hostRegistryLoaded || !target || !isCurrent()) return;
    if (hostExists || requestedConnectionRef.current === target) return;
    requestedConnectionRef.current = target;
    addRemoteSshHost();
  }, [addRemoteSshHost, hostExists, hostRegistryLoaded, isCurrent, target]);

  useEffect(() => {
    const host = getDesktopHost();
    const ready = host?.workspaceNavigation?.ready;
    if (typeof host?.events?.on !== "function" || typeof ready !== "function") return;

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let receivedLiveTarget = false;
    const accept = (payload: unknown) => {
      const next = readWorkspaceDeepLinkTarget(payload);
      if (!next) return;
      const current = currentTarget.current;
      if (current?.serverId === next.serverId && current.path === next.path) return;
      currentTarget.current = next;
      setTarget(next);
    };

    void listenToDesktopEvent<unknown>("open-workspace", (payload) => {
      if (disposed) return;
      receivedLiveTarget = true;
      accept(payload);
    })
      .then(async (dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        const pending = await ready();
        if (!disposed && !receivedLiveTarget) accept(pending);
        return undefined;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!target || !hostRegistryLoaded || !hostExists || requestedConnectionRef.current === target)
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
