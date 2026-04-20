import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Picker from "@emoji-mart/react";
import data from "@emoji-mart/data";
import { useUnistyles } from "react-native-unistyles";
import type { ChatEmojiPickerProps, EmojiPickerAnchor } from "./emoji-picker";

// Width emoji-mart will actually render at: perLine * emojiButtonSize + padding.
// Keep these in sync with the Picker props below.
// We fix both width and height on the wrapper and let emoji-mart's internal
// grid scroll. Emoji-mart's natural height (~650px) blew past the viewport
// when unconstrained.
const PICKER_PER_LINE = 9;
const PICKER_EMOJI_BUTTON_SIZE = 32;
const PICKER_WIDTH = PICKER_PER_LINE * PICKER_EMOJI_BUTTON_SIZE + 24;
const PICKER_HEIGHT = 360;

export function ChatEmojiPicker({ open, onClose, onEmojiSelected, anchor }: ChatEmojiPickerProps) {
  const { theme } = useUnistyles();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPosition(resolvePosition(anchor, vw, vh));
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!containerRef.current || !target) return;
      if (!containerRef.current.contains(target)) onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onPointer);
    }, 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
      clearTimeout(t);
    };
  }, [open, onClose]);

  // Mirror the app's current light/dark palette so the picker doesn't stay
  // dark when the user switched to light mode in Settings.
  const pickerTheme: "light" | "dark" = theme.colorScheme === "light" ? "light" : "dark";

  if (!open || typeof document === "undefined" || !position) return null;

  return createPortal(
    <div
      ref={containerRef}
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        width: PICKER_WIDTH,
        height: PICKER_HEIGHT,
        zIndex: 2_147_483_647,
        borderRadius: 8,
        overflow: "hidden",
        boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
        border: `1px solid ${theme.colors.border}`,
        backgroundColor: theme.colors.surface0,
      }}
    >
      <Picker
        data={data}
        theme={pickerTheme}
        previewPosition="none"
        skinTonePosition="search"
        dynamicWidth={false}
        perLine={PICKER_PER_LINE}
        emojiSize={20}
        emojiButtonSize={PICKER_EMOJI_BUTTON_SIZE}
        maxFrequentRows={2}
        navPosition="top"
        onEmojiSelect={(e: { native?: string }) => {
          if (e?.native) onEmojiSelected(e.native);
        }}
      />
    </div>,
    document.body,
  );
}

function resolvePosition(
  anchor: EmojiPickerAnchor | null | undefined,
  vw: number,
  vh: number,
): { left: number; top: number } {
  const margin = 8;
  if (!anchor) {
    return {
      left: Math.max(margin, vw - PICKER_WIDTH - margin),
      top: Math.max(margin, vh - PICKER_HEIGHT - margin),
    };
  }
  // Slack-style anchor: the picker's bottom-left corner sits at the button's
  // top-left. Picker extends UP and to the RIGHT, so the icon lines up with
  // the bottom-left corner of the picker.
  let left = anchor.x;
  let top = anchor.y - PICKER_HEIGHT;
  if (top < margin) {
    // Not enough room above — open downward from the button's bottom-left.
    top = anchor.y + anchor.height;
    if (top + PICKER_HEIGHT > vh - margin) {
      top = Math.max(margin, vh - PICKER_HEIGHT - margin);
    }
  }
  if (left + PICKER_WIDTH > vw - margin) {
    // Not enough room to the right — right-align picker to the button so it
    // extends to the left instead.
    left = anchor.x + anchor.width - PICKER_WIDTH;
  }
  if (left < margin) left = margin;
  return { left, top };
}
