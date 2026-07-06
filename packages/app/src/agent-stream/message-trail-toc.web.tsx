import { useCallback, useMemo, useRef, useState } from "react";
import { View, Pressable, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ListTree } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";
import type { MessageTrailItem } from "./message-trail-items";

export interface MessageTrailTocProps {
  items: MessageTrailItem[];
  onJumpToMessage: (id: string) => void;
}

const ThemedListIcon = withUnistyles(ListTree);
const iconRestMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const iconActiveMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const TOC_HEADER: SheetHeader = { title: "Jump to message" };

// Floating table of contents shown in place of the tick rail when the pane is too narrow.
// A small bottom-right button opens a plain list of the conversation's user messages;
// picking one scrolls the chat to it. (Search is intentionally left out — it belongs to a
// separate, dedicated search feature.)
export function MessageTrailToc({ items, onJumpToMessage }: MessageTrailTocProps) {
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);

  const options = useMemo<ComboboxOption[]>(
    () => items.map((item) => ({ id: item.id, label: item.preview || `Message ${item.ordinal}` })),
    [items],
  );

  const handleToggle = useCallback(() => setOpen((previous) => !previous), []);

  const handleSelect = useCallback(
    (id: string) => {
      onJumpToMessage(id);
      setOpen(false);
    },
    [onJumpToMessage],
  );

  const buttonStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType) => [
      styles.button,
      hovered && styles.buttonHovered,
      (pressed || open) && styles.buttonPressed,
    ],
    [open],
  );

  return (
    <>
      <View style={styles.floating} pointerEvents="box-none">
        <Pressable
          ref={anchorRef}
          collapsable={false}
          style={buttonStyle}
          onPress={handleToggle}
          accessibilityRole="button"
          accessibilityLabel="Jump to message"
          testID="message-trail-toc"
        >
          <ThemedListIcon size={18} uniProps={open ? iconActiveMapping : iconRestMapping} />
        </Pressable>
      </View>
      <Combobox
        options={options}
        value=""
        onSelect={handleSelect}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={280}
        // Cap the popover to a handful of rows so a long conversation scrolls internally
        // instead of requesting a tall panel that, opening upward from a bottom-anchored
        // button, can reach past the top of a short window/pane.
        desktopFixedHeight={260}
        header={TOC_HEADER}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  floating: {
    position: "absolute",
    right: theme.spacing[3],
    bottom: theme.spacing[4],
  },
  button: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    ...theme.shadow.sm,
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface3,
  },
  buttonPressed: {
    backgroundColor: theme.colors.surface0,
  },
}));
