import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Image, ScrollView, Text, View } from "react-native";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import { StyleSheet } from "react-native-unistyles";
import type { PluginListItem, PluginUpdatePreview } from "@getpaseo/protocol/messages";
import { formatPluginInstallation } from "@getpaseo/protocol/plugin-source-reference";
import type {
  PluginListingIndex,
  PluginListing,
  PluginListingDetail,
} from "@getpaseo/protocol/plugin-registry";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-api-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useInstalledPlugin, usePluginEvaluationError } from "@/plugins/registry";
import { pluginDisplayName } from "@/plugins/plugin-list";
import { PluginSettingsContent } from "@/plugins/settings";
import { usePluginActions, type PluginAction } from "./actions";
import { useListingMeta } from "./browse-tab";
import { ListingInstallControl } from "./install-control";
import { InstallPluginSheet, type InstallTarget } from "./install-sheet";
import {
  categoryLabel,
  installedByListing,
  installedListingId,
  listingAuthorAvatar,
  listingImages,
  listingText,
  listingSource,
  listingVersion,
} from "./listing";
import { PluginActionsMenu } from "./menus";
import { updatePlugins, usePluginOperation, type PluginOperation } from "./operations";
import { PluginMeta, PluginTile } from "./plugin-row";
import { buildPluginListingRoute } from "./routes";
import { PluginsOffAlert } from "./plugins-off-alert";
import { OverviewSkeleton, PluginPageSkeleton } from "./skeletons";
import {
  useLivePluginList,
  usePluginDirectory,
  usePluginListing,
  usePluginUpdates,
} from "./queries";
import { pluginErrorText } from "./error-text";

/** Which plugin the page is for: one installed on the host, or one listed in the directory. */
export type PluginPageSubject =
  | { kind: "installed"; pluginId: string; screenId?: string }
  | { kind: "listing"; listingId: string };

function useResolvedPlugin(serverId: string, subject: PluginPageSubject) {
  const plugins = useLivePluginList(serverId);
  const plugin = useMemo(() => {
    const list = plugins.data ?? [];
    if (subject.kind === "installed") return list.find((item) => item.id === subject.pluginId);
    return installedByListing(list).get(subject.listingId);
  }, [plugins.data, subject]);
  const listingId =
    subject.kind === "listing" ? subject.listingId : plugin && installedListingId(plugin);
  const detail = usePluginListing(serverId, listingId);
  const directory = usePluginDirectory(serverId);
  // The directory the user came from already has the listing, so the page shows it at once and
  // only the overview waits for the listing's own request.
  const listing =
    detail.data ?? directory.query.data?.plugins.find((entry) => entry.id === listingId);
  const listingLoading = detail.isLoading && !listing;
  return {
    plugin,
    listingId,
    listing,
    detail,
    loading: plugins.isLoading || (subject.kind === "listing" && listingLoading),
  };
}

function UpdateButton({ serverId, plugin }: { serverId: string; plugin: PluginListItem }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const updates = usePluginUpdates(serverId);
  const operation = usePluginOperation(serverId, plugin.id);
  const preview = updates.data?.find((candidate) => candidate.id === plugin.id);
  const update = useCallback(() => {
    if (!client || !preview?.proposal) return;
    void updatePlugins({
      client,
      queryClient,
      serverId,
      proposals: [preview.proposal],
      onUpdated: ([updated]) =>
        toast.show(
          t("settings.plugins.gallery.update.updated", { name: pluginDisplayName(updated!) }),
          { variant: "success" },
        ),
    });
  }, [client, preview, queryClient, serverId, t, toast]);
  if (!preview) return null;
  const running = operation?.status === "running";
  let label = t("settings.plugins.gallery.actions.update");
  if (running) label = t("settings.plugins.gallery.actions.updating");
  else if (operation?.status === "failed") label = t("settings.plugins.gallery.actions.retry");
  return (
    <Button variant="outline" onPress={update} loading={running} testID="plugin-update">
      {label}
    </Button>
  );
}

function InstalledControls({
  serverId,
  plugin,
  repositoryUrl,
  onRemoved,
}: {
  serverId: string;
  plugin: PluginListItem;
  repositoryUrl?: string;
  onRemoved(): void;
}) {
  const { t } = useTranslation();
  const actions = usePluginActions(serverId);
  const name = pluginDisplayName(plugin);
  const pendingAction =
    actions.pending?.pluginId === plugin.id ? actions.pending.action : undefined;
  const toggle = useCallback(
    (enabled: boolean) => void actions.run(enabled ? "enable" : "disable", plugin),
    [actions, plugin],
  );
  const act = useCallback(
    async (action: PluginAction) => {
      if ((await actions.run(action, plugin)) && action === "remove") onRemoved();
    },
    [actions, onRemoved, plugin],
  );
  const onAction = useCallback((action: PluginAction) => void act(action), [act]);
  return (
    <View style={styles.controls}>
      <UpdateButton serverId={serverId} plugin={plugin} />
      <Switch
        value={plugin.enabled}
        onValueChange={toggle}
        disabled={pendingAction !== undefined}
        accessibilityLabel={`${name}: ${t(
          plugin.enabled ? "settings.plugins.actions.disable" : "settings.plugins.actions.enable",
        )}`}
      />
      <PluginActionsMenu
        serverId={serverId}
        plugin={plugin}
        repositoryUrl={repositoryUrl}
        pendingAction={pendingAction}
        onAction={onAction}
      />
    </View>
  );
}

function MediaImage({ url, onOpen }: { url: string; onOpen(url: string): void }) {
  const { t } = useTranslation();
  const source = useMemo(() => ({ uri: url }), [url]);
  const open = useCallback(() => onOpen(url), [onOpen, url]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={t("settings.plugins.gallery.details.openImage")}
      onPress={open}
      style={styles.media}
    >
      <Image source={source} style={styles.mediaImage} resizeMode="cover" />
    </PressHighlight>
  );
}

/** The listing's screenshots in a row; one opens full size in the lightbox. */
function MediaStrip({ urls }: { urls: string[] }) {
  const [image, setImage] = useState<ImageLightboxSource | null>(null);
  const open = useCallback((uri: string) => setImage({ type: "uri", uri }), []);
  const close = useCallback(() => setImage(null), []);
  if (urls.length === 0) return null;
  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.mediaStrip}
        contentContainerStyle={styles.mediaRow}
      >
        {urls.map((url) => (
          <MediaImage key={url} url={url} onOpen={open} />
        ))}
      </ScrollView>
      <AttachmentLightbox source={image} onClose={close} />
    </>
  );
}

function DetailValue({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.detailValue} numberOfLines={1}>
      {children}
    </Text>
  );
}

function detailSource(plugin: PluginListItem | undefined, listing: PluginListing | undefined) {
  if (plugin?.installation) return formatPluginInstallation(plugin.installation);
  if (plugin) return plugin.path;
  if (!listing) return undefined;
  return listingSource(listing);
}

function Details({ plugin, listing }: { plugin?: PluginListItem; listing?: PluginListing }) {
  const { t } = useTranslation();
  const version = plugin?.installation?.currentRevision ?? (listing && listingVersion(listing));
  const source = detailSource(plugin, listing);
  const repository = listing?.repository.url;
  return (
    <SettingsSection title={t("settings.plugins.gallery.sections.details")}>
      <SettingsCard>
        {version ? (
          <SettingsRow label={t("settings.plugins.gallery.install.version")}>
            <DetailValue>{version}</DetailValue>
          </SettingsRow>
        ) : null}
        {source ? (
          <SettingsRow label={t("settings.plugins.gallery.install.source")}>
            <DetailValue>{source}</DetailValue>
          </SettingsRow>
        ) : null}
        {listing?.license ? (
          <SettingsRow label={t("settings.plugins.gallery.details.license")}>
            <DetailValue>{listing.license}</DetailValue>
          </SettingsRow>
        ) : null}
        {listing ? (
          <SettingsRow label={t("settings.plugins.gallery.details.updated")}>
            <DetailValue>{listing.updatedAt.slice(0, 10)}</DetailValue>
          </SettingsRow>
        ) : null}
        {repository ? (
          <SettingsRow label={t("settings.plugins.gallery.actions.repository")}>
            <ExternalLink href={repository} label={repository.replace(/^https:\/\//, "")} />
          </SettingsRow>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

/** What the page shows about the plugin, from whichever of the installed plugin and listing exist. */
interface PluginPageModel {
  name: string;
  description?: string;
  /** "author · installs · category" for a listing; the ID when the name hides it. */
  metaLine?: string;
  /** The listing author's picture, before the meta line. */
  authorAvatar?: string;
  /** Why the plugin failed to load, or why its install failed. */
  error?: string;
  /** Why the last update failed, while the update is still offered. The installed version keeps running. */
  updateError?: string;
  /** The plugin's own settings screen, shown inline. */
  screenId?: string;
  overview?: string;
}

function usePluginPageModel({
  serverId,
  subject,
  plugin,
  listing,
  detail,
  installOperation,
}: {
  serverId: string;
  subject: PluginPageSubject;
  plugin?: PluginListItem;
  listing?: PluginListing;
  /** The listing with its overview, once its own request returns. */
  detail?: PluginListingDetail;
  installOperation: PluginOperation | undefined;
}): PluginPageModel {
  const { i18n } = useTranslation();
  const directory = usePluginDirectory(serverId);
  const meta = useListingMeta();
  const pluginId = plugin?.id ?? "";
  const installedPlugin = useInstalledPlugin(serverId, pluginId);
  const evaluationError = usePluginEvaluationError(serverId, pluginId);
  const pluginOperation = usePluginOperation(serverId, pluginId);
  const updates = usePluginUpdates(serverId);
  const text = listing ? listingText(listing, i18n.language) : undefined;
  const requestedScreen = subject.kind === "installed" ? subject.screenId : undefined;
  return {
    name: plugin ? pluginDisplayName(plugin) : (text?.name ?? subjectId(subject)),
    description: text?.description ?? plugin?.description,
    metaLine: listing
      ? listingMetaLine(meta(listing), directory.query.data, listing)
      : installedMetaLine(plugin),
    authorAvatar: listing && listingAuthorAvatar(listing),
    error: plugin ? (evaluationError ?? plugin.error) : failedError(installOperation),
    updateError: failedUpdateError(pluginOperation, updates.data, pluginId),
    screenId: plugin ? (requestedScreen ?? installedPlugin?.settingsScreens[0]?.id) : undefined,
    overview: detail && listingOverview(detail, i18n.language),
  };
}

function subjectId(subject: PluginPageSubject): string {
  return subject.kind === "listing" ? subject.listingId : subject.pluginId;
}

function listingOverview(listing: PluginListingDetail, language: string): string {
  return (listing.overviewTranslations?.[language] ?? listing.readme).trim();
}

function listingMetaLine(
  meta: string,
  index: PluginListingIndex | undefined,
  listing: PluginListing,
): string {
  const category = listing.categories[0];
  return category && index ? `${meta} · ${categoryLabel(index, category)}` : meta;
}

function installedMetaLine(plugin: PluginListItem | undefined): string | undefined {
  return plugin?.name && plugin.name !== plugin.id ? plugin.id : undefined;
}

function failedError(operation: PluginOperation | undefined): string | undefined {
  return operation?.status === "failed" ? operation.error : undefined;
}

/** Shown with the Update button it belongs to, as on the Installed tab's Updates row. */
function failedUpdateError(
  operation: PluginOperation | undefined,
  updates: PluginUpdatePreview[] | undefined,
  pluginId: string,
): string | undefined {
  if (operation?.kind !== "update" || !updates?.some((preview) => preview.id === pluginId))
    return undefined;
  return failedError(operation);
}

function HeaderControl({
  serverId,
  plugin,
  listing,
  installOperation,
  onInstall,
  onRemoved,
}: {
  serverId: string;
  plugin?: PluginListItem;
  listing?: PluginListing;
  installOperation: PluginOperation | undefined;
  onInstall(listing: PluginListing): void;
  onRemoved(): void;
}) {
  if (plugin)
    return (
      <InstalledControls
        serverId={serverId}
        plugin={plugin}
        repositoryUrl={listing?.repository.url}
        onRemoved={onRemoved}
      />
    );
  if (!listing) return null;
  return (
    <ListingInstallControl
      listing={listing}
      operation={installOperation}
      onInstall={onInstall}
      primary
    />
  );
}

/**
 * A plugin's page: what it is, its install or on/off control, its own settings, its overview and
 * the facts about where it came from. The same page serves an installed plugin and a listing.
 */
export function PluginPage({
  serverId,
  subject,
  onBack,
}: {
  serverId: string;
  subject: PluginPageSubject;
  onBack(): void;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const { plugin, listingId, listing, detail, loading } = useResolvedPlugin(serverId, subject);
  const installOperation = usePluginOperation(serverId, listingId);
  const model = usePluginPageModel({
    serverId,
    subject,
    plugin,
    listing,
    detail: detail.data,
    installOperation,
  });
  const [installTarget, setInstallTarget] = useState<InstallTarget | null>(null);
  const install = useCallback(
    (target: PluginListing) => setInstallTarget({ kind: "listing", listing: target }),
    [],
  );
  const closeInstall = useCallback(() => setInstallTarget(null), []);
  // An installed page finds its listing through the plugin, which uninstalling removes. A listed
  // plugin's page becomes its listing's page, offering Install again; any other returns to Plugins.
  const onRemoved = useCallback(() => {
    if (subject.kind !== "installed") return;
    if (listingId) router.replace(buildPluginListingRoute(serverId, listingId));
    else onBack();
  }, [listingId, onBack, serverId, subject.kind]);

  const back = compact ? null : (
    <Button onPress={onBack} variant="ghost" leftIcon={ArrowLeft} style={styles.back}>
      {t("settings.plugins.screens.backToPlugins")}
    </Button>
  );
  if (loading)
    return (
      <View>
        {back}
        <PluginPageSkeleton />
      </View>
    );
  if (!plugin && !listing)
    return (
      <Alert
        size="sm"
        variant="warning"
        title={t("settings.plugins.gallery.missing")}
        description={detail.error ? pluginErrorText(detail.error) : undefined}
      />
    );

  return (
    <View>
      {back}
      <View style={styles.header}>
        <PluginTile name={model.name} icon={listing?.icon} size="lg" />
        <View style={styles.identity}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1} testID="plugin-page-name">
              {model.name}
            </Text>
            {plugin && model.error ? (
              <StatusBadge label={t("settings.plugins.status.failed")} variant="error" size="xs" />
            ) : null}
          </View>
          {model.metaLine ? (
            <PluginMeta text={model.metaLine} authorAvatar={model.authorAvatar} />
          ) : null}
        </View>
        <HeaderControl
          serverId={serverId}
          plugin={plugin}
          listing={listing}
          installOperation={installOperation}
          onInstall={install}
          onRemoved={onRemoved}
        />
      </View>
      <PluginPageBody
        serverId={serverId}
        plugin={plugin}
        listing={listing}
        overviewLoading={detail.isLoading}
        model={model}
      />
      {installTarget ? (
        <InstallPluginSheet serverId={serverId} target={installTarget} onClose={closeInstall} />
      ) : null}
    </View>
  );
}

function PluginPageBody({
  serverId,
  plugin,
  listing,
  overviewLoading,
  model,
}: {
  serverId: string;
  plugin?: PluginListItem;
  listing?: PluginListing;
  overviewLoading: boolean;
  model: PluginPageModel;
}) {
  const { t } = useTranslation();
  return (
    <>
      {plugin ? <PluginsOffAlert serverId={serverId} /> : null}
      {model.description ? <Text style={styles.description}>{model.description}</Text> : null}
      {model.error ? (
        <View style={styles.block}>
          <Alert size="sm" variant="error" title={model.error} />
        </View>
      ) : null}
      {model.updateError ? (
        <View style={styles.block}>
          <Alert size="sm" variant="error" title={model.updateError} />
        </View>
      ) : null}
      {listing ? <MediaStrip urls={listingImages(listing)} /> : null}
      {plugin && model.screenId ? (
        // The plugin's settings screen brings its own sections.
        <PluginSettingsContent serverId={serverId} pluginId={plugin.id} screenId={model.screenId} />
      ) : null}
      {model.overview || (listing && overviewLoading) ? (
        <SettingsSection title={t("settings.plugins.gallery.sections.overview")}>
          {model.overview ? (
            <SettingsCard>
              <View style={styles.overview}>
                <MarkdownRenderer text={model.overview} external />
              </View>
            </SettingsCard>
          ) : (
            <OverviewSkeleton />
          )}
        </SettingsSection>
      ) : null}
      <Details plugin={plugin} listing={listing} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  back: { alignSelf: "flex-start", paddingHorizontal: 0, marginBottom: theme.spacing[4] },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    marginBottom: theme.spacing[4],
  },
  identity: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  nameRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  name: { flexShrink: 1, color: theme.colors.foreground, fontSize: theme.fontSize.xl },
  controls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  description: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    marginBottom: theme.spacing[6],
  },
  block: { marginBottom: theme.spacing[6] },
  // The settings row's padding, so the overview's text sits where a row's label would.
  overview: { padding: theme.spacing[4] },
  mediaStrip: { flexGrow: 0, marginBottom: theme.spacing[6] },
  mediaRow: { gap: theme.spacing[3] },
  media: {
    height: 180,
    aspectRatio: 16 / 10,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  mediaImage: { width: "100%", height: "100%" },
  detailValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    maxWidth: 320,
  },
}));
