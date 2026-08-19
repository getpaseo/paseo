import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";
import { Pressable, Text, View, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import * as Haptics from "expo-haptics";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import type { ActivePromptSource, ChatOutlinePrompt } from "./model";

export interface ChatOutlineRailProps {
  prompts: ChatOutlinePrompt[];
  activePrompt: ActivePromptSource;
  onJumpToPrompt: (seq: number) => void;
}

const RAIL_WIDTH = 36;
const SLOT_HEIGHT = 8;
const MIN_PANEL_WIDTH = 918;
const RESTING_PILL_HEIGHT = 2;
const ACTIVE_PILL_WIDTH = 18;
const RESTING_PILL_WIDTH = 10;
const PREVIEW_WIDTH = 260;
const PREVIEW_HEIGHT = 48;
const PREVIEW_GAP = 4;

/**
 * Native touch version of the chat outline rail. The rail is a scrubber:
 * touching anywhere opens a preview of the prompt under the finger, sliding
 * moves between prompts, and the preview persists after release until it is
 * tapped (jump) or the rail is touched again (dismiss). This replaces the
 * hover-driven web rail, which has no equivalent on touch screens.
 */
export function ChatOutlineRail({
  prompts,
  activePrompt,
  onJumpToPrompt,
}: ChatOutlineRailProps): ReactElement | null {
  const activeSeq = useSyncExternalStore(activePrompt.subscribe, activePrompt.getActiveSeq);
  const { onLayout, isBelow: isPanelNarrow } = useContainerWidthBelow(MIN_PANEL_WIDTH);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const scrubIndexRef = useRef<number | null>(null);
  const railHeightRef = useRef(0);

  const resolveTickIndex = useCallback(
    (locationY: number): number | null => {
      const height = railHeightRef.current;
      if (height <= 0 || prompts.length === 0) {
        return null;
      }
      const raw = Math.floor((locationY / height) * prompts.length);
      return Math.max(0, Math.min(prompts.length - 1, raw));
    },
    [prompts.length],
  );

  const applyScrubIndex = useCallback((index: number) => {
    if (scrubIndexRef.current !== index) {
      scrubIndexRef.current = index;
      setScrubIndex(index);
      void Haptics.selectionAsync().catch(() => {});
    }
  }, []);

  const handleRailLayout = useCallback((event: LayoutChangeEvent) => {
    railHeightRef.current = event.nativeEvent.layout.height;
  }, []);

  const handleGrant = useCallback(
    (event: GestureResponderEvent) => {
      if (scrubIndexRef.current !== null) {
        // A second touch dismisses the persisted preview.
        scrubIndexRef.current = null;
        setScrubIndex(null);
        return;
      }
      const index = resolveTickIndex(event.nativeEvent.locationY);
      if (index !== null) {
        applyScrubIndex(index);
      }
    },
    [applyScrubIndex, resolveTickIndex],
  );

  const handleMove = useCallback(
    (event: GestureResponderEvent) => {
      if (scrubIndexRef.current === null) {
        return;
      }
      const index = resolveTickIndex(event.nativeEvent.locationY);
      if (index !== null) {
        applyScrubIndex(index);
      }
    },
    [applyScrubIndex, resolveTickIndex],
  );

  const handleJump = useCallback(
    (seq: number) => {
      scrubIndexRef.current = null;
      setScrubIndex(null);
      onJumpToPrompt(seq);
    },
    [onJumpToPrompt],
  );

  if (prompts.length < 2) {
    return null;
  }

  const previewPrompt = scrubIndex !== null ? prompts[scrubIndex] : null;

  return (
    <View style={styles.panelMeasure} pointerEvents="box-none" onLayout={onLayout}>
      {isPanelNarrow ? null : (
        <View style={styles.railOuter}>
          <View
            style={styles.rail}
            testID="chat-outline-rail"
            onLayout={handleRailLayout}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={handleGrant}
            onResponderMove={handleMove}
          >
            {prompts.map((prompt, index) => (
              <ChatOutlineTick
                key={prompt.seq}
                isActive={prompt.seq === activeSeq}
                hasAttention={scrubIndex === index}
              />
            ))}
          </View>
          {previewPrompt ? (
            <Pressable
              style={styles.preview}
              testID="chat-outline-preview"
              accessibilityRole="button"
              accessibilityLabel={`${previewPrompt.seq}`}
              onPress={() => handleJump(previewPrompt.seq)}
            >
              <Text style={styles.previewText} numberOfLines={2}>
                {previewPrompt.preview}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

function ChatOutlineTick({
  isActive,
  hasAttention,
}: {
  isActive: boolean;
  hasAttention: boolean;
}) {
  return (
    <View style={styles.slot}>
      <View
        style={[
          styles.pill,
          isActive && styles.pillActive,
          hasAttention && styles.pillAttention,
        ]}
        testID="chat-outline-tick"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panelMeasure: {
    position: "absolute",
    inset: 0,
  },
  railOuter: {
    position: "absolute",
    left: theme.spacing[2],
    top: "10%",
    bottom: "10%",
    width: RAIL_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  rail: {
    width: RAIL_WIDTH,
    flex: 1,
  },
  slot: {
    width: RAIL_WIDTH,
    flexBasis: SLOT_HEIGHT,
    flexShrink: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  pill: {
    width: RESTING_PILL_WIDTH,
    height: RESTING_PILL_HEIGHT,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.borderAccent,
  },
  pillActive: {
    width: ACTIVE_PILL_WIDTH,
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
}));
