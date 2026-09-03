import { useCallback, useMemo, useState } from "react";
import { Pressable, View, type TextStyle, type ViewStyle } from "react-native";
import { Code, Maximize2, Workflow } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { ZoomableViewport } from "@/components/zoomable-viewport";
import type { Theme } from "@/styles/theme";
import type { MarkdownFenceRendererProps } from "../types";
import { MermaidFullscreenViewer } from "./fullscreen-viewer.web";
import { MermaidIframeRuntime, type MermaidRenderedMessage } from "./iframe-runtime.web";
import { useMermaidRenderModel } from "./use-render-model";
import { getDiagramBoxStyle } from "./presentation";

interface MermaidFenceHostImplProps extends MarkdownFenceRendererProps {
  colorScheme?: "light" | "dark";
}

function MermaidFenceHostImpl({
  code,
  phase,
  inheritedStyles,
  textStyle,
  colorScheme = "dark",
}: MermaidFenceHostImplProps) {
  const { t } = useTranslation();
  const { state, request, rendered, renderFailed } = useMermaidRenderModel({
    source: code,
    phase,
    colorScheme,
  });
  const [hasRuntimeContent, setHasRuntimeContent] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const showSourcePress = useCallback(() => setShowSource(true), []);
  const showDiagramPress = useCallback(() => setShowSource(false), []);
  const openFullscreen = useCallback(() => setIsFullscreen(true), []);
  const closeFullscreen = useCallback(() => setIsFullscreen(false), []);
  const handleRendered = useCallback(
    (message: MermaidRenderedMessage) => {
      setHasRuntimeContent(true);
      rendered({
        revision: message.revision,
        source: message.source,
        colorScheme: message.colorScheme,
        dimensions: { height: message.height, width: message.width },
      });
    },
    [rendered],
  );
  const visible = state.visible;
  const canShowDiagram = visible !== null && hasRuntimeContent;
  const diagramVisible = canShowDiagram && !showSource;
  const runtimeHeight = Math.max(visible?.height ?? 240, 1);
  const actions = useMemo(
    () => [
      {
        icon: Code,
        label: t("message.diagram.viewSource"),
        onPress: showSourcePress,
      },
      {
        icon: Maximize2,
        label: t("message.diagram.fullscreen"),
        onPress: openFullscreen,
        testID: "mermaid-fullscreen",
      },
    ],
    [openFullscreen, showSourcePress, t],
  );
  const sourceView = useMemo(() => {
    const { marginTop, marginBottom, marginVertical, ...sourceTextStyle } = textStyle;
    const margins: ViewStyle = {
      marginTop: marginTop ?? marginVertical,
      marginBottom: marginBottom ?? marginVertical,
    };
    const text: TextStyle = sourceTextStyle;
    return { container: [margins, sourceContainerStyle], text };
  }, [textStyle]);
  const diagramStyle = useMemo(
    () => [
      getDiagramBoxStyle(textStyle),
      containerStyle,
      { height: runtimeHeight, minHeight: MIN_DIAGRAM_BOX_HEIGHT },
    ],
    [runtimeHeight, textStyle],
  );
  const diagramSize = useMemo(
    () => (visible ? { width: visible.width, height: visible.height } : MEASURING_SIZE),
    [visible],
  );
  const sourceVisible = !diagramVisible;
  const sourceContainer = showSource ? sourceView.container : sourceContainerStyle;
  const sourceTextStyle = showSource ? sourceView.text : textStyle;
  const viewportStyle = diagramVisible ? diagramStyle : measuringStyle;

  return (
    <>
      {sourceVisible ? (
        <View style={sourceContainer}>
          <HighlightedCodeBlock
            code={code}
            language="mermaid"
            inheritedStyles={inheritedStyles}
            textStyle={sourceTextStyle}
          />
          {showSource && canShowDiagram ? (
            <Pressable
              accessibilityLabel={t("message.diagram.viewDiagram")}
              accessibilityRole="button"
              hitSlop={4}
              onPress={showDiagramPress}
              style={controlStyles.sourceButton}
            >
              {({ hovered }) => (
                <Workflow
                  size={14}
                  color={hovered ? controlStyles.iconHovered.color : controlStyles.icon.color}
                />
              )}
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <ZoomableViewport
        accessibilityLabel={t("message.diagram.diagram")}
        actions={actions}
        contentSize={diagramSize}
        style={viewportStyle}
        testID="mermaid-viewport"
        wheelActivation="modifier"
      >
        <MermaidIframeRuntime
          request={request}
          onRendered={handleRendered}
          onRenderFailed={renderFailed}
        />
      </ZoomableViewport>
      {isFullscreen && visible ? (
        <MermaidFullscreenViewer
          source={visible.source}
          colorScheme={visible.colorScheme}
          onClose={closeFullscreen}
        />
      ) : null}
    </>
  );
}

const MEASURING_SIZE = { width: 240, height: 240 };
/**
 * The toolbar overlays the top of the box (8px offset + 32px compact buttons) and the box clips
 * with `overflow: hidden`, so a shorter box leaves the buttons half-clipped and unclickable.
 */
const MIN_DIAGRAM_BOX_HEIGHT = 56;
const sourceContainerStyle: ViewStyle = { position: "relative" };
/**
 * The viewport's own root is `flex: 1`, so as a flex item it has `flex-basis: 0%` and that basis
 * replaces the height below. In the markdown column there is no free space to grow into, so the
 * box collapses and the diagram is scaled down to fit a couple of pixels. Size it from the height.
 */
const containerStyle: ViewStyle = {
  flexBasis: "auto",
  flexGrow: 0,
  flexShrink: 0,
  overflow: "hidden",
  position: "relative",
};
const measuringStyle: ViewStyle = {
  position: "absolute",
  left: 0,
  right: 0,
  top: 0,
  height: 240,
  opacity: 0,
  pointerEvents: "none",
};
const controlStyles = StyleSheet.create((theme) => ({
  sourceButton: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    padding: theme.spacing[1],
  },
  icon: { color: theme.colors.foregroundMuted },
  iconHovered: { color: theme.colors.foreground },
}));
const mapColorScheme = (theme: Theme) => ({ colorScheme: theme.colorScheme });
const ThemedMermaidFenceHost = withUnistyles(MermaidFenceHostImpl);

export function MermaidFenceHost(props: MarkdownFenceRendererProps) {
  return <ThemedMermaidFenceHost {...props} uniProps={mapColorScheme} />;
}
