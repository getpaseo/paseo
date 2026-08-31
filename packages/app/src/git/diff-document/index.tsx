import { useCallback, useMemo, useRef, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import { RenderProfile } from "@/utils/render-profiler";
import { createDiffPalette, retainDiffPalette } from "./palette";
import { DiffSurface } from "./surface";
import type { DiffDocumentProps, DiffPalette } from "./types";

export type { DiffDocumentProps, WorkingDiffMode } from "./types";

type ThemedDiffDocumentProps = DiffDocumentProps & {
  palette: DiffPalette;
};

function ThemedDiffDocument(props: ThemedDiffDocumentProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const paletteRef = useRef(props.palette);
  paletteRef.current = retainDiffPalette(paletteRef.current, props.palette);
  const palette = paletteRef.current;
  const { paths, onChange } = props.collapseState;
  const collapsedFilePaths = useMemo(() => new Set(paths), [paths]);
  const toggleFile = useCallback(
    (path: string) => {
      const next = collapsedFilePaths.has(path)
        ? paths.filter((entry) => entry !== path)
        : [...paths, path];
      onChange(next);
    },
    [collapsedFilePaths, onChange, paths],
  );
  return (
    <DiffSurface
      {...props}
      palette={palette}
      collapsedFilePaths={collapsedFilePaths}
      onToggleFile={toggleFile}
      selectedPath={selectedPath}
      onSelectPath={setSelectedPath}
    />
  );
}

const StyledDiffDocument = withUnistyles(ThemedDiffDocument, (theme) => ({
  palette: createDiffPalette(theme),
}));

export function DiffDocument(props: DiffDocumentProps) {
  return (
    <RenderProfile id="DiffDocument">
      <StyledDiffDocument {...props} />
    </RenderProfile>
  );
}
