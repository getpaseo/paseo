import { router, type Href } from "expo-router";
import { navigateToLastWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  buildOpenProjectRoute,
  buildProjectSettingsRoute,
  buildProjectsSettingsRoute,
  buildSettingsHostSectionRoute,
  buildSettingsRoute,
  decodeSegment,
  isSettingsSectionSlug,
  normalizeHostSectionSlug,
  stripSearchAndHash,
  type HostSectionSlug,
  type SettingsSectionSlug,
} from "@/utils/host-routes";

export type SettingsView =
  | { kind: "plugin"; serverId: string; pluginId: string; screenId: string }
  | { kind: "root" }
  | { kind: "section"; section: SettingsSectionSlug }
  | { kind: "host"; serverId: string; section: HostSectionSlug }
  | { kind: "project"; serverId: string; projectId: string };

/** Mirrors the route tree in `src/app/settings`; keep the two in sync. */
export function parseSettingsViewFromPathname(pathname: string): SettingsView | null {
  const pathOnly = stripSearchAndHash(pathname);
  if (pathOnly !== "/settings" && !pathOnly.startsWith("/settings/")) {
    return null;
  }

  const segments = pathOnly
    .slice("/settings".length)
    .replace(/^\//, "")
    .split("/")
    .map(decodeSegment);
  while (segments.length > 0 && segments[segments.length - 1] === "") {
    segments.pop();
  }

  const [first, ...rest] = segments;
  if (first === undefined) {
    return { kind: "root" };
  }

  if (first !== "hosts") {
    return { kind: "section", section: isSettingsSectionSlug(first) ? first : "general" };
  }

  const [serverId, hostSection, detailId, screenId] = rest;
  if (!serverId) {
    return { kind: "root" };
  }

  if (hostSection === undefined) {
    return { kind: "host", serverId, section: "connections" };
  }

  if (hostSection === "projects" && detailId) {
    return { kind: "project", serverId, projectId: detailId };
  }
  if (hostSection === "plugins" && detailId && screenId) {
    return { kind: "plugin", serverId, pluginId: detailId, screenId };
  }

  return {
    kind: "host",
    serverId,
    section: normalizeHostSectionSlug(hostSection) ?? "connections",
  };
}

export function openHostOverview(serverId: string): void {
  router.push(buildSettingsHostSectionRoute(serverId, "host"));
}

export function openProjectSettings(serverId: string, projectId: string): void {
  router.push(buildProjectSettingsRoute(serverId, projectId));
}

export function returnFromSettings(view: SettingsView): void {
  if (view.kind === "root") {
    if (!navigateToLastWorkspace()) {
      router.replace(buildOpenProjectRoute());
    }
    return;
  }

  let parent: Href = buildSettingsRoute();
  if (view.kind === "plugin") parent = buildSettingsHostSectionRoute(view.serverId, "plugins");
  if (view.kind === "project") parent = buildProjectsSettingsRoute(view.serverId);
  router.dismissTo(parent as Href);
}
