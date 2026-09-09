import { useCallback, useLayoutEffect, useRef } from "react";
import type { NativeScrollEvent, ScrollView } from "react-native";

// Nested streaming panels use the same follow-output contract as the chat viewport:
// stick to the latest output, detach if the reader scrolls up, reattach at the bottom.
// After the stream ends, keep pinning to the end until the reader has scrolled the panel.
// Thinking panels remount when they leave the live head for history, so the last follow
// state is persisted by key and restored on the new instance.

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
  persistedFollowOutputScroll.set(persistKey, state);
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
}): boolean {
  if (input.offsetY > RESUME_THRESHOLD_PX) {
    return false;
  }
  if (input.following) {
    return true;
  }
  return input.lastOffsetY > RESUME_THRESHOLD_PX;
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

export function useFollowOutputScroll(enabled: boolean, persistKey?: string) {
  const persisted = readPersistedFollowOutputScroll(persistKey);
  const scrollRef = useRef<ScrollView>(null);
  const stateRef = useRef(persisted ?? createFollowOutputScrollState());
  const enabledRef = useRef(enabled);
  const persistKeyRef = useRef(persistKey);
  persistKeyRef.current = persistKey;
  const hasStreamedRef = useRef(enabled || persisted !== null);
  if (enabled) {
    hasStreamedRef.current = true;
  }
  if (enabled && !enabledRef.current) {
    stateRef.current = createFollowOutputScrollState(stateRef.current.offsetY);
  }
  enabledRef.current = enabled;

  const applyContentSizeAction = useCallback(() => {
    const following = stateRef.current.following;
    const action = resolveFollowOutputContentSizeAction({
      enabled: enabledRef.current,
      following,
      hasStreamed: hasStreamedRef.current,
      restoreOffsetY: following ? null : stateRef.current.offsetY,
    });
    if (action === "stick-end") {
      scrollRef.current?.scrollToEnd({ animated: false });
      return;
    }
    if (action === "restore") {
      scrollRef.current?.scrollTo({ y: stateRef.current.offsetY, animated: false });
    }
  }, []);

  const onContentSizeChange = useCallback(() => {
    applyContentSizeAction();
  }, [applyContentSizeAction]);

  const onScroll = useCallback(
    (event: {
      nativeEvent: Pick<NativeScrollEvent, "contentOffset" | "contentSize" | "layoutMeasurement">;
    }) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      if (
        shouldIgnoreFollowOutputScrollReset({
          following: stateRef.current.following,
          offsetY: contentOffset.y,
          lastOffsetY: stateRef.current.offsetY,
        })
      ) {
        applyContentSizeAction();
        return;
      }
      stateRef.current = reduceFollowOutputUserScroll(stateRef.current, {
        offsetY: contentOffset.y,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      });
      if (hasStreamedRef.current) {
        writePersistedFollowOutputScroll(persistKeyRef.current, stateRef.current);
      }
    },
    [applyContentSizeAction],
  );

  useLayoutEffect(() => {
    const latestPersisted = readPersistedFollowOutputScroll(persistKeyRef.current);
    if (latestPersisted) {
      stateRef.current = latestPersisted;
      hasStreamedRef.current = true;
    }
    applyContentSizeAction();
    return () => {
      if (hasStreamedRef.current) {
        writePersistedFollowOutputScroll(persistKeyRef.current, stateRef.current);
      }
    };
  }, [applyContentSizeAction, enabled]);

  return { scrollRef, onContentSizeChange, onScroll };
}
