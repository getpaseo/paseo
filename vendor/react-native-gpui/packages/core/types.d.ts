/**
 * Type additions for the desktop-shell View props.
 *
 * `desktopDragRegion` and `onContextMenu` are parsed by `HostPlatformViewProps`
 * and listed in the GPUI `BaseViewConfig`, so Fabric carries them to the
 * renderer. React Native's own `ViewProps` does not know them, so they are
 * declared here.
 *
 * Caption buttons are not a View prop. A `WindowControl` component carries its own
 * hover and pressed state and its own native action, so it does not need a field
 * on every view.
 *
 * This file is published and referenced by `react-native-gpui-env.d.ts`, which
 * the CLI writes into an app's root. A module augmentation only applies when the
 * file is part of the compilation, so referencing it from the app's tsconfig
 * include set is what makes the props visible everywhere — an app should not have
 * to import the desktop entry point to write `<View desktopDragRegion>`.
 *
 * The augmentation is deliberately global: in an app shared with iOS and Android
 * these props type-check on mobile too, and do nothing there. That is so they can
 * be written anywhere without a platform check.
 *
 * @format
 */

import type { NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native';

/** The native payload of a context-menu event. */
export interface DesktopContextMenuEventData {
  /** Position of the trigger, in window coordinates. */
  x: number;
  y: number;
  /** Position of the trigger, in the page's coordinates. */
  pageX: number;
  pageY: number;
  windowId?: number;
  /**
   * The button that triggered it, using the W3C numbering: 0 left, 1 middle,
   * 2 right, 3 back, 4 forward. A keyboard trigger reports 0.
   */
  button: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /**
   * How it was triggered. `keyboard` means the Menu key or Shift+F10, which only
   * Windows and Linux report; the menu is then anchored at the view's corner
   * rather than at a pointer.
   */
  trigger: 'mouse' | 'keyboard';
}

/**
 * The style properties a state style can change. A property that is being
 * animated by a native-driven animation keeps its animated value.
 */
export type DesktopStateStyle = Pick<
  ViewStyle,
  | 'backgroundColor'
  | 'opacity'
  | 'boxShadow'
  | 'transform'
  | 'borderColor'
  | 'borderLeftColor'
  | 'borderTopColor'
  | 'borderRightColor'
  | 'borderBottomColor'
  | 'outlineColor'
  | 'outlineWidth'
  | 'outlineOffset'
> & {
  /** The color of the text inside the view. */
  color?: ColorValue;
};

/**
 * A state style that applies while the ancestor that set `group` to this name
 * is hovered or pressed.
 */
export interface DesktopGroupStateStyle {
  /** The name an ancestor sets with its `group` prop. */
  group: string;
  style: StyleProp<DesktopStateStyle>;
}

/** A file or folder dragged in from the operating system. */
export interface DesktopDroppedFile {
  /** The absolute path. */
  path: string;
  name: string;
  /** Size in bytes; `0` for a folder. */
  size: number;
  /** The media type for the extension, or an empty string when unknown. */
  type: string;
  isDirectory: boolean;
}

export interface DesktopDragEventData {
  /** The view that takes the files. */
  target: number;
  /** The pointer position in that view. */
  x: number;
  y: number;
  /** The pointer position in the page. */
  pageX: number;
  pageY: number;
  files: DesktopDroppedFile[];
  /** For a drag started in the app: the view being dragged. Absent for files from the operating system. */
  source?: number;
}

export interface DesktopScrollBarDragEventData {
  /** The scroll offset when the event fired. */
  contentOffset: { x: number; y: number };
}

export type DesktopScrollBarDragEvent =
  NativeSyntheticEvent<DesktopScrollBarDragEventData>;

export interface DesktopDragSourceEventData {
  /** The view being dragged. */
  target: number;
  /** The pointer position in the page. */
  pageX: number;
  pageY: number;
  /** For `onDragEnd`: whether the drag ended on a view that takes drops. */
  dropped?: boolean;
}

export type DesktopDragSourceEvent =
  NativeSyntheticEvent<DesktopDragSourceEventData>;

export type DesktopDragEvent = NativeSyntheticEvent<DesktopDragEventData>;

export interface DesktopWheelEventData {
  /** The view the wheel event was sent to. */
  target: number;
  /** The change in the horizontal and vertical position, as the web's `WheelEvent` reports it: positive scrolls right and down. */
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  /** `0` when the deltas are pixels, `1` when they are lines. A mouse wheel reports lines; a trackpad reports pixels. */
  deltaMode: 0 | 1;
  /** Whether the event comes from a trackpad or another continuous device, rather than a mouse wheel. */
  isTrackpad: boolean;
  /** `'began'`, `'changed'` and `'ended'` bracket a trackpad gesture; `'none'` is a mouse wheel notch. */
  phase: 'none' | 'began' | 'changed' | 'ended' | 'cancelled';
  /** `true` for the inertial events a trackpad sends after the fingers lift. */
  momentum: boolean;
  /** `true` for a pinch: the deltas are the zoom change, and `ctrlKey` is `true`, as a browser reports a pinch. */
  isPinch: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** The pointer position in the window, in points. */
  clientX: number;
  clientY: number;
  x: number;
  y: number;
  pageX: number;
  pageY: number;
  screenX: number;
  screenY: number;
  /** The pointer position in the target view. */
  offsetX: number;
  offsetY: number;
  /** When the platform delivered the event, in milliseconds since the epoch. */
  timestamp: number;
}

export type DesktopWheelEvent = NativeSyntheticEvent<DesktopWheelEventData>;

export type DesktopContextMenuEvent =
  NativeSyntheticEvent<DesktopContextMenuEventData>;

/** Kept for the name existing code uses. */
export type ContextMenuEvent = DesktopContextMenuEvent;

declare module 'react-native' {
  interface ScrollViewProps {
    /** The scroll bar's thumb started to be dragged. */
    onScrollBarDragStart?: (event: DesktopScrollBarDragEvent) => void;
    /** The thumb moved while it was dragged. */
    onScrollBarDrag?: (event: DesktopScrollBarDragEvent) => void;
    /** The thumb was released. */
    onScrollBarDragEnd?: (event: DesktopScrollBarDragEvent) => void;
  }

  interface ViewProps {
    /**
     * Marks this view as part of a custom title bar: a primary press drags the
     * window and a double click zooms/minimizes it. Children that handle the
     * press themselves keep working.
     */
    desktopDragRegion?: boolean;
    /**
     * Called when this view's context menu is requested: a right click, Ctrl +
     * click on macOS, or the Menu key / Shift+F10 on Windows and Linux.
     */
    onContextMenu?: (event: DesktopContextMenuEvent) => void;
    /**
     * The capturing counterpart. Present when either this or `onContextMenu` is
     * set, so a view with only the capture handler still receives events.
     */
    onContextMenuCapture?: (event: DesktopContextMenuEvent) => void;
    /**
     * The mouse wheel or a trackpad scrolled or pinched over this view. It
     * bubbles. `preventDefault()` or `stopPropagation()` keeps a parent
     * `ScrollView` from scrolling for the event.
     */
    onWheel?: (event: DesktopWheelEvent) => void;
    /** The capturing counterpart, called before the handlers of the views below. */
    onWheelCapture?: (event: DesktopWheelEvent) => void;
    /**
     * Whether the view takes files dragged in from the operating system. The
     * nearest view under the pointer that does gets the drag events.
     */
    acceptsFiles?: boolean;
    /**
     * Lets the user drag this view within the app. A press that moves a few
     * points starts a drag, see `DragDrop`.
     */
    /**
     * Text shown in a tooltip after the pointer rests over this view, as the
     * web's `title` attribute does. Also the view's accessibility description
     * when it has no `accessibilityHint`.
     */
    tooltip?: string;
    draggable?: boolean;
    /** Whether this view takes drags started in the app (`draggable` views). */
    droppable?: boolean;
    onDragStart?: (event: DesktopDragSourceEvent) => void;
    onDrag?: (event: DesktopDragSourceEvent) => void;
    onDragEnd?: (event: DesktopDragSourceEvent) => void;
    onDragStartCapture?: (event: DesktopDragSourceEvent) => void;
    onDragCapture?: (event: DesktopDragSourceEvent) => void;
    onDragEndCapture?: (event: DesktopDragSourceEvent) => void;
    onDragEnter?: (event: DesktopDragEvent) => void;
    onDragOver?: (event: DesktopDragEvent) => void;
    onDragLeave?: (event: DesktopDragEvent) => void;
    onDrop?: (event: DesktopDragEvent) => void;
    onDragEnterCapture?: (event: DesktopDragEvent) => void;
    onDragOverCapture?: (event: DesktopDragEvent) => void;
    onDragLeaveCapture?: (event: DesktopDragEvent) => void;
    onDropCapture?: (event: DesktopDragEvent) => void;
    /** Applied while files are dragged over this view, which must set `acceptsFiles` or `droppable`. */
    dragOverStyle?: StyleProp<DesktopStateStyle>;
    /** Names this view as a group that descendants style against with `groupHoverStyle` and `groupActiveStyle`. */
    group?: string;
    /** Applied while the pointer is over this view. */
    hoverStyle?: StyleProp<DesktopStateStyle>;
    /** Applied while a mouse button pressed on this view is held. */
    activeStyle?: StyleProp<DesktopStateStyle>;
    /** Applied while this view has keyboard focus. Needs a view that can take focus. */
    focusStyle?: StyleProp<DesktopStateStyle>;
    /** Applied while this view has focus and the last input was the keyboard. */
    focusVisibleStyle?: StyleProp<DesktopStateStyle>;
    /** Applied while the pointer is over the ancestor that set `group` to this name. */
    groupHoverStyle?: DesktopGroupStateStyle;
    /** Applied while a button pressed on the ancestor that set `group` to this name is held. */
    groupActiveStyle?: DesktopGroupStateStyle;
  }
}

export {};
