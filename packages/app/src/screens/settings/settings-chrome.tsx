import { useCallback, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHosts } from "@/runtime/host-runtime";
import { SettingsAddHostFlow } from "@/screens/settings/settings-add-host-flow";
import { SettingsSidebar, useSortedHosts } from "@/screens/settings/settings-sidebar";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSettingsAddHostFlowStore } from "@/stores/settings-add-host-flow-store";
import { resolveActiveHostServerId } from "@/types/host-connection";
import { WindowChromeRegion } from "@/utils/desktop-window";
import {
  buildSettingsHostSectionRoute,
  buildSettingsSectionRoute,
  type HostSectionSlug,
  type SettingsSectionSlug,
} from "@/utils/host-routes";
import {
  parseSettingsViewFromPathname,
  returnFromSettings,
  type SettingsView,
} from "@/navigation/settings-navigation";

interface SettingsChromeProps {
  children: ReactNode;
}

/**
 * The tree around `children` never changes shape, so the root stack is never
 * remounted by entering or leaving Settings. Only the sidebar slot and a few
 * props switch. Moving `children` between branches here unmounts every
 * workspace pane — see `e2e/browser/workspace-pane-remount.spec.ts`.
 */
export function SettingsChrome({ children }: SettingsChromeProps) {
  const pathname = usePathname();
  const isCompactLayout = useIsCompactFormFactor();
  const view = useMemo(() => parseSettingsViewFromPathname(pathname), [pathname]);
  // Compact renders the sidebar as an in-page list, so it needs no chrome.
  const showSidebar = view !== null && !isCompactLayout;

  return (
    <View style={showSidebar ? styles.row : styles.fill}>
      {showSidebar ? <DesktopSettingsSidebar view={view} /> : null}
      <WindowChromeRegion corners={showSidebar ? "top-right" : "both"}>
        <View
          style={showSidebar ? styles.settingsPane : styles.fill}
          testID={showSidebar ? "settings-detail-pane" : undefined}
        >
          {children}
        </View>
      </WindowChromeRegion>
      {view ? <SettingsAddHostFlow /> : null}
    </View>
  );
}

function DesktopSettingsSidebar({ view }: { view: SettingsView }) {
  const router = useRouter();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const sortedHosts = useSortedHosts(hosts, localServerId);
  const lastWorkspaceSelection = useLastWorkspaceSelection();
  const openAddHost = useSettingsAddHostFlowStore((state) => state.open);

  const routedHostServerId =
    view.kind === "host" || view.kind === "project" || view.kind === "plugin"
      ? view.serverId
      : null;
  const [pickedHostServerId, setPickedHostServerId] = useState<string | null>(null);

  const activeHostServerId = useMemo(() => {
    if (routedHostServerId) return routedHostServerId;
    return resolveActiveHostServerId({
      selectedServerId: pickedHostServerId ?? lastWorkspaceSelection?.serverId ?? null,
      localServerId,
      hosts,
      orderedHosts: sortedHosts,
    });
  }, [
    routedHostServerId,
    pickedHostServerId,
    lastWorkspaceSelection?.serverId,
    localServerId,
    hosts,
    sortedHosts,
  ]);

  const handleSelectSection = useCallback(
    (section: SettingsSectionSlug) => {
      router.replace(buildSettingsSectionRoute(section));
    },
    [router],
  );

  const handleSelectHostSection = useCallback(
    (section: HostSectionSlug) => {
      if (!activeHostServerId) {
        openAddHost();
        return;
      }
      router.replace(buildSettingsHostSectionRoute(activeHostServerId, section));
    },
    [activeHostServerId, openAddHost, router],
  );

  const handleSelectHost = useCallback(
    (serverId: string) => {
      setPickedHostServerId(serverId);
      if (view.kind === "project") {
        router.replace(buildSettingsHostSectionRoute(serverId, "projects"));
        return;
      }
      if (view.kind !== "host") {
        return;
      }
      router.replace(buildSettingsHostSectionRoute(serverId, view.section));
    },
    [router, view],
  );

  const handleBackToWorkspace = useCallback(() => {
    returnFromSettings({ kind: "root" });
  }, []);

  return (
    <WindowChromeRegion corners="top-left">
      <SettingsSidebar
        view={view}
        onSelectSection={handleSelectSection}
        onSelectHostSection={handleSelectHostSection}
        onSelectHost={handleSelectHost}
        onAddHost={openAddHost}
        onBackToWorkspace={handleBackToWorkspace}
        activeHostServerId={activeHostServerId}
        layout="desktop"
      />
    </WindowChromeRegion>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: {
    flex: 1,
  },
  row: {
    flex: 1,
    flexDirection: "row",
  },
  settingsPane: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
