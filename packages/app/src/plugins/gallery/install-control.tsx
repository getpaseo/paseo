import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { PluginListItem } from "@getpaseo/protocol/messages";
import type { PluginListing } from "@getpaseo/protocol/plugin-registry";
import { Button } from "@/components/ui/button";
import type { PluginOperation } from "./operations";

function useInstallLabel(operation: PluginOperation | undefined): string {
  const { t } = useTranslation();
  if (operation?.status === "running") return t("settings.plugins.gallery.actions.installing");
  if (operation?.status === "failed") return t("settings.plugins.gallery.actions.retry");
  return t("settings.plugins.gallery.actions.install");
}

/**
 * A listing's install state where the user is looking: Install, Installing… while it runs, Retry
 * after a failure (the row or page shows why), and Uninstall once it is on the host. Both ask
 * before they act.
 */
export function ListingInstallControl({
  listing,
  installedPlugin,
  operation,
  uninstalling = false,
  onInstall,
  onUninstall,
  primary = false,
}: {
  listing: PluginListing;
  /** The plugin this listing installed on the host, when it is installed. */
  installedPlugin?: PluginListItem;
  operation: PluginOperation | undefined;
  uninstalling?: boolean;
  onInstall(listing: PluginListing): void;
  onUninstall?(plugin: PluginListItem): void;
  /** The page's one accent action, on the plugin's own page. */
  primary?: boolean;
}) {
  const { t } = useTranslation();
  const installLabel = useInstallLabel(operation);
  const install = useCallback(() => onInstall(listing), [listing, onInstall]);
  const uninstall = useCallback(() => {
    if (installedPlugin) onUninstall?.(installedPlugin);
  }, [installedPlugin, onUninstall]);
  if (installedPlugin) {
    const label = uninstalling
      ? t("settings.plugins.actions.removing")
      : t("settings.plugins.actions.remove");
    return (
      <Button
        variant="outline"
        onPress={uninstall}
        loading={uninstalling}
        accessibilityLabel={`${label} ${listing.name}`}
        testID={`plugin-uninstall-${listing.id}`}
      >
        {label}
      </Button>
    );
  }
  return (
    <Button
      variant={primary ? "default" : "outline"}
      onPress={install}
      loading={operation?.status === "running"}
      accessibilityLabel={`${installLabel} ${listing.name}`}
      testID={`plugin-install-${listing.id}`}
    >
      {installLabel}
    </Button>
  );
}
