import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { PluginListItem, PluginUpdatePreview } from "@getpaseo/protocol/messages";
import { formatPluginInstallation } from "@getpaseo/protocol/plugin-source-reference";
import type { PluginListing } from "@getpaseo/protocol/plugin-registry";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-api-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { usePluginEvaluationError } from "@/plugins/registry";
import { pluginDisplayName } from "@/plugins/plugin-list";
import { settingsStyles } from "@/styles/settings";
import { usePluginActions } from "./actions";
import { listingAuthor, listingAuthorAvatar, installedListingId } from "./listing";
import { updatePlugins, usePluginOperation } from "./operations";
import { PluginRow } from "./plugin-row";
import { usePluginUpdates } from "./queries";
import { buildPluginPageRoute } from "./routes";

function shortRevision(revision: string | undefined): string | undefined {
  return revision && /^[0-9a-f]{40,64}$/.test(revision) ? revision.slice(0, 7) : revision;
}

function matchesQuery(plugin: PluginListItem, query: string): boolean {
  if (!query) return true;
  return [plugin.id, plugin.name ?? "", plugin.description ?? ""]
    .join("\n")
    .toLowerCase()
    .includes(query);
}

/** "author · version" for a listed plugin; where it was installed from otherwise. */
function installedMeta(plugin: PluginListItem, listing: PluginListing | undefined) {
  if (!plugin.installation) return plugin.path;
  if (!listing) return formatPluginInstallation(plugin.installation);
  const version = shortRevision(plugin.installation.currentRevision);
  return version ? `${listingAuthor(listing)} · ${version}` : listingAuthor(listing);
}

function useUpdate(serverId: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  return useCallback(
    (previews: PluginUpdatePreview[]) => {
      if (!client) return;
      void updatePlugins({
        client,
        queryClient,
        serverId,
        proposals: previews.flatMap((preview) => preview.proposal ?? []),
        onUpdated: (plugins) =>
          toast.show(
            plugins.length === 1
              ? t("settings.plugins.gallery.update.updated", {
                  name: pluginDisplayName(plugins[0]!),
                })
              : t("settings.plugins.gallery.update.updatedMany", { count: plugins.length }),
            { variant: "success" },
          ),
      });
    },
    [client, queryClient, serverId, t, toast],
  );
}

function UpdateRow({
  serverId,
  plugin,
  preview,
  listing,
  onUpdate,
}: {
  serverId: string;
  plugin: PluginListItem;
  preview: PluginUpdatePreview;
  listing?: PluginListing;
  onUpdate(previews: PluginUpdatePreview[]): void;
}) {
  const { t } = useTranslation();
  const operation = usePluginOperation(serverId, plugin.id);
  const running = operation?.status === "running";
  const name = pluginDisplayName(plugin);
  const target =
    preview.target?.kind === "npm" ? preview.target.version : preview.target?.commit.slice(0, 7);
  const current = shortRevision(preview.current?.currentRevision);
  const open = useCallback(
    () => router.push(buildPluginPageRoute(serverId, plugin.id)),
    [plugin.id, serverId],
  );
  const update = useCallback(() => onUpdate([preview]), [onUpdate, preview]);
  let label = t("settings.plugins.gallery.actions.update");
  if (running) label = t("settings.plugins.gallery.actions.updating");
  else if (operation?.status === "failed") label = t("settings.plugins.gallery.actions.retry");
  return (
    <PluginRow
      name={name}
      icon={listing?.icon}
      description={plugin.description ?? listing?.description}
      meta={current && target ? `${current} → ${target}` : target}
      error={operation?.status === "failed" ? operation.error : undefined}
      onPress={open}
      accessibilityLabel={name}
      testID={`plugin-update-${plugin.id}`}
    >
      <Button variant="outline" onPress={update} loading={running}>
        {label}
      </Button>
    </PluginRow>
  );
}

function InstalledRow({
  serverId,
  plugin,
  listing,
  pending,
  onToggle,
}: {
  serverId: string;
  plugin: PluginListItem;
  listing?: PluginListing;
  pending: boolean;
  onToggle(plugin: PluginListItem, enabled: boolean): void;
}) {
  const { t } = useTranslation();
  const name = pluginDisplayName(plugin);
  const error = usePluginEvaluationError(serverId, plugin.id) ?? plugin.error;
  const failed = error !== undefined || plugin.status === "failed";
  const open = useCallback(
    () => router.push(buildPluginPageRoute(serverId, plugin.id)),
    [plugin.id, serverId],
  );
  const toggle = useCallback((enabled: boolean) => onToggle(plugin, enabled), [onToggle, plugin]);
  const badge = useMemo(
    () =>
      failed ? (
        <StatusBadge label={t("settings.plugins.status.failed")} variant="error" size="xs" />
      ) : null,
    [failed, t],
  );
  return (
    <PluginRow
      name={name}
      icon={listing?.icon}
      badge={badge}
      description={plugin.description ?? listing?.description}
      meta={installedMeta(plugin, listing)}
      authorAvatar={listing && listingAuthorAvatar(listing)}
      error={error}
      onPress={open}
      accessibilityLabel={name}
      testID={`plugin-row-${plugin.id}`}
    >
      <Switch
        value={plugin.enabled}
        onValueChange={toggle}
        disabled={pending}
        accessibilityLabel={`${name}: ${t(
          plugin.enabled ? "settings.plugins.actions.disable" : "settings.plugins.actions.enable",
        )}`}
      />
    </PluginRow>
  );
}

export function InstalledTab({
  serverId,
  plugins,
  listings,
  query,
  onBrowse,
}: {
  serverId: string;
  plugins: readonly PluginListItem[];
  /** Directory listings by ID, for icons and authors. Empty until the directory loads. */
  listings: ReadonlyMap<string, PluginListing>;
  query: string;
  onBrowse(): void;
}) {
  const { t } = useTranslation();
  const actions = usePluginActions(serverId);
  const updates = usePluginUpdates(serverId);
  const update = useUpdate(serverId);
  const normalizedQuery = query.trim().toLowerCase();
  const shown = plugins.filter((plugin) => matchesQuery(plugin, normalizedQuery));
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const pendingUpdates = (updates.data ?? []).filter((preview) => byId.has(preview.id));
  const listingOf = (plugin: PluginListItem) => {
    const id = installedListingId(plugin);
    return id ? listings.get(id) : undefined;
  };
  const toggle = useCallback(
    (plugin: PluginListItem, enabled: boolean) =>
      void actions.run(enabled ? "enable" : "disable", plugin),
    [actions],
  );
  const updateAll = useCallback(() => update(pendingUpdates), [pendingUpdates, update]);
  const updatesTrailing = useMemo(
    () =>
      pendingUpdates.length > 1 ? (
        <Button variant="ghost" onPress={updateAll}>
          {t("settings.plugins.gallery.actions.updateAll")}
        </Button>
      ) : undefined,
    [pendingUpdates.length, t, updateAll],
  );

  return (
    <>
      {pendingUpdates.length > 0 && !normalizedQuery ? (
        <SettingsSection
          title={t("settings.plugins.gallery.sections.updates")}
          trailing={updatesTrailing}
          testID="plugin-updates"
        >
          <SettingsCard>
            {pendingUpdates.map((preview) => {
              const plugin = byId.get(preview.id)!;
              return (
                <UpdateRow
                  key={preview.id}
                  serverId={serverId}
                  plugin={plugin}
                  preview={preview}
                  listing={listingOf(plugin)}
                  onUpdate={update}
                />
              );
            })}
          </SettingsCard>
        </SettingsSection>
      ) : null}
      <SettingsSection title={t("settings.plugins.gallery.sections.installed")}>
        <SettingsCard testID="plugin-installed-list">
          {shown.length ? (
            shown.map((plugin) => (
              <InstalledRow
                key={plugin.id}
                serverId={serverId}
                plugin={plugin}
                listing={listingOf(plugin)}
                pending={actions.pending?.pluginId === plugin.id}
                onToggle={toggle}
              />
            ))
          ) : (
            <View style={styles.empty}>
              <Text style={settingsStyles.rowHint}>
                {normalizedQuery
                  ? t("settings.plugins.gallery.empty.noMatches")
                  : t("settings.plugins.states.empty")}
              </Text>
              {normalizedQuery ? null : (
                <Button variant="outline" onPress={onBrowse}>
                  {t("settings.plugins.gallery.actions.browse")}
                </Button>
              )}
            </View>
          )}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  empty: { padding: theme.spacing[6], alignItems: "center", gap: theme.spacing[3] },
}));
