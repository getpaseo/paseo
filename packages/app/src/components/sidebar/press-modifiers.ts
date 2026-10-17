import { Platform } from "react-native";

/**
 * Which non-navigating thing a workspace-row press means, decided by the pointer modifiers held
 * at pointerdown. `toggle` is Cmd on Apple platforms and Ctrl elsewhere; `range` is Shift.
 */
export type WorkspaceRowPressIntent = { kind: "toggle" } | { kind: "range" };

/** Pure decision so the platform split (Cmd vs Ctrl) is testable without a browser. */
export function resolveWorkspaceRowPressIntent(input: {
  applePlatform: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): WorkspaceRowPressIntent | null {
  if (input.shiftKey) return { kind: "range" };
  const multiSelect = input.applePlatform ? input.metaKey : input.ctrlKey;
  if (multiSelect) return { kind: "toggle" };
  return null;
}

let pendingIntent: WorkspaceRowPressIntent | null = null;
let handledAtPointerUp = false;
let applePlatformOverrideForTests: boolean | null = null;

function isApplePlatform(): boolean {
  if (applePlatformOverrideForTests !== null) {
    return applePlatformOverrideForTests;
  }
  if (Platform.OS !== "web") return false;
  return (
    typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent ?? "")
  );
}

/**
 * Tests inject the platform instead of monkey-patching `navigator`, which the repository
 * forbids. Pass null to return to real detection.
 */
export function setApplePlatformOverrideForTests(applePlatform: boolean | null): void {
  applePlatformOverrideForTests = applePlatform;
}

/**
 * React-native-web's responder system never delivers a press for a Ctrl-keyed click
 * (`isPrimaryPointerDown` rejects Ctrl the way it rejects right-clicks, because Ctrl+click is
 * the Mac context-menu gesture), so the press handler cannot be where modifier clicks are
 * handled. The row container instead snapshots the intent at `onPointerDown` and applies it at
 * `onPointerUp`, and flags the press so the synthesized one — which still arrives for Shift —
 * knows the click was already handled.
 *
 * On web the handler receives the raw DOM PointerEvent, which carries the modifier flags; the
 * synthetic React Native type does not, so the flags are read defensively.
 */
export function captureWorkspaceRowPointerModifiers(event: unknown): void {
  const modifiers = event as {
    button?: number | null;
    ctrlKey?: boolean | null;
    metaKey?: boolean | null;
    shiftKey?: boolean | null;
  };
  // Only the primary button edits the selection: Ctrl+right-click is the context-menu gesture on
  // Windows/Linux and must leave the selection exactly as it is.
  if (modifiers.button != null && modifiers.button !== 0) {
    pendingIntent = null;
    return;
  }
  pendingIntent = resolveWorkspaceRowPressIntent({
    applePlatform: isApplePlatform(),
    ctrlKey: modifiers.ctrlKey === true,
    metaKey: modifiers.metaKey === true,
    shiftKey: modifiers.shiftKey === true,
  });
}

/**
 * Pointer came up on the row: return the captured intent for the caller to apply, or null for a
 * plain click. A returned intent also arms the press suppression, because Shift clicks still
 * synthesize a press after this.
 */
export function consumeWorkspaceRowPointerUpIntent(): WorkspaceRowPressIntent | null {
  const intent = pendingIntent;
  pendingIntent = null;
  handledAtPointerUp = intent !== null;
  return intent;
}

/** True when the pointerup already applied this press's intent; consumes the flag. */
export function consumeWorkspaceRowPressSuppression(): boolean {
  const suppressed = handledAtPointerUp;
  handledAtPointerUp = false;
  return suppressed;
}
