import { useCallback, useMemo, type ReactNode, type Ref } from "react";
import { View, type ViewProps } from "react-native";
import { Maximize2, Minimize2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { StyleSheet } from "react-native-unistyles";
import { ComposerFullscreenHost } from "./fullscreen-host";

function keepEditorFocused(event: import("react-native").PointerEvent) {
  if (isWeb) event.preventDefault();
}

/** Both presentations receive the same editing surface and send capability. */
export function ComposerInputPresentation({
  fullscreen,
  iconSize,
  active,
  surface,
  toolbar,
  send,
  error,
  onExit,
  inputWrapperRef,
  inputWrapperStyle,
  inputPointerEvents,
  attachmentSlot,
  showFullscreenButton,
  onEnter,
  overlay,
}: {
  fullscreen: boolean;
  iconSize: number;
  active: boolean;
  surface: ReactNode;
  toolbar: ReactNode;
  send: ReactNode;
  error: ReactNode;
  onExit: () => void;
  inputWrapperRef: Ref<View>;
  inputWrapperStyle: ViewProps["style"];
  inputPointerEvents: ViewProps["pointerEvents"];
  attachmentSlot: ReactNode;
  showFullscreenButton: boolean;
  onEnter: () => void;
  overlay: ReactNode;
}) {
  const { t } = useTranslation();
  // ArrowUp ends at x19; the fullscreen glyphs end at x21 in Lucide's 24px viewBox.
  // Compensate for that difference to align visible ink with Send, not just boxes.
  const railAdjustment = iconSize / 12;
  const maximizeIcon = useCallback(
    (color: string) => <Maximize2 color={color} size={iconSize} />,
    [iconSize],
  );
  const minimizeIcon = useCallback(
    (color: string) => <Minimize2 color={color} size={iconSize} />,
    [iconSize],
  );
  const enterStyle = useMemo(
    () => [styles.fullscreenButton, { right: -6 + railAdjustment }],
    [railAdjustment],
  );
  const exitStyle = useMemo(
    () => [styles.iconButton, { marginRight: railAdjustment }],
    [railAdjustment],
  );
  if (!fullscreen)
    return (
      <>
        <View ref={inputWrapperRef} style={inputWrapperStyle} pointerEvents={inputPointerEvents}>
          {attachmentSlot}
          <View style={styles.inlineTextSurface}>
            {surface}
            {showFullscreenButton ? (
              <Button
                variant="ghost"
                size="xs"
                accessibilityLabel={t("composer.input.fullscreen")}
                leftIcon={maximizeIcon}
                onPointerDown={keepEditorFocused}
                onPress={onEnter}
                style={enterStyle}
                hitSlop={8}
              >
                {null}
              </Button>
            ) : null}
          </View>
          {toolbar}
        </View>
        {overlay}
      </>
    );
  return (
    <ComposerFullscreenHost onExit={onExit} active={active}>
      <View style={styles.fullscreen} testID="composer-fullscreen">
        <View style={styles.exitRow}>
          <Button
            variant="ghost"
            size="xs"
            accessibilityLabel={t("composer.input.exitFullscreen")}
            onPointerDown={keepEditorFocused}
            onPress={onExit}
            style={exitStyle}
            leftIcon={minimizeIcon}
            hitSlop={8}
          >
            {null}
          </Button>
        </View>
        {surface}
        {error}
        <View style={styles.sendRow}>{send}</View>
      </View>
    </ComposerFullscreenHost>
  );
}

const styles = StyleSheet.create((theme) => ({
  inlineTextSurface: { flexShrink: 1, position: "relative" },
  iconButton: {
    width: 28,
    height: 28,
    padding: 0,
    borderWidth: 0,
    borderRadius: theme.borderRadius.full,
  },
  fullscreenButton: {
    position: "absolute",
    top: 0,
    width: 28,
    height: 28,
    padding: 0,
    borderWidth: 0,
    borderRadius: theme.borderRadius.full,
  },
  fullscreen: {
    flex: 1,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  exitRow: { alignItems: "flex-end", flexShrink: 0 },
  sendRow: { flexShrink: 0, alignItems: "flex-end" },
}));
