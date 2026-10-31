import type { DictationStatus } from "@/hooks/use-dictation";

export type TerminalDictationLifecycleDecision = "keep" | "cancel" | "discard";

/**
 * What a terminal's dictation does when its pane stops being presented (another
 * tab or terminal selected, workspace left, explorer closed) or another terminal
 * takes the recording. Recording, paused and processing are cancelled, a failed
 * attempt is discarded. Status `recording` also covers a start still acquiring
 * the microphone, because the hook sets it before awaiting the source.
 */
export function resolveTerminalDictationLifecycle(input: {
  isPresented: boolean;
  isRecordingOwner: boolean;
  status: DictationStatus;
}): TerminalDictationLifecycleDecision {
  if (input.status === "idle") {
    return "keep";
  }
  if (input.isPresented && input.isRecordingOwner) {
    return "keep";
  }
  return input.status === "failed" ? "discard" : "cancel";
}

/**
 * True when DOM keyboard focus is inside this pane's terminal surface: the same
 * focus that gives a shortcut the `terminal` scope, so exactly one pane owns it.
 */
export function isTerminalKeyboardOwner(surface: unknown, activeElement: unknown): boolean {
  if (typeof Element === "undefined") {
    return false;
  }
  return (
    surface instanceof Element &&
    activeElement instanceof Element &&
    surface.contains(activeElement)
  );
}
