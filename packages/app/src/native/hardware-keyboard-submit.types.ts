export type HardwareKeyboardSendShortcut = "enter" | "mod-enter";

export interface HardwareKeyboardSubmitEvent {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}
