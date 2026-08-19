import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Minus, Square, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { getIsElectronRuntime, getIsElectronRuntimeMac } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import {
  closeDesktopWindow,
  getDesktopWindow,
  isDesktopWindowMaximized,
  minimizeDesktopWindow,
  toggleDesktopMaximize,
} from "@/desktop/electron/window";

/**
 * Minimise / maximise / close drawn by the app instead of by Chromium's Window Controls
 * Overlay, so they sit in the header's own flex row and share its button metrics.
 *
 * Renders nothing on macOS, where the OS draws traffic lights in the top-left, and nothing
 * outside Electron. The surface that owns the window's top-right corner mounts this exactly
 * once — see useOwnsWindowChromeCorner in @/utils/desktop-window.
 */

const ThemedMinus = withUnistyles(Minus);
const ThemedSquare = withUnistyles(Square);
const ThemedX = withUnistyles(X);

const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColor = (theme: Theme) => ({ color: theme.colors.foreground });

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const enabled = !isNative && getIsElectronRuntime() && !getIsElectronRuntimeMac();

  useEffect(() => {
    if (!enabled) return;
    let active = true;

    async function sync() {
      const next = await isDesktopWindowMaximized();
      if (active) setMaximized(next);
    }

    void sync();

    // The main process already emits a resize event on maximize/unmaximize, so reuse it
    // rather than adding a second channel just for the glyph.
    const win = getDesktopWindow();
    if (!win || typeof win.onResized !== "function") return;
    const subscribe = win.onResized;
    let dispose: (() => void) | undefined;
    void (async () => {
      const next = await subscribe(() => void sync());
      if (!active) {
        next();
        return;
      }
      dispose = next;
    })();

    return () => {
      active = false;
      dispose?.();
    };
  }, [enabled]);

  const handleMinimize = useCallback(() => void minimizeDesktopWindow(), []);
  const handleMaximize = useCallback(() => void toggleDesktopMaximize(), []);
  const handleClose = useCallback(() => void closeDesktopWindow(), []);

  if (!enabled) return null;

  return (
    <View style={styles.row}>
      <Pressable
        onPress={handleMinimize}
        style={styles.button}
        testID="window-control-minimize"
        accessible
        accessibilityRole="button"
        accessibilityLabel="Minimize"
      >
        {({ hovered }) => (
          <View style={[styles.surface, hovered && styles.surfaceHovered]}>
            <ThemedMinus size={16} uniProps={hovered ? foregroundColor : mutedColor} />
          </View>
        )}
      </Pressable>

      <Pressable
        onPress={handleMaximize}
        style={styles.button}
        testID="window-control-maximize"
        accessible
        accessibilityRole="button"
        accessibilityLabel={maximized ? "Restore" : "Maximize"}
      >
        {({ hovered }) => (
          <View style={[styles.surface, hovered && styles.surfaceHovered]}>
            <ThemedSquare
              size={maximized ? 12 : 14}
              uniProps={hovered ? foregroundColor : mutedColor}
            />
          </View>
        )}
      </Pressable>

      <Pressable
        onPress={handleClose}
        style={styles.button}
        testID="window-control-close"
        accessible
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        {({ hovered }) => (
          <View style={[styles.closeSurface, hovered && styles.closeSurfaceHovered]}>
            <ThemedX size={16} uniProps={hovered ? closeGlyphColor : mutedColor} />
          </View>
        )}
      </Pressable>
    </View>
  );
}

// Windows paints the close button's glyph white on its red hover fill.
const closeGlyphColor = () => ({ color: "#ffffff" });

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    // Interactive controls have to be subtracted from the titlebar drag region, or Electron
    // turns their clicks into window drags.
    WebkitAppRegion: "no-drag",
  },
  button: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  // Hover paints a surface behind the glyph and recolours the glyph from the same palette,
  // so the two always contrast. Recolouring the glyph alone leaves its legibility at the
  // mercy of whatever paints the header, which is how the hovered glyph went invisible.
  surface: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  surfaceHovered: {
    backgroundColor: theme.colors.surface2,
  },
  closeSurface: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  closeSurfaceHovered: {
    backgroundColor: "#c42b1c",
  },
}));
