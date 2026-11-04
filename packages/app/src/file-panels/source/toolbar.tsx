import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PaneContentToolbar } from "@/components/ui/pane-content-toolbar";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { Theme } from "@/styles/theme";
import { formatFileSize } from "@/utils/format-file-size";
import { FileConflictAlert, type FileConflictAlertState } from "./conflict-alert";
import type { FileEditorStatus } from "./editor/model";

const ThemedSpinner = withUnistyles(LoadingSpinner);
const spinnerMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export type TextFileView = "preview" | "source";

/**
 * The text file panel's toolbar: the file's size and lines, the save state, the vim mode and the
 * cursor, the Preview|Source control when the panel has a preview, and a conflict under it.
 */
export function TextFileToolbar({
  size,
  lineCount,
  view,
  onViewChange,
  editorStatus,
  cursor,
  vimMode,
  conflict,
}: {
  size: number;
  lineCount: number;
  view?: TextFileView;
  onViewChange?(view: TextFileView): void;
  editorStatus?: FileEditorStatus;
  cursor?: { line: number; column: number };
  vimMode?: string | null;
  conflict?: FileConflictAlertState | null;
}) {
  const { t } = useTranslation();
  const views = [
    {
      value: "preview" as const,
      label: t("panels.file.editor.preview"),
      testID: "file-mode-preview",
    },
    { value: "source" as const, label: t("panels.file.editor.source"), testID: "file-mode-source" },
  ];
  return (
    <View style={styles.chrome}>
      <PaneContentToolbar testID="file-panel-bar">
        <View style={styles.row}>
          <View style={styles.metadata}>
            <Text
              style={styles.whisper}
              numberOfLines={1}
              accessibilityLabel={t("panels.file.editor.fileSize", { size: formatFileSize(size) })}
            >
              {formatFileSize(size)}
            </Text>
            <Text
              style={styles.whisper}
              numberOfLines={1}
              accessibilityLabel={t("panels.file.editor.lines", { count: lineCount })}
            >
              {t("panels.file.editor.lines", { count: lineCount })}
            </Text>
          </View>
          <View
            style={styles.status}
            accessibilityLabel={
              editorStatus
                ? t("panels.file.editor.editorStatus", { status: editorStatus })
                : undefined
            }
          >
            {editorStatus === "dirty" ? (
              <View
                style={styles.dirtyDot}
                accessibilityLabel={t("panels.file.editor.unsavedChanges")}
              />
            ) : null}
            {editorStatus === "saving" ? (
              <>
                <ThemedSpinner size={14} uniProps={spinnerMapping} />
                <Text style={styles.secondary}>{t("panels.file.editor.saving")}</Text>
              </>
            ) : null}
            {editorStatus === "error" ? (
              <Text style={styles.error}>{t("panels.file.editor.saveFailed")}</Text>
            ) : null}
            {vimMode ? (
              <Text
                style={styles.vim}
                accessibilityLabel={t("panels.file.editor.vimMode", { mode: vimMode })}
              >
                {vimMode}
              </Text>
            ) : null}
            {cursor ? (
              <Text
                style={styles.whisper}
                accessibilityLabel={t("panels.file.editor.cursor", cursor)}
              >
                Ln {cursor.line}, Col {cursor.column}
              </Text>
            ) : null}
          </View>
          {view && onViewChange ? (
            <SegmentedControl
              size="xs"
              value={view}
              onValueChange={onViewChange}
              testID="file-preview-mode"
              options={views}
            />
          ) : null}
        </View>
      </PaneContentToolbar>
      {conflict ? <FileConflictAlert state={conflict} /> : null}
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
  metadata: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  status: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  whisper: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  dirtyDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  vim: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
