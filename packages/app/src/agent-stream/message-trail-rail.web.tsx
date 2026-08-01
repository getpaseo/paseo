import { memo, useCallback } from "react";
import { Pressable, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MessageTrailRailProps } from "./message-trail-rail";

export const MessageTrailRail = memo(function MessageTrailRail({
  prompts,
  onJumpToPrompt,
}: MessageTrailRailProps) {
  if (prompts.length < 2) return null;

  return (
    <View style={styles.rail} role="tablist" testID="message-trail-rail">
      {prompts.map((prompt, index) => (
        <MessageTrailTick
          key={prompt.seq}
          seq={prompt.seq}
          label={`${index + 1} of ${prompts.length}: ${prompt.preview}`}
          onJumpToPrompt={onJumpToPrompt}
        />
      ))}
    </View>
  );
});

function tickStyle({ hovered }: PressableStateCallbackType) {
  return [styles.hitTarget, hovered && styles.hovered];
}

const MessageTrailTick = memo(function MessageTrailTick({
  seq,
  label,
  onJumpToPrompt,
}: {
  seq: number;
  label: string;
  onJumpToPrompt: (seq: number) => void;
}) {
  const onPress = useCallback(() => onJumpToPrompt(seq), [onJumpToPrompt, seq]);
  return (
    <Pressable
      style={tickStyle}
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityLabel={label}
      testID={`message-trail-tick-${seq}`}
    >
      <View style={styles.tick} />
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  rail: {
    display: { xs: "none", lg: "flex" },
    position: "absolute",
    left: theme.spacing[4],
    top: "10%",
    bottom: "10%",
    width: 28,
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
    zIndex: 2,
  },
  hitTarget: {
    width: 28,
    minHeight: 5,
    flexShrink: 1,
    alignItems: "center",
    justifyContent: "center",
    opacity: 0.45,
  },
  hovered: {
    opacity: 1,
  },
  tick: {
    width: 8,
    height: 2,
    borderRadius: 1,
    backgroundColor: theme.colors.foregroundMuted,
  },
}));
