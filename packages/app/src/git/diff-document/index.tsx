import { useCallback, useMemo, useRef, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import { RenderProfile } from "@/utils/render-profiler";
import { TextZoomArea, useScopedTextZoom, zoomedFontSize } from "@/text-zoom";
import { createDiffPalette, retainDiffPalette } from "./palette";
import { DiffSurface } from "./surface";
import type { DiffDocumentProps, DiffHeaderTypography, DiffPalette } from "./types";

export type { DiffDocumentProps, WorkingDiffMode } from "./types";

type ThemedDiffDocumentProps = DiffDocumentProps & {
  palette: DiffPalette;
  headerTypography: DiffHeaderTypography;
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
  headerTypography: {
    family: theme.fontFamily.ui,
    size: theme.fontSize.base,
    statSize: theme.fontSize.sm,
  },
}));

const ZOOM_AREA_STYLE = { flex: 1, minHeight: 0 } as const;

/**
 * Diffs follow the file views' pinch zoom. The code size drives the measurer, the line-number
 * gutter and the change markers, so they stay aligned; the surface keeps the row at the top of
 * the viewport in place when the layout changes.
 */
function ZoomedDiffDocument(props: DiffDocumentProps) {
  const zoom = useScopedTextZoom();
  const { displayPreferences } = props;
  const zoomedPreferences = useMemo(
    () =>
      zoom === 1
        ? displayPreferences
        : {
            ...displayPreferences,
            codeFontSize: zoomedFontSize(displayPreferences.codeFontSize, zoom),
          },
    [displayPreferences, zoom],
  );
  return <StyledDiffDocument {...props} displayPreferences={zoomedPreferences} />;
}

export function DiffDocument(props: DiffDocumentProps) {
  return (
    <RenderProfile id="DiffDocument">
      <TextZoomArea surface="files" style={ZOOM_AREA_STYLE}>
        <ZoomedDiffDocument {...props} />
      </TextZoomArea>
    </RenderProfile>
  );
}
