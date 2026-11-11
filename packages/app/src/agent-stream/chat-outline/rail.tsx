import { memo, useCallback, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type AccessibilityActionEvent, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useReducedMotion, useSharedValue } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";
import { useStableEvent } from "@/hooks/use-stable-event";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import {
  promptTickMagnification,
  resolveOutlinePreviewTop,
  resolveOutlineScrubIntent,
  resolvePromptSlotAt,
  type ActivePromptSource,
  type ChatOutlinePrompt,
  type OutlineAccessibilityAction,
} from "./model";

export interface ChatOutlineRailProps {
  prompts: ChatOutlinePrompt[];
  activePrompt: ActivePromptSource;
  onJumpToPrompt: (seq: number) => void;
  onStepToPrompt: (action: OutlineAccessibilityAction) => void;
  onScrubStart: () => void;
}

// The touch strip covers only the transcript's left gutter (`listContentContainer` pads
// rows by spacing[3]), so it never sits over a row's own hit area.
const RAIL_WIDTH = 16;
const SLOT_HEIGHT = 16;
const PILL_INSET = 3;
const RESTING_PILL_HEIGHT = 2;
const MAGNIFIED_PILL_HEIGHT = 4;
const RESTING_PILL_WIDTH = 6;
const ACTIVE_PILL_WIDTH = 10;
const MAGNIFIED_PILL_WIDTH = 24;
const PREVIEW_WIDTH = 240;
const PREVIEW_HEIGHT = 64;
const PREVIEW_GAP = 8;
// The preview floats above the touch point, clear of the thumb resting on the edge.
const PREVIEW_FINGER_CLEARANCE = 24;

interface ColumnFrame {
  y: number;
  height: number;
}

const EMPTY_COLUMN_FRAME: ColumnFrame = { y: 0, height: 0 };

/**
 * The touch counterpart of the web outline: a column of ticks in the left gutter that a
 * finger drags along to pick a prompt, with the picked prompt previewed beside it and
 * jumped to on release.
 */
export const ChatOutlineRail = memo(function ChatOutlineRail({
  prompts,
  activePrompt,
  onJumpToPrompt,
  onStepToPrompt,
  onScrubStart,
}: ChatOutlineRailProps) {
  const { t } = useTranslation();
  const activeSeq = useSyncExternalStore(activePrompt.subscribe, activePrompt.getActiveSeq);
  const requestedSeq = useSyncExternalStore(activePrompt.subscribe, activePrompt.getRequestedSeq);
  const prefersReducedMotion = useReducedMotion();
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [railOffset, setRailOffset] = useState(0);
  const [columnFrame, setColumnFrame] = useState<ColumnFrame>(EMPTY_COLUMN_FRAME);
  const touchStartX = useSharedValue(0);
  const touchStartY = useSharedValue(0);
  const columnY = useSharedValue(0);
  const columnHeight = useSharedValue(0);
  const slotCount = useSharedValue(prompts.length);
  const scrubIndexShared = useSharedValue(-1);
  // Once the finger scrubs or yields, later samples must not cancel the scrub or take
  // the touch back from the left-drawer gesture.
  const scrubDecided = useSharedValue(false);
  // Shared values are written on the UI thread. Assigning during render logs
  // "Writing to value during component render" and fights the gesture worklet.
  useLayoutEffect(() => {
    if (slotCount.value === prompts.length) return;
    slotCount.value = prompts.length;
  }, [prompts.length, slotCount]);

  const handleRailLayout = useCallback((event: LayoutChangeEvent) => {
    const y = event.nativeEvent.layout.y;
    setRailOffset((current) => (current === y ? current : y));
  }, []);
  const handleColumnLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      columnY.value = y;
      columnHeight.value = height;
      setColumnFrame((current) =>
        current.y === y && current.height === height ? current : { y, height },
      );
    },
    [columnHeight, columnY],
  );

  // Slot changes cross to React. Frames in between stay on the UI thread.
  const beginScrub = useStableEvent((index: number) => {
    onScrubStart();
    scrubTo(index);
  });
  const scrubTo = useStableEvent((index: number) => {
    setScrubIndex((current) => (current === index ? current : index));
    void Haptics.selectionAsync().catch(() => {});
  });
  const commitScrub = useStableEvent((index: number) => {
    const prompt = prompts[Math.min(prompts.length - 1, Math.max(0, index))];
    if (prompt) onJumpToPrompt(prompt.seq);
  });
  const endScrub = useStableEvent(() => {
    setScrubIndex(null);
  });

  // Rebuilt only when the stable callbacks change, not when the prompt list refreshes.
  // The UI thread reads slotCount/column frames from shared values, so a refresh mid-scrub
  // cannot close over a stale list.
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .manualActivation(true)
        .onTouchesDown((event) => {
          if (scrubDecided.value) return;
          const touch = event.changedTouches[0];
          if (!touch) return;
          touchStartX.value = touch.absoluteX;
          touchStartY.value = touch.absoluteY;
        })
        .onTouchesMove((event, stateManager) => {
          if (scrubDecided.value) return;
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            scrubDecided.value = true;
            stateManager.fail();
            return;
          }
          const intent = resolveOutlineScrubIntent(
            touch.absoluteX - touchStartX.value,
            touch.absoluteY - touchStartY.value,
          );
          if (intent === "wait") return;
          scrubDecided.value = true;
          if (intent === "fail") stateManager.fail();
          else stateManager.activate();
        })
        .onStart((event) => {
          const index = resolvePromptSlotAt({
            offsetY: event.y - columnY.value,
            railHeight: columnHeight.value,
            slotCount: slotCount.value,
          });
          if (index === null) return;
          scrubIndexShared.value = index;
          scheduleOnRN(beginScrub, index);
        })
        .onUpdate((event) => {
          const index = resolvePromptSlotAt({
            offsetY: event.y - columnY.value,
            railHeight: columnHeight.value,
            slotCount: slotCount.value,
          });
          if (index === null || index === scrubIndexShared.value) return;
          scrubIndexShared.value = index;
          scheduleOnRN(scrubTo, index);
        })
        .onEnd((_event, success) => {
          if (!success) return;
          const index = scrubIndexShared.value;
          if (index < 0) return;
          scheduleOnRN(commitScrub, index);
        })
        .onFinalize(() => {
          scrubDecided.value = false;
          if (scrubIndexShared.value < 0) return;
          scrubIndexShared.value = -1;
          scheduleOnRN(endScrub);
        }),
    [
      beginScrub,
      columnHeight,
      columnY,
      commitScrub,
      endScrub,
      scrubDecided,
      scrubIndexShared,
      scrubTo,
      slotCount,
      touchStartX,
      touchStartY,
    ],
  );

  // Screen readers cannot drag the strip, so it adjusts one prompt at a time instead.
  const activeIndex = prompts.findIndex((prompt) => prompt.seq === (requestedSeq ?? activeSeq));
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      const actionName = event.nativeEvent.actionName;
      if (!isOutlineAccessibilityAction(actionName)) return;
      onStepToPrompt(actionName);
    },
    [onStepToPrompt],
  );
  const accessibilityValue = useMemo(() => {
    const prompt = prompts[activeIndex];
    if (!prompt) return undefined;
    return {
      text: t("agentStream.chatOutline.position", {
        index: activeIndex + 1,
        count: prompts.length,
        preview: prompt.preview,
      }),
    };
  }, [activeIndex, prompts, t]);

  if (prompts.length < 2) return null;

  let preview: OutlinePreview | null = null;
  if (scrubIndex !== null) {
    preview = outlinePreview({
      prompts,
      scrubIndex,
      railOffset,
      columnFrame,
    });
  }

  return (
    <>
      <GestureDetector gesture={gesture}>
        <View
          style={styles.rail}
          collapsable={false}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={t("agentStream.chatOutline.label")}
          accessibilityValue={accessibilityValue}
          accessibilityActions={ADJUSTABLE_ACTIONS}
          onAccessibilityAction={handleAccessibilityAction}
          onLayout={handleRailLayout}
          testID="chat-outline-rail"
        >
          <View
            style={styles.column}
            onLayout={handleColumnLayout}
            pointerEvents="none"
            importantForAccessibility="no-hide-descendants"
          >
            {prompts.map((prompt, index) => (
              <ChatOutlineTick
                key={prompt.seq}
                isActive={prompt.seq === activeSeq}
                hasAttention={index === scrubIndex}
                magnification={tickMagnification({ index, scrubIndex, prefersReducedMotion })}
              />
            ))}
          </View>
        </View>
      </GestureDetector>
      <OutlineScrubPreview preview={preview} />
    </>
  );
});

function OutlineScrubPreview({ preview }: { preview: OutlinePreview | null }) {
  if (!preview) return null;
  return (
    <View
      style={[styles.preview, inlineUnistylesStyle({ top: preview.top })]}
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no"
      testID="chat-outline-preview"
    >
      <Text style={styles.previewCount}>{preview.count}</Text>
      <Text style={styles.previewText} numberOfLines={2}>
        {preview.text}
      </Text>
    </View>
  );
}

interface OutlinePreview {
  top: number;
  count: string;
  text: string;
}

interface OutlinePreviewInput {
  prompts: ChatOutlinePrompt[];
  scrubIndex: number;
  railOffset: number;
  columnFrame: ColumnFrame;
}

function outlinePreview(input: OutlinePreviewInput): OutlinePreview | null {
  const prompt = input.prompts[input.scrubIndex];
  if (!prompt) return null;
  const top = resolveOutlinePreviewTop({
    railY: input.railOffset,
    columnY: input.columnFrame.y,
    columnHeight: input.columnFrame.height,
    slotIndex: input.scrubIndex,
    slotCount: input.prompts.length,
    previewHeight: PREVIEW_HEIGHT,
    fingerClearance: PREVIEW_FINGER_CLEARANCE,
  });
  if (top === null) return null;
  return {
    top,
    count: `${input.scrubIndex + 1} / ${input.prompts.length}`,
    text: prompt.preview,
  };
}

const ADJUSTABLE_ACTIONS = [{ name: "increment" }, { name: "decrement" }];

function isOutlineAccessibilityAction(action: string): action is OutlineAccessibilityAction {
  return action === "increment" || action === "decrement";
}

interface TickMagnificationInput {
  index: number;
  scrubIndex: number | null;
  prefersReducedMotion: boolean;
}

function tickMagnification({
  index,
  scrubIndex,
  prefersReducedMotion,
}: TickMagnificationInput): number {
  if (prefersReducedMotion || scrubIndex === null) return 0;
  return promptTickMagnification(index - scrubIndex);
}

interface ChatOutlineTickProps {
  isActive: boolean;
  hasAttention: boolean;
  magnification: number;
}

const ChatOutlineTick = memo(function ChatOutlineTick({
  isActive,
  hasAttention,
  magnification,
}: ChatOutlineTickProps) {
  const restingWidth = isActive ? ACTIVE_PILL_WIDTH : RESTING_PILL_WIDTH;
  const pillWidth = restingWidth + magnification * (MAGNIFIED_PILL_WIDTH - restingWidth);
  const pillHeight =
    RESTING_PILL_HEIGHT + magnification * (MAGNIFIED_PILL_HEIGHT - RESTING_PILL_HEIGHT);

  return (
    <View style={styles.slot}>
      <View
        style={[
          styles.pill,
          isActive && styles.pillActive,
          hasAttention && styles.pillAttention,
          inlineUnistylesStyle({ width: pillWidth, height: pillHeight }),
        ]}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  rail: {
    position: "absolute",
    left: 0,
    top: "10%",
    bottom: "10%",
    width: RAIL_WIDTH,
    justifyContent: "center",
    // Magnified ticks grow past the strip. The preview itself is a sibling, so the
    // 240pt bubble does not depend on this view's overflow.
    overflow: "visible",
    zIndex: 2,
  },
  column: {
    width: RAIL_WIDTH,
    flexShrink: 1,
    overflow: "visible",
  },
  // Slots tile the column with no gaps, so the touch-to-prompt mapping matches the ticks
  // even when a long conversation squeezes them well below their resting height.
  slot: {
    width: RAIL_WIDTH,
    flexBasis: SLOT_HEIGHT,
    flexShrink: 1,
    justifyContent: "center",
    paddingLeft: PILL_INSET,
    overflow: "visible",
  },
  // Pills share one left edge and grow rightward over the transcript while scrubbing.
  pill: {
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.borderAccent,
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
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    zIndex: 3,
    ...theme.shadow.md,
  },
  previewCount: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  previewText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
