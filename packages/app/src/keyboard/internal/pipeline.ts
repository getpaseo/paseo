import {
  resolveKeyboardShortcut,
  type ChordState,
  type KeyboardShortcutContext,
  type KeyboardShortcutMatch,
  type ParsedShortcutBinding,
} from "../keyboard-shortcuts";
import type { KeyboardSourceInput } from "./sources/contract";
import type { createOverlayRegistry } from "./overlays";

interface KeyboardPipelineOptions {
  getContext(): Omit<KeyboardShortcutContext, "focusScope">;
  getBindings(): readonly ParsedShortcutBinding[];
  isCapturing(): boolean;
  dispatch(match: KeyboardShortcutMatch, input: KeyboardSourceInput): boolean;
  overlays: ReturnType<typeof createOverlayRegistry>;
  beforeResolve?(input: KeyboardSourceInput): boolean;
  chordChanged?(previous: ChordState, next: ChordState, input: KeyboardSourceInput | null): void;
}
function emptyChord(): ChordState {
  return { candidateIndices: [], step: 0, timeoutId: null };
}

export function createKeyboardPipeline(options: KeyboardPipelineOptions) {
  let chord = emptyChord();
  function reset() {
    const previous = chord;
    if (chord.timeoutId !== null) clearTimeout(chord.timeoutId);
    chord = emptyChord();
    options.chordChanged?.(previous, chord, null);
  }
  return {
    dispose: reset,
    keyDown(input: KeyboardSourceInput): boolean {
      const event = input.event;
      if (options.overlays.dispatch(event)) return true;
      if (event.isComposing || event.key === "Process" || options.isCapturing()) return false;
      if (options.beforeResolve && !options.beforeResolve(input)) return false;
      const previous = chord;
      const result = resolveKeyboardShortcut({
        event,
        context: { ...options.getContext(), focusScope: input.focusScope },
        bindings: options.getBindings(),
        chordState: chord,
        onChordReset: reset,
      });
      chord = result.nextChordState;
      options.chordChanged?.(previous, chord, input);
      if (result.preventDefault) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (!result.match) return false;
      if (!options.dispatch(result.match, input)) return false;
      if (result.match.preventDefault) event.preventDefault();
      if (result.match.stopPropagation) event.stopPropagation();
      return true;
    },
  };
}
