import React from "react";
import { Pressable, View } from "react-native";
import { Scan, ZoomIn, ZoomOut } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  iconButtonChromeGlyphSize,
  iconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import type { ZoomableViewportAction } from "./types";

interface ViewportToolbarProps {
  actions: ZoomableViewportAction[];
  maxScale: number;
  minScale: number;
  onReset: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  scale: number;
  visible: boolean;
}

interface ResolvedViewportAction extends ZoomableViewportAction {
  disabled: boolean;
}

export const ViewportToolbar = React.memo(function ViewportToolbar({
  actions,
  maxScale,
  minScale,
  onReset,
  onZoomIn,
  onZoomOut,
  scale,
  visible,
}: ViewportToolbarProps) {
  const { t } = useTranslation();
  const viewportActions: ResolvedViewportAction[] = [
    {
      icon: ZoomIn,
      label: t("message.diagram.zoomIn"),
      onPress: onZoomIn,
      disabled: scale >= maxScale,
    },
    {
      icon: ZoomOut,
      label: t("message.diagram.zoomOut"),
      onPress: onZoomOut,
      disabled: scale <= minScale,
    },
    {
      icon: Scan,
      label: t("message.diagram.resetZoom"),
      onPress: onReset,
      disabled: scale === 1,
    },
    ...actions.map((action) => ({ ...action, disabled: false })),
  ];

  return (
    <View style={styles.cluster} testID="zoomable-viewport-toolbar">
      {viewportActions.map((action) => (
        <ViewportToolbarButton
          key={action.label}
          action={action}
          disabled={action.disabled}
          visible={visible}
        />
      ))}
    </View>
  );
});

function ViewportToolbarButton({
  action,
  disabled,
  visible,
}: {
  action: ZoomableViewportAction;
  disabled: boolean;
  visible: boolean;
}) {
  const Icon = action.icon;
  const isCompact = useIsCompactFormFactor();
  const iconSize = iconButtonChromeGlyphSize("small", isCompact);
  const buttonStyle = React.useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) =>
      iconButtonChromeStyle({
        size: "small",
        compact: isCompact,
        state: { hovered, pressed },
        disabled,
        style: visible ? styles.button : styles.buttonHidden,
      }),
    [disabled, isCompact, visible],
  );
  return (
    <Pressable
      accessibilityLabel={action.label}
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={isCompact ? 6 : 4}
      onPress={action.onPress}
      style={buttonStyle}
      testID={action.testID}
    >
      {({ hovered }) => (
        <Icon size={iconSize} color={hovered ? styles.iconHovered.color : styles.icon.color} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  cluster: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    zIndex: 1,
    flexDirection: "row",
    gap: theme.spacing[1],
    pointerEvents: "box-none",
  },
  button: {
    backgroundColor: theme.colors.surface2,
    opacity: 1,
    pointerEvents: "auto",
  },
  buttonHidden: {
    backgroundColor: theme.colors.surface2,
    opacity: 0,
    pointerEvents: "none",
  },
  icon: { color: theme.colors.foregroundMuted },
  iconHovered: { color: theme.colors.foreground },
}));
