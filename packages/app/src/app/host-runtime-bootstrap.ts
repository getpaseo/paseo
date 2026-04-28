import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type { DaemonStartResult } from "@/runtime/daemon-start-service";
import type { Href } from "expo-router";
import { buildHostRootRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";

export interface HostRuntimeBootstrapStore {
  boot: () => void;
}

export interface HostRuntimeBootstrapDaemonStartService {
  start: () => Promise<DaemonStartResult>;
}

export interface StartHostRuntimeBootstrapInput {
  store: HostRuntimeBootstrapStore;
  daemonStartService: HostRuntimeBootstrapDaemonStartService;
  shouldStartDaemon: boolean;
}

export function startHostRuntimeBootstrap(input: StartHostRuntimeBootstrapInput): void {
  input.store.boot();
  if (input.shouldStartDaemon) {
    void input.daemonStartService.start();
  }
}

export const WELCOME_ROUTE: Href = "/welcome";

export interface ResolveStartupRedirectInput {
  pathname: string;
  anyOnlineHostServerId: string | null;
  workspaceSelection: ActiveWorkspaceSelection | null;
  isWorkspaceSelectionLoaded: boolean;
  hasGivenUpWaitingForHost: boolean;
}

export function resolveStartupRedirectRoute(input: ResolveStartupRedirectInput): Href | null {
  if (input.pathname !== "/" && input.pathname !== "") {
    return null;
  }
  if (!input.isWorkspaceSelectionLoaded) {
    return null;
  }

  if (input.anyOnlineHostServerId) {
    if (
      input.workspaceSelection &&
      input.workspaceSelection.serverId === input.anyOnlineHostServerId
    ) {
      return buildHostWorkspaceRoute(
        input.workspaceSelection.serverId,
        input.workspaceSelection.workspaceId,
      );
    }
    return buildHostRootRoute(input.anyOnlineHostServerId);
  }

  if (input.hasGivenUpWaitingForHost) {
    return WELCOME_ROUTE;
  }

  return null;
}
