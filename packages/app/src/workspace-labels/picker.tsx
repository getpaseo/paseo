import React, {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { CheckSquare, Plus, Square } from "lucide-react-native";
import {
  WORKSPACE_LABEL_COLORS,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { MenuHint, MenuItem, useMenuContext } from "@/components/ui/menu";
import { SearchField } from "@/components/ui/search-field";
import {
  createWorkspaceLabelPickerModel,
  useWorkspaceLabelProjection,
  workspaceLabels,
} from "@/workspace-labels";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { WORKSPACE_LABEL_COLOR_STYLE, workspaceLabelColorName } from "./colors";

const CREATE_LEADING = <Plus size={14} />;

export function WorkspaceLabelPickerPage({
  serverId,
  workspaceId,
  assignedLabels,
}: {
  serverId: string;
  workspaceId: string;
  assignedLabels: readonly string[];
}): ReactElement {
  const menu = useMenuContext("WorkspaceLabelPickerPage");
  const { t } = useTranslation();
  const { labels, targetHost: host } = useWorkspaceLabelProjection(serverId);
  const model = useMemo(
    () =>
      createWorkspaceLabelPickerModel({
        mutate: ({ label, assigned }) =>
          workspaceLabels.setAssignment({ serverId, workspaceId, label, assigned }),
        close: () => menu.setOpen(false),
      }),
    [menu, serverId, workspaceId],
  );
  useEffect(() => {
    model.sync({ labels, assigned: assignedLabels, online: host?.status === "online" });
  }, [assignedLabels, host?.status, labels, model]);
  const snapshot = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const disabled = !snapshot.online;
  const pending = useMemo(() => new Set(snapshot.pendingNames), [snapshot.pendingNames]);
  const setQuery = useCallback((value: string) => model.setQuery(value), [model]);
  const beginCreate = useCallback(() => model.beginCreate(), [model]);
  const setCreateName = useCallback((value: string) => model.setCreateName(value), [model]);
  const create = useCallback(
    (color: WorkspaceLabelDefinition["color"]) => model.create(color),
    [model],
  );
  const toggle = useCallback(
    (label: WorkspaceLabelDefinition, assigned: boolean, source: "row" | "checkbox") =>
      model.toggle(label, assigned, source),
    [model],
  );

  return (
    <>
      <View style={styles.search}>
        <SearchField
          value={snapshot.query}
          onChangeText={setQuery}
          placeholder={t("workspaceLabels.search")}
          clearAccessibilityLabel={t("workspaceLabels.clearSearch")}
          testID="workspace-label-picker-search"
        />
      </View>
      <MenuItem
        leading={CREATE_LEADING}
        disabled={disabled}
        closeOnSelect={false}
        onSelect={beginCreate}
        testID="workspace-label-picker-create"
      >
        {snapshot.picker.create.name
          ? t("workspaceLabels.createNamed", { name: snapshot.picker.create.name })
          : t("workspaceLabels.create")}
      </MenuItem>
      {snapshot.creating ? (
        <View style={styles.create}>
          <TextInput
            value={snapshot.createName}
            onChangeText={setCreateName}
            placeholder={t("workspaceLabels.name")}
            editable={!disabled}
            style={styles.input}
            testID="workspace-label-picker-create-name"
          />
          <View style={styles.palette}>
            {WORKSPACE_LABEL_COLORS.map((color) => (
              <CreateColorItem
                key={color}
                color={color}
                disabled={disabled || !snapshot.createName.trim() || pending.size > 0}
                create={create}
              />
            ))}
          </View>
        </View>
      ) : null}
      {snapshot.picker.rows.map((row) => (
        <WorkspaceLabelPickerRow
          key={row.name.toLocaleLowerCase()}
          label={row}
          disabled={disabled || pending.has(row.name.toLocaleLowerCase())}
          onToggle={toggle}
        />
      ))}
      {snapshot.error ? (
        <MenuHint testID="workspace-label-picker-error">{snapshot.error}</MenuHint>
      ) : null}
      {host?.status === "unsupported" ? (
        <MenuHint>{t("workspaceLabels.updateHostUse")}</MenuHint>
      ) : null}
    </>
  );
}

function CreateColorItem({
  color,
  disabled,
  create,
}: {
  color: WorkspaceLabelDefinition["color"];
  disabled: boolean;
  create: (color: WorkspaceLabelDefinition["color"]) => void;
}): ReactElement {
  const leading = useMemo(
    () => <View style={[styles.dot, styles[WORKSPACE_LABEL_COLOR_STYLE[color]]]} />,
    [color],
  );
  const select = useCallback(() => create(color), [color, create]);
  return (
    <MenuItem
      leading={leading}
      disabled={disabled}
      closeOnSelect={false}
      onSelect={select}
      testID={`workspace-label-picker-create-color-${color}`}
    >
      {workspaceLabelColorName(color)}
    </MenuItem>
  );
}

function WorkspaceLabelPickerRow({
  label,
  disabled,
  onToggle,
}: {
  label: WorkspaceLabelDefinition & { assigned: boolean };
  disabled: boolean;
  onToggle: (
    label: WorkspaceLabelDefinition,
    assigned: boolean,
    source: "row" | "checkbox",
  ) => Promise<boolean>;
}): ReactElement {
  const { t } = useTranslation();
  const handleRow = useCallback(() => {
    void onToggle(label, !label.assigned, "row");
  }, [label, onToggle]);
  const handleCheckbox = useCallback(() => {
    void onToggle(label, !label.assigned, "checkbox");
  }, [label, onToggle]);
  const dotStyle = useMemo(
    () => [styles.dot, styles[WORKSPACE_LABEL_COLOR_STYLE[label.color]]],
    [label.color],
  );
  const accessibilityState = useMemo(
    () => ({ checked: label.assigned, disabled }),
    [disabled, label.assigned],
  );
  return (
    <View style={styles.labelRow}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={t(
          label.assigned
            ? "workspaceLabels.accessibility.removeKeepOpen"
            : "workspaceLabels.accessibility.addKeepOpen",
          { name: label.name },
        )}
        accessibilityState={accessibilityState}
        disabled={disabled}
        onPress={handleCheckbox}
        style={styles.checkboxTarget}
        testID={`workspace-label-picker-checkbox-${label.name}`}
      >
        {label.assigned ? <CheckSquare size={15} /> : <Square size={15} />}
      </Pressable>
      <Pressable
        accessibilityRole="menuitem"
        disabled={disabled}
        onPress={handleRow}
        style={styles.labelBody}
        testID={`workspace-label-picker-row-${label.name}`}
      >
        <View style={dotStyle} />
        <Text style={styles.labelText}>{label.name}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  search: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[1] },
  create: { gap: theme.spacing[2], paddingHorizontal: theme.spacing[3] },
  input: {
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
  },
  palette: { gap: theme.spacing[1] },
  labelRow: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
  },
  labelBody: {
    flex: 1,
    minWidth: 0,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  labelText: { color: theme.colors.foreground },
  dot: { width: 10, height: 10, borderRadius: 5 },
  checkboxTarget: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
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
