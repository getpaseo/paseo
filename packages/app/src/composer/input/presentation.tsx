import { useCallback, useMemo, type ReactNode, type Ref } from "react";
import { View, type ViewProps } from "react-native";
import { Maximize2, Minimize2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ComposerFullscreenBody, ComposerFullscreenFooter } from "@/composer/dock";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE } from "@/styles/theme";
import { StyleSheet } from "react-native-unistyles";
import { useComposerFullscreenExit } from "./fullscreen-exit";
import { resolveGlyphRailOffset } from "./state";

const CONTROL_SIZE = 28;
const FULLSCREEN_GLYPH_SIZE = ICON_SIZE.md;

function keepEditorFocused(event: import("react-native").PointerEvent) {
  if (isWeb) event.preventDefault();
}

/**
 * One tree for both layout modes. The editing surface keeps its position so the
 * mounted editor, its native buffer, selection, and focus survive every toggle;
 * only the chrome around it changes. Fullscreen shows exit top right and Send
 * bottom right, both on the rail the inline Send button uses; a send error sits
 * in the same footer as Send.
 */
export function ComposerInputPresentation({
  fullscreen,
  sendIconSize,
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
  sendIconSize: number;
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
  // A retained tab keeps its fullscreen editor mounted while hidden; the global exit
  // action (Escape, hardware back) belongs only to the pane the user is in.
  const { isActiveComposer } = useComposerKeyboardScope();
  const exitScopeRef = useComposerFullscreenExit(fullscreen && isActiveComposer, onExit);
  const railOffset = resolveGlyphRailOffset({
    controlSize: CONTROL_SIZE,
    sendIconSize,
    glyphIconSize: FULLSCREEN_GLYPH_SIZE,
  });
  const maximizeIcon = useCallback(
    (color: string) => <Maximize2 color={color} size={FULLSCREEN_GLYPH_SIZE} />,
    [],
  );
  const minimizeIcon = useCallback(
    (color: string) => <Minimize2 color={color} size={FULLSCREEN_GLYPH_SIZE} />,
    [],
  );
  // The toolbar row bleeds 6px past the input padding; the inline glyph sits on that edge.
  const enterStyle = useMemo(() => [styles.enterButton, { right: -6 + railOffset }], [railOffset]);
  const exitStyle = useMemo(() => [styles.iconButton, { marginRight: railOffset }], [railOffset]);
  return (
    <View
      ref={exitScopeRef}
      style={fullscreen ? styles.fullscreen : styles.inline}
      testID={fullscreen ? "composer-fullscreen" : undefined}
    >
      {fullscreen ? (
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
      ) : null}
      <ComposerFullscreenBody fullscreen={fullscreen}>
        <View
          ref={inputWrapperRef}
          style={fullscreen ? styles.fullscreenInputWrapper : inputWrapperStyle}
          pointerEvents={inputPointerEvents}
        >
          {fullscreen ? null : attachmentSlot}
          <View style={fullscreen ? styles.fullscreenTextSurface : styles.inlineTextSurface}>
            {surface}
            {showFullscreenButton && !fullscreen ? (
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
          {fullscreen ? null : toolbar}
        </View>
      </ComposerFullscreenBody>
      {fullscreen ? (
        <ComposerFullscreenFooter style={styles.footer}>
          {error}
          <View style={styles.sendRow}>{send}</View>
        </ComposerFullscreenFooter>
      ) : null}
      {overlay}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  inline: { flexShrink: 1, position: "relative" },
  inlineTextSurface: { flexShrink: 1, position: "relative" },
  iconButton: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    padding: 0,
    borderWidth: 0,
    borderRadius: theme.borderRadius.full,
  },
  enterButton: {
    position: "absolute",
    top: 0,
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
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
  fullscreenInputWrapper: { flex: 1, minHeight: 0 },
  fullscreenTextSurface: { flex: 1, minHeight: 0 },
  exitRow: { alignItems: "flex-end", flexShrink: 0 },
  // The send error rides the keyboard with Send; below the body it would sit behind it.
  footer: { flexShrink: 0, gap: theme.spacing[3] },
  sendRow: { alignItems: "flex-end" },
}));
