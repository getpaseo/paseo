export interface FindShortcutPlatform {
  isMac: boolean;
}

/**
 * The one Find keystroke policy: Command+F on macOS, Control+F everywhere else.
 *
 * Control+F is a macOS text-editing binding that moves the caret forward, so a
 * surface that also claims it there eats a keystroke the text editor owns.
 *
 * The platform is a parameter rather than a lookup because this module is
 * imported by the terminal emulator runtime, which is bundled on its own into
 * the terminal WebView and cannot load React Native. App surfaces pass
 * `findShortcutPlatform()` from `@/pane-find`.
 */
export function isFindShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  platform: FindShortcutPlatform,
): boolean {
  const primaryModifier = platform.isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  return primaryModifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f";
}
