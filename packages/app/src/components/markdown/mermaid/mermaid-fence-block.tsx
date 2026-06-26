import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View, type TextStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Check, Copy, Expand, FileCode2, GitGraph } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { HighlightedCodeBlock, splitFenceStyle } from "@/components/highlighted-code-block";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { MermaidDiagramView } from "@/components/markdown/mermaid/mermaid-diagram-view";
import { MermaidLightbox } from "@/components/markdown/mermaid/mermaid-lightbox";

type MermaidFenceView = "diagram" | "source";

export interface MermaidFenceBlockProps {
  code: string;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
}

const COPIED_RESET_MS = 1500;

const ThemedGitGraph = withUnistyles(GitGraph);
const ThemedFileCode2 = withUnistyles(FileCode2);
const ThemedExpand = withUnistyles(Expand);
const ThemedCopy = withUnistyles(Copy);
const ThemedCheck = withUnistyles(Check);

const mutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function MermaidFenceBlock({ code, inheritedStyles, textStyle }: MermaidFenceBlockProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [view, setView] = useState<MermaidFenceView>("diagram");
  const [fullscreenSvg, setFullscreenSvg] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedResetRef.current) {
        clearTimeout(copiedResetRef.current);
      }
    },
    [],
  );

  const { containerStyle } = useMemo(
    () => splitFenceStyle(inheritedStyles, textStyle),
    [inheritedStyles, textStyle],
  );

  const controlsVisible = isHovered || isNative || isCompact;
  const showDiagram = view === "diagram";

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const handleShowDiagram = useCallback(() => setView("diagram"), []);
  const handleShowSource = useCallback(() => setView("source"), []);

  const handleCopy = useCallback(async () => {
    if (!code) {
      return;
    }
    await Clipboard.setStringAsync(code);
    setCopied(true);
    if (copiedResetRef.current) {
      clearTimeout(copiedResetRef.current);
    }
    copiedResetRef.current = setTimeout(() => {
      setCopied(false);
      copiedResetRef.current = null;
    }, COPIED_RESET_MS);
  }, [code]);

  const handleExpand = useCallback(() => {
    if (!fullscreenSvg) {
      return;
    }
    setLightboxOpen(true);
  }, [fullscreenSvg]);

  const handleCloseLightbox = useCallback(() => setLightboxOpen(false), []);

  const handleSvgChange = useCallback((svg: string | null) => {
    setFullscreenSvg((previous) => (previous === svg ? previous : svg));
  }, []);

  const toolbarOpacity = controlsVisible ? 1 : 0;
  const toolbarInnerStyle = useMemo(
    () => [fenceStyles.toolbarInner, { opacity: toolbarOpacity }],
    [toolbarOpacity],
  );
  const diagramSegmentStyle = useMemo(
    () => [fenceStyles.segment, showDiagram ? fenceStyles.segmentActive : null],
    [showDiagram],
  );
  const sourceSegmentStyle = useMemo(
    () => [fenceStyles.segment, !showDiagram ? fenceStyles.segmentActive : null],
    [showDiagram],
  );

  return (
    <View
      style={containerStyle}
      dataSet={CODE_SURFACE_DATASET}
      onPointerEnter={isWeb ? handlePointerEnter : undefined}
      onPointerLeave={isWeb ? handlePointerLeave : undefined}
    >
      <View style={fenceStyles.toolbar} pointerEvents={controlsVisible ? "auto" : "none"}>
        <View style={toolbarInnerStyle}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("markdown.mermaid.viewDiagram")}
            onPress={handleShowDiagram}
            style={diagramSegmentStyle}
          >
            <ThemedGitGraph size={14} uniProps={mutedIconColorMapping} />
            <Text style={fenceStyles.segmentLabel}>{t("markdown.mermaid.diagram")}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("markdown.mermaid.viewSource")}
            onPress={handleShowSource}
            style={sourceSegmentStyle}
          >
            <ThemedFileCode2 size={14} uniProps={mutedIconColorMapping} />
            <Text style={fenceStyles.segmentLabel}>{t("markdown.mermaid.source")}</Text>
          </Pressable>
          <View style={fenceStyles.toolbarSpacer} />
          {fullscreenSvg ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("markdown.mermaid.openFullscreen")}
              onPress={handleExpand}
              hitSlop={8}
              style={fenceStyles.iconButton}
            >
              <ThemedExpand size={14} uniProps={mutedIconColorMapping} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              copied ? t("message.actions.copied") : t("message.actions.copyCode")
            }
            onPress={handleCopy}
            hitSlop={8}
            style={fenceStyles.iconButton}
          >
            {copied ? (
              <ThemedCheck size={14} uniProps={mutedIconColorMapping} />
            ) : (
              <ThemedCopy size={14} uniProps={mutedIconColorMapping} />
            )}
          </Pressable>
        </View>
      </View>

      {showDiagram ? (
        <View style={fenceStyles.diagramBody}>
          <MermaidDiagramView source={code} onSvgChange={handleSvgChange} />
        </View>
      ) : (
        <View style={fenceStyles.sourceBody}>
          <HighlightedCodeBlock
            code={code}
            language="mermaid"
            inheritedStyles={inheritedStyles}
            textStyle={textStyle}
            bodyOnly
          />
        </View>
      )}

      {lightboxOpen ? <MermaidLightbox svg={fullscreenSvg} onClose={handleCloseLightbox} /> : null}
    </View>
  );
}

const fenceStyles = StyleSheet.create((theme) => ({
  toolbar: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    zIndex: 2,
    maxWidth: "100%",
  },
  toolbarInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  segment: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  segmentActive: {
    backgroundColor: theme.colors.surface2,
  },
  segmentLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  toolbarSpacer: {
    flexGrow: 1,
    minWidth: theme.spacing[2],
  },
  iconButton: {
    padding: theme.spacing[1],
  },
  diagramBody: {
    paddingTop: theme.spacing[8],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  sourceBody: {
    paddingTop: theme.spacing[8],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
}));
