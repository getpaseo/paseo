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
/** Coordinates of the pointerup that armed the suppression; null when nothing is armed. */
let suppressionPointer: { clientX: number; clientY: number } | null = null;
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

/** Client coordinates and click detail carried by a pointer- or click-derived event. */
function eventPoint(
  event: unknown,
): { clientX: number; clientY: number; detail: number; type: string } | null {
  const native = (event as { nativeEvent?: unknown } | undefined)?.nativeEvent ?? event;
  const candidate = native as
    | { clientX?: unknown; clientY?: unknown; detail?: unknown; type?: unknown }
    | undefined;
  if (
    !candidate ||
    typeof candidate.clientX !== "number" ||
    typeof candidate.clientY !== "number"
  ) {
    return null;
  }
  return {
    clientX: candidate.clientX,
    clientY: candidate.clientY,
    detail: typeof candidate.detail === "number" ? candidate.detail : 0,
    type: typeof candidate.type === "string" ? candidate.type : "",
  };
}

/**
 * React-native-web's responder system never delivers a press for a Ctrl-keyed click
 * (`isPrimaryPointerDown` rejects Ctrl the way it rejects right-clicks, because Ctrl+click is
 * the Mac context-menu gesture), so the press handler cannot be where modifier clicks are
 * handled. The row container instead snapshots the intent at `onPointerDown` and applies it at
 * `onPointerUp`, and flags the press so the synthesized one — which react-native-web invokes
 * from the later `click` event — knows the click was already handled.
 *
 * On web the handler receives the raw DOM PointerEvent, which carries the modifier flags; the
 * synthetic React Native type does not, so the flags are read defensively.
 */
export function captureWorkspaceRowPointerModifiers(event: unknown): void {
  // A new pointer gesture supersedes any press the previous one armed but never delivered.
  suppressionPointer = null;
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
 * plain click. A returned intent also arms the press suppression, because the synthesized press
 * still arrives for Shift clicks. Pass the pointerup event so the armed suppression carries the
 * coordinates the matching `click` will repeat.
 */
export function consumeWorkspaceRowPointerUpIntent(
  event?: unknown,
): WorkspaceRowPressIntent | null {
  const intent = pendingIntent;
  pendingIntent = null;
  if (intent !== null) {
    const point = eventPoint(event);
    suppressionPointer = point
      ? { clientX: point.clientX, clientY: point.clientY }
      : { clientX: Number.NaN, clientY: Number.NaN };
  }
  return intent;
}

/**
 * True when this press is the synthesized one for a pointerup that already applied the intent;
 * consumes the flag. React-native-web delivers pointer presses as `click` events, which repeat
 * the pointerup's coordinates; keyboard activation (Enter/Space) dispatches a `click` with
 * `detail` 0 and no coordinates, so it bypasses the suppression instead of being swallowed.
 */
export function consumeWorkspaceRowPressSuppression(event?: unknown): boolean {
  if (!suppressionPointer) {
    return false;
  }
  const point = eventPoint(event);
  if (!point || point.detail === 0 || point.type === "keydown") {
    // A keyboard press is never the pointer's synthesized press; leave the flag alone so the
    // interaction's own click — if the browser still delivers one — is still matched.
    return false;
  }
  const matches =
    point.clientX === suppressionPointer.clientX && point.clientY === suppressionPointer.clientY;
  suppressionPointer = null;
  return matches;
}
