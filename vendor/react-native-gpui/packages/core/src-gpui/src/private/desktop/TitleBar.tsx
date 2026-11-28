/**
 * A small custom title bar so apps do not rebuild one.
 *
 * The bar is a drag region: pressing it moves the window and a double click
 * zooms (or minimizes, per the user's macOS setting). On macOS the traffic
 * lights stay visible above a transparent title bar, so the bar leaves room for
 * them; elsewhere it draws its own caption buttons, but only where the window
 * really is frameless — a Linux compositor can refuse the request and leave the
 * window manager's own title bar in place, and a second set of buttons beside it
 * would be a bug.
 *
 * The caption buttons follow the Windows ones: 46 points wide, the full height
 * of the bar, flush with its right edge, a subtle fill on hover and red behind
 * the close button. Their glyphs are drawn rather than typed, so they do not
 * depend on an icon font being installed.
 *
 * @format
 */

import React from 'react';
import {
  Image,
  Platform,
  StyleSheet,
  Text,
  View,
  processColor,
  useColorScheme,
} from 'react-native';
import type { ColorValue, StyleProp, ViewStyle } from 'react-native';
import {
  capabilities,
  useClientDecorations,
  windowButtonIcon,
  windowButtonLayout,
} from './index';
import { Menu, useMenuBarVisible } from './menu';
import { WindowControl } from './WindowControl';
import type { WindowControlAction, WindowControlState } from './WindowControl';

export interface TitleBarProps {
  title?: string;
  trafficLightInset?: number;
  showCaptionButtons?: boolean;
  /**
   * Whether the bar is light or dark, which decides the color of the title and
   * the caption glyphs. Defaults to whichever contrasts with the bar's own
   * `backgroundColor`, or to the system appearance when the bar has none.
   */
  appearance?: 'light' | 'dark';
  /**
   * Whether to keep a row under the bar for the window's menu bar, where the
   * menu bar is drawn in the window (Linux). Defaults to `true`; without the
   * row the menu bar is a strip above the whole window, title bar included.
   * Hide the menu bar itself with `window.menuBar` in `desktop.json` or
   * `Menu.setMenuBarVisible`.
   */
  menuBar?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

const CAPTION_ACTIONS: WindowControlAction[] = [
  'minimize',
  'maximize',
  'close',
];

/**
 * The buttons a GTK `button-layout` puts on each side of the bar, in order.
 * Names that are not caption buttons (`appmenu`, `menu`, `icon`) are skipped.
 */
export function parseButtonLayout(layout: string): {
  left: WindowControlAction[];
  right: WindowControlAction[];
} {
  const side = (names: string) =>
    names
      .split(',')
      .map(name => name.trim())
      .filter((name): name is WindowControlAction =>
        CAPTION_ACTIONS.includes(name as WindowControlAction),
      );
  const [left = '', right = ''] = layout.includes(':')
    ? layout.split(':')
    : ['', layout];
  return { left: side(left), right: side(right) };
}

/** The colors of one appearance, as Windows draws its own caption buttons. */
const PALETTE = {
  light: {
    foreground: '#000000',
    hover: 'rgba(0, 0, 0, 0.1)',
    pressed: 'rgba(0, 0, 0, 0.2)',
  },
  dark: {
    foreground: '#ffffff',
    hover: 'rgba(255, 255, 255, 0.1)',
    pressed: 'rgba(255, 255, 255, 0.2)',
  },
};
const CLOSE_HOVER = '#e81123';
const CLOSE_PRESSED = '#f1707a';
const CLOSE_FOREGROUND = '#ffffff';

/**
 * Light or dark, from a background color: `null` when there is no opaque color
 * to judge, so the caller can fall back to the system appearance.
 */
function appearanceOf(color: ColorValue | undefined): 'light' | 'dark' | null {
  if (color == null) return null;
  const processed = processColor(color);
  if (typeof processed !== 'number') return null;
  const alpha = (processed >>> 24) & 0xff;
  if (alpha < 0x80) return null;
  const red = (processed >>> 16) & 0xff;
  const green = (processed >>> 8) & 0xff;
  const blue = processed & 0xff;
  // Relative luminance, close enough to decide which side of the middle a
  // color is on.
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance < 0.5 ? 'dark' : 'light';
}

export function TitleBar({
  title,
  trafficLightInset,
  showCaptionButtons,
  appearance,
  menuBar,
  style,
  children,
}: TitleBarProps) {
  const systemScheme = useColorScheme();
  // `Platform.OS` is the host, reported by the desktop module, so it needs no
  // fallback: it is `macos`, `windows` or `linux` on a desktop build.
  const isMac = Platform.OS === 'macos';
  const isLinux = !isMac && Platform.OS !== 'windows';
  // A window that kept its native title bar already has buttons, so drawing a
  // second set would only ever be wrong. `clientDecorations` is the capability
  // that says whether the window is really frameless, which on Linux depends on
  // what the compositor granted.
  const frameless = useClientDecorations();
  // The compositor draws the frame (Linux with server-side decorations): its bar
  // already has the title and the buttons, so only the app's own controls stay,
  // as a toolbar row.
  const nativeFrame = isLinux && !frameless;
  const inset = trafficLightInset ?? (isMac ? 78 : 0);
  const captionButtons = showCaptionButtons ?? (frameless && !isMac);
  const resolved =
    appearance ??
    appearanceOf(StyleSheet.flatten(style)?.backgroundColor) ??
    (systemScheme === 'dark' ? 'dark' : 'light');
  const palette = PALETTE[resolved];
  const menuBarVisible = useMenuBarVisible();
  const menuSlot =
    menuBar !== false && capabilities().menuBarInWindow && menuBarVisible;
  const slotRef = React.useRef<React.ElementRef<typeof View>>(null);
  const measureSlot = React.useCallback(() => {
    slotRef.current?.measureInWindow((x, y, width, height) => {
      Menu.setMenuBarSlot(
        { x, y, width, height },
        {
          foreground: processColor(palette.foreground) as number,
          hover: processColor(palette.hover) as number,
        },
      ).catch(() => {});
    });
  }, [palette.foreground, palette.hover]);
  React.useEffect(() => {
    if (!menuSlot) {
      return undefined;
    }
    measureSlot();
    return () => {
      Menu.clearMenuBarSlot().catch(() => {});
    };
  }, [menuSlot, measureSlot]);
  const buttons = React.useMemo(
    () =>
      isLinux
        ? parseButtonLayout(windowButtonLayout())
        : { left: [], right: CAPTION_ACTIONS },
    [isLinux],
  );
  const renderButtons = (actions: WindowControlAction[]) => (
    <View
      style={[styles.captionButtons, isLinux && styles.captionButtonsLinux]}
    >
      {actions.map(action => (
        <WindowControl
          key={action}
          action={action}
          testID={`titlebar-${action}`}
          style={({ hovered, pressed }) => [
            styles.captionButton,
            isLinux && styles.captionButtonLinux,
            hovered && {
              backgroundColor:
                action === 'close' && !isLinux ? CLOSE_HOVER : palette.hover,
            },
            pressed && {
              backgroundColor:
                action === 'close' && !isLinux
                  ? CLOSE_PRESSED
                  : palette.pressed,
            },
          ]}
        >
          {state => (
            <CaptionGlyph
              action={action}
              state={state}
              color={
                action === 'close' &&
                !isLinux &&
                (state.hovered || state.pressed)
                  ? CLOSE_FOREGROUND
                  : palette.foreground
              }
            />
          )}
        </WindowControl>
      ))}
    </View>
  );
  return (
    <>
      {nativeFrame && React.Children.toArray(children).length === 0 ? null : (
        <View
          desktopDragRegion={!nativeFrame}
          style={[
            styles.bar,
            { paddingLeft: inset },
            captionButtons &&
              (isLinux
                ? styles.barWithRoundCaptionButtons
                : styles.barWithCaptionButtons),
            captionButtons && buttons.left.length > 0 && styles.barLeftButtons,
            style,
          ]}
        >
          {captionButtons && buttons.left.length > 0
            ? renderButtons(buttons.left)
            : null}
          {title != null && !nativeFrame ? (
            <Text
              numberOfLines={1}
              style={[styles.title, { color: palette.foreground }]}
            >
              {title}
            </Text>
          ) : null}
          <View style={styles.spacer} pointerEvents="box-none">
            {children}
          </View>
          {captionButtons && buttons.right.length > 0
            ? renderButtons(buttons.right)
            : null}
        </View>
      )}
      {menuSlot ? (
        <View
          ref={slotRef}
          pointerEvents="none"
          onLayout={measureSlot}
          style={[
            styles.menuSlot,
            { backgroundColor: StyleSheet.flatten(style)?.backgroundColor },
          ]}
        />
      ) : null}
    </>
  );
}

/**
 * Windows' own caption glyphs, from the icon font every Windows 10 and 11
 * install ships, so the buttons look exactly like the system's.
 */
const WINDOWS_GLYPHS = {
  minimize: '',
  maximize: '',
  restore: '',
  close: '',
};

/**
 * The 10-point glyph Windows draws in a caption button: a dash, a square (or two
 * overlapping squares while maximized), or a cross.
 *
 * Elsewhere the dash and the squares are drawn, and the cross is a character:
 * drawing it would need rotated strokes, and node transforms do not rotate.
 */
function CaptionGlyph({
  action,
  state,
  color,
}: {
  action: WindowControlAction;
  state: WindowControlState;
  color: string;
}) {
  if (Platform.OS === 'windows') {
    const glyph =
      action === 'maximize' && state.maximized
        ? WINDOWS_GLYPHS.restore
        : WINDOWS_GLYPHS[action];
    return <Text style={[styles.windowsGlyph, { color }]}>{glyph}</Text>;
  }
  if (Platform.OS !== 'macos') {
    const uri = windowButtonIcon(
      action === 'maximize' && state.maximized ? 'restore' : action,
      color,
    );
    if (uri != null) {
      return <Image source={{ uri }} style={styles.themeIcon} />;
    }
  }
  if (action === 'minimize') {
    return (
      <View style={styles.glyph}>
        <View style={[styles.dash, { backgroundColor: color }]} />
      </View>
    );
  }
  if (action === 'maximize') {
    if (state.maximized) {
      return (
        <View style={styles.glyph}>
          <View style={[styles.restoreBack, { borderColor: color }]} />
          <View style={[styles.restoreFront, { borderColor: color }]} />
        </View>
      );
    }
    return (
      <View style={styles.glyph}>
        <View style={[styles.square, { borderColor: color }]} />
      </View>
    );
  }
  return <Text style={[styles.cross, { color }]}>{'✕'}</Text>;
}

const GLYPH = 10;

const styles = StyleSheet.create({
  menuSlot: {
    height: 26,
  },
  bar: {
    height: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 8,
    backgroundColor: 'transparent',
  },
  // The caption buttons sit flush with the window's right edge.
  barWithCaptionButtons: {
    paddingRight: 0,
  },
  // Linux draws the buttons compact and round, inset from the window edge.
  barWithRoundCaptionButtons: {
    paddingRight: 8,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
  },
  spacer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  captionButtons: {
    flexDirection: 'row',
    alignSelf: 'stretch',
  },
  barLeftButtons: {
    paddingLeft: 8,
  },
  captionButtonsLinux: {
    alignSelf: 'center',
    gap: 6,
  },
  captionButtonLinux: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  captionButton: {
    width: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeIcon: {
    width: 16,
    height: 16,
  },
  glyph: {
    width: GLYPH,
    height: GLYPH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dash: {
    width: GLYPH,
    height: 1,
  },
  square: {
    width: GLYPH,
    height: GLYPH,
    borderWidth: 1,
  },
  restoreBack: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: GLYPH - 2,
    height: GLYPH - 2,
    borderTopWidth: 1,
    borderRightWidth: 1,
  },
  restoreFront: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    width: GLYPH - 2,
    height: GLYPH - 2,
    borderWidth: 1,
  },
  cross: {
    fontSize: 12,
    lineHeight: 12,
  },
  windowsGlyph: {
    fontFamily: 'Segoe MDL2 Assets',
    fontSize: GLYPH,
    lineHeight: GLYPH,
  },
});
