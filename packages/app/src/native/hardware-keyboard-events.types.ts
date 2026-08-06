export interface HardwareKeyDownEvent {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Hardware auto-repeat (Android reports it; iOS pressesBegan never repeats). */
  repeat?: boolean;
}
