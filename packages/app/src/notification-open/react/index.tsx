import { useEffect } from "react";
import { router, usePathname, useRootNavigationState, type Href } from "expo-router";
import { openPluginNotification } from "@/plugins/notification-open";
import { pluginRegistry } from "@/plugins/registry";
import { getHostRuntimeStore, useHostRegistryStatus } from "@/runtime/host-runtime";
import {
  navigateToWorkspace,
  useIsLastWorkspaceSelectionHydrated,
} from "@/stores/navigation-active-workspace-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { createNotificationOpenRouter } from "../model";
import { createNotificationOpenSource } from "../source";

let ready = false;
const waiters = new Set<() => void>();

function navigateFromNotification(route: string): void {
  if (!route.startsWith("/settings")) {
    if (router.canDismiss()) {
      router.dismissAll();
    }
    router.replace(route as Href);
    return;
  }
  router.navigate(route as Href);
}

const notificationRouter = createNotificationOpenRouter({
  source: createNotificationOpenSource(),
  openAgent: (target) => navigateToAgent({ ...target, pin: true }),
  openTerminal: ({ serverId, workspaceId, terminalId }) =>
    navigateToWorkspace({
      serverId,
      workspaceId,
      target: { kind: "terminal", terminalId },
    }),
  openPlugin: (target) =>
    openPluginNotification(target, {
      registry: pluginRegistry,
      openAgent: (agentTarget) => navigateToAgent({ ...agentTarget, pin: true }),
      openWorkspace: (workspaceTarget) => navigateToWorkspace(workspaceTarget),
      openRoute: navigateFromNotification,
      isHostRegistered: (targetServerId) =>
        getHostRuntimeStore()
          .getHosts()
          .some((host) => host.serverId === targetServerId),
      focusHost: (targetServerId) => useSidebarViewStore.getState().focusHost(targetServerId),
    }),
  openRoute: (route) => router.navigate(route as Href),
  whenReadyToNavigate: () =>
    ready
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          waiters.add(resolve);
        }),
});

export function NotificationOpenRouter({ startupBlocked }: { startupBlocked: boolean }) {
  const root = useRootNavigationState();
  const pathname = usePathname();
  const registryStatus = useHostRegistryStatus();
  const selectionHydrated = useIsLastWorkspaceSelectionHydrated();
  // Index routes redirect during startup. Let their final leaf commit before dispatching a tap.
  const atStartupIndex = pathname === "/" || /^\/h\/[^/]+\/?$/.test(pathname);
  const canNavigate = Boolean(
    root?.key &&
    registryStatus === "ready" &&
    selectionHydrated &&
    !startupBlocked &&
    !atStartupIndex,
  );
  useEffect(() => {
    ready = canNavigate;
    if (ready) {
      for (const resolve of waiters) resolve();
      waiters.clear();
    }
    return () => {
      ready = false;
    };
  }, [canNavigate]);
  useEffect(() => notificationRouter.start(), []);
  return null;
}
