import { useCallback, useLayoutEffect, useRef } from "react";
import type { NativeScrollEvent, ScrollView } from "react-native";

// Nested streaming panels use the same follow-output contract as the chat viewport:
// stick to the latest output, detach if the reader scrolls up, reattach at the bottom.
// After the stream ends, keep pinning to the end until the reader has scrolled the panel.
// Thinking panels remount when they leave the live head for history, so the last follow
// state is persisted by key and restored on the new instance.
//
// The stateful orchestration lives in `createFollowOutputScrollController`, a plain object
// that takes an injected `FollowOutputScrollable` port. `useFollowOutputScroll` is a thin
// React wrapper around it, so tests exercise the controller directly with a fake scrollable
// instead of mounting a component tree.

export interface FollowOutputScrollState {
  following: boolean;
  offsetY: number;
}

export interface FollowOutputScrollMetrics {
  offsetY: number;
  contentHeight: number;
  viewportHeight: number;
}

const USER_SCROLL_DELTA_EPSILON = 1;
const RESUME_THRESHOLD_PX = 1;

// Long-lived tabs stream many nested panels; cap retained positions so closed
// conversations don't accumulate entries forever.
export const MAX_PERSISTED_FOLLOW_OUTPUT_PANELS = 50;

const persistedFollowOutputScroll = new Map<string, FollowOutputScrollState>();

export function resetFollowOutputScrollPersistence(): void {
  persistedFollowOutputScroll.clear();
}

export function createFollowOutputScrollState(offsetY = 0): FollowOutputScrollState {
  return { following: true, offsetY };
}

function readPersistedFollowOutputScroll(
  persistKey: string | undefined,
): FollowOutputScrollState | null {
  if (!persistKey) {
    return null;
  }
  return persistedFollowOutputScroll.get(persistKey) ?? null;
}

function writePersistedFollowOutputScroll(
  persistKey: string | undefined,
  state: FollowOutputScrollState,
): void {
  if (!persistKey) {
    return;
  }
  // Re-insert so the key becomes most-recently-written for the eviction order below.
  persistedFollowOutputScroll.delete(persistKey);
  persistedFollowOutputScroll.set(persistKey, state);
  if (persistedFollowOutputScroll.size > MAX_PERSISTED_FOLLOW_OUTPUT_PANELS) {
    const oldestKey = persistedFollowOutputScroll.keys().next().value;
    if (oldestKey !== undefined) {
      persistedFollowOutputScroll.delete(oldestKey);
    }
  }
}

export function isFollowOutputAtBottom(metrics: FollowOutputScrollMetrics): boolean {
  const { offsetY, contentHeight, viewportHeight } = metrics;
  if (![offsetY, contentHeight, viewportHeight].every(Number.isFinite)) {
    return true;
  }
  return contentHeight - viewportHeight - offsetY <= RESUME_THRESHOLD_PX;
}

export function shouldStickFollowOutputToBottom(input: {
  enabled: boolean;
  following: boolean;
  hasStreamed?: boolean;
}): boolean {
  if (!input.following) {
    return false;
  }
  return input.enabled || Boolean(input.hasStreamed);
}

export function shouldIgnoreFollowOutputScrollReset(input: {
  following: boolean;
  offsetY: number;
  lastOffsetY: number;
  // True only for the first scroll report since the panel mounted, remounted, or its
  // content size last changed — the narrow window where native can echo a stale offset
  // of ~0 before the real layout settles. Outside that window, an offset near 0 is the
  // reader actually scrolling to the top.
  isLayoutReset: boolean;
}): boolean {
  if (input.offsetY > RESUME_THRESHOLD_PX) {
    return false;
  }
  if (input.following) {
    return true;
  }
  return input.isLayoutReset && input.lastOffsetY > RESUME_THRESHOLD_PX;
}

export function resolveFollowOutputContentSizeAction(input: {
  enabled: boolean;
  following: boolean;
  hasStreamed: boolean;
  restoreOffsetY: number | null;
}): "stick-end" | "restore" | "none" {
  if (shouldStickFollowOutputToBottom(input)) {
    return "stick-end";
  }
  if (input.restoreOffsetY !== null) {
    return "restore";
  }
  return "none";
}

export function reduceFollowOutputUserScroll(
  state: FollowOutputScrollState,
  metrics: FollowOutputScrollMetrics,
): FollowOutputScrollState {
  const scrolledUp = metrics.offsetY < state.offsetY - USER_SCROLL_DELTA_EPSILON;
  const scrolledDown = metrics.offsetY > state.offsetY + USER_SCROLL_DELTA_EPSILON;
  const atBottom = isFollowOutputAtBottom(metrics);

  if (!state.following && atBottom && scrolledDown) {
    return { following: true, offsetY: metrics.offsetY };
  }
  if (state.following && scrolledUp) {
    return { following: false, offsetY: metrics.offsetY };
  }
  return { following: state.following, offsetY: metrics.offsetY };
}

export interface FollowOutputScrollable {
  scrollToEnd(options: { animated: boolean }): void;
  scrollTo(options: { y: number; animated: boolean }): void;
}

export interface FollowOutputScrollController {
  attach(scrollable: FollowOutputScrollable | null): void;
  setPersistKey(persistKey: string | undefined): void;
  setEnabled(enabled: boolean): void;
  onContentSizeChange(): void;
  onScroll(metrics: FollowOutputScrollMetrics): void;
  mount(): void;
  unmount(): void;
}

export function createFollowOutputScrollController(
  initialEnabled: boolean,
  initialPersistKey?: string,
): FollowOutputScrollController {
  const persisted = readPersistedFollowOutputScroll(initialPersistKey);
  let scrollable: FollowOutputScrollable | null = null;
  let persistKey = initialPersistKey;
  let enabled = initialEnabled;
  let state = persisted ?? createFollowOutputScrollState();
  let hasStreamed = initialEnabled || persisted !== null;
  let awaitingLayoutMeasure = true;

  function applyContentSizeAction(): void {
    const following = state.following;
    const action = resolveFollowOutputContentSizeAction({
      enabled,
      following,
      hasStreamed,
      restoreOffsetY: following ? null : state.offsetY,
    });
    if (action === "stick-end") {
      scrollable?.scrollToEnd({ animated: false });
      return;
    }
    if (action === "restore") {
      scrollable?.scrollTo({ y: state.offsetY, animated: false });
    }
  }

  return {
    attach(next) {
      scrollable = next;
    },
    setPersistKey(next) {
      persistKey = next;
    },
    setEnabled(next) {
      if (next && !enabled) {
        state = createFollowOutputScrollState(state.offsetY);
      }
      enabled = next;
      if (enabled) {
        hasStreamed = true;
      }
    },
    onContentSizeChange() {
      awaitingLayoutMeasure = true;
      applyContentSizeAction();
    },
    onScroll(metrics) {
      const isLayoutReset = awaitingLayoutMeasure;
      awaitingLayoutMeasure = false;
      if (
        shouldIgnoreFollowOutputScrollReset({
          following: state.following,
          offsetY: metrics.offsetY,
          lastOffsetY: state.offsetY,
          isLayoutReset,
        })
      ) {
        applyContentSizeAction();
        return;
      }
      state = reduceFollowOutputUserScroll(state, metrics);
      if (hasStreamed) {
        writePersistedFollowOutputScroll(persistKey, state);
      }
    },
    mount() {
      const latestPersisted = readPersistedFollowOutputScroll(persistKey);
      if (latestPersisted) {
        state = latestPersisted;
        hasStreamed = true;
      }
      awaitingLayoutMeasure = true;
      applyContentSizeAction();
    },
    unmount() {
      if (hasStreamed) {
        writePersistedFollowOutputScroll(persistKey, state);
      }
    },
  };
}

export function useFollowOutputScroll(enabled: boolean, persistKey?: string) {
  const scrollRef = useRef<ScrollView>(null);
  const controllerRef = useRef<FollowOutputScrollController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createFollowOutputScrollController(enabled, persistKey);
  }
  const controller = controllerRef.current;
  controller.setPersistKey(persistKey);
  controller.setEnabled(enabled);

  const onContentSizeChange = useCallback(() => {
    controller.onContentSizeChange();
  }, [controller]);

  const onScroll = useCallback(
    (event: {
      nativeEvent: Pick<NativeScrollEvent, "contentOffset" | "contentSize" | "layoutMeasurement">;
    }) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      controller.onScroll({
        offsetY: contentOffset.y,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      });
    },
    [controller],
  );

  useLayoutEffect(() => {
    controller.attach({
      scrollToEnd: (options) => scrollRef.current?.scrollToEnd(options),
      scrollTo: (options) => scrollRef.current?.scrollTo(options),
    });
    controller.mount();
    return () => controller.unmount();
  }, [controller, enabled]);

  return { scrollRef, onContentSizeChange, onScroll };
}
