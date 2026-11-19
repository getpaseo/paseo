import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceDeepLinkTarget } from "@getpaseo/protocol/workspace-deep-link";
import { getDesktopHost } from "@/desktop/host";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { useAddHost } from "@/hosts/add-host";
import { useOpenProject } from "@/hooks/use-open-project";
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
  const workspaces = useSessionStore(
    (state) => state.sessions[target.serverId]?.workspaces ?? EMPTY_WORKSPACES,
  );
  const openProject = useOpenProject(target.serverId);
  const attemptRef = useRef<string | null>(null);
  const action = resolveWorkspaceDeepLinkAction({
    target,
    hostExists: true,
    workspaces: workspaces.values(),
  });

  useEffect(() => {
    if (action.kind === "open-workspace") {
      navigateToWorkspace({ serverId: target.serverId, workspaceId: action.workspaceId });
      onHandled();
      return;
    }
    if (!isConnected) return;

    const attemptKey = `${target.serverId}\u0000${target.path}`;
    if (attemptRef.current === attemptKey) return;
    attemptRef.current = attemptKey;
    let cancelled = false;
    void openProject(target.path).then((result) => {
      if (!cancelled && result.ok) onHandled();
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [action, isConnected, onHandled, openProject, target]);

  return null;
}

const EMPTY_WORKSPACES = new Map();

export function WorkspaceNavigationListener() {
  const hosts = useHosts();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const [target, setTarget] = useState<WorkspaceDeepLinkTarget | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const requestedConnectionRef = useRef<string | null>(null);

  const handleAddedHost = useCallback((serverId: string) => {
    const pending = targetRef.current;
    if (!pending) return;
    if (serverId !== pending.serverId) {
      console.warn("[WorkspaceNavigation] Connected host identity did not match the link target");
      setTarget(null);
    }
  }, []);
  const addRemoteSshHost = useAddHost({ method: "ssh", onAdded: handleAddedHost });
  const handleTargetHandled = useCallback(() => setTarget(null), []);

  useEffect(() => {
    if (!hostRegistryLoaded || !target) return;
    const hostExists = hosts.some((host) => host.serverId === target.serverId);
    if (hostExists) {
      requestedConnectionRef.current = null;
      return;
    }

    const key = `${target.serverId}\u0000${target.path}`;
    if (requestedConnectionRef.current === key) return;
    requestedConnectionRef.current = key;
    addRemoteSshHost();
  }, [addRemoteSshHost, hostRegistryLoaded, hosts, target]);

  useEffect(() => {
    const host = getDesktopHost();
    const ready = host?.workspaceNavigation?.ready;
    if (typeof host?.events?.on !== "function" || typeof ready !== "function") return;

    let disposed = false;
    let unlisten: (() => void) | null = null;
    const accept = (payload: OpenWorkspaceEventPayload | null) => {
      const next = readTarget(payload);
      if (next) {
        requestedConnectionRef.current = null;
        setTarget(next);
      }
    };

    void listenToDesktopEvent<OpenWorkspaceEventPayload>("open-workspace", accept)
      .then(async (dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        accept(await ready());
        return undefined;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!target || !hosts.some((host) => host.serverId === target.serverId)) return null;
  return <WorkspaceTargetResolver target={target} onHandled={handleTargetHandled} />;
}
