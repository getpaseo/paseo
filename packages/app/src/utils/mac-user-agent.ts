/**
 * What the browser says about the platform. `getShortcutOs()` is the app's
 * answer for keyboard policy and consults native and Electron first; this is the
 * browser half of it, kept free of React Native imports so the terminal WebView
 * bundle can use it too.
 */
export function isMacUserAgent(): boolean {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent ?? "";
  const platform = (navigator as Navigator & { platform?: string }).platform ?? "";
  return (
    /Macintosh|Mac OS|iPhone|iPad|iPod/i.test(userAgent) || /Mac|iPhone|iPad|iPod/i.test(platform)
  );
}
