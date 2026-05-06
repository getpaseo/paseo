import { router, useLocalSearchParams, usePathname, type Href } from "expo-router";
import {
  buildHostWorkspaceRoute,
  decodeWorkspaceIdFromPathSegment,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";

export interface ActiveWorkspaceSelection {
  serverId: string;
  workspaceId: string;
}

interface NavigateToWorkspaceOptions {
  currentPathname?: string | null;
}

let lastWorkspaceSelection: ActiveWorkspaceSelection | null = null;

function getParamValue(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const firstValue = value[0];
    return typeof firstValue === "string" ? firstValue.trim() : "";
  }
  return "";
}

function parseWorkspaceSelectionFromRouteParams(params: {
  serverId?: string | string[];
  workspaceId?: string | string[];
}): ActiveWorkspaceSelection | null {
  const serverId = getParamValue(params.serverId);
  const workspaceValue = getParamValue(params.workspaceId);
  const workspaceId = workspaceValue ? decodeWorkspaceIdFromPathSegment(workspaceValue) : null;
  if (!serverId || !workspaceId) {
    return null;
  }
  return { serverId, workspaceId };
}

export function navigateToWorkspace(
  serverId: string,
  workspaceId: string,
  _options: NavigateToWorkspaceOptions = {},
) {
  lastWorkspaceSelection = { serverId, workspaceId };
  const route = buildHostWorkspaceRoute(serverId, workspaceId) as Href;
  router.dismissTo(route);
}

export function navigateToLastWorkspace(): boolean {
  if (!lastWorkspaceSelection) {
    return false;
  }
  navigateToWorkspace(lastWorkspaceSelection.serverId, lastWorkspaceSelection.workspaceId);
  return true;
}

export function useActiveWorkspaceSelection(): ActiveWorkspaceSelection | null {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    workspaceId?: string | string[];
  }>();
  const selection =
    parseHostWorkspaceRouteFromPathname(usePathname()) ??
    parseWorkspaceSelectionFromRouteParams(params);
  if (selection) {
    lastWorkspaceSelection = selection;
  }
  return selection;
}
