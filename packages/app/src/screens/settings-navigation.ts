import { buildHostOpenProjectRoute } from "@/utils/host-routes";

export type SettingsBackDestination =
  | { kind: "entry-route"; route: string }
  | { kind: "fallback-route"; route: string };

export type CompactSettingsDetailBackDestination =
  | { kind: "settings-root" }
  | { kind: "router-back" };

export function resolveSettingsBackDestination({
  entryReturnPath,
  anyOnlineServerId,
}: {
  entryReturnPath: string | null;
  anyOnlineServerId: string | null;
}): SettingsBackDestination {
  if (entryReturnPath) {
    return { kind: "entry-route", route: entryReturnPath };
  }
  if (anyOnlineServerId) {
    return { kind: "fallback-route", route: buildHostOpenProjectRoute(anyOnlineServerId) };
  }
  return { kind: "fallback-route", route: "/" };
}

export function resolveCompactSettingsDetailBackDestination({
  hasEntryContext,
  canGoBack,
}: {
  hasEntryContext: boolean;
  canGoBack: boolean;
}): CompactSettingsDetailBackDestination {
  if (hasEntryContext || !canGoBack) {
    return { kind: "settings-root" };
  }
  return { kind: "router-back" };
}
