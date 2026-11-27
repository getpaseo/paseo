import { useEffect, useRef } from "react";
import { z } from "zod";
import { getIsElectron } from "@/constants/platform";
import { installBrowserProxyRendererBridge, readHostBrowserRouting } from "@/desktop/browser/proxy";
import { getDesktopHost } from "@/desktop/host";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import type { WorkspaceDescriptor } from "@/stores/session-store";

interface ForwardScope {
  serverId: string;
  workspaceId: string;
}

interface ForwardEndpoint {
  terminalId: string;
  port: number;
}

const forwardResponse = z.number().int().min(1).max(65535).nullable();

export async function invokeWorkspacePortForward(
  action: "get" | "start" | "stop",
  target: ForwardScope & ForwardEndpoint,
): Promise<number | null> {
  const forward = getDesktopHost()?.browser?.workspacePortForward;
  if (!forward) throw new Error("Local workspace forwarding requires the desktop app");
  if (action === "start") {
    const routing = readHostBrowserRouting(target.serverId);
    if (routing.kind !== "remote" || routing.support !== "supported") {
      throw new Error("The remote host does not support workspace forwarding");
    }
    installBrowserProxyRendererBridge();
    return forwardResponse.parse(await forward({ ...target, action, target: routing.target }));
  }
  return forwardResponse.parse(await forward({ ...target, action }));
}

function prune(scope: ForwardScope, endpoints: readonly ForwardEndpoint[]): void {
  void getDesktopHost()
    ?.browser?.workspacePortForward?.({ ...scope, action: "prune", endpoints })
    .catch((error: unknown) => {
      console.warn("Could not clean up workspace port forwards", error);
    });
}

export function useWorkspacePortForwardLifetime(
  serverId: string,
  workspaceId: string,
  workspace: Pick<WorkspaceDescriptor, "scripts"> | null | undefined,
  focused: boolean,
): void {
  const host = useHostRuntimeSnapshot(serverId);
  const activeConnectionId = host?.connectionStatus === "online" ? host.activeConnectionId : null;
  const observedWorkspace = useRef<ForwardScope | null>(null);
  useEffect(() => {
    if (!getIsElectron() || !focused || !serverId || !workspaceId) return;
    const scope = { serverId, workspaceId };
    if (!workspace) {
      if (
        observedWorkspace.current?.serverId === serverId &&
        observedWorkspace.current.workspaceId === workspaceId
      ) {
        observedWorkspace.current = null;
        prune(scope, []);
      }
      return;
    }
    observedWorkspace.current = scope;
    const endpoints = workspace.scripts.flatMap(({ type, terminalId, port, lifecycle }) =>
      type === "service" && lifecycle === "running" && terminalId && port
        ? [{ terminalId, port }]
        : [],
    );
    prune(scope, endpoints);
  }, [serverId, workspaceId, workspace, focused]);
  useEffect(() => {
    if (!getIsElectron() || !focused || !serverId || !workspaceId || !activeConnectionId) return;
    return () => {
      observedWorkspace.current = null;
      prune({ serverId, workspaceId }, []);
    };
  }, [serverId, workspaceId, focused, activeConnectionId]);
}
