import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceDeepLinkTarget } from "@getpaseo/protocol/workspace-deep-link";
import { getDesktopHost } from "@/desktop/host";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { useAddHost } from "@/hosts/add-host";
import { useOpenProject } from "@/hooks/use-open-project";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { useToast } from "@/contexts/toast-context";
import { useHostRegistryLoaded, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { resolveWorkspaceDeepLinkAction } from "./workspace-navigation-model";

interface OpenWorkspaceEventPayload {
  serverId?: unknown;
  path?: unknown;
}

function readTarget(payload: OpenWorkspaceEventPayload | null): WorkspaceDeepLinkTarget | null {
  const serverId = typeof payload?.serverId === "string" ? payload.serverId.trim() : "";
  const path = typeof payload?.path === "string" ? payload.path.trim() : "";
  return serverId && path ? { serverId, path } : null;
}

function WorkspaceTargetResolver({
  target,
  onHandled,
}: {
  target: WorkspaceDeepLinkTarget;
  onHandled: () => void;
}) {
  const isConnected = useHostRuntimeIsConnected(target.serverId);
  const hydrated = useSessionStore(
    (state) => state.sessions[target.serverId]?.hasHydratedWorkspaces ?? false,
  );
  useDirectoryDemand(target.serverId);
  const workspaces = useSessionStore(
    (state) => state.sessions[target.serverId]?.workspaces ?? EMPTY_WORKSPACES,
  );
  const openProject = useOpenProject(target.serverId);
  const toast = useToast();
  const attemptRef = useRef<string | null>(null);
  const action = resolveWorkspaceDeepLinkAction({
    target,
    hostExists: true,
    directoryReady: isConnected && hydrated,
    workspaces: workspaces.values(),
  });
  const workspaceId = action.kind === "open-workspace" ? action.workspaceId : null;

  useEffect(() => {
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
        const result = await openProject(target.path);
        if (!result.ok) toast.error(result.error ?? "Could not open the linked project.");
      } catch {
        toast.error("Could not open the linked project.");
      } finally {
        onHandled();
      }
    })();
  }, [action.kind, onHandled, openProject, target, toast, workspaceId]);

  return null;
}

const EMPTY_WORKSPACES = new Map();

export function WorkspaceNavigationListener() {
  const hosts = useHosts();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const [target, setTarget] = useState<WorkspaceDeepLinkTarget | null>(null);
  const requestedConnectionRef = useRef<WorkspaceDeepLinkTarget | null>(null);
  const toast = useToast();
  const handleTargetHandled = useCallback(
    () => setTarget((current) => (current === target ? null : current)),
    [target],
  );
  const handleAddedHost = useCallback(
    (serverId: string) => {
      if (!target) return;
      if (serverId !== target.serverId) {
        toast.error("The connected host does not match the workspace link.");
        handleTargetHandled();
        return;
      }
      setTarget((current) => (current === target ? { ...target } : current));
    },
    [handleTargetHandled, target, toast],
  );
  const addRemoteSshHost = useAddHost({
    method: "ssh",
    onAdded: handleAddedHost,
    onDismiss: handleTargetHandled,
  });
  const hostExists = !!target && hosts.some((host) => host.serverId === target.serverId);

  useEffect(() => {
    if (!hostRegistryLoaded || !target) return;
    if (hostExists || requestedConnectionRef.current === target) return;
    requestedConnectionRef.current = target;
    addRemoteSshHost();
  }, [addRemoteSshHost, hostExists, hostRegistryLoaded, target]);

  useEffect(() => {
    const host = getDesktopHost();
    const ready = host?.workspaceNavigation?.ready;
    if (typeof host?.events?.on !== "function" || typeof ready !== "function") return;

    let disposed = false;
    let unlisten: (() => void) | null = null;
    const accept = (payload: OpenWorkspaceEventPayload | null) => {
      const next = readTarget(payload);
      if (next) {
        setTarget((current) =>
          current?.serverId === next.serverId && current.path === next.path ? current : next,
        );
      }
    };

    void listenToDesktopEvent<OpenWorkspaceEventPayload>("open-workspace", accept)
      .then(async (dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        const pending = await ready();
        if (!disposed) accept(pending);
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
  return <WorkspaceTargetResolver target={target} onHandled={handleTargetHandled} />;
}
