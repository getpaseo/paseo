import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { createControlGeometry } from "@/components/ui/control-geometry";
import { Switch } from "@/components/ui/switch";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { settingsStyles } from "@/styles/settings";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { ImportRow, LocalFilesTarget, LocalFilesForm } from "./form";
import { useLocalFilesForm } from "./use-form";
import { pickLocalFiles } from "./picker";

interface Props {
  target: LocalFilesTarget;
  sources: LocalFilesTarget[];
  onClose: () => void;
}

export function LocalFilesSheet({ target, sources, onClose }: Props) {
  const { t } = useTranslation();
  const { form, state } = useLocalFilesForm(target);
  const [source, setSource] = useState<LocalFilesTarget | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const compact = useIsCompactFormFactor();
  const busy = state.phase === "loading" || state.phase === "importing";
  const complete = state.phase === "complete";
  const sourceTriggerStyle = useCallback(
    ({ hovered }: { hovered: boolean }) => [
      styles.sourceTrigger,
      hovered ? styles.sourceTriggerHover : null,
      busy ? styles.disabled : null,
    ],
    [busy],
  );
  const close = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);
  const chooseSource = useCallback(
    (value: LocalFilesTarget) => {
      setSource(value);
      void form.chooseHost(value);
    },
    [form],
  );
  const chooseDevice = useCallback(() => {
    setSource(null);
    void form.chooseDevice(pickLocalFiles, t("localFiles.thisDevice"));
  }, [form, t]);
  const inspectSource = useCallback(() => {
    if (source) void form.chooseHost(source, [sourcePath.trim()]);
  }, [form, source, sourcePath]);
  const submit = useCallback(() => {
    void form.submit();
  }, [form]);
  const refreshConfig = useCallback(() => {
    void form.refreshConfig();
  }, [form]);
  const header = useMemo(
    () => ({ title: t("localFiles.importTo", { host: target.label }) }),
    [t, target.label],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        {state.rows.length > 0 && !complete ? (
          <View style={styles.footerOptions}>
            {state.limitExceeded ? (
              <Text style={settingsStyles.rowError} accessibilityRole="alert">
                {t("localFiles.limits")}
              </Text>
            ) : null}
            <Text style={settingsStyles.rowHint}>
              {t("localFiles.total", {
                count: state.selectedCount,
                size: formatBytes(state.selectedBytes),
              })}
            </Text>
            <View style={settingsStyles.row}>
              <Text style={[settingsStyles.rowTitle, styles.flex]}>{t("localFiles.include")}</Text>
              <Switch
                value={state.includeInWorktrees}
                onValueChange={form.setIncludeInWorktrees}
                disabled={busy}
                accessibilityLabel={t("localFiles.include")}
                testID="local-files-include"
              />
            </View>
          </View>
        ) : null}
        <View style={styles.actions}>
          <Button variant="secondary" onPress={close} disabled={busy}>
            {complete ? t("common.actions.close") : t("common.actions.cancel")}
          </Button>
          {!complete ? (
            <Button
              variant="default"
              onPress={submit}
              disabled={!state.canSubmit}
              loading={state.phase === "importing"}
              testID="local-files-submit"
            >
              {state.selectedCount === 0 ? t("localFiles.include") : t("localFiles.import")}
            </Button>
          ) : null}
        </View>
      </View>
    ),
    [busy, close, complete, state, form, submit, t],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={close}
      header={header}
      footer={footer}
      desktopMaxWidth={560}
      sizeContentToCurrentSnapPoint
      testID="local-files-sheet"
    >
      <View style={styles.content}>
        <Text style={settingsStyles.rowHint} selectable>
          {target.root}
        </Text>
        {complete ? (
          <Text style={settingsStyles.rowTitle} testID="local-files-complete">
            {t("localFiles.complete")}
          </Text>
        ) : (
          <View style={styles.sources}>
            <Button
              variant="outline"
              disabled={busy}
              testID="local-files-device"
              onPress={chooseDevice}
            >
              {t("localFiles.fromDevice")}
            </Button>
            {sources.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={busy}
                  style={sourceTriggerStyle}
                  accessibilityRole="button"
                  accessibilityLabel={t("localFiles.fromHost")}
                  testID="local-files-source-host"
                >
                  <Text style={styles.sourceTriggerText}>{t("localFiles.fromHost")}</Text>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {sources.map((entry) => (
                    <SourceItem
                      key={entry.serverId + ":" + entry.projectId}
                      entry={entry}
                      onChoose={chooseSource}
                    />
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </View>
        )}
        {state.sourceLabel ? (
          <Text style={settingsStyles.rowHint}>
            {t("localFiles.source", { source: state.sourceLabel })}
          </Text>
        ) : null}
        {source && !complete ? (
          <Field label={t("localFiles.sourcePath")}>
            <View style={styles.sources}>
              <FormTextInput
                initialValue=""
                onChangeText={setSourcePath}
                editable={!busy}
                size={compact ? "md" : "sm"}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder=".env.local"
                style={styles.pathInput}
              />
              <Button
                variant="outline"
                disabled={busy || !sourcePath.trim()}
                onPress={inspectSource}
              >
                {t("localFiles.inspect")}
              </Button>
            </View>
          </Field>
        ) : null}
        {state.phase === "loading" ? (
          <Text style={settingsStyles.rowHint}>{t("common.loading")}</Text>
        ) : null}
        {state.rows.map((row) => (
          <FileRow key={row.path} row={row} busy={busy || complete} onSelect={form.setSelected} />
        ))}
        {state.rows.length > 0 && !complete && state.includeInWorktrees ? (
          <View>
            <Text style={settingsStyles.rowHint}>{t("localFiles.configPreview")}</Text>
            <Text style={styles.config} testID="local-files-config-preview">
              {JSON.stringify({ worktree: { localFiles: state.includedPaths } }, null, 2)}
            </Text>
          </View>
        ) : null}
        {state.configNeedsRefresh ? (
          <Button
            variant="outline"
            disabled={busy}
            onPress={refreshConfig}
            testID="local-files-refresh-config"
          >
            {t("localFiles.refresh")}
          </Button>
        ) : null}
        {state.error ? (
          <Text
            style={settingsStyles.rowError}
            accessibilityRole="alert"
            testID="local-files-error"
          >
            {t("localFiles.errors." + state.error)}
          </Text>
        ) : null}
        <Text style={settingsStyles.rowHint}>{t("localFiles.limits")}</Text>
      </View>
    </AdaptiveModalSheet>
  );
}

function FileRow({
  row,
  busy,
  onSelect,
}: {
  row: ImportRow;
  busy: boolean;
  onSelect: LocalFilesForm["setSelected"];
}) {
  const { t } = useTranslation();
  const replace = row.destination.status === "ready";
  let status = t("localFiles.status." + row.destination.status);
  if (replace) status = t("localFiles.existing");
  if (row.status === "too_large" || row.status === "imported")
    status = t("localFiles.status." + row.status);
  const selectable = row.status === "ready" || row.status === "failed";
  if (row.sourceStatus !== "ready") status = t("localFiles.status." + row.sourceStatus);
  const select = useCallback((value: boolean) => onSelect(row.path, value), [onSelect, row.path]);
  const label = replace ? t("localFiles.replace", { path: row.path }) : row.path;
  return (
    <View style={[settingsStyles.card, settingsStyles.row]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{row.path}</Text>
        <Text style={settingsStyles.rowHint}>{formatBytes(row.size) + " · " + status}</Text>
        {row.error ? (
          <Text style={settingsStyles.rowError}>{t("localFiles.errors." + row.error)}</Text>
        ) : null}
      </View>
      <Switch
        value={row.selected}
        onValueChange={select}
        disabled={busy || !selectable}
        accessibilityLabel={label}
        testID={"local-file-select-" + row.path}
      />
    </View>
  );
}

function SourceItem({
  entry,
  onChoose,
}: {
  entry: LocalFilesTarget;
  onChoose: (entry: LocalFilesTarget) => void;
}) {
  const select = useCallback(() => onChoose(entry), [entry, onChoose]);
  return <DropdownMenuItem onSelect={select}>{entry.label + " · " + entry.root}</DropdownMenuItem>;
}

function formatBytes(size: number): string {
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KiB";
  return (size / (1024 * 1024)).toFixed(1) + " MiB";
}

const styles = StyleSheet.create((theme) => ({
  sourceTrigger: {
    ...createControlGeometry(theme).buttonMd,
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  sourceTriggerHover: { backgroundColor: theme.colors.surface1 },
  sourceTriggerText: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  disabled: { opacity: 0.5 },
  content: { gap: theme.spacing[3] },
  sources: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2], alignItems: "center" },
  footer: { width: "100%", gap: theme.spacing[2] },
  footerOptions: { gap: theme.spacing[1] },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  pathInput: { flex: 1 },
  flex: { flex: 1 },
  config: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
  },
}));
