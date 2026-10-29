import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsSection, SettingsSelect } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { CheckboxRow } from "@/components/ui/checkbox-row";
import { getIsElectron } from "@/constants/platform";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { useAppSettings } from "@/hooks/use-settings";
import { useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import type { HostBackup } from "./bundle";
import {
  applyBackup,
  availableDeviceItems,
  defaultDeviceSelection,
  hostPartState,
  hostSelection,
  planPreviewRequests,
  toggle,
  type BackupImportPorts,
  type BackupImportResult,
  type DeviceItemId,
  type HostConnection,
  type HostImportChoice,
  type HostImportPreview,
  type HostPartState,
  type HostPreviewState,
  type ReenterItem,
} from "./import-model";
import { useImportSessionStore, type ImportSession } from "./import-session-store";

const NO_TARGET = "none";

// An answer only lands while its part still waits on that host: a late answer from a host the
// user switched away from, or one a reconnect already dropped, is ignored.
function withAnswer(sourceServerId: string, answer: HostPreviewState) {
  return (current: Record<string, HostPreviewState>): Record<string, HostPreviewState> => {
    const waiting = current[sourceServerId];
    return waiting?.status === "loading" && waiting.target === answer.target
      ? { ...current, [sourceServerId]: answer }
      : current;
  };
}

function toHostConnection(status: HostRuntimeConnectionStatus | undefined): HostConnection {
  if (status === "online") return "online";
  return status === "offline" || status === "error" ? "offline" : "connecting";
}

function deviceItemLabel(t: TFunction, item: DeviceItemId): string {
  const labels: Record<DeviceItemId, string> = {
    appSettings: t("settings.backup.device.appSettings"),
    shortcutOverrides: t("settings.backup.device.shortcutOverrides"),
    changesPreferences: t("settings.backup.device.changesPreferences"),
    desktopSettings: t("settings.backup.device.desktopSettings"),
    desktopDaemon: t("settings.backup.device.desktopDaemon"),
    hosts: t("settings.backup.device.hosts"),
  };
  return labels[item];
}

function sectionLabel(t: TFunction, id: string): string {
  const labels: Record<string, string> = {
    profiles: t("settings.backup.sections.profiles"),
    providers: t("settings.backup.sections.providers"),
    metadataGeneration: t("settings.backup.sections.metadataGeneration"),
    agentBehavior: t("settings.backup.sections.agentBehavior"),
    speech: t("settings.backup.sections.speech"),
    skills: t("settings.backup.sections.skills"),
  };
  return labels[id] ?? id;
}

function resultLabel(t: TFunction, result: BackupImportResult): string {
  if (result.scope === "device") return deviceItemLabel(t, result.item as DeviceItemId);
  if (result.item.startsWith("section:")) return sectionLabel(t, result.item.slice(8));
  if (result.item.startsWith("plugin:")) return result.item.slice(7);
  if (result.item.startsWith("settings:")) {
    return t("settings.backup.pluginSettings", { plugin: result.item.slice(9).split("/")[0] });
  }
  if (result.item === "pluginsEnabled") return t("settings.backup.enablePlugins");
  return result.item;
}

function sectionHint(t: TFunction, section: HostImportPreview["sections"][number]): string {
  if (section.status === "invalid") {
    return t("settings.backup.sectionInvalid", { issues: section.issues.join("; ") });
  }
  if (section.status === "unchanged") return t("settings.backup.sectionUnchanged");
  return t("settings.backup.sectionChanges", { changes: section.changes.join(", ") });
}

function outcomeLabel(t: TFunction, outcome: BackupImportResult["outcome"]): string {
  const labels = {
    applied: t("settings.backup.outcome.applied"),
    skipped: t("settings.backup.outcome.skipped"),
    failed: t("settings.backup.outcome.failed"),
  };
  return labels[outcome];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ImportBackupSheetProps {
  visible: boolean;
  session: ImportSession;
  onClose: () => void;
}

export function ImportBackupSheet({ visible, session, onClose }: ImportBackupSheetProps) {
  const { backup, key: sessionKey, step, edits } = session;
  const { t } = useTranslation();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const transferSupport = useHostFeatureAvailabilityMap(serverIds, "configTransfer");
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const targetOptions = useMemo(
    () => hosts.filter((host) => transferSupport.get(host.serverId) === true),
    [hosts, transferSupport],
  );

  const deviceItems = useMemo(() => availableDeviceItems(backup, getIsElectron()), [backup]);
  const defaultDevice = useMemo(() => defaultDeviceSelection(deviceItems), [deviceItems]);
  const device = edits.device ?? defaultDevice;
  const targets = useMemo(() => {
    // Each part defaults to the host it was exported from, when that host can take it.
    const defaultTarget = (serverId: string) =>
      targetOptions.some((host) => host.serverId === serverId) ? serverId : null;
    return Object.fromEntries(
      backup.hosts.map((part) => [
        part.serverId,
        part.serverId in edits.targets
          ? edits.targets[part.serverId]
          : defaultTarget(part.serverId),
      ]),
    );
  }, [backup.hosts, edits.targets, targetOptions]);
  const choices = edits.choices;
  const [previews, setPreviews] = useState<Record<string, HostPreviewState>>({});
  const setSessionStep = useImportSessionStore((store) => store.setStep);
  const updateEdits = useImportSessionStore((store) => store.updateEdits);

  const { updateSettings: saveAppSettings } = useAppSettings();
  const { replaceAll } = useKeyboardShortcutOverrides();
  const { updatePreferences } = useChangesPreferences();
  const { updateSettings: patchDesktopSettings } = useDesktopSettings();

  // A preview is the target host's answer about the file, so it is fetched again whenever the
  // user points a part of the backup at a different host.
  useEffect(() => {
    const { ask, forget } = planPreviewRequests(
      backup.hosts,
      targets,
      (serverId) => toHostConnection(connectionStatuses.get(serverId)) === "online",
      previews,
    );
    if (forget.length > 0) {
      setPreviews((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => !forget.includes(id))),
      );
    }
    for (const { part, target } of ask) {
      const client = getHostRuntimeStore().getClient(target);
      if (!client) continue;
      setPreviews((current) => ({ ...current, [part.serverId]: { status: "loading", target } }));
      client
        .previewConfigImport(part.document)
        .then(({ requestId: _requestId, ...preview }) => {
          setPreviews(withAnswer(part.serverId, { status: "ready", target, preview }));
          return undefined;
        })
        .catch((error: unknown) => {
          setPreviews(
            withAnswer(part.serverId, { status: "error", target, message: errorMessage(error) }),
          );
        });
    }
  }, [backup.hosts, connectionStatuses, previews, targets]);

  const partStates = useMemo(
    () =>
      Object.fromEntries(
        backup.hosts.map((part) => {
          const target = targets[part.serverId] ?? null;
          const connection = toHostConnection(target ? connectionStatuses.get(target) : undefined);
          const state = hostPartState(
            part.serverId,
            target,
            connection,
            previews[part.serverId],
            choices[part.serverId],
          );
          return [part.serverId, state] as const;
        }),
      ),
    [backup.hosts, choices, connectionStatuses, previews, targets],
  );
  const hostChoices = useMemo(() => hostSelection(Object.values(partStates)), [partStates]);

  const ports = useMemo<BackupImportPorts>(
    () => ({
      saveAppSettings: (settings) => saveAppSettings(settings),
      replaceShortcutOverrides: replaceAll,
      saveChangesPreferences: updatePreferences,
      patchDesktopSettings,
      importHosts: (profiles) => getHostRuntimeStore().importHostProfiles(profiles),
      applyHostImport: async (serverId, request) => {
        const client = getHostRuntimeStore().getClient(serverId);
        if (!client) throw new Error(t("settings.backup.hostOffline"));
        const { requestId: _requestId, ...outcome } = await client.applyConfigImport(request);
        return outcome;
      },
    }),
    [patchDesktopSettings, replaceAll, saveAppSettings, t, updatePreferences],
  );

  const handleApply = useCallback(() => {
    if (!hostChoices) return;
    void (async () => {
      setSessionStep(sessionKey, { kind: "applying" });
      try {
        const outcome = await applyBackup(backup, { device, hosts: hostChoices }, ports);
        setSessionStep(sessionKey, { kind: "results", ...outcome });
      } catch (error) {
        setSessionStep(sessionKey, { kind: "error", message: errorMessage(error) });
      }
    })();
  }, [backup, device, hostChoices, ports, sessionKey, setSessionStep]);

  const applying = step.kind === "applying";
  const handleSheetClose = useCallback(() => {
    if (!applying) onClose();
  }, [applying, onClose]);
  const handleToggleDevice = useCallback(
    (item: string) =>
      updateEdits(sessionKey, (current) => ({
        ...current,
        device: toggle(current.device ?? defaultDevice, item as DeviceItemId),
      })),
    [defaultDevice, sessionKey, updateEdits],
  );
  const handleTarget = useCallback(
    (sourceServerId: string, target: string | null) =>
      updateEdits(sessionKey, (current) => ({
        ...current,
        targets: { ...current.targets, [sourceServerId]: target },
      })),
    [sessionKey, updateEdits],
  );
  const handleChoice = useCallback(
    (sourceServerId: string, next: HostImportChoice) =>
      updateEdits(sessionKey, (current) => ({
        ...current,
        choices: { ...current.choices, [sourceServerId]: next },
      })),
    [sessionKey, updateEdits],
  );
  const hostLabelFor = useCallback(
    (serverId: string) => hosts.find((host) => host.serverId === serverId)?.label ?? serverId,
    [hosts],
  );
  const header = useMemo<SheetHeader>(
    () => ({
      title:
        step.kind === "results"
          ? t("settings.backup.resultsTitle")
          : t("settings.backup.sheetTitle"),
    }),
    [step.kind, t],
  );

  const footer = useMemo(
    () =>
      step.kind === "results" ? (
        <View style={styles.footer}>
          <Button style={styles.footerButton} onPress={onClose} testID="backup-import-done">
            {t("settings.backup.done")}
          </Button>
        </View>
      ) : (
        <View style={styles.footer}>
          <Button
            style={styles.footerButton}
            variant="secondary"
            onPress={onClose}
            disabled={applying}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            style={styles.footerButton}
            variant="default"
            onPress={handleApply}
            loading={applying}
            disabled={!hostChoices}
            testID="backup-import-apply"
          >
            {applying ? t("settings.backup.applying") : t("settings.backup.apply")}
          </Button>
        </View>
      ),
    [applying, handleApply, hostChoices, onClose, step.kind, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleSheetClose}
      footer={footer}
      testID="backup-import-sheet"
    >
      {step.kind === "results" ? (
        <ImportResults results={step.results} reenter={step.reenter} hostLabel={hostLabelFor} />
      ) : (
        <>
          {deviceItems.length > 0 ? (
            <SettingsSection title={t("settings.backup.deviceSection")} flush>
              <View style={settingsStyles.card}>
                {deviceItems.map((item, index) => (
                  <CheckboxRow
                    key={item}
                    label={deviceItemLabel(t, item)}
                    checked={device.includes(item)}
                    disabled={applying}
                    withBorder={index > 0}
                    value={item}
                    onToggle={handleToggleDevice}
                    testID={`backup-import-device-${item}`}
                  />
                ))}
              </View>
            </SettingsSection>
          ) : null}

          {backup.hosts.map((part) => (
            <HostPartChooser
              key={part.serverId}
              part={part}
              target={targets[part.serverId] ?? null}
              targetOptions={targetOptions.map((host) => ({
                label: host.label,
                value: host.serverId,
              }))}
              state={partStates[part.serverId]}
              disabled={applying}
              onTarget={handleTarget}
              onChoice={handleChoice}
            />
          ))}

          {backup.unreadable.length > 0 ? (
            <Text style={settingsStyles.rowHint} testID="backup-import-unreadable">
              {t("settings.backup.unreadable", { parts: backup.unreadable.join(", ") })}
            </Text>
          ) : null}
          {step.kind === "error" ? (
            <Text style={settingsStyles.rowError} testID="backup-import-error">
              {t("settings.backup.applyFailed", { message: step.message })}
            </Text>
          ) : null}
        </>
      )}
    </AdaptiveModalSheet>
  );
}

interface HostPartChooserProps {
  part: HostBackup;
  target: string | null;
  targetOptions: { label: string; value: string }[];
  state: HostPartState;
  disabled: boolean;
  onTarget: (sourceServerId: string, target: string | null) => void;
  onChoice: (sourceServerId: string, choice: HostImportChoice) => void;
}

function HostPartChooser({
  part,
  target,
  targetOptions,
  state,
  disabled,
  onTarget,
  onChoice,
}: HostPartChooserProps) {
  const { t } = useTranslation();
  const options = useMemo(
    () => [{ label: t("settings.backup.doNotApply"), value: NO_TARGET }, ...targetOptions],
    [t, targetOptions],
  );
  const handleTarget = useCallback(
    (value: string) => onTarget(part.serverId, value === NO_TARGET ? null : value),
    [onTarget, part.serverId],
  );
  const handleChoice = useCallback(
    (next: HostImportChoice) => onChoice(part.serverId, next),
    [onChoice, part.serverId],
  );

  return (
    <SettingsSection title={t("settings.backup.hostPart", { label: part.label })} flush>
      <View style={settingsStyles.card}>
        <SettingsSelect
          label={t("settings.backup.applyTo")}
          value={target ?? NO_TARGET}
          options={options}
          onValueChange={handleTarget}
          disabled={disabled}
          testID={`backup-import-target-${part.serverId}`}
        />
        {state.kind === "checking" ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <Text style={settingsStyles.rowHint}>{t("settings.backup.previewLoading")}</Text>
          </View>
        ) : null}
        {state.kind === "offline" ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <Text style={settingsStyles.rowHint}>{t("settings.backup.hostOffline")}</Text>
          </View>
        ) : null}
        {state.kind === "failed" ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <Text style={settingsStyles.rowError}>
              {t("settings.backup.previewFailed", { message: state.message })}
            </Text>
          </View>
        ) : null}
        {state.kind === "ready" ? (
          <HostPreviewRows
            preview={state.preview}
            choice={state.choice}
            disabled={disabled}
            onChoice={handleChoice}
          />
        ) : null}
      </View>
    </SettingsSection>
  );
}

function HostPreviewRows({
  preview,
  choice,
  disabled,
  onChoice,
}: {
  preview: HostImportPreview;
  choice: HostImportChoice;
  disabled: boolean;
  onChoice: (choice: HostImportChoice) => void;
}) {
  const { t } = useTranslation();
  const installable = preview.plugins.some((plugin) => plugin.status === "install");
  const handleToggleSection = useCallback(
    (id: string) => onChoice({ ...choice, sections: toggle(choice.sections, id) }),
    [choice, onChoice],
  );
  const handleTogglePlugin = useCallback(
    (id: string) => onChoice({ ...choice, plugins: toggle(choice.plugins, id) }),
    [choice, onChoice],
  );
  const handleToggleEnable = useCallback(
    () => onChoice({ ...choice, enablePlugins: !choice.enablePlugins }),
    [choice, onChoice],
  );
  return (
    <>
      {preview.sections.map((section) => (
        <CheckboxRow
          key={section.id}
          label={sectionLabel(t, section.id)}
          hint={sectionHint(t, section)}
          checked={choice.sections.includes(section.id)}
          disabled={disabled || section.status !== "ready"}
          withBorder
          value={section.id}
          onToggle={handleToggleSection}
          testID={`backup-import-section-${section.id}`}
        />
      ))}
      {preview.plugins.map((plugin) => (
        <CheckboxRow
          key={plugin.id}
          label={plugin.id}
          hint={
            plugin.status === "install"
              ? t("settings.backup.pluginInstall", { source: plugin.source ?? "" })
              : (plugin.reason ?? plugin.status)
          }
          checked={choice.plugins.includes(plugin.id)}
          disabled={disabled || plugin.status !== "install"}
          withBorder
          value={plugin.id}
          onToggle={handleTogglePlugin}
          testID={`backup-import-plugin-${plugin.id}`}
        />
      ))}
      {installable && preview.requiresPluginsEnabled ? (
        <CheckboxRow
          label={t("settings.backup.enablePlugins")}
          hint={
            preview.pluginsStartedByEnabling.length > 0
              ? t("settings.backup.enablePluginsAlsoStarts", {
                  plugins: preview.pluginsStartedByEnabling.join(", "),
                })
              : t("settings.backup.enablePluginsHint")
          }
          checked={choice.enablePlugins}
          disabled={disabled}
          withBorder
          value="enablePlugins"
          onToggle={handleToggleEnable}
          testID="backup-import-enable-plugins"
        />
      ) : null}
    </>
  );
}

function ImportResults({
  results,
  reenter,
  hostLabel,
}: {
  results: BackupImportResult[];
  reenter: ReenterItem[];
  hostLabel: (serverId: string) => string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <View style={settingsStyles.card} testID="backup-import-results">
        {results.length === 0 ? (
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>{t("settings.backup.nothingApplied")}</Text>
          </View>
        ) : (
          results.map((result, index) => (
            <View
              key={`${result.scope}:${result.item}`}
              style={[settingsStyles.row, index > 0 ? settingsStyles.rowBorder : null]}
            >
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>
                  {result.scope === "device"
                    ? resultLabel(t, result)
                    : `${hostLabel(result.scope)}: ${resultLabel(t, result)}`}
                </Text>
                {result.reason ? (
                  <Text
                    style={
                      result.outcome === "failed" ? settingsStyles.rowError : settingsStyles.rowHint
                    }
                  >
                    {result.reason}
                  </Text>
                ) : null}
              </View>
              <Text style={settingsStyles.rowHint}>{outcomeLabel(t, result.outcome)}</Text>
            </View>
          ))
        )}
      </View>
      {reenter.length > 0 ? (
        <SettingsSection title={t("settings.backup.reenterTitle")} flush>
          <View style={settingsStyles.card} testID="backup-import-reenter">
            {reenter.map((entry, index) => (
              <View
                key={`${entry.scope}:${entry.path}`}
                style={[settingsStyles.row, index > 0 ? settingsStyles.rowBorder : null]}
              >
                <Text style={settingsStyles.rowTitle}>
                  {entry.kind === "password"
                    ? t("settings.backup.reenterPassword", { label: entry.path })
                    : `${hostLabel(entry.scope)}: ${entry.path}`}
                </Text>
              </View>
            ))}
          </View>
        </SettingsSection>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
}));
