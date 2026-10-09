import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RenderProfile } from "@/utils/render-profiler";
import { createDiffPalette, retainDiffPalette } from "./palette";
import { DiffSurface } from "./surface";
import type { DiffDocumentProps, DiffHeaderTypography, DiffPalette } from "./types";
import { usePersistedViewedFiles } from "./use-persisted-viewed-files";

export type { DiffDocumentProps, WorkingDiffMode } from "./types";

type ThemedDiffDocumentProps = DiffDocumentProps & {
  palette: DiffPalette;
  headerTypography: DiffHeaderTypography;
};

const EMPTY_PATHS: string[] = [];

function ThemedDiffDocument(props: ThemedDiffDocumentProps) {
  const { t } = useTranslation();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const paletteRef = useRef(props.palette);
  paletteRef.current = retainDiffPalette(paletteRef.current, props.palette);
  const palette = paletteRef.current;
  const collapseState = props.mode.kind === "working" ? props.collapseState : null;
  const viewedFilesStorageKey =
    props.mode.kind === "working" ? props.mode.viewedFilesStorageKey : null;
  const {
    viewedFiles,
    changedPaths,
    isLoading,
    isSaving,
    pendingFilePath,
    error,
    isLoadError,
    toggleFileViewed: persistFileViewed,
    invalidateViewedFiles,
    retry,
  } = usePersistedViewedFiles({ storageKey: viewedFilesStorageKey, files: props.files });
  const canToggleViewed = !isLoading && !isSaving && !isLoadError;
  const collapseStateRef = useRef(collapseState);
  collapseStateRef.current = collapseState;
  const paths = collapseState?.paths ?? EMPTY_PATHS;
  const collapsedFilePaths = useMemo(() => new Set(paths), [paths]);
  const toggleFile = useCallback(
    (path: string) => {
      if (!collapseState) return;
      const next = collapsedFilePaths.has(path)
        ? paths.filter((entry) => entry !== path)
        : [...paths, path];
      collapseState.onChange(next);
    },
    [collapseState, collapsedFilePaths, paths],
  );
  useEffect(() => {
    if (
      !collapseState ||
      !canToggleViewed ||
      error ||
      props.files.length === 0 ||
      changedPaths.length === 0
    )
      return;
    // Keep persisted review revisions and the owning panel's collapse state in sync with new diffs.
    const invalidPaths = new Set(changedPaths);
    const next = paths.filter((path) => !invalidPaths.has(path));
    if (next.length !== paths.length) collapseState.onChange(next);
    invalidateViewedFiles(changedPaths);
  }, [
    canToggleViewed,
    changedPaths,
    collapseState,
    error,
    invalidateViewedFiles,
    paths,
    props.files.length,
  ]);
  const toggleFileViewed = useCallback(
    (file: ParsedDiffFile) => {
      if (!canToggleViewed) return;
      persistFileViewed(file, (isViewed) => {
        const current = collapseStateRef.current;
        if (!current) return;
        if (!isViewed) {
          current.onChange(current.paths.filter((path) => path !== file.path));
        } else if (!current.paths.includes(file.path)) {
          current.onChange([...current.paths, file.path]);
        }
      });
    },
    [canToggleViewed, persistFileViewed],
  );
  return (
    <View style={styles.container}>
      {error ? (
        <Alert
          variant="error"
          description={t("workspace.git.diff.viewedStateFailed")}
          testID="diff-viewed-error"
        >
          <Button variant="ghost" size="xs" onPress={retry}>
            {t(isLoadError ? "common.actions.retry" : "common.actions.dismiss")}
          </Button>
        </Alert>
      ) : null}
      <DiffSurface
        {...props}
        palette={palette}
        collapsedFilePaths={collapsedFilePaths}
        onToggleFile={toggleFile}
        viewedFiles={viewedFiles}
        viewedActionDisabled={!canToggleViewed}
        viewedFilePendingPath={pendingFilePath}
        onToggleFileViewed={toggleFileViewed}
        selectedPath={selectedPath}
        onSelectPath={setSelectedPath}
      />
    </View>
  );
}

const StyledDiffDocument = withUnistyles(ThemedDiffDocument, (theme) => ({
  palette: createDiffPalette(theme),
  headerTypography: {
    family: theme.fontFamily.ui,
    size: theme.fontSize.base,
    statSize: theme.fontSize.sm,
  },
}));

export function DiffDocument(props: DiffDocumentProps) {
  const key = props.mode.kind === "working" ? props.mode.viewedFilesStorageKey : "commit";
  return (
    <RenderProfile id="DiffDocument">
      <StyledDiffDocument key={key} {...props} />
    </RenderProfile>
  );
}

const styles = StyleSheet.create({ container: { flex: 1, minHeight: 0 } });
