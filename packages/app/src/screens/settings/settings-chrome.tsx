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

export function SettingsChrome({ children }: SettingsChromeProps) {
  const pathname = usePathname();
  const isCompactLayout = useIsCompactFormFactor();
  const view = useMemo(() => parseSettingsViewFromPathname(pathname), [pathname]);

  if (!view || isCompactLayout) {
    return (
      <>
        {children}
        {view ? <SettingsAddHostFlow /> : null}
      </>
    );
  }

  return <DesktopSettingsChrome view={view}>{children}</DesktopSettingsChrome>;
}

function DesktopSettingsChrome({ view, children }: SettingsChromeProps & { view: SettingsView }) {
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
    <View style={styles.container}>
      <View style={styles.row}>
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
        <WindowChromeRegion corners="top-right">
          <View style={styles.contentPane} testID="settings-detail-pane">
            {children}
          </View>
        </WindowChromeRegion>
      </View>
      <SettingsAddHostFlow />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  row: {
    flex: 1,
    flexDirection: "row",
  },
  contentPane: {
    flex: 1,
  },
}));
