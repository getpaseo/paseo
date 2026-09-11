import { useCallback, useId, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  StyleSheet as RNStyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Animated, { FadeIn, FadeOut, useReducedMotion } from "react-native-reanimated";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MAX_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { PROMPT_JUMP_TOP_INSET_PX } from "../prompt-jump-settle";
import type { PinnedPromptResolution } from "./model";
import type { PinnedPromptProps } from "./pinned-prompt";

const PINNED_PROMPT_SCALE = 0.7;
const PINNED_PROMPT_MAX_LINES = 5;
const CONTENT_LINE_HEIGHT_RATIO = 1.4;
const PINNED_PROMPT_BACKDROP_BLUR_PX = 12;

// The animated shell is the rail's flex child, so the width cap has to live here: a `flexShrink`
// on the bubble inside it would only ever be measured against the shell's own content width.
// Plain RN styles on purpose — see docs/unistyles.md on Reanimated + Unistyles styles.
const shellStyles = RNStyleSheet.create({
  shell: {
    minWidth: 0,
    maxWidth: "100%",
    flexShrink: 1,
  },
});

export function PinnedPrompt({ pinnedId, promptById, onJumpToPrompt }: PinnedPromptProps) {
  const pinnedItemId = useSyncExternalStore(pinnedId.subscribe, pinnedId.getValue);
  const isCompact = useIsCompactFormFactor();
  const prompt = pinnedItemId === null ? null : (promptById.get(pinnedItemId) ?? null);
  // A pinned header would eat a phone viewport, where the transcript is already the whole screen.
  if (isCompact) {
    return null;
  }
  // The layer stays mounted across pins so the bubble's exit animation has a parent to run under.
  // Keying the bubble on the prompt resets its overflow measurement, so a short prompt following a
  // long one never inherits its fade.
  return (
    <View style={styles.layer} pointerEvents="box-none">
      <View style={styles.rail} pointerEvents="box-none">
        {prompt ? (
          <PinnedPromptBubble key={prompt.id} prompt={prompt} onJumpToPrompt={onJumpToPrompt} />
        ) : null}
      </View>
    </View>
  );
}

function PinnedPromptBubble({
  prompt,
  onJumpToPrompt,
}: {
  prompt: PinnedPromptResolution;
  onJumpToPrompt: (itemId: string) => void;
}) {
  const { t } = useTranslation();
  const prefersReducedMotion = useReducedMotion();
  const [clipHeight, setClipHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);

  // A retained agent tab is hidden with `display: none`, which reports a zero-height layout. Keep
  // the last real measurement rather than publishing hidden geometry.
  const handleClipLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) {
      setClipHeight(height);
    }
  }, []);
  const handleContentLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (height > 0) {
      setContentHeight(height);
    }
  }, []);
  const handlePress = useCallback(() => onJumpToPrompt(prompt.id), [onJumpToPrompt, prompt.id]);

  // `overflow: hidden` on the clip box does not shrink its child's box, so the inner view reports
  // the prompt's full height even while the clip box is capped.
  const isOverflowing = clipHeight > 0 && contentHeight > clipHeight;

  return (
    <Animated.View
      style={shellStyles.shell}
      entering={prefersReducedMotion ? undefined : FadeIn.duration(140)}
      exiting={prefersReducedMotion ? undefined : FadeOut.duration(140)}
    >
      <Pressable
        style={styles.bubble}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={t("agentStream.pinnedPrompt.jump")}
        testID="pinned-prompt"
      >
        <View style={styles.clip} onLayout={handleClipLayout}>
          <View onLayout={handleContentLayout}>
            <Text style={styles.text}>{prompt.text}</Text>
          </View>
        </View>
        {isOverflowing ? <PinnedPromptFade /> : null}
      </Pressable>
    </Animated.View>
  );
}

function PinnedPromptFadeSvg({ gradientId, color }: { gradientId: string; color: string }) {
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
          {/* Vary opacity rather than interpolating toward `transparent`, which crosses black in
              some engines and leaves a grey fringe. */}
          <Stop offset="0%" stopColor={color} stopOpacity={0} />
          <Stop offset="100%" stopColor={color} stopOpacity={1} />
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

const ThemedPinnedPromptFadeSvg = withUnistyles(PinnedPromptFadeSvg);
// The fade ends on the bubble's own translucent color; an opaque stop would paint a solid patch
// on a glass surface. SVG honours the alpha in an rgba `stop-color`.
const bubbleColorMapping = (theme: Theme) => ({ color: theme.colors.surfaceGlass });

/**
 * Fades the clipped tail of the prompt into the bubble. It sits inside the bubble's padding so the
 * rounded bottom corners stay opaque — fading the bubble itself would dissolve its shape into the
 * transcript scrolling underneath.
 */
function PinnedPromptFade() {
  // React-generated ids contain characters that are invalid inside SVG fragment references.
  const gradientId = `pinned-prompt-fade-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <View style={styles.fade} pointerEvents="none" testID="pinned-prompt-fade">
      <ThemedPinnedPromptFadeSvg gradientId={gradientId} uniProps={bubbleColorMapping} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  // Matches the real bubble's web line height in components/message.tsx.
  const lineHeight = Math.round(theme.fontSize.content * CONTENT_LINE_HEIGHT_RATIO);
  return {
    // An absolutely positioned sibling of the transcript, so the scroll container's content box
    // never changes and the bottom-anchor controller never sees the pin.
    layer: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      alignItems: "center",
      // The scaled bubble's top-right corner stays at its layout corner, so matching the jump
      // inset lands the real message exactly where the pin was and the pin un-zooms in place.
      paddingTop: PROMPT_JUMP_TOP_INSET_PX,
    },
    // The transcript's own content rail, right-aligned like the real user bubble.
    rail: {
      width: "100%",
      maxWidth: MAX_CONTENT_WIDTH,
      paddingHorizontal: theme.spacing[2],
      flexDirection: "row",
      justifyContent: "flex-end",
    },
    bubble: {
      // Translucent over a blurred backdrop, so the transcript scrolling underneath reads as depth
      // rather than as text bleeding through. `_web` is Unistyles' typed escape hatch for CSS
      // that React Native has no name for; this file is web-only.
      backgroundColor: theme.colors.surfaceGlass,
      _web: {
        backdropFilter: `blur(${PINNED_PROMPT_BACKDROP_BLUR_PX}px)`,
        WebkitBackdropFilter: `blur(${PINNED_PROMPT_BACKDROP_BLUR_PX}px)`,
      },
      borderRadius: theme.borderRadius["2xl"],
      borderTopRightRadius: theme.borderRadius.sm,
      paddingHorizontal: theme.spacing[4],
      paddingVertical: theme.spacing[4],
      // The shell above owns the width cap; the bubble fills it, so a wrapped prompt is never wider
      // than the real message's rail and the scale leaves it at 70% of the content width at most.
      minWidth: 0,
      transform: [{ scale: PINNED_PROMPT_SCALE }],
      // Scale toward the top-right corner so the right edge stays on the rail whatever the
      // bubble's width. CSS string form on purpose: Unistyles' web converter only translates
      // `transform` arrays, so RN's array origin would reach the DOM verbatim and fall back to
      // center. This file is web-only, so the native array concern does not apply.
      transformOrigin: "100% 0",
      cursor: "pointer",
      // Large, low-alpha shadow so the pin reads as floating over the transcript without a hard
      // edge against it.
      ...theme.shadow.lg,
    },
    clip: {
      maxHeight: lineHeight * PINNED_PROMPT_MAX_LINES,
      overflow: "hidden",
    },
    text: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.content,
      lineHeight,
      overflowWrap: "anywhere",
      // The pin sits inside AssistantSelectionCopySurface, which serializes the DOM selection on
      // copy. Selectable pinned text would silently duplicate the prompt in the clipboard.
      userSelect: "none",
    },
    fade: {
      position: "absolute",
      left: theme.spacing[4],
      right: theme.spacing[4],
      bottom: theme.spacing[4],
      height: Math.round(lineHeight * 1.5),
    },
  };
});
