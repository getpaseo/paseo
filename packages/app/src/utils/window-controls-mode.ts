export type MiddleControlMode = "maximize" | "restore" | "restore-fullscreen";

/**
 * Windows has no macOS-style fullscreen state with its own affordance: the caption buttons are
 * minimise, maximise and close, and the maximised button is called Restore. F11 (the View menu's
 * togglefullscreen role) can still put the window in fullscreen, and the OS then reports
 * `isMaximized() === false` even though the window fills the screen. Keying the middle control
 * off maximised alone therefore offered "Maximize" on an already-full window.
 *
 * So both large states present the same Restore button, in Windows' own vocabulary. Only the
 * action differs, because leaving fullscreen is not the same call as unmaximising.
 *
 * Lives outside the component so it can be tested without pulling React Native through the
 * test transform.
 */
export function resolveMiddleControlMode(input: {
  maximized: boolean;
  fullscreen: boolean;
}): MiddleControlMode {
  if (input.fullscreen) return "restore-fullscreen";
  return input.maximized ? "restore" : "maximize";
}

export const MIDDLE_CONTROL_LABEL: Record<MiddleControlMode, string> = {
  maximize: "Maximize",
  restore: "Restore",
  "restore-fullscreen": "Restore",
};

/** Both restore states draw the same glyph, because they read the same to the user. */
export function isRestoreMode(mode: MiddleControlMode): boolean {
  return mode === "restore" || mode === "restore-fullscreen";
}
