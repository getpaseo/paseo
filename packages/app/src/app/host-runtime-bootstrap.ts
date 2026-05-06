import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type { DaemonStartResult } from "@/runtime/daemon-start-service";
import type { Href } from "expo-router";
import { buildHostRootRoute } from "@/utils/host-routes";

export interface HostRuntimeBootstrapStore {
  boot: () => void;
}

export interface HostRuntimeBootstrapDaemonStartService {
  start: () => Promise<DaemonStartResult>;
}

type HostRuntimeBootstrapStartGate = boolean | (() => boolean | Promise<boolean>);

export interface StartHostRuntimeBootstrapInput {
  store: HostRuntimeBootstrapStore;
  daemonStartService: HostRuntimeBootstrapDaemonStartService;
  shouldStartDaemon: HostRuntimeBootstrapStartGate;
  onGateError?: (message: string) => void;
}

export function startHostRuntimeBootstrap(input: StartHostRuntimeBootstrapInput): void {
  input.store.boot();
  startDaemonIfGateAllows({
    daemonStartService: input.daemonStartService,
    shouldStartDaemon: input.shouldStartDaemon,
    onGateError: input.onGateError,
  });
}

export function startDaemonIfGateAllows(input: {
  daemonStartService: HostRuntimeBootstrapDaemonStartService;
  shouldStartDaemon: HostRuntimeBootstrapStartGate;
  onGateError?: (message: string) => void;
}): void {
  const gate = input.shouldStartDaemon;
  if (typeof gate === "boolean") {
    if (gate) {
      void input.daemonStartService.start();
    }
    return;
  }

  void Promise.resolve()
    .then(() => gate())
    .then((shouldStartDaemon) => {
      if (shouldStartDaemon) {
        void input.daemonStartService.start();
      }
      return null;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      input.onGateError?.(`Failed to evaluate desktop daemon settings: ${message}`);
    });
}

export const WELCOME_ROUTE: Href = "/welcome";

export interface ResolveStartupRedirectInput {
  pathname: string;
  anyOnlineHostServerId: string | null;
  workspaceSelection: ActiveWorkspaceSelection | null;
  isWorkspaceSelectionLoaded: boolean;
  hasGivenUpWaitingForHost: boolean;
}

function isIndexPathname(pathname: string) {
  return pathname === "/" || pathname === "";
}

export function resolveStartupWorkspaceSelection(
  input: ResolveStartupRedirectInput,
): ActiveWorkspaceSelection | null {
  if (!isIndexPathname(input.pathname)) {
    return null;
  }
  if (!input.isWorkspaceSelectionLoaded) {
    return null;
  }
  if (
    !input.anyOnlineHostServerId ||
    !input.workspaceSelection ||
    input.workspaceSelection.serverId !== input.anyOnlineHostServerId
  ) {
    return null;
  }
  return input.workspaceSelection;
}

export function resolveStartupRedirectRoute(input: ResolveStartupRedirectInput): Href | null {
  if (!isIndexPathname(input.pathname)) {
    return null;
  }
  if (!input.isWorkspaceSelectionLoaded) {
    return null;
  }

  if (input.anyOnlineHostServerId) {
    if (resolveStartupWorkspaceSelection(input)) {
      return null;
    }
    return buildHostRootRoute(input.anyOnlineHostServerId);
  }

  if (input.hasGivenUpWaitingForHost) {
    return WELCOME_ROUTE;
  }

  return null;
}
