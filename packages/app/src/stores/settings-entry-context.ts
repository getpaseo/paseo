import {
  buildSettingsHostSectionRoute,
  buildSettingsRoute,
  parseHostWorkspaceRouteFromPathname,
  parseServerIdFromPathname,
} from "@/utils/host-routes";

export interface SettingsEntryContext {
  returnPathname: string;
  serverId: string | null;
  workspaceId: string | null;
}

let entryContext: SettingsEntryContext | null = null;

function normalizePathname(pathname: string): string | null {
  const trimmed = pathname.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [withoutHash] = trimmed.split("#");
  const [pathOnly] = (withoutHash ?? "").split("?");
  const normalized = pathOnly?.trim() ?? "";
  return normalized.startsWith("/") ? normalized : null;
}

export function isSettingsPathname(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  if (!normalized) {
    return false;
  }
  if (normalized === "/settings" || normalized.startsWith("/settings/")) {
    return true;
  }
  return /^\/h\/[^/]+\/settings\/?$/.test(normalized);
}

function isSafeSettingsReturnPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  if (!normalized || isSettingsPathname(normalized)) {
    return false;
  }
  if (normalized === "/") {
    return true;
  }
  return /^\/h\/[^/]+(?:\/|$)/.test(normalized);
}

export function buildSettingsEntryRoute(pathname: string): string {
  const serverId = parseServerIdFromPathname(pathname);
  if (!serverId) {
    return buildSettingsRoute();
  }
  return buildSettingsHostSectionRoute(serverId, "connections");
}

function createSettingsEntryContext(pathname: string): SettingsEntryContext | null {
  const returnPathname = normalizePathname(pathname);
  if (!returnPathname || !isSafeSettingsReturnPath(returnPathname)) {
    return null;
  }

  const workspaceRoute = parseHostWorkspaceRouteFromPathname(returnPathname);
  const serverId = workspaceRoute?.serverId ?? parseServerIdFromPathname(returnPathname);
  return {
    returnPathname,
    serverId: serverId ?? null,
    workspaceId: workspaceRoute?.workspaceId ?? null,
  };
}

function rememberSettingsEntryContext(context: SettingsEntryContext | null): void {
  entryContext = context;
}

export function peekSettingsEntryContext(): SettingsEntryContext | null {
  return entryContext;
}

export function consumeSettingsEntryReturnPath(): string | null {
  const context = entryContext;
  entryContext = null;
  if (!context || !isSafeSettingsReturnPath(context.returnPathname)) {
    return null;
  }
  return context.returnPathname;
}

export function prepareSettingsEntryNavigation(pathname: string): string {
  const context = createSettingsEntryContext(pathname);
  if (context) {
    rememberSettingsEntryContext(context);
  } else if (!isSettingsPathname(pathname)) {
    entryContext = null;
  }
  return buildSettingsEntryRoute(pathname);
}
