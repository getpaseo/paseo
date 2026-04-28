import React from "react";
import { Redirect, usePathname } from "expo-router";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { useEarliestOnlineHostServerId, useHostRuntimeBootstrapState } from "@/app/_layout";
import { resolveStartupRedirectRoute } from "@/app/host-runtime-bootstrap";
import {
  getLastNavigationWorkspaceRouteSelection,
  useIsLastNavigationWorkspaceRouteSelectionLoaded,
} from "@/stores/navigation-active-workspace-store";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";

const isDesktop = shouldUseDesktopDaemon();

export default function Index() {
  const pathname = usePathname();
  const bootstrapState = useHostRuntimeBootstrapState();
  const anyOnlineHostServerId = useEarliestOnlineHostServerId();
  const isWorkspaceSelectionLoaded = useIsLastNavigationWorkspaceRouteSelectionLoaded();

  const redirectRoute = resolveStartupRedirectRoute({
    pathname,
    anyOnlineHostServerId,
    workspaceSelection: isWorkspaceSelectionLoaded
      ? getLastNavigationWorkspaceRouteSelection()
      : null,
    isWorkspaceSelectionLoaded,
    hasGivenUpWaitingForHost: bootstrapState.hasGivenUpWaitingForHost,
  });

  if (redirectRoute) {
    return <Redirect href={redirectRoute} />;
  }

  return <StartupSplashScreen bootstrapState={isDesktop ? bootstrapState : undefined} />;
}
