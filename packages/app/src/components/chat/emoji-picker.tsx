/**
 * Cross-platform emoji picker.
 *
 * Metro picks the right implementation:
 *   • `emoji-picker.web.tsx` — compact Slack-style popover via `emoji-mart`
 *   • `emoji-picker.native.tsx` — bottom sheet via `rn-emoji-keyboard`
 *
 * Only types + the default export should live in this shared module so the
 * two implementations stay behind the same import path.
 */

export interface EmojiPickerAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChatEmojiPickerProps {
  open: boolean;
  onClose: () => void;
  onEmojiSelected: (emoji: string) => void;
  /**
   * Viewport-relative rect of the element that opened the picker. Used by the
   * web popover to position itself next to the trigger; ignored on native.
   */
  anchor?: EmojiPickerAnchor | null;
}
