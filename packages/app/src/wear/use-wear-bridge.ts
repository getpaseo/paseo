/**
 * No-op Wear bridge for every platform except Android.
 *
 * Wear OS only pairs with Android — Google dropped iOS support — so there is no
 * bridge to run on iOS, web, or Electron.
 *
 * This is a Metro platform-extension split rather than a runtime `if`, per the
 * platform gating rules in CLAUDE.md, and it does real work here: it keeps
 * `@getpaseo/expo-wear-bridge` out of the non-Android bundles entirely. Importing
 * it unconditionally made the web bundle resolve an Android-only native module,
 * which broke the desktop build because that module's compiled output is not
 * built on the desktop path.
 *
 * The Android implementation is in use-wear-bridge.android.ts.
 */
export function useWearBridge(): void {
  // Intentionally empty.
}
