import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View, type PointerEvent as RNPointerEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useReducedMotion } from "react-native-reanimated";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { formatMessageTimestamp } from "@/utils/time";
import { createChatOutlineHoverIntent } from "./hover-intent";
import { promptTickMagnification } from "./model";
import type { ChatOutlineRailProps } from "./rail";

// Hover tracking lives on the rail and the slots, never on the Pressable inside them:
// magnifying a slot must not move the box the pointer is resting on. See docs/hover.md.
const RAIL_WIDTH = 36;
const SLOT_HEIGHT = 8;
const MIN_PANEL_WIDTH = 918;
const RESTING_PILL_HEIGHT = 2;
const MAGNIFIED_PILL_HEIGHT = 4;
const RESTING_PILL_WIDTH = 10;
const ACTIVE_PILL_WIDTH = 18;
const MAGNIFIED_PILL_WIDTH = 26;
const PREVIEW_WIDTH = 260;
const PREVIEW_HEIGHT = 64;
const PREVIEW_GAP = 4;

export const ChatOutlineRail = memo(function ChatOutlineRail({
  prompts,
  activePrompt,
  onJumpToPrompt,
}: ChatOutlineRailProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const activeSeq = useSyncExternalStore(activePrompt.subscribe, activePrompt.getActiveSeq);
  const prefersReducedMotion = useReducedMotion();
  const { onLayout, isBelow: isPanelNarrow } = useContainerWidthBelow(MIN_PANEL_WIDTH);

  const hoverIntent = useMemo(
    () =>
      createChatOutlineHoverIntent({
        activate: setHoveredIndex,
        schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
        cancel: (timerId) => window.clearTimeout(timerId),
      }),
    [],
  );
  const handlePointerEnterTick = useCallback(
    (index: number) => hoverIntent.pointAt(index),
    [hoverIntent],
  );
  const handlePointerEnterRail = useCallback(
    (event: RNPointerEvent) => {
      hoverIntent.enter({ x: event.nativeEvent.clientX, y: event.nativeEvent.clientY });
    },
    [hoverIntent],
  );
  const handlePointerMoveRail = useCallback(
    (event: RNPointerEvent) => {
      hoverIntent.move({ x: event.nativeEvent.clientX, y: event.nativeEvent.clientY });
    },
    [hoverIntent],
  );
  const handlePointerLeaveRail = useCallback(() => hoverIntent.leave(), [hoverIntent]);
  useEffect(() => () => hoverIntent.dispose(), [hoverIntent]);
  useEffect(() => {
    if (isPanelNarrow) hoverIntent.leave();
  }, [hoverIntent, isPanelNarrow]);
  const handleFocusChange = useCallback((index: number, focused: boolean) => {
    setFocusedIndex((current) => {
      if (focused) return index;
      return current === index ? null : current;
    });
  }, []);

  // The pointer owns the magnified band while it is on the rail; keyboard focus drives the
  // same band and the same preview once the pointer leaves.
  const attentionIndex = hoveredIndex ?? focusedIndex;

  if (prompts.length < 2) return null;

  return (
    <View style={styles.panelMeasure} pointerEvents="box-none" onLayout={onLayout}>
      {isPanelNarrow ? null : (
        <View
          style={styles.rail}
          role="tablist"
          testID="chat-outline-rail"
          onPointerEnter={handlePointerEnterRail}
          onPointerMove={handlePointerMoveRail}
          onPointerLeave={handlePointerLeaveRail}
        >
          {prompts.map((prompt, index) => (
            <ChatOutlineTick
              key={prompt.seq}
              index={index}
              seq={prompt.seq}
              preview={prompt.preview}
              timestamp={prompt.timestamp}
              label={`${index + 1} of ${prompts.length}: ${prompt.preview}`}
              isActive={prompt.seq === activeSeq}
              hasAttention={index === attentionIndex}
              magnification={
                prefersReducedMotion || attentionIndex === null
                  ? 0
                  : promptTickMagnification(index - attentionIndex)
              }
              onHover={handlePointerEnterTick}
              onFocusChange={handleFocusChange}
              onJumpToPrompt={onJumpToPrompt}
            />
          ))}
        </View>
      )}
    </View>
  );
});

interface ChatOutlineTickProps {
  index: number;
  seq: number;
  preview: string;
  timestamp: string;
  label: string;
  isActive: boolean;
  hasAttention: boolean;
  magnification: number;
  onHover: (index: number) => void;
  onFocusChange: (index: number, focused: boolean) => void;
  onJumpToPrompt: (seq: number) => void;
}

const ChatOutlineTick = memo(function ChatOutlineTick({
  index,
  seq,
  preview,
  timestamp,
  label,
  isActive,
  hasAttention,
  magnification,
  onHover,
  onFocusChange,
  onJumpToPrompt,
}: ChatOutlineTickProps) {
  const formattedTimestamp = useMemo(
    () => formatMessageTimestamp(new Date(timestamp)),
    [timestamp],
  );
  const handlePress = useCallback(() => {
    onJumpToPrompt(seq);
    onFocusChange(index, false);
  }, [index, onFocusChange, onJumpToPrompt, seq]);
  const handlePointerEnter = useCallback(() => onHover(index), [index, onHover]);
  const handleFocus = useCallback(() => onFocusChange(index, true), [index, onFocusChange]);
  const handleBlur = useCallback(() => onFocusChange(index, false), [index, onFocusChange]);

  // The pill grows inside a slot that never moves, so magnification can never pull the hit
  // target out from under the pointer.
  const restingWidth = isActive ? ACTIVE_PILL_WIDTH : RESTING_PILL_WIDTH;
  const pillWidth = restingWidth + magnification * (MAGNIFIED_PILL_WIDTH - restingWidth);
  const pillHeight =
    RESTING_PILL_HEIGHT + magnification * (MAGNIFIED_PILL_HEIGHT - RESTING_PILL_HEIGHT);

  return (
    <View style={styles.slot} onPointerEnter={handlePointerEnter}>
      <Pressable
        style={styles.target}
        onPress={handlePress}
        onFocus={handleFocus}
        onBlur={handleBlur}
        accessibilityRole="tab"
        aria-selected={isActive}
        accessibilityLabel={label}
        testID={`chat-outline-tick-${seq}`}
      >
        <View
          style={[
            styles.pill,
            isActive && styles.pillActive,
            hasAttention && styles.pillAttention,
            inlineUnistylesStyle({ width: pillWidth, height: pillHeight }),
          ]}
        />
      </Pressable>
      {hasAttention ? (
        <View style={styles.preview} pointerEvents="none" aria-hidden testID="chat-outline-preview">
          <Text style={styles.previewText} numberOfLines={2}>
            {preview}
          </Text>
          <Text
            style={styles.previewTimestamp}
            numberOfLines={1}
            testID="chat-outline-preview-timestamp"
          >
            {formattedTimestamp}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  panelMeasure: {
    position: "absolute",
    inset: 0,
  },
  rail: {
    position: "absolute",
    left: theme.spacing[2],
    top: "10%",
    bottom: "10%",
    width: RAIL_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  // Slots tile the rail with no gaps, so every pixel of the column belongs to a prompt even
  // when a long conversation squeezes them well below their resting height.
  slot: {
    width: RAIL_WIDTH,
    flexBasis: SLOT_HEIGHT,
    flexShrink: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  // Pills share one left rail and grow rightward, so magnification reads as a bulge moving
  // with the pointer instead of every tick breathing about its own centre.
  target: {
    width: "100%",
    height: "100%",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingLeft: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  // At rest the pills use low-emphasis chrome so the column stays readable peripherally
  // without competing with the transcript. Attention is the only foreground state.
  pill: {
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.borderAccent,
    transitionProperty: "width, height, background-color",
    transitionDuration: "140ms",
    transitionTimingFunction: "ease-out",
  },
  pillActive: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  pillAttention: {
    backgroundColor: theme.colors.foreground,
  },
  preview: {
    position: "absolute",
    left: RAIL_WIDTH + PREVIEW_GAP,
    top: "50%",
    marginTop: -PREVIEW_HEIGHT / 2,
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    ...theme.shadow.md,
  },
  previewText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  previewTimestamp: {
    marginTop: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
