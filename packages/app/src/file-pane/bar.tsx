import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneContentToolbar } from "@/components/ui/pane-content-toolbar";
import {
  FilePanelBarMenu,
  FilePanelSwitcher,
  useFilePanelChoiceSnapshot,
  type FilePanelChoice,
} from "@/file-panels";

/**
 * The file tab's bar: the switcher between the file's panels, "Open with…", and whether the panel
 * has unsaved changes. Shown only when the file has more than one panel; the panel shows the rest.
 */
export function FilePanelBar({ choice, modified }: { choice: FilePanelChoice; modified: boolean }) {
  const { t } = useTranslation();
  const { openWith } = useFilePanelChoiceSnapshot(choice);
  if (!openWith) return null;
  return (
    <View style={styles.chrome}>
      <PaneContentToolbar testID="file-panel-bar">
        <View style={styles.row}>
          <View style={styles.spacer} />
          {modified ? (
            <View
              style={styles.modifiedDot}
              accessibilityLabel={t("panels.file.editor.unsavedChanges")}
              testID="file-panel-modified"
            />
          ) : null}
          <FilePanelSwitcher choice={choice} />
          <FilePanelBarMenu choice={choice} />
        </View>
      </PaneContentToolbar>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  chrome: {
    flexShrink: 0,
  },
  row: {
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
  },
  spacer: { flex: 1 },
  modifiedDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
}));
