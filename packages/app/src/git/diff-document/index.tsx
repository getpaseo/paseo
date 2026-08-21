import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import { resolveFocusedSubmoduleExpansion } from "./model";
import { createDiffPalette, retainDiffPalette } from "./palette";
import { DiffSurface } from "./surface";
import type { DiffDocumentProps, DiffPalette } from "./types";

export type { DiffDocumentProps, WorkingDiffMode } from "./types";

type ThemedDiffDocumentProps = DiffDocumentProps & {
  palette: DiffPalette;
};

const EMPTY_PATHS: string[] = [];

function ThemedDiffDocument(props: ThemedDiffDocumentProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const paletteRef = useRef(props.palette);
  paletteRef.current = retainDiffPalette(paletteRef.current, props.palette);
  const palette = paletteRef.current;
  const collapseState = props.mode.kind === "working" ? props.collapseState : null;
  const paths = collapseState?.paths ?? EMPTY_PATHS;
  const collapsedFilePaths = useMemo(() => new Set(paths), [paths]);
  const submoduleCollapseState = props.submoduleCollapseState;
  const submodulePaths = submoduleCollapseState?.paths ?? EMPTY_PATHS;
  const collapsedSubmodulePaths = useMemo(() => new Set(submodulePaths), [submodulePaths]);
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
  const toggleSubmodule = useCallback(
    (path: string) => {
      if (!submoduleCollapseState) return;
      const next = collapsedSubmodulePaths.has(path)
        ? submodulePaths.filter((entry) => entry !== path)
        : [...submodulePaths, path];
      submoduleCollapseState.onChange(next);
    },
    [collapsedSubmodulePaths, submoduleCollapseState, submodulePaths],
  );
  const previousFocusKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const focusPath = props.mode.kind === "working" ? (props.mode.focusPath ?? null) : null;
    const focusRequestId = props.mode.kind === "working" ? props.mode.focusRequestId : undefined;
    const focusKey = focusPath ? `${focusRequestId ?? 0}:${focusPath}` : null;
    const result = resolveFocusedSubmoduleExpansion({
      focusKey,
      focusPath,
      previousFocusKey: previousFocusKeyRef.current,
      files: props.files,
      collapsedSubmodulePaths,
    });
    if (result.consumed) previousFocusKeyRef.current = focusKey;
    if (result.expandSubmodulePath) toggleSubmodule(result.expandSubmodulePath);
  }, [collapsedSubmodulePaths, props.files, props.mode, toggleSubmodule]);
  return (
    <DiffSurface
      {...props}
      palette={palette}
      collapsedFilePaths={collapsedFilePaths}
      collapsedSubmodulePaths={collapsedSubmodulePaths}
      onToggleFile={toggleFile}
      onToggleSubmodule={toggleSubmodule}
      selectedPath={selectedPath}
      onSelectPath={setSelectedPath}
    />
  );
}

const StyledDiffDocument = withUnistyles(ThemedDiffDocument, (theme) => ({
  palette: createDiffPalette(theme),
}));

export function DiffDocument(props: DiffDocumentProps) {
  return <StyledDiffDocument {...props} />;
}
