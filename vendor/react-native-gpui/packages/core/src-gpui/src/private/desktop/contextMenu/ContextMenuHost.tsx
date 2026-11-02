/**
 * The host that renders a custom context menu inside a window.
 *
 * One host is mounted per window (the desktop wrapper does that around each
 * root), and it draws into an RN `Modal` so the menu stacks above an open modal
 * and lives in window coordinates. Everything visual comes from `MenuSurface`
 * and `MenuRow`; this file owns the state a menu needs: which menu is open, the
 * highlight, the submenu chain, dismissal and keyboard navigation.
 *
 * The menu cannot extend past the window, so it is measured once at zero opacity
 * and then placed by `placement.ts` against the window size the portal reports.
 * `Dimensions` is deliberately not used: it only knows the main window, so a
 * secondary window would place its menu against the wrong rectangle.
 *
 * @format
 */

import React from 'react';
import {
  AccessibilityInfo,
  Modal,
  StyleSheet,
  View,
  findNodeHandle,
  useColorScheme,
} from 'react-native';
import type {
  KeyDownEvent,
  LayoutChangeEvent,
  PointerEvent,
} from 'react-native';
import { platform } from '../index';
import { useDesktopWindowId } from '../windowContext';
import { DesktopWindow } from '../windows';
import { MenuSurface } from './MenuSurface';
import { contextMenuConfig, subscribeContextMenuConfig } from './config';
import type { MenuRenderers } from './config';
import { EMPTY_NAVIGATION, navigate, type NavigationState } from './navigation';
import type { MenuEntry } from './types';
import { entryId, isEnabled, isSubmenu, submenuItems } from './types';
import { placeLevels, type MenuLevel } from './levels';
import { measurableSize, type Point, type Size } from './placement';
import {
  isInSafeTriangle,
  safeTriangleFor,
  type SafeTriangle,
} from './safeTriangle';
import {
  registerContextMenuHost,
  type ContextMenuHandle,
  type OpenCustomMenuOptions,
} from './registry';
import { themeForScheme, type MenuTheme } from './theme';

/** How long the pointer must rest on a submenu row before it opens. */
export const SUBMENU_HOVER_DELAY_MS = 200;

/**
 * How far the pointer must travel after a menu opens before a secondary-button
 * release counts as "drag onto a row" rather than the tail of the click that
 * opened the menu. Without it a plain right click would open the menu and then
 * release over its first row, choosing an item the user never picked.
 */
const DRAG_THRESHOLD = 6;

/**
 * How long that guard stays armed. The release normally follows within a frame
 * or two, so a short window is enough, and it keeps a menu opened from the
 * keyboard from swallowing the first right click that comes much later.
 */
const OPEN_RELEASE_WINDOW_MS = 400;

/**
 * Two handlers can see one Escape: the focused panel's key handler and the
 * modal's `onRequestClose`. Closing twice would dismiss the menu when the user
 * only meant to leave a submenu, so the second one inside this window is ignored.
 */
const CLOSE_DEDUPE_MS = 50;

interface Session {
  options: OpenCustomMenuOptions;
  resolve: (id: string | null) => void;
}

function initialLevel(items: MenuEntry[]): MenuLevel {
  return {
    items,
    highlightedIndex: -1,
    size: null,
    rows: {},
    parentIndex: 0,
    openedAt: null,
  };
}

function pointerOf(event: PointerEvent): Point {
  return { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
}

/**
 * The theme the host draws with: the built-in one for the platform's colour
 * scheme, with the app's overrides applied. The config is a module-level store
 * rather than a provider, so a host in a second window sees the same overrides.
 */
/** The app's replaced building blocks, read the same way the theme is. */
function useMenuRenderers(): MenuRenderers {
  const config = React.useSyncExternalStore(
    subscribeContextMenuConfig,
    contextMenuConfig,
    contextMenuConfig,
  );
  return config.renderers ?? {};
}

function useMenuTheme(): MenuTheme {
  const scheme = useColorScheme();
  const config = React.useSyncExternalStore(
    subscribeContextMenuConfig,
    contextMenuConfig,
    contextMenuConfig,
  );
  return React.useMemo(
    () => themeForScheme(scheme, config.theme),
    [scheme, config.theme],
  );
}

/**
 * The window's context menu host.
 *
 * It registers itself under its window id, so `ContextMenu.show` reaches it
 * through `registry.ts`. Only `open` and `close` are exposed there; everything
 * else is internal state, which is what keeps the seam small enough to rewire.
 */
export function ContextMenuHost() {
  const windowId = useDesktopWindowId();
  const theme = useMenuTheme();
  const renderers = useMenuRenderers();
  const Surface = renderers.Surface ?? MenuSurface;

  const [session, setSession] = React.useState<Session | null>(null);
  const [levels, setLevels] = React.useState<MenuLevel[]>([]);
  const [windowSize, setWindowSize] = React.useState<Size | null>(null);
  const [anchor, setAnchor] = React.useState<Point | null>(null);

  const sessionRef = React.useRef<Session | null>(null);
  const levelsRef = React.useRef<MenuLevel[]>(levels);

  // The callbacks below run from events, which are dispatched after the commit,
  // so the refs are brought up to date in effects rather than during render: a
  // render React abandons must not leave them holding uncommitted state.
  React.useEffect(() => {
    levelsRef.current = levels;
  }, [levels]);

  const pointerRef = React.useRef<Point | null>(null);
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // The release that completes the right click which opened the menu arrives
  // after the backdrop has mounted. It is not a new gesture, so it is swallowed;
  // otherwise the menu would dismiss and immediately re-open under the pointer.
  // The window and the point together are what tell it apart from a real click.
  const swallowReleaseRef = React.useRef<{
    until: number;
    point: Point | null;
  }>({
    until: 0,
    point: null,
  });
  const lastCloseAtRef = React.useRef(0);
  const navigationRef = React.useRef<NavigationState>(EMPTY_NAVIGATION);
  const panelRefs = React.useRef<Array<React.ElementRef<typeof View> | null>>(
    [],
  );

  const placements = React.useMemo(
    () => placeLevels(levels, anchor, windowSize),
    [levels, anchor, windowSize],
  );
  const placementsRef = React.useRef(placements);
  React.useEffect(() => {
    placementsRef.current = placements;
  }, [placements]);

  const clearHoverTimer = React.useCallback(() => {
    if (hoverTimerRef.current != null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const restoreFocus = React.useCallback(() => {
    sessionRef.current?.options.restoreFocus?.();
  }, []);

  const resolveSession = React.useCallback(
    (value: string | null) => {
      const current = sessionRef.current;
      sessionRef.current = null;
      setSession(null);
      setLevels([]);
      setAnchor(null);
      clearHoverTimer();
      navigationRef.current = EMPTY_NAVIGATION;
      current?.resolve(value);
    },
    [clearHoverTimer],
  );

  const dismiss = React.useCallback(() => {
    restoreFocus();
    resolveSession(null);
  }, [resolveSession, restoreFocus]);

  /**
   * Closes one level: the deepest submenu, or the menu itself at the root. This
   * is both the Escape and the Left-arrow behaviour, and what a native menu does.
   */
  const closeOneLevel = React.useCallback(() => {
    const now = Date.now();
    if (now - lastCloseAtRef.current < CLOSE_DEDUPE_MS) {
      return;
    }
    lastCloseAtRef.current = now;
    clearHoverTimer();
    const current = levelsRef.current;
    if (current.length <= 1) {
      dismiss();
      return;
    }
    const parentIndex = current[current.length - 1].parentIndex;
    const next = current.slice(0, -1);
    next[next.length - 1] = {
      ...next[next.length - 1],
      highlightedIndex: parentIndex,
    };
    setLevels(next);
  }, [clearHoverTimer, dismiss]);

  const open = React.useCallback(
    (options: OpenCustomMenuOptions): Promise<string | null> => {
      if (options.presentation === 'native') {
        // The native presentation never comes through this host; refusing here
        // keeps a wiring mistake visible instead of drawing a menu nobody asked
        // for.
        return Promise.resolve(null);
      }
      return new Promise<string | null>(resolve => {
        // One menu at a time: opening a new one replaces the open one, and the
        // replaced session resolves with `null` so its caller does not hang.
        sessionRef.current?.resolve(null);
        clearHoverTimer();
        navigationRef.current = EMPTY_NAVIGATION;
        swallowReleaseRef.current = {
          until: Date.now() + OPEN_RELEASE_WINDOW_MS,
          point: options.position ?? pointerRef.current ?? null,
        };
        const next: Session = { options, resolve };
        sessionRef.current = next;
        setSession(next);
        setLevels([initialLevel(options.items)]);
        setAnchor(options.position ?? pointerRef.current ?? { x: 0, y: 0 });
      });
    },
    [clearHoverTimer],
  );

  // A host can unmount with a menu open (a window closing, a reload), and an
  // unresolved promise would keep its caller waiting for a menu that is gone.
  React.useEffect(
    () => () => {
      const current = sessionRef.current;
      sessionRef.current = null;
      current?.resolve(null);
    },
    [],
  );

  // The registry is the seam `ContextMenu.show` uses: it looks the host up by
  // window id, so a show call from one window's JS reaches that window's menu.
  const handle = React.useMemo<ContextMenuHandle>(
    () => ({ open, close: dismiss }),
    [open, dismiss],
  );
  React.useEffect(
    () => registerContextMenuHost(windowId, handle),
    [windowId, handle],
  );

  // A menu is a transient overlay: losing the window's focus, or resizing it,
  // leaves the placement stale, so both dismiss it.
  React.useEffect(() => {
    if (session == null) {
      return undefined;
    }
    const window = new DesktopWindow(windowId);
    const blur = window.addListener('blur', () => dismiss());
    const resize = window.addListener('resize', () => dismiss());
    return () => {
      blur.remove();
      resize.remove();
    };
  }, [session, windowId, dismiss]);

  const highlight = React.useCallback(
    (levelIndex: number, rowIndex: number) => {
      setLevels(current =>
        current.map((level, index) =>
          index === levelIndex && level.highlightedIndex !== rowIndex
            ? { ...level, highlightedIndex: rowIndex }
            : level,
        ),
      );
    },
    [],
  );

  const choose = React.useCallback(
    (entry: MenuEntry) => {
      if (!isEnabled(entry)) {
        return;
      }
      // A role item resolves with its role name, which is how the integrator can
      // run the same action the native presenters run; a submenu never resolves
      // on its own.
      const id = isSubmenu(entry) ? null : entryId(entry);
      restoreFocus();
      resolveSession(id);
    },
    [resolveSession, restoreFocus],
  );

  const openSubmenu = React.useCallback(
    (levelIndex: number, rowIndex: number, pointer: Point | null) => {
      const level = levelsRef.current[levelIndex];
      const entry = level?.items[rowIndex];
      if (entry == null || !isEnabled(entry)) {
        return;
      }
      const items = submenuItems(entry);
      if (items == null) {
        return;
      }
      clearHoverTimer();
      setLevels(current => {
        if (current[levelIndex] == null) {
          return current;
        }
        const next = current.slice(0, levelIndex + 1);
        next[levelIndex] = { ...next[levelIndex], highlightedIndex: rowIndex };
        // Re-opening the same submenu must not throw its measurement away, or
        // its rows jump on the next frame.
        const existing = next[levelIndex + 1];
        if (
          existing != null &&
          existing.parentIndex === rowIndex &&
          existing.items === items
        ) {
          return next;
        }
        next.push({
          ...initialLevel(items),
          parentIndex: rowIndex,
          openedAt: pointer,
        });
        return next;
      });
    },
    [clearHoverTimer],
  );

  /** The safe triangle of the deepest level, once it has been placed. */
  const deepestTriangle = React.useCallback((): SafeTriangle | null => {
    const current = levelsRef.current;
    const index = current.length - 1;
    const deepest = current[index];
    const placement = placementsRef.current[index];
    if (
      deepest == null ||
      deepest.openedAt == null ||
      deepest.size == null ||
      placement == null ||
      placement.side == null
    ) {
      return null;
    }
    return safeTriangleFor(
      deepest.openedAt,
      {
        ...placement.point,
        width: deepest.size.width,
        height: deepest.size.height,
      },
      placement.side,
    );
  }, []);

  const handleRowHover = React.useCallback(
    (levelIndex: number, rowIndex: number, pointer: Point) => {
      pointerRef.current = pointer;
      const current = levelsRef.current;
      const level = current[levelIndex];
      const entry = level?.items[rowIndex];
      if (entry == null || !isEnabled(entry)) {
        return;
      }
      clearHoverTimer();
      if (current.length > levelIndex + 1) {
        // The pointer may cross a sibling row on its way to an open submenu.
        // Staying inside the triangle keeps that submenu open; leaving it closes
        // the deeper levels and treats the row under the pointer normally, which
        // includes arming the hover timer if that row has a submenu of its own.
        const triangle = deepestTriangle();
        if (triangle != null && isInSafeTriangle(pointer, triangle)) {
          return;
        }
        setLevels(values => {
          const next = values.slice(0, levelIndex + 1);
          next[levelIndex] = {
            ...next[levelIndex],
            highlightedIndex: rowIndex,
          };
          return next;
        });
      } else {
        highlight(levelIndex, rowIndex);
      }
      if (isSubmenu(entry)) {
        hoverTimerRef.current = setTimeout(() => {
          hoverTimerRef.current = null;
          openSubmenu(levelIndex, rowIndex, pointerRef.current);
        }, SUBMENU_HOVER_DELAY_MS);
      }
    },
    [clearHoverTimer, deepestTriangle, highlight, openSubmenu],
  );

  /**
   * Whether a secondary release is the tail of the click that opened the menu:
   * inside the guard window and close to where the menu opened. A drag away from
   * the anchor is a deliberate gesture even inside the window.
   */
  const isOpeningRelease = React.useCallback((point: Point): boolean => {
    const guard = swallowReleaseRef.current;
    if (Date.now() > guard.until) {
      return false;
    }
    const origin = guard.point;
    return (
      origin == null ||
      (Math.abs(point.x - origin.x) <= DRAG_THRESHOLD &&
        Math.abs(point.y - origin.y) <= DRAG_THRESHOLD)
    );
  }, []);

  const handleRowPress = React.useCallback(
    (levelIndex: number, rowIndex: number, point?: Point) => {
      const entry = levelsRef.current[levelIndex]?.items[rowIndex];
      if (entry == null) {
        return;
      }
      if (point != null && isOpeningRelease(point)) {
        // The release that ended the right click which opened the menu, still
        // over the same spot: not a deliberate choice.
        return;
      }
      if (isSubmenu(entry)) {
        openSubmenu(levelIndex, rowIndex, pointerRef.current);
        return;
      }
      choose(entry);
    },
    [choose, isOpeningRelease, openSubmenu],
  );

  const handleRowLayout = React.useCallback(
    (levelIndex: number, rowIndex: number, event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      setLevels(current =>
        current.map((level, index) => {
          if (index !== levelIndex) {
            return level;
          }
          const previous = level.rows[rowIndex];
          if (
            previous != null &&
            previous.y === y &&
            previous.height === height
          ) {
            return level;
          }
          return {
            ...level,
            rows: { ...level.rows, [rowIndex]: { y, height } },
          };
        }),
      );
    },
    [],
  );

  const handleLevelLayout = React.useCallback(
    (levelIndex: number, event: LayoutChangeEvent) => {
      const size = measurableSize(event.nativeEvent.layout);
      if (size == null) {
        return;
      }
      setLevels(current =>
        current.map((level, index) =>
          index === levelIndex &&
          (level.size == null ||
            level.size.width !== size.width ||
            level.size.height !== size.height)
            ? { ...level, size }
            : level,
        ),
      );
    },
    [],
  );

  const focusLevel = React.useCallback((depth: number) => {
    const panel = panelRefs.current[depth];
    if (panel == null) {
      return;
    }
    // The desktop bridge focuses a plain view the way a screen reader would:
    // `TextInput` is the only component with a `focus()` command, so a menu
    // panel has to take focus through accessibility focus.
    const tag = findNodeHandle(panel);
    if (tag != null) {
      AccessibilityInfo.setAccessibilityFocus(tag);
    }
  }, []);

  React.useEffect(() => {
    if (session == null || levels.length === 0) {
      return;
    }
    // The deepest panel takes focus, so keys reach the level on screen.
    focusLevel(levels.length - 1);
  }, [session, levels.length, focusLevel]);

  const handleKeyDown = React.useCallback(
    (event: KeyDownEvent) => {
      const native = event.nativeEvent;
      const current = levelsRef.current;
      const level = current[current.length - 1];
      if (level == null) {
        return;
      }
      const depth = current.length - 1;
      // Escape is left to the modal's `onRequestClose`, which is the path the
      // desktop shell sends it on; handling it here as well would close two
      // levels for one keystroke.
      if (native.key.toLowerCase() === 'escape') {
        return;
      }
      const result = navigate({
        items: level.items,
        key: native.key,
        state: {
          ...navigationRef.current,
          // The reducer only knows the index it was last given; the render is
          // the source of truth, so it wins on entry.
          index: level.highlightedIndex,
        },
        now: Date.now(),
        modifiers: {
          alt: native.altKey,
          ctrl: native.ctrlKey,
          meta: native.metaKey,
        },
      });
      navigationRef.current = result.state;
      switch (result.action) {
        case 'closeLevel':
          closeOneLevel();
          return;
        case 'openSubmenu':
          openSubmenu(depth, result.state.index, pointerRef.current);
          return;
        case 'activate': {
          const entry = level.items[result.state.index];
          if (entry != null) {
            choose(entry);
          }
          return;
        }
        default:
          break;
      }
      if (result.state.index !== level.highlightedIndex) {
        highlight(depth, result.state.index);
      }
    },
    [choose, closeOneLevel, highlight, openSubmenu],
  );

  const handleBackdropRelease = React.useCallback(
    (point: Point, button: number) => {
      const isRight = button !== 0;
      if (isRight && isOpeningRelease(point)) {
        return;
      }
      const reopen = sessionRef.current?.options.onBackdropContextMenu;
      if (isRight && reopen != null) {
        // Right-clicking elsewhere moves the menu, as native menus do. Only the
        // caller can decide which menu belongs at that point; without the
        // callback the click simply dismisses.
        resolveSession(null);
        reopen(point);
        return;
      }
      dismiss();
    },
    [dismiss, isOpeningRelease, resolveSession],
  );

  if (session == null || levels.length === 0) {
    return null;
  }

  return (
    <Modal
      transparent
      visible
      animationType="none"
      onRequestClose={closeOneLevel}
    >
      {/*
        The portal's content is modal: it hides the rest of the tree from
        assistive technology while the menu is open, which is what the modal role
        means here. It is set once, on the root, rather than on every level.
      */}
      <View
        style={styles.root}
        aria-modal
        onLayout={event =>
          setWindowSize(measurableSize(event.nativeEvent.layout))
        }
        onPointerMove={event => {
          pointerRef.current = pointerOf(event);
        }}
      >
        <View
          testID="context-menu-backdrop"
          style={StyleSheet.absoluteFill}
          onPointerUp={event =>
            handleBackdropRelease(pointerOf(event), event.nativeEvent.button)
          }
        />
        {levels.map((level, index) => {
          const placement = placements[index];
          const isDeepest = index === levels.length - 1;
          return (
            <Surface
              key={`level-${index}`}
              items={level.items}
              highlightedIndex={level.highlightedIndex}
              theme={theme}
              platform={platform() ?? 'macos'}
              focusable={isDeepest}
              panelRef={element => {
                panelRefs.current[index] = element;
              }}
              onKeyDown={isDeepest ? handleKeyDown : undefined}
              onLayout={event => handleLevelLayout(index, event)}
              // The left and top come from placement; the opacity hides the
              // measuring pass, which exists only to learn the panel's size and
              // would otherwise flash at the top-left corner.
              style={[
                { left: placement?.point.x ?? 0, top: placement?.point.y ?? 0 },
                placement == null ? styles.measuring : null,
              ]}
              onRowLayout={(rowIndex, event) =>
                handleRowLayout(index, rowIndex, event)
              }
              onRowHover={(rowIndex, point) =>
                handleRowHover(index, rowIndex, point)
              }
              onRowPress={(rowIndex, point) =>
                handleRowPress(index, rowIndex, point)
              }
              // Replacements only draw: hover, press, keys and placement stay
              // here, so a themed row cannot break the menu's behaviour.
              renderRow={renderers.Row}
              renderSeparator={renderers.Separator}
            />
          );
        })}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  measuring: {
    opacity: 0,
  },
});
