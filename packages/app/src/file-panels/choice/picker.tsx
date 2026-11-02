import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { PluginIconView } from "@/plugins/icons";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import type { FilePanel } from "../panels";
import type { FilePanelPickerState } from "./model";
import { useFilePanelChoiceSnapshot, type FilePanelChoice } from "./hook";
import { filePanelIcon, filePanelOptionLabel, filePanelPickerTitle } from "./presentation";

const ThemedCheck = withUnistyles(Check);
const ThemedPanelIcon = withUnistyles(PluginIconView);
const checkedIconMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The first-open question for a file with several panels, over the panel already showing. */
export function FilePanelPicker({ choice }: { choice: FilePanelChoice }) {
  const { t } = useTranslation();
  const { picker } = useFilePanelChoiceSnapshot(choice);
  // The sheet animates out after the model has closed the picker; keep drawing what it asked.
  const [shown, setShown] = useState(picker);
  if (picker && picker !== shown) setShown(picker);
  const content = picker ?? shown;

  const dismiss = useCallback(() => choice.dismissPicker(), [choice]);
  const confirm = useCallback(() => choice.confirmPicker(), [choice]);
  const toggleRemember = useCallback(
    () => choice.setRemember(!choice.getSnapshot().picker?.remember),
    [choice],
  );
  const header = useMemo<SheetHeader>(
    () => ({ title: content ? filePanelPickerTitle(t, content.selectorKey) : "" }),
    [content, t],
  );
  const footer = useMemo(
    () => (
      <Button
        style={styles.footerButton}
        variant="default"
        onPress={confirm}
        testID="file-panel-picker-use"
      >
        {t("panels.file.filePanels.use")}
      </Button>
    ),
    [confirm, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={picker !== null}
      onClose={dismiss}
      footer={footer}
      snapPoints={PICKER_SNAP_POINTS}
      desktopMaxWidth={420}
      testID="file-panel-picker"
    >
      {content ? (
        <PickerBody choice={choice} picker={content} onToggleRemember={toggleRemember} />
      ) : null}
    </AdaptiveModalSheet>
  );
}

const PICKER_SNAP_POINTS = ["60%", "90%"];

function PickerBody({
  choice,
  picker,
  onToggleRemember,
}: {
  choice: FilePanelChoice;
  picker: FilePanelPickerState<FilePanel>;
  onToggleRemember: () => void;
}) {
  const { t } = useTranslation();
  const select = useCallback((panelId: string) => choice.selectInPicker(panelId), [choice]);
  return (
    <>
      <View style={settingsStyles.card} accessibilityRole="radiogroup">
        {picker.candidates.map((panel, index) => (
          <PanelRadioRow
            key={panel.id}
            panel={panel}
            label={filePanelOptionLabel(t, panel)}
            selected={panel.id === picker.selectedPanelId}
            withBorder={index > 0}
            onSelect={select}
          />
        ))}
      </View>
      <CheckboxRow
        label={t("panels.file.filePanels.dontAskAgain")}
        checked={picker.remember}
        onToggle={onToggleRemember}
      />
    </>
  );
}

function PanelRadioRow({
  panel,
  label,
  selected,
  withBorder,
  onSelect,
}: {
  panel: FilePanel;
  label: string;
  selected: boolean;
  withBorder: boolean;
  onSelect: (panelId: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(panel.id), [onSelect, panel.id]);
  const accessibilityState = useMemo(() => ({ checked: selected }), [selected]);
  const rowStyle = useMemo(
    () => [settingsStyles.row, withBorder ? settingsStyles.rowBorder : null, styles.optionRow],
    [withBorder],
  );
  return (
    <PressHighlight
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      aria-checked={selected}
    >
      <View style={selected ? styles.radioSelected : styles.radio}>
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
      <ThemedPanelIcon icon={filePanelIcon(panel)} size={16} uniProps={mutedIconMapping} />
      <Text style={settingsStyles.rowTitle} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
}

function CheckboxRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  const accessibilityState = useMemo(() => ({ checked }), [checked]);
  return (
    <PressHighlight
      style={styles.checkboxRow}
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      aria-checked={checked}
      testID="file-panel-picker-remember"
    >
      <View style={checked ? styles.checkboxChecked : styles.checkbox}>
        {checked ? <ThemedCheck size={14} uniProps={checkedIconMapping} /> : null}
      </View>
      <Text style={settingsStyles.rowTitle}>{label}</Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  footerButton: {
    flex: 1,
  },
  optionRow: {
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  radioSelected: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
}));
