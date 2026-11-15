import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { PluginListItem } from "@getpaseo/protocol/messages";
import type { PluginListing } from "@getpaseo/protocol/plugin-registry";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useToast } from "@/contexts/toast-api-context";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { pluginDisplayName } from "@/plugins/plugin-list";
import { listingAuthor, listingSource, listingText, listingVersion } from "./listing";
import { dismissFailedOperation, installPlugin, usePluginOperation } from "./operations";

const PLUGIN_SOURCE_DOCS_URL = "https://paseo.sh/docs/plugins/reference#plugin-sources";
const SOURCE_SUBJECT = "source";

/** What the sheet installs: a directory listing, or a source the user types. */
export type InstallTarget = { kind: "listing"; listing: PluginListing } | { kind: "source" };

export function useHostLabel(serverId: string): string {
  const hosts = useHosts();
  return hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
}

/**
 * Every install is confirmed here: who made the plugin, where its code comes from, and that it runs
 * unsandboxed on the host. A listing install closes the sheet and reports on the listing's row; an
 * install from source has no row, so the sheet stays open until it finishes.
 */
export function InstallPluginSheet({
  serverId,
  target,
  onClose,
}: {
  serverId: string;
  target: InstallTarget;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const hostLabel = useHostLabel(serverId);
  const { config } = useDaemonConfig(serverId);
  const pluginsOff = config?.pluginsEnabled !== true;
  const [source, setSource] = useState("");
  const sourceRun = usePluginOperation(serverId, target.kind === "source" ? SOURCE_SUBJECT : "");
  const sourceRunning = target.kind === "source" && sourceRun?.status === "running";
  const close = useCallback(() => {
    if (target.kind === "source") dismissFailedOperation(serverId, SOURCE_SUBJECT);
    onClose();
  }, [onClose, serverId, target.kind]);
  const name =
    target.kind === "listing"
      ? listingText(target.listing, i18n.language).name
      : t("settings.plugins.gallery.install.sourceTitle");

  const onInstalled = useCallback(
    (plugin: PluginListItem) => {
      toast.show(t("settings.plugins.feedback.installed", { name: pluginDisplayName(plugin) }), {
        variant: "success",
      });
    },
    [t, toast],
  );
  const confirm = useCallback(() => {
    if (!client) return;
    const request = { client, queryClient, serverId, enablePlugins: pluginsOff, onInstalled };
    if (target.kind === "listing") {
      void installPlugin({ ...request, source: target.listing.id, subject: target.listing.id });
      onClose();
      return;
    }
    void installPlugin({
      ...request,
      source: source.trim(),
      subject: SOURCE_SUBJECT,
      onInstalled: (plugin) => {
        onInstalled(plugin);
        close();
      },
    });
  }, [client, close, onClose, onInstalled, pluginsOff, queryClient, serverId, source, target]);

  const header = useMemo<SheetHeader>(
    () => ({
      title:
        target.kind === "listing"
          ? t("settings.plugins.gallery.install.title", { name })
          : t("settings.plugins.gallery.install.sourceTitle"),
    }),
    [name, t, target.kind],
  );
  // Until the config loads, the sheet cannot say whether installing also turns plugins on.
  const canInstall =
    Boolean(client && config) && (target.kind === "listing" || source.trim().length > 0);
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button variant="secondary" onPress={close}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          onPress={confirm}
          disabled={!canInstall}
          loading={sourceRunning}
          testID="plugin-install-confirm"
        >
          {sourceRunning
            ? t("settings.plugins.gallery.actions.installing")
            : t("settings.plugins.gallery.actions.install")}
        </Button>
      </View>
    ),
    [canInstall, close, confirm, sourceRunning, t],
  );
  const docsLink = useMemo(
    () => <ExternalLink href={PLUGIN_SOURCE_DOCS_URL} label={t("settings.plugins.docs")} />,
    [t],
  );

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      footer={footer}
      desktopMaxWidth={480}
      testID="plugin-install-sheet"
    >
      <View style={styles.body}>
        {target.kind === "listing" ? (
          <SettingsCard>
            <SettingsRow label={t("settings.plugins.gallery.install.author")}>
              <Text style={styles.value}>{listingAuthor(target.listing)}</Text>
            </SettingsRow>
            <SettingsRow label={t("settings.plugins.gallery.install.source")}>
              <Text style={styles.value} numberOfLines={1}>
                {listingSource(target.listing)}
              </Text>
            </SettingsRow>
            <SettingsRow label={t("settings.plugins.gallery.install.version")}>
              <Text style={styles.value}>{listingVersion(target.listing)}</Text>
            </SettingsRow>
          </SettingsCard>
        ) : (
          <Field label={t("settings.plugins.sourceLabel")} trailing={docsLink}>
            <FormTextInput
              initialValue=""
              onChangeText={setSource}
              placeholder={t("settings.plugins.sourcePlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              editable={!sourceRunning}
              accessibilityLabel={t("settings.plugins.sourceLabel")}
              testID="plugin-source-input"
            />
          </Field>
        )}
        <Alert
          size="sm"
          variant="warning"
          title={t("settings.plugins.gallery.install.warningTitle", { host: hostLabel })}
          description={
            pluginsOff
              ? t("settings.plugins.gallery.install.turnsOn")
              : t("settings.plugins.gallery.install.warningDescription")
          }
        />
        {target.kind === "source" && sourceRun?.status === "failed" ? (
          <Alert size="sm" variant="error" title={sourceRun.error} />
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4] },
  value: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base, maxWidth: 260 },
  actions: { flex: 1, flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
