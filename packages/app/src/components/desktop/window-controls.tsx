import { useCallback, useMemo } from "react";
import { Pressable, View } from "react-native";
import Svg, { Line, Rect } from "react-native-svg";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  closeDesktopWindow,
  minimizeDesktopWindow,
  toggleDesktopMaximize,
} from "@/desktop/electron/window";
import {
  getDesktopWindowControlsPresentation,
  type DesktopWindowControlsPresentation,
} from "@/desktop/window-chrome-presentation";
import { useCustomDesktopWindowControls } from "@/utils/desktop-window";
import type { Theme } from "@/styles/theme";

type WindowControlKind = "minimize" | "maximize" | "restore" | "close";

function WindowControlGlyph({
  kind,
  color,
  size,
  strokeWidth,
}: {
  kind: WindowControlKind;
  color: string;
  size: number;
  strokeWidth: number;
}) {
  if (kind === "minimize") {
    return (
      <Svg width={size} height={size} viewBox="0 0 16 16" style={styles.glyph}>
        <Line x1={3} y1={8} x2={13} y2={8} stroke={color} strokeWidth={strokeWidth} />
      </Svg>
    );
  }
  if (kind === "restore") {
    return (
      <Svg width={size} height={size} viewBox="0 0 16 16" style={styles.glyph}>
        <Rect
          x={5.5}
          y={3.5}
          width={7}
          height={7}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
        />
        <Line x1={3.5} y1={5.5} x2={3.5} y2={12.5} stroke={color} strokeWidth={strokeWidth} />
        <Line x1={3} y1={12.5} x2={10.5} y2={12.5} stroke={color} strokeWidth={strokeWidth} />
      </Svg>
    );
  }
  if (kind === "close") {
    return (
      <Svg width={size} height={size} viewBox="0 0 16 16" style={styles.glyph}>
        <Line x1={4} y1={4} x2={12} y2={12} stroke={color} strokeWidth={strokeWidth} />
        <Line x1={12} y1={4} x2={4} y2={12} stroke={color} strokeWidth={strokeWidth} />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" style={styles.glyph}>
      <Rect
        x={3.5}
        y={3.5}
        width={9}
        height={9}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
      />
    </Svg>
  );
}

const ThemedWindowControlGlyph = withUnistyles(WindowControlGlyph);
const mutedGlyphMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const whiteGlyphMapping = () => ({ color: "#ffffff" });

function WindowControl({
  kind,
  label,
  onPress,
  presentation,
}: {
  kind: WindowControlKind;
  label: string;
  onPress: () => void;
  presentation: DesktopWindowControlsPresentation;
}) {
  const glyph = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => {
      const highlighted = hovered || pressed;
      const closeHighlighted = kind === "close" && highlighted;
      return (
        <View
          style={[
            styles.controlSurface,
            presentation.hoverShape === "circle"
              ? styles.circularControlSurface
              : styles.fullControlSurface,
            highlighted ? styles.controlHovered : null,
            closeHighlighted ? styles.closeHovered : null,
          ]}
        >
          <ThemedWindowControlGlyph
            kind={kind}
            size={presentation.glyphSize}
            strokeWidth={presentation.glyphStrokeWidth}
            uniProps={closeHighlighted ? whiteGlyphMapping : mutedGlyphMapping}
          />
        </View>
      );
    },
    [kind, presentation],
  );
  const controlStyle = useMemo(
    () => [styles.control, { width: presentation.controlWidth }],
    [presentation.controlWidth],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={controlStyle}
    >
      {glyph}
    </Pressable>
  );
}

export function DesktopWindowControls() {
  const { t } = useTranslation();
  const { visible, mode, isMaximized } = useCustomDesktopWindowControls();
  const minimize = useCallback(() => void minimizeDesktopWindow(), []);
  const toggleMaximize = useCallback(() => void toggleDesktopMaximize(), []);
  const close = useCallback(() => void closeDesktopWindow(), []);
  if (!visible || !mode) return null;
  const presentation = getDesktopWindowControlsPresentation(mode);

  return (
    <View
      style={[styles.controls, { height: presentation.controlHeight }]}
      testID="desktop-window-controls"
    >
      <WindowControl
        kind="minimize"
        label={t("desktop.windowControls.minimize")}
        onPress={minimize}
        presentation={presentation}
      />
      <WindowControl
        kind={isMaximized ? "restore" : "maximize"}
        label={t(
          isMaximized ? "desktop.windowControls.restore" : "desktop.windowControls.maximize",
        )}
        onPress={toggleMaximize}
        presentation={presentation}
      />
      <WindowControl
        kind="close"
        label={t("desktop.windowControls.close")}
        onPress={close}
        presentation={presentation}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: {
    position: "absolute",
    top: 0,
    right: 0,
    zIndex: 3000,
    flexDirection: "row",
  },
  control: {
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  controlSurface: {
    alignItems: "center",
    justifyContent: "center",
  },
  fullControlSurface: {
    width: "100%",
    height: "100%",
  },
  circularControlSurface: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  glyph: {
    flexShrink: 0,
  },
  controlHovered: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  closeHovered: {
    backgroundColor: "rgba(232, 17, 35, 0.9)",
  },
}));
