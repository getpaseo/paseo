import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import {
  WORKSPACE_LABEL_COLORS,
  workspaceLabelKey,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { useHosts } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { StyleSheet } from "react-native-unistyles";
import {
  createWorkspaceLabelManagerModel,
  useWorkspaceLabelProjection,
  workspaceLabels,
} from "@/workspace-labels";
import { WORKSPACE_LABEL_COLOR_STYLE, workspaceLabelColorName } from "./colors";
import { useTranslation } from "react-i18next";

export function WorkspaceLabelManagerModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const managerHeader = useMemo(() => ({ title: t("workspaceLabels.manage.title") }), [t]);
  const hosts = useHosts();
  const { hosts: labelHosts } = useWorkspaceLabelProjection();
  const snapshots = useMemo(
    () => Object.fromEntries(labelHosts.map((host) => [host.serverId, host])),
    [labelHosts],
  );
  const model = useMemo(
    () =>
      createWorkspaceLabelManagerModel({
        rename: (input) => workspaceLabels.rename(input),
        recolor: (input) => workspaceLabels.recolor(input),
        inspectDelete: (input) => workspaceLabels.inspectDelete(input),
        delete: (input) => workspaceLabels.delete(input),
      }),
    [],
  );

  useEffect(() => {
    if (!visible) return;
    model.syncHosts(
      hosts.map((host) => ({
        serverId: host.serverId,
        label: host.label || host.serverId,
        status: snapshots[host.serverId]?.status ?? "offline",
        labels: snapshots[host.serverId]?.labels ?? [],
        error: snapshots[host.serverId]?.error,
      })),
    );
  }, [hosts, model, snapshots, visible]);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const selected = state.selected;
  const disabled = state.host?.status !== "online" || state.pending;
  const selectHost = useCallback((serverId: string) => model.selectHost(serverId), [model]);
  const setQuery = useCallback((value: string) => model.setQuery(value), [model]);
  const selectLabel = useCallback((name: string) => model.selectLabel(name), [model]);
  const setDraftName = useCallback((value: string) => model.setDraftName(value), [model]);
  const recolor = useCallback(
    (color: WorkspaceLabelDefinition["color"]) => model.recolor(color),
    [model],
  );

  const remove = useCallback(async (): Promise<void> => {
    if (!selected) return;
    await model.delete((affected) =>
      confirmDialog({
        title: t("workspaceLabels.manage.deleteTitle", { name: selected.name }),
        message: t("workspaceLabels.manage.deleteMessage", { count: affected }),
        confirmLabel: t("workspaceLabels.manage.delete"),
        destructive: true,
      }),
    );
  }, [model, selected, t]);
  const rename = useCallback(() => {
    void model.rename();
  }, [model]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={managerHeader}
      testID="workspace-label-manager"
    >
      <View style={styles.body}>
        <Text style={styles.sectionLabel}>{t("workspaceLabels.manage.host")}</Text>
        <View style={styles.row}>
          {hosts.map((host) => (
            <ManagerHostButton
              key={host.serverId}
              host={host}
              selected={state.serverId === host.serverId}
              disabled={state.pending}
              selectHost={selectHost}
            />
          ))}
        </View>
        <SearchField
          value={state.query}
          onChangeText={setQuery}
          placeholder={t("workspaceLabels.manage.searchHost")}
          clearAccessibilityLabel={t("workspaceLabels.clearSearch")}
        />
        <View style={styles.list}>
          {state.labels.map((label) => (
            <ManagerLabelRow
              key={workspaceLabelKey(label.name)}
              label={label}
              selected={selected?.name === label.name}
              disabled={state.pending}
              selectLabel={selectLabel}
            />
          ))}
          {state.labels.length === 0 ? (
            <Text style={styles.muted}>{t("workspaceLabels.manage.empty")}</Text>
          ) : null}
        </View>
        {selected ? (
          <View style={styles.editor}>
            <TextInput
              value={state.draftName}
              onChangeText={setDraftName}
              editable={!disabled}
              style={styles.input}
              testID="workspace-label-manager-name"
            />
            <View style={styles.colors}>
              {WORKSPACE_LABEL_COLORS.map((color) => (
                <ManagerColorButton
                  key={color}
                  color={color}
                  selected={selected.color === color}
                  disabled={disabled}
                  onRecolor={recolor}
                />
              ))}
            </View>
            <View style={styles.row}>
              <Button
                size="sm"
                disabled={disabled || !state.draftName.trim() || state.draftName === selected.name}
                onPress={rename}
              >
                {t("workspaceLabels.manage.rename")}
              </Button>
              <Button size="sm" variant="destructive" disabled={disabled} onPress={remove}>
                {t("workspaceLabels.manage.delete")}
              </Button>
            </View>
          </View>
        ) : null}
        {state.host?.status === "offline" ? (
          <Text style={styles.muted}>{t("workspaceLabels.manage.offline")}</Text>
        ) : null}
        {state.host?.status === "unsupported" ? (
          <Text style={styles.muted}>{t("workspaceLabels.manage.updateHost")}</Text>
        ) : null}
        {(state.error ?? state.host?.error) ? (
          <Text style={styles.error}>{state.error ?? state.host?.error}</Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function ManagerHostButton({
  host,
  selected,
  disabled,
  selectHost,
}: {
  host: ReturnType<typeof useHosts>[number];
  selected: boolean;
  disabled: boolean;
  selectHost: (serverId: string) => void;
}): ReactElement {
  const select = useCallback(() => {
    selectHost(host.serverId);
  }, [host.serverId, selectHost]);
  return (
    <Button
      size="sm"
      variant={selected ? "default" : "secondary"}
      disabled={disabled}
      onPress={select}
      testID={`workspace-label-manager-host-${host.serverId}`}
    >
      {host.label || host.serverId}
    </Button>
  );
}

function ManagerLabelRow({
  label,
  selected,
  disabled,
  selectLabel,
}: {
  label: WorkspaceLabelDefinition;
  selected: boolean;
  disabled: boolean;
  selectLabel: (name: string) => void;
}): ReactElement {
  const select = useCallback(() => {
    selectLabel(label.name);
  }, [label.name, selectLabel]);
  const dotStyle = useMemo(
    () => [styles.dot, styles[WORKSPACE_LABEL_COLOR_STYLE[label.color]]],
    [label.color],
  );
  const rowStyle = useMemo(
    () => [styles.labelRow, selected && styles.labelRowSelected],
    [selected],
  );
  return (
    <Pressable
      style={rowStyle}
      disabled={disabled}
      onPress={select}
      testID={`workspace-label-manager-label-${label.name}`}
    >
      <View style={dotStyle} />
      <Text style={styles.text}>{label.name}</Text>
    </Pressable>
  );
}

function ManagerColorButton({
  color,
  selected,
  disabled,
  onRecolor,
}: {
  color: WorkspaceLabelDefinition["color"];
  selected: boolean;
  disabled: boolean;
  onRecolor: (color: WorkspaceLabelDefinition["color"]) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const accessibilityState = useMemo(() => ({ checked: selected, disabled }), [disabled, selected]);
  const style = useMemo(
    () => [
      styles.color,
      styles[WORKSPACE_LABEL_COLOR_STYLE[color]],
      selected && styles.colorSelected,
    ],
    [color, selected],
  );
  const recolor = useCallback(() => {
    void onRecolor(color);
  }, [color, onRecolor]);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={t("workspaceLabels.accessibility.color", {
        color: workspaceLabelColorName(color),
      })}
      accessibilityState={accessibilityState}
      aria-checked={selected}
      disabled={disabled}
      style={style}
      onPress={recolor}
      testID={`workspace-label-manager-color-${color}`}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3], paddingBottom: theme.spacing[4] },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  sectionLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  list: { gap: theme.spacing[1] },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  labelRowSelected: { backgroundColor: theme.colors.surface2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  text: { color: theme.colors.foreground },
  muted: { color: theme.colors.foregroundMuted },
  editor: { gap: theme.spacing[3], paddingTop: theme.spacing[2] },
  input: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
  },
  colors: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  color: { width: 44, height: 44, borderRadius: 22 },
  colorSelected: { borderWidth: 3, borderColor: theme.colors.foreground },
  error: { color: theme.colors.destructive },
  labelColorViolet: { backgroundColor: theme.colors.palette.workspaceLabel.violet },
  labelColorSky: { backgroundColor: theme.colors.palette.workspaceLabel.sky },
  labelColorEmerald: { backgroundColor: theme.colors.palette.workspaceLabel.emerald },
  labelColorOrange: { backgroundColor: theme.colors.palette.workspaceLabel.orange },
  labelColorPink: { backgroundColor: theme.colors.palette.workspaceLabel.pink },
  labelColorIndigo: { backgroundColor: theme.colors.palette.workspaceLabel.indigo },
  labelColorTeal: { backgroundColor: theme.colors.palette.workspaceLabel.teal },
  labelColorRed: { backgroundColor: theme.colors.palette.workspaceLabel.red },
  labelColorAmber: { backgroundColor: theme.colors.palette.workspaceLabel.amber },
  labelColorBlue: { backgroundColor: theme.colors.palette.workspaceLabel.blue },
}));
