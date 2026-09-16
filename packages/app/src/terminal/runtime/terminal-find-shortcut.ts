export const isMac =
  typeof navigator !== "undefined" &&
  (/Macintosh|Mac OS/i.test(navigator.userAgent ?? "") ||
    /Mac/i.test((navigator as Navigator & { platform?: string }).platform ?? ""));

export function isFindShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  platform = { isMac },
): boolean {
  const primaryModifier = platform.isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  return primaryModifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f";
}
