import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { PluginListing } from "@getpaseo/protocol/plugin-registry";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useInstalledPlugins } from "@/plugins/registry";
import { BrowseTab } from "./browse-tab";
import { InstallPluginSheet, type InstallTarget } from "./install-sheet";
import { InstalledTab } from "./installed-tab";
import { installedByListing } from "./listing";
import { PluginsOffAlert } from "./plugins-off-alert";
import { useLivePluginList, usePluginDirectory } from "./queries";
import { PluginRowsSkeleton } from "./skeletons";
import { pluginErrorText } from "./error-text";

type GalleryTab = "installed" | "browse";

/**
 * Settings → Plugins: the plugins on this host and the directory to add more, behind one switch.
 * Opens on Installed when something is installed, otherwise on Browse.
 */
export function PluginGalleryPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "pluginManagement");
  useInstalledPlugins();
  const plugins = useLivePluginList(serverId);
  const directory = usePluginDirectory(serverId);
  const [chosenTab, setChosenTab] = useState<GalleryTab | null>(null);
  const [query, setQuery] = useState("");
  const [installTarget, setInstallTarget] = useState<InstallTarget | null>(null);
  const installed = useMemo(() => plugins.data ?? [], [plugins.data]);
  // The opening tab is chosen once, so installing the first plugin does not move the user off Browse.
  if (chosenTab === null && plugins.data)
    setChosenTab(plugins.data.length === 0 ? "browse" : "installed");
  const tab: GalleryTab = chosenTab ?? "installed";
  const byListing = useMemo(() => installedByListing(installed), [installed]);
  const listings = useMemo(
    () => new Map((directory.query.data?.plugins ?? []).map((listing) => [listing.id, listing])),
    [directory.query.data],
  );
  const tabs = useMemo(
    () => [
      {
        value: "installed" as const,
        label: plugins.data
          ? t("settings.plugins.gallery.tabs.installedCount", { count: plugins.data.length })
          : t("settings.plugins.gallery.tabs.installed"),
        testID: "plugin-tab-installed",
      },
      {
        value: "browse" as const,
        label: t("settings.plugins.gallery.tabs.browse"),
        testID: "plugin-tab-browse",
      },
    ],
    [plugins.data, t],
  );
  const browse = useCallback(() => setChosenTab("browse"), []);
  const install = useCallback(
    (listing: PluginListing) => setInstallTarget({ kind: "listing", listing }),
    [],
  );
  const closeInstall = useCallback(() => setInstallTarget(null), []);
  const retry = useCallback(() => void plugins.refetch(), [plugins]);

  if (!connected)
    return (
      <Alert
        size="md"
        variant="warning"
        title={t("settings.plugins.states.offlineTitle")}
        description={t("settings.plugins.states.offlineDescription")}
      />
    );
  if (!supported)
    return <Alert size="md" variant="warning" title={t("settings.plugins.states.updateTitle")} />;

  let content = <PluginRowsSkeleton testID="plugin-list-loading" />;
  if (plugins.isError) {
    content = (
      <Alert
        size="sm"
        variant="error"
        title={t("settings.plugins.states.errorTitle")}
        description={pluginErrorText(plugins.error)}
      >
        <Button variant="outline" onPress={retry}>
          {t("settings.plugins.states.retry")}
        </Button>
      </Alert>
    );
  } else if (plugins.data) {
    content =
      tab === "installed" ? (
        <InstalledTab
          serverId={serverId}
          plugins={installed}
          listings={listings}
          query={query}
          onBrowse={browse}
        />
      ) : (
        <BrowseTab serverId={serverId} installed={byListing} query={query} onInstall={install} />
      );
  }

  return (
    <View>
      <View style={styles.toolbar}>
        <SegmentedControl
          options={tabs}
          value={tab}
          onValueChange={setChosenTab}
          testID="plugin-tabs"
        />
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={
              tab === "installed"
                ? t("settings.plugins.gallery.search.installed")
                : t("settings.plugins.gallery.search.browse")
            }
            clearAccessibilityLabel={t("settings.plugins.gallery.search.clear")}
            testID="plugin-search"
          />
        </View>
      </View>
      {tab === "installed" ? <PluginsOffAlert serverId={serverId} /> : null}
      {content}
      {installTarget ? (
        <InstallPluginSheet serverId={serverId} target={installTarget} onClose={closeInstall} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
    marginBottom: theme.spacing[6],
  },
  // The search box sits at the end of the row, as on the website, and takes the whole row when the
  // tabs leave it too little room.
  search: { flexGrow: 1, flexBasis: 220, flexDirection: "row", justifyContent: "flex-end" },
}));
