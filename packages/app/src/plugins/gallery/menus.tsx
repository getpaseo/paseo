import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ArrowUpRight,
  FileText,
  MoreHorizontal,
  PackagePlus,
  Power,
  RotateCw,
  Trash2,
} from "lucide-react-native";
import type { PluginListItem, PluginLogEntry } from "@getpaseo/protocol/messages";
import {
  AdaptiveModalSheet,
  SheetHeaderIconButton,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  iconButtonChromeHang,
  useIconButtonChromeGlyphSize,
  useIconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import { foregroundIconColorMapping, mutedIconColorMapping } from "@/components/ui/icon-color";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-api-context";
import { useFetchQuery } from "@/data/query";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { pluginDisplayName } from "@/plugins/plugin-list";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";
import type { PluginAction } from "./actions";
import { InstallPluginSheet } from "./install-sheet";
import { pluginErrorText } from "./error-text";

const SUBMIT_PLUGIN_URL =
  "https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml";
const ThemedMore = withUnistyles(MoreHorizontal);
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const ThemedPackagePlus = withUnistyles(PackagePlus);
const ThemedPower = withUnistyles(Power);
const ThemedArrow = withUnistyles(ArrowUpRight);
const ThemedRotate = withUnistyles(RotateCw);
const ThemedLogs = withUnistyles(FileText);
const ThemedTrash = withUnistyles(Trash2);
const installIcon = <ThemedPackagePlus size={14} uniProps={mutedIconColorMapping} />;
const powerIcon = <ThemedPower size={14} uniProps={mutedIconColorMapping} />;
const linkIcon = <ThemedArrow size={14} uniProps={mutedIconColorMapping} />;
const reloadIcon = <ThemedRotate size={14} uniProps={mutedIconColorMapping} />;
const logsIcon = <ThemedLogs size={14} uniProps={mutedIconColorMapping} />;
const removeIcon = <ThemedTrash size={14} uniProps={dangerIconMapping} />;

type TriggerState = PressableStateCallbackType & { hovered?: boolean; open?: boolean };
// The trigger hangs by how far its frame reaches past the glyph, so the glyph sits on the trailing
// content rail and the frame does not grow the row.
const TRIGGER_HANG = iconButtonChromeHang("small");

function MenuTrigger({ label, testID }: { label: string; testID: string }) {
  const compact = useIsCompactFormFactor();
  const style = useIconButtonChromeStyle({ size: "small", compact, style: styles.trigger });
  const glyphSize = useIconButtonChromeGlyphSize("small", compact);
  return (
    <DropdownMenuTrigger
      accessibilityRole="button"
      accessibilityLabel={label}
      style={style}
      testID={testID}
    >
      {({ hovered, open }: TriggerState) => (
        <ThemedMore
          size={glyphSize}
          uniProps={hovered || open ? foregroundIconColorMapping : mutedIconColorMapping}
        />
      )}
    </DropdownMenuTrigger>
  );
}

/** The page's occasional actions: install from a source, turn plugins off, submit a plugin. */
export function PluginGalleryMenu({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  // COMPAT(pluginSourceInstallation): added in v0.8.0; remove gate after 2027-03-16.
  const sourceInstallSupported = useHostFeature(serverId, "pluginSourceInstallation");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [installing, setInstalling] = useState(false);
  const pluginsOn = config?.pluginsEnabled === true;
  const openInstall = useCallback(() => setInstalling(true), []);
  const closeInstall = useCallback(() => setInstalling(false), []);
  const toggle = useCallback(async () => {
    try {
      await patchConfig({ pluginsEnabled: !pluginsOn });
      toast.show(
        pluginsOn
          ? t("settings.plugins.feedback.globalDisabled")
          : t("settings.plugins.feedback.globalEnabled"),
        { variant: "success" },
      );
    } catch (error) {
      toast.error(pluginErrorText(error));
    }
  }, [patchConfig, pluginsOn, t, toast]);
  const submit = useCallback(() => void openExternalUrl(SUBMIT_PLUGIN_URL), []);
  const label = t("settings.plugins.gallery.menu");
  return (
    <>
      <DropdownMenu>
        <MenuTrigger label={label} testID="plugin-gallery-menu" />
        <DropdownMenuContent align="end" width={220} sheetTitle={label}>
          {sourceInstallSupported ? (
            <DropdownMenuItem leading={installIcon} onSelect={openInstall}>
              {t("settings.plugins.gallery.actions.installFromSource")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem leading={powerIcon} onSelect={toggle} disabled={!config}>
            {pluginsOn
              ? t("settings.plugins.gallery.actions.turnOff")
              : t("settings.plugins.gallery.actions.turnOnAll")}
          </DropdownMenuItem>
          <DropdownMenuItem leading={linkIcon} onSelect={submit}>
            {t("settings.plugins.gallery.actions.submit")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {installing ? (
        <InstallPluginSheet serverId={serverId} target={SOURCE_TARGET} onClose={closeInstall} />
      ) : null}
    </>
  );
}
const SOURCE_TARGET = { kind: "source" } as const;

/** One installed plugin's occasional actions, on its page. */
export function PluginActionsMenu({
  serverId,
  plugin,
  repositoryUrl,
  pendingAction,
  onAction,
}: {
  serverId: string;
  plugin: PluginListItem;
  repositoryUrl?: string;
  pendingAction?: PluginAction;
  onAction(action: PluginAction): void;
}) {
  const { t } = useTranslation();
  // COMPAT(pluginLogs): added in v0.4.0, remove gate after 2027-08-16.
  const logsSupported = useHostFeature(serverId, "pluginLogs");
  const [logsOpen, setLogsOpen] = useState(false);
  const reload = useCallback(() => onAction("reload"), [onAction]);
  const remove = useCallback(() => onAction("remove"), [onAction]);
  const openLogs = useCallback(() => setLogsOpen(true), []);
  const closeLogs = useCallback(() => setLogsOpen(false), []);
  const openRepository = useCallback(() => {
    if (repositoryUrl) void openExternalUrl(repositoryUrl);
  }, [repositoryUrl]);
  const label = t("settings.plugins.actions.menu", { name: pluginDisplayName(plugin) });
  return (
    <>
      <DropdownMenu>
        <MenuTrigger label={label} testID={`plugin-actions-${plugin.id}`} />
        <DropdownMenuContent align="end" width={220} sheetTitle={label}>
          <DropdownMenuItem
            leading={reloadIcon}
            onSelect={reload}
            disabled={!plugin.enabled || pendingAction !== undefined}
            status={pendingAction === "reload" ? "pending" : "idle"}
            pendingLabel={t("settings.plugins.actions.reloading")}
          >
            {t("settings.plugins.actions.reload")}
          </DropdownMenuItem>
          {logsSupported ? (
            <DropdownMenuItem leading={logsIcon} onSelect={openLogs}>
              {t("settings.plugins.logs.action")}
            </DropdownMenuItem>
          ) : null}
          {repositoryUrl ? (
            <DropdownMenuItem leading={linkIcon} onSelect={openRepository}>
              {t("settings.plugins.gallery.actions.repository")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            destructive
            leading={removeIcon}
            onSelect={remove}
            disabled={pendingAction !== undefined}
            status={pendingAction === "remove" ? "pending" : "idle"}
            pendingLabel={t("settings.plugins.actions.removing")}
          >
            {t("settings.plugins.actions.remove")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {logsOpen ? (
        <PluginLogsSheet serverId={serverId} plugin={plugin} onClose={closeLogs} />
      ) : null}
    </>
  );
}

function PluginLogsSheet({
  serverId,
  plugin,
  onClose,
}: {
  serverId: string;
  plugin: PluginListItem;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const pluginId = plugin.id;
  const logs = useFetchQuery({
    queryKey: ["plugin-logs", serverId, pluginId],
    queryFn: () => {
      if (!client) throw new Error("Plugin host is offline");
      return client.getPluginLogs(pluginId);
    },
    enabled: Boolean(client),
    dataShape: "list",
    staleTimeMs: 0,
  });
  const refresh = useCallback(() => {
    void logs.refetch();
  }, [logs]);
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.plugins.logs.title", { name: pluginDisplayName(plugin) }),
      actions: (
        <SheetHeaderIconButton
          icon={RotateCw}
          label={
            logs.isFetching
              ? t("settings.plugins.logs.refreshing")
              : t("settings.plugins.logs.refresh")
          }
          onPress={refresh}
          busy={logs.isFetching}
        />
      ),
    }),
    [logs.isFetching, plugin, refresh, t],
  );

  let content = <Text style={styles.logsState}>{t("settings.plugins.logs.loading")}</Text>;
  if (logs.isError) {
    content = (
      <Alert
        size="sm"
        variant="error"
        title={t("settings.plugins.logs.errorTitle")}
        description={pluginErrorText(logs.error)}
      >
        <Button variant="outline" onPress={refresh}>
          {t("settings.plugins.logs.refresh")}
        </Button>
      </Alert>
    );
  } else if (!logs.isLoading) {
    content = logs.data?.length ? (
      <View style={styles.logList}>
        {logs.data.map((entry: PluginLogEntry) => (
          <View key={entry.sequence} style={styles.logEntry}>
            <Text style={entry.stream === "stderr" ? styles.logStderr : styles.logStdout}>
              {entry.timestamp} {entry.stream}
            </Text>
            <Text style={styles.logMessage}>{entry.message}</Text>
          </View>
        ))}
      </View>
    ) : (
      <Text style={styles.logsState}>{t("settings.plugins.logs.empty")}</Text>
    );
  }

  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} testID="plugin-logs-sheet">
      {content}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: { marginVertical: TRIGGER_HANG, marginRight: TRIGGER_HANG },
  logsState: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
    paddingVertical: theme.spacing[6],
  },
  logList: { gap: theme.spacing[2] },
  logEntry: {
    padding: theme.spacing[3],
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  logStdout: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  logStderr: {
    color: theme.colors.statusDanger,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  logMessage: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.base,
  },
}));
