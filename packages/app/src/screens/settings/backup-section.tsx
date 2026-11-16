import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Text, View } from "react-native";
import { SettingsAction, SettingsCard, SettingsSection } from "@/components/settings";
import { CheckboxRow } from "@/components/ui/checkbox-row";
import { getIsElectron } from "@/constants/platform";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useFilePicker } from "@/hooks/use-file-picker";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { useAppSettings } from "@/hooks/use-settings";
import { useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { saveDownloadedBytes, shareSavedFile } from "@/stores/download-store";
import { settingsStyles } from "@/styles/settings";
import { resolveAppVersion } from "@/utils/app-version";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupFileError,
  exportHostProfile,
  parseBackup,
  serializeBackup,
  type ExportedHost,
  type HostBackup,
} from "@/backup/bundle";
import { ImportBackupSheet } from "@/backup/import-sheet";
import { useImportSessionStore } from "@/backup/import-session-store";

const BACKUP_MIME_TYPE = "application/json";

type ActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; message: string }
  | { status: "error"; message: string };

function hostExportHint(t: TFunction, supported: boolean | null | undefined): string {
  if (supported === true) return t("settings.backup.hostIncluded");
  if (supported === false) return t("settings.backup.hostUnsupported");
  return t("settings.backup.hostOffline");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Moves this device's preferences and its hosts' settings to another installation. */
export function BackupSection() {
  const { t } = useTranslation();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const transferSupport = useHostFeatureAvailabilityMap(serverIds, "configTransfer");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [exportState, setExportState] = useState<ActionState>({ status: "idle" });
  const [importState, setImportState] = useState<ActionState>({ status: "idle" });
  const importSession = useImportSessionStore((store) => store.session);
  const openImportSession = useImportSessionStore((store) => store.open);
  const closeImportSession = useImportSessionStore((store) => store.close);

  const { settings } = useAppSettings();
  const { overrides } = useKeyboardShortcutOverrides();
  const { preferences } = useChangesPreferences();
  const { settings: desktopSettings } = useDesktopSettings();
  const { pickFiles } = useFilePicker();

  const exportableServerIds = useMemo(
    () =>
      serverIds.filter(
        (serverId) => transferSupport.get(serverId) === true && !excluded.includes(serverId),
      ),
    [excluded, serverIds, transferSupport],
  );

  const handleExport = useCallback(() => {
    void (async () => {
      setExportState({ status: "pending" });
      try {
        const hostParts: HostBackup[] = [];
        for (const serverId of exportableServerIds) {
          const client = getHostRuntimeStore().getClient(serverId);
          if (!client) throw new Error(t("settings.backup.hostOffline"));
          const { document } = await client.exportConfig();
          const label = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
          hostParts.push({ serverId, label, document });
        }
        const createdAt = new Date().toISOString();
        const fileName = `paseo-backup-${createdAt.slice(0, 10)}.json`;
        const json = serializeBackup({
          format: BACKUP_FORMAT,
          version: BACKUP_VERSION,
          createdAt,
          appVersion: resolveAppVersion(),
          device: {
            appSettings: settings,
            shortcutOverrides: overrides,
            changesPreferences: preferences,
            ...(getIsElectron() ? { desktopSettings } : {}),
            hosts: hosts
              .map(exportHostProfile)
              .filter((host): host is ExportedHost => host !== null),
          },
          hosts: hostParts,
        });
        const uri = await saveDownloadedBytes({
          bytes: new TextEncoder().encode(json),
          fileName,
          mimeType: BACKUP_MIME_TYPE,
        });
        if (uri) await shareSavedFile(uri, BACKUP_MIME_TYPE, fileName);
        setExportState({ status: "done", message: t("settings.backup.exported", { fileName }) });
      } catch (error) {
        setExportState({
          status: "error",
          message: t("settings.backup.exportFailed", { message: errorMessage(error) }),
        });
      }
    })();
  }, [desktopSettings, exportableServerIds, hosts, overrides, preferences, settings, t]);

  const handleImport = useCallback(() => {
    void (async () => {
      setImportState({ status: "pending" });
      try {
        const files = await pickFiles({
          multiple: false,
          accept: {
            name: t("settings.backup.fileTypeName"),
            extensions: ["json"],
            mimeTypes: [BACKUP_MIME_TYPE],
          },
        });
        const file = files?.[0];
        if (!file) {
          setImportState({ status: "idle" });
          return;
        }
        openImportSession(parseBackup(new TextDecoder().decode(await file.readBytes())));
        setImportState({ status: "idle" });
      } catch (error) {
        setImportState({
          status: "error",
          message:
            error instanceof BackupFileError
              ? error.message
              : t("settings.backup.importFailed", { message: errorMessage(error) }),
        });
      }
    })();
  }, [openImportSession, pickFiles, t]);

  const handleToggleHost = useCallback((serverId: string) => {
    setExcluded((current) =>
      current.includes(serverId)
        ? current.filter((entry) => entry !== serverId)
        : [...current, serverId],
    );
  }, []);

  return (
    <>
      <SettingsSection title={t("settings.backup.exportTitle")} testID="backup-export">
        <SettingsCard>
          <SettingsAction
            label={t("settings.backup.exportLabel")}
            hint={t("settings.backup.exportHint")}
            actionLabel={
              exportState.status === "pending"
                ? t("settings.backup.exporting")
                : t("settings.backup.exportAction")
            }
            onPress={handleExport}
            disabled={exportState.status === "pending"}
            testID="backup-export-action"
          />
          {hosts.map((host) => {
            const supported = transferSupport.get(host.serverId);
            return (
              <CheckboxRow
                key={host.serverId}
                label={host.label}
                hint={hostExportHint(t, supported)}
                checked={supported === true && !excluded.includes(host.serverId)}
                disabled={supported !== true || exportState.status === "pending"}
                withBorder
                value={host.serverId}
                onToggle={handleToggleHost}
                testID={`backup-export-host-${host.serverId}`}
              />
            );
          })}
        </SettingsCard>
        <ActionFeedback state={exportState} testID="backup-export-feedback" />
      </SettingsSection>

      <SettingsSection title={t("settings.backup.importTitle")} testID="backup-import">
        <SettingsCard>
          <SettingsAction
            label={t("settings.backup.importLabel")}
            hint={t("settings.backup.importHint")}
            actionLabel={t("settings.backup.importAction")}
            onPress={handleImport}
            disabled={importState.status === "pending"}
            testID="backup-import-action"
          />
        </SettingsCard>
        <ActionFeedback state={importState} testID="backup-import-feedback" />
      </SettingsSection>

      {importSession ? (
        <ImportBackupSheet
          key={importSession.key}
          visible
          session={importSession}
          onClose={closeImportSession}
        />
      ) : null}
    </>
  );
}

function ActionFeedback({ state, testID }: { state: ActionState; testID: string }) {
  if (state.status !== "done" && state.status !== "error") return null;
  return (
    <View style={settingsStyles.row}>
      <Text
        style={state.status === "error" ? settingsStyles.rowError : settingsStyles.rowHint}
        testID={testID}
      >
        {state.message}
      </Text>
    </View>
  );
}
