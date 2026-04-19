import EmojiPicker, { type EmojiType } from "rn-emoji-keyboard";
import { useUnistyles } from "react-native-unistyles";
import type { ChatEmojiPickerProps } from "./emoji-picker";

/**
 * Native (iOS/Android) variant: bottom sheet with full emoji database.
 * The popover approach used on web isn't idiomatic on mobile.
 */
export function ChatEmojiPicker({
  open,
  onClose,
  onEmojiSelected,
}: ChatEmojiPickerProps) {
  const { theme } = useUnistyles();
  return (
    <EmojiPicker
      open={open}
      onClose={onClose}
      onEmojiSelected={(e: EmojiType) => onEmojiSelected(e.emoji)}
      enableSearchBar
      enableRecentlyUsed
      categoryPosition="top"
      emojiSize={22}
      expandable={false}
      defaultHeight="55%"
      theme={{
        backdrop: "#00000066",
        knob: theme.colors.surface2,
        container: theme.colors.surface0,
        header: theme.colors.foreground,
        skinTonesContainer: theme.colors.surface1,
        category: {
          icon: theme.colors.foregroundMuted,
          iconActive: theme.colors.foreground,
          container: theme.colors.surface1,
          containerActive: theme.colors.primary,
        },
        search: {
          text: theme.colors.foreground,
          placeholder: theme.colors.foregroundMuted,
          icon: theme.colors.foregroundMuted,
          background: theme.colors.surface1,
        },
        emoji: {
          selected: theme.colors.primary,
        },
      }}
    />
  );
}
