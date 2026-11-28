/**
 * Dragging views inside the app.
 *
 * A `draggable` view starts a drag when a press moves a few points. The payload
 * is set in its `onDragStart`; a `droppable` view reads it in `onDragEnter`,
 * `onDragOver` and `onDrop`.
 *
 * ```tsx
 * <View draggable onDragStart={() => DragDrop.setPayload({ id: note.id })} />
 * <View droppable onDrop={() => move(DragDrop.getPayload<{ id: string }>())} />
 * ```
 *
 * @format
 */

import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { DeviceEventEmitter, View } from 'react-native';

export interface DragState {
  /** Whether a drag is in progress. */
  active: boolean;
  /** The tag of the view being dragged. */
  source: number | null;
  /** The payload set with `DragDrop.setPayload`, kept readable after the drag ends until the next one starts. */
  payload: unknown;
  /** The pointer position in the window. */
  x: number;
  y: number;
  /** The tag of the `droppable` view the pointer is over. */
  over: number | null;
}

const IDLE: DragState = {
  active: false,
  source: null,
  payload: undefined,
  x: 0,
  y: 0,
  over: null,
};

let state: DragState = IDLE;
let held: { value: unknown } | null = null;
const listeners = new Set<() => void>();
const moves = new Set<(x: number, y: number) => void>();

function publish(next: DragState) {
  state = next;
  listeners.forEach(listener => listener());
}

interface DragEventPayload {
  source: number;
  id: number;
  x: number;
  y: number;
  over?: number | null;
  dropped?: boolean;
}

DeviceEventEmitter.addListener(
  'gpuiDesktop:dragStart',
  (event: DragEventPayload) => {
    const payload = held ? held.value : undefined;
    held = null;
    publish({
      active: true,
      source: event.source,
      payload,
      x: event.x,
      y: event.y,
      over: null,
    });
  },
);

DeviceEventEmitter.addListener(
  'gpuiDesktop:dragMove',
  (event: DragEventPayload) => {
    publish({
      ...state,
      x: event.x,
      y: event.y,
      over: event.over ?? null,
    });
    moves.forEach(listener => listener(event.x, event.y));
  },
);

DeviceEventEmitter.addListener('gpuiDesktop:dragEnd', () => {
  publish({ ...state, active: false, source: null, over: null });
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const DragDrop = {
  /**
   * Sets what the drag in progress carries. Call it from the source's
   * `onDragStart`.
   */
  setPayload(value: unknown): void {
    if (state.active) {
      publish({ ...state, payload: value });
    } else {
      held = { value };
    }
  },
  /** What the current drag carries, or the last one's once it has ended. */
  getPayload<T = unknown>(): T | undefined {
    return state.payload as T | undefined;
  },
  getState(): DragState {
    return state;
  },
  subscribe,
  /** Calls `listener` with the pointer position, in the window, on each move of a drag. */
  onMove(listener: (x: number, y: number) => void): () => void {
    moves.add(listener);
    return () => {
      moves.delete(listener);
    };
  },
};

/** The drag in progress, re-rendering as it moves. */
export function useDragState(): DragState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Whether a drag is in progress, re-rendering only when that changes. */
export function useIsDragging(): boolean {
  return useSyncExternalStore(subscribe, () => state.active);
}

export interface DragPreviewProps<T = unknown> {
  /** Draws the preview for the payload. */
  render: (payload: T) => React.ReactNode;
  /** Where the preview sits from the pointer. Defaults to 12 points right and down. */
  offset?: { x: number; y: number };
}

/**
 * Draws a preview beside the pointer while a drag is in progress. Mount it once,
 * as the last child of a root view that fills the window.
 */
export function DragPreview<T = unknown>({
  render,
  offset = { x: 12, y: 12 },
}: DragPreviewProps<T>) {
  const drag = useDragState();
  if (!drag.active) {
    return null;
  }
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: drag.x + offset.x,
        top: drag.y + offset.y,
      }}
    >
      {render(drag.payload as T)}
    </View>
  );
}

/** What `useDragAutoScroll` needs of a scroll view's ref. */
export interface DragScrollable {
  scrollTo(options: { x?: number; y?: number; animated?: boolean }): void;
  measureInWindow(
    callback: (x: number, y: number, width: number, height: number) => void,
  ): void;
}

export interface DragAutoScrollOptions {
  /** How close to an edge, in points, the pointer scrolls. Defaults to 40. */
  edge?: number;
  /** The most it scrolls per frame, in points. Defaults to 14. */
  speed?: number;
  horizontal?: boolean;
}

/**
 * Scrolls a `ScrollView` while a drag is held near its edge. Spread the result
 * on the scroll view and pass its ref.
 */
export function useDragAutoScroll(
  ref: React.RefObject<DragScrollable | null>,
  { edge = 40, speed = 14, horizontal = false }: DragAutoScrollOptions = {},
) {
  const offset = useRef(0);
  const frame = useRef({ start: 0, size: 0 });
  const velocity = useRef(0);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      velocity.current = 0;
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const tick = () => {
      if (velocity.current === 0) {
        return;
      }
      offset.current = Math.max(0, offset.current + velocity.current);
      ref.current?.scrollTo(
        horizontal
          ? { x: offset.current, animated: false }
          : { y: offset.current, animated: false },
      );
    };
    const unsubscribeMove = DragDrop.onMove((x, y) => {
      ref.current?.measureInWindow((left, top, width, height) => {
        frame.current = horizontal
          ? { start: left, size: width }
          : { start: top, size: height };
        const position = (horizontal ? x : y) - frame.current.start;
        let next = 0;
        if (position >= 0 && position < edge) {
          next = -speed * (1 - position / edge);
        } else if (
          position <= frame.current.size &&
          position > frame.current.size - edge
        ) {
          next = speed * (1 - (frame.current.size - position) / edge);
        }
        velocity.current = next;
        if (next !== 0 && timer == null) {
          timer = setInterval(tick, 16);
        } else if (next === 0 && timer != null) {
          stop();
        }
      });
    });
    const unsubscribeState = subscribe(() => {
      if (!state.active) {
        stop();
      }
    });
    return () => {
      unsubscribeMove();
      unsubscribeState();
      stop();
    };
  }, [ref, edge, speed, horizontal]);
  return {
    scrollEventThrottle: 16,
    onScroll: (event: {
      nativeEvent: { contentOffset: { x: number; y: number } };
    }) => {
      offset.current = horizontal
        ? event.nativeEvent.contentOffset.x
        : event.nativeEvent.contentOffset.y;
    },
  };
}
