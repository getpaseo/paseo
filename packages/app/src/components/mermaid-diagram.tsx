import * as Clipboard from "expo-clipboard";
import { Check, Copy, Focus, Minus, Plus } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollView, Text, View, type TextStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import {
  MermaidDiagramRenderer,
  type MermaidDiagramRendererHandle,
} from "@/components/mermaid-diagram-renderer";
import type { MermaidCameraState } from "@/components/mermaid-diagram-dom-camera";
import type { Theme } from "@/styles/theme";

interface MermaidDiagramProps {
  code: string;
  inheritedStyles: TextStyle;
  isComplete: boolean;
  textStyle: TextStyle;
}

type RenderPhase = "rendering" | "rendered" | "error";

interface DiagramRenderState {
  code: string;
  phase: RenderPhase;
}

interface DiagramCameraState {
  code: string;
  camera: MermaidCameraState;
}

const INITIAL_CAMERA_STATE: MermaidCameraState = {
  canZoomIn: false,
  canZoomOut: false,
};
const COPY_RESET_MS = 1500;
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedMermaidDiagramRenderer = withUnistyles(MermaidDiagramRenderer);
const foregroundMutedSpinnerMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const mermaidRendererMapping = (theme: Theme) => ({
  palette: {
    background: theme.colors.surface0,
    border: theme.colors.border,
    foreground: theme.colors.foreground,
    mutedForeground: theme.colors.foregroundMuted,
    primary: theme.colors.accent,
    primaryForeground: theme.colors.accentForeground,
    surface: theme.colors.surface2,
  },
});

export function MermaidDiagram({
  code,
  inheritedStyles,
  isComplete,
  textStyle,
}: MermaidDiagramProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const rendererRef = useRef<MermaidDiagramRendererHandle>(null);
  const copiedResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);

  const [renderState, setRenderState] = useState<DiagramRenderState>({
    code,
    phase: "rendering",
  });
  const [cameraSnapshot, setCameraSnapshot] = useState<DiagramCameraState>({
    code,
    camera: INITIAL_CAMERA_STATE,
  });
  const phase = renderState.code === code ? renderState.phase : "rendering";
  const cameraState = cameraSnapshot.code === code ? cameraSnapshot.camera : INITIAL_CAMERA_STATE;

  useEffect(
    () => () => {
      if (copiedResetRef.current) {
        clearTimeout(copiedResetRef.current);
      }
    },
    [],
  );

  const handleRendered = useCallback(() => setRenderState({ code, phase: "rendered" }), [code]);
  const handleError = useCallback(() => setRenderState({ code, phase: "error" }), [code]);
  const handleCameraStateChange = useCallback(
    (camera: MermaidCameraState) => setCameraSnapshot({ code, camera }),
    [code],
  );
  const handleZoomOut = useCallback(() => rendererRef.current?.zoomOut(), []);
  const handleZoomIn = useCallback(() => rendererRef.current?.zoomIn(), []);
  const handleFit = useCallback(() => rendererRef.current?.fit(), []);
  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    if (copiedResetRef.current) {
      clearTimeout(copiedResetRef.current);
    }
    copiedResetRef.current = setTimeout(() => {
      setCopied(false);
      copiedResetRef.current = null;
    }, COPY_RESET_MS);
  }, [code]);

  const isInteractive = isComplete && phase === "rendered";
  const viewportStyle = useMemo(
    () => [styles.viewport, isCompact ? styles.viewportCompact : styles.viewportWide],
    [isCompact],
  );
  let viewportContent: ReactNode;
  if (!isComplete) {
    viewportContent = (
      <View style={styles.centeredState}>
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedSpinnerMapping} />
        <Text style={styles.stateText}>{t("message.mermaid.waiting")}</Text>
      </View>
    );
  } else if (phase === "error") {
    viewportContent = (
      <ScrollView style={styles.errorScroller} contentContainerStyle={styles.errorContent}>
        <Text style={styles.errorText}>{t("message.mermaid.renderFailed")}</Text>
        <HighlightedCodeBlock
          code={code}
          language="mermaid"
          inheritedStyles={inheritedStyles}
          textStyle={textStyle}
        />
      </ScrollView>
    );
  } else {
    viewportContent = (
      <>
        <ThemedMermaidDiagramRenderer
          ref={rendererRef}
          code={code}
          uniProps={mermaidRendererMapping}
          onCameraStateChange={handleCameraStateChange}
          onError={handleError}
          onRendered={handleRendered}
        />
        {phase === "rendering" ? (
          <View style={styles.renderingOverlay} pointerEvents="none">
            <ThemedLoadingSpinner size="small" uniProps={foregroundMutedSpinnerMapping} />
            <Text style={styles.stateText}>{t("message.mermaid.rendering")}</Text>
          </View>
        ) : null}
      </>
    );
  }

  return (
    <View style={styles.container} testID="mermaid-diagram">
      <View style={styles.toolbar}>
        <Text style={styles.title}>{t("message.mermaid.title")}</Text>
        <View style={styles.actions}>
          <Button
            variant="ghost"
            size="xs"
            leftIcon={Minus}
            style={styles.iconButton}
            disabled={!isInteractive || !cameraState.canZoomOut}
            accessibilityLabel={t("message.mermaid.zoomOut")}
            testID="mermaid-zoom-out"
            onPress={handleZoomOut}
          />
          <Button
            variant="ghost"
            size="xs"
            leftIcon={Plus}
            style={styles.iconButton}
            disabled={!isInteractive || !cameraState.canZoomIn}
            accessibilityLabel={t("message.mermaid.zoomIn")}
            testID="mermaid-zoom-in"
            onPress={handleZoomIn}
          />
          <Button
            variant="ghost"
            size="xs"
            leftIcon={Focus}
            style={styles.iconButton}
            disabled={!isInteractive}
            accessibilityLabel={t("message.mermaid.fit")}
            testID="mermaid-fit"
            onPress={handleFit}
          />
          <Button
            variant="ghost"
            size="xs"
            leftIcon={copied ? Check : Copy}
            style={styles.iconButton}
            accessibilityLabel={
              copied ? t("message.actions.copied") : t("message.mermaid.copySource")
            }
            testID="mermaid-copy-source"
            onPress={handleCopy}
          />
        </View>
      </View>
      <View style={viewportStyle}>{viewportContent}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
    marginVertical: theme.spacing[2],
  },
  toolbar: {
    minHeight: 36,
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
  },
  iconButton: {
    width: 28,
    paddingHorizontal: 0,
  },
  viewport: {
    position: "relative",
    backgroundColor: theme.colors.surface0,
  },
  viewportCompact: {
    height: 280,
  },
  viewportWide: {
    height: 360,
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  renderingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  errorScroller: {
    flex: 1,
  },
  errorContent: {
    padding: theme.spacing[3],
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[2],
  },
}));
