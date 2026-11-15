import { router, type Href } from "expo-router";
import {
  navigateToWorkspace,
  navigateToLastWorkspace,
} from "@/stores/navigation-active-workspace-store";
import {
  buildOpenProjectRoute,
  buildProjectSettingsRoute,
  buildProjectsSettingsRoute,
  buildSettingsHostSectionRoute,
  buildSettingsRoute,
  type HostSectionSlug,
  type SettingsSectionSlug,
} from "@/utils/host-routes";

import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import { usePanelStore } from "@/stores/panel-store";
import {
  beginSettingsSidebarVisit,
  getSettingsSidebarReturn,
} from "@/navigation/settings-presentation/session";

export function openSettingsFromSidebar(input: {
  workspace: ActiveWorkspaceSelection | null;
  isCompact: boolean;
  route?: Href;
}): void {
  const panels = usePanelStore.getState();
  if (input.isCompact && input.workspace && panels.mobilePanel.target === "agent-list") {
    beginSettingsSidebarVisit(input.workspace);
  } else {
    panels.showMobileAgent();
  }
  router.push(input.route ?? buildSettingsRoute());
}

export type SettingsView =
  | { kind: "plugin"; serverId: string; pluginId: string; screenId: string }
  | { kind: "root" }
  | { kind: "section"; section: SettingsSectionSlug }
  | { kind: "host"; serverId: string; section: HostSectionSlug }
  | { kind: "project"; serverId: string; projectId: string };

export function openHostOverview(serverId: string): void {
  router.push(buildSettingsHostSectionRoute(serverId, "host"));
}

export function openProjectSettings(serverId: string, projectId: string): void {
  router.push(buildProjectSettingsRoute(serverId, projectId));
}

export function returnFromSettings(view: SettingsView): void {
  if (view.kind === "root") {
    const destination = getSettingsSidebarReturn();
    if (destination && usePanelStore.getState().mobilePanel.target === "agent-list") {
      navigateToWorkspace({
        serverId: destination.serverId,
        workspaceId: destination.workspaceId,
        surface: "sidebar",
      });
      return;
    }
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
