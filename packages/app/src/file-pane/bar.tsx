import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { Theme } from "@/styles/theme";
import { FileConflictAlert } from "./conflict-alert";
import type { FileEditorStatus } from "./editor/model";

const ThemedSpinner = withUnistyles(LoadingSpinner);
const spinnerMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function FilePanelBar({
  size,
  lineCount,
  mode,
  onModeChange,
  editorStatus,
  cursor,
  vimMode,
  conflictUnavailable,
  onOverwrite,
  onReload,
}: {
  size: number;
  lineCount?: number;
  mode?: "preview" | "source";
  onModeChange?(mode: "preview" | "source"): void;
  editorStatus?: FileEditorStatus;
  cursor?: { line: number; column: number };
  vimMode?: string | null;
  conflictUnavailable?: boolean;
  onOverwrite?(): void;
  onReload?(): void;
}) {
  return (
    <View style={styles.chrome} testID="file-panel-bar">
      <View style={styles.row}>
        <View style={styles.metadata}>
          <Text style={styles.whisper} accessibilityLabel={`File size ${formatFileSize(size)}`}>
            {formatFileSize(size)}
          </Text>
          {lineCount !== undefined ? (
            <Text style={styles.whisper} accessibilityLabel={`${lineCount} lines`}>
              {lineCount} lines
            </Text>
          ) : null}
        </View>
        <View
          style={styles.status}
          accessibilityLabel={editorStatus ? `Editor status ${editorStatus}` : undefined}
        >
          {editorStatus === "dirty" ? (
            <View style={styles.dirtyDot} accessibilityLabel="Unsaved changes" />
          ) : null}
          {editorStatus === "saving" ? (
            <>
              <ThemedSpinner size={14} uniProps={spinnerMapping} />
              <Text style={styles.secondary}>Saving...</Text>
            </>
          ) : null}
          {editorStatus === "error" ? <Text style={styles.error}>Save failed</Text> : null}
          {editorStatus === "conflict" ? <Text style={styles.error}>Changed on disk</Text> : null}
          {vimMode ? (
            <Text style={styles.vim} accessibilityLabel={`Vim mode ${vimMode}`}>
              {vimMode}
            </Text>
          ) : null}
          {cursor ? (
            <Text
              style={styles.whisper}
              accessibilityLabel={`Line ${cursor.line}, column ${cursor.column}`}
            >
              Ln {cursor.line}, Col {cursor.column}
            </Text>
          ) : null}
        </View>
        {mode && onModeChange ? (
          <SegmentedControl
            size="xs"
            value={mode}
            onValueChange={onModeChange}
            testID="file-markdown-mode"
            options={MARKDOWN_MODES}
          />
        ) : null}
      </View>
      {editorStatus === "conflict" && onOverwrite && onReload ? (
        <View style={styles.notice}>
          <FileConflictAlert
            unavailable={conflictUnavailable ?? false}
            onOverwrite={onOverwrite}
            onReload={onReload}
          />
        </View>
      ) : null}
    </View>
  );
}

const MARKDOWN_MODES = [
  { value: "preview" as const, label: "Preview", testID: "file-mode-preview" },
  { value: "source" as const, label: "Source", testID: "file-mode-source" },
];

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create((theme) => ({
  chrome: {
    flexShrink: 0,
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  row: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  metadata: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  whisper: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.xs },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.xs },
  dirtyDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  status: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  vim: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  notice: { paddingHorizontal: theme.spacing[3], paddingBottom: theme.spacing[3] },
}));
