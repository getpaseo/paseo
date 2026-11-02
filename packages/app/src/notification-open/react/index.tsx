import { useEffect } from "react";
import { router, usePathname, useRootNavigationState, type Href } from "expo-router";
import { useHostRegistryStatus } from "@/runtime/host-runtime";
import {
  navigateToWorkspace,
  useIsLastWorkspaceSelectionHydrated,
} from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { createNotificationOpenRouter } from "../model";
import { createNotificationOpenSource } from "../source";

let ready = false;
const waiters = new Set<() => void>();
const notificationRouter = createNotificationOpenRouter({
  source: createNotificationOpenSource(),
  openAgent: (target) => navigateToAgent({ ...target, pin: true }),
  openTerminal: ({ serverId, workspaceId, terminalId }) =>
    navigateToWorkspace({
      serverId,
      workspaceId,
      target: { kind: "terminal", terminalId },
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
