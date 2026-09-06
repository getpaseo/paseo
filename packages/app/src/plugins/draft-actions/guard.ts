/**
 * Invalidation counter shared by the draft-action buttons of one composer
 * surface.
 *
 * A press captures the current generation; the surface invalidates the
 * generation whenever its inputs change. A late transform result only writes
 * when its captured generation is still current, so a result that resolves
 * after the surface moved on (draft edited or sent, another action pressed,
 * composer locked for submission) never clobbers newer input.
 */
export interface PluginDraftActionGuard {
  /** Capture the current generation. Also invalidates earlier captures. */
  capture(): number;
  /** Invalidate every outstanding capture. */
  invalidate(): void;
  /** Whether a captured generation is still current. */
  isCurrent(generation: number): boolean;
}

export function createPluginDraftActionGuard(): PluginDraftActionGuard {
  let generation = 0;
  return {
    capture() {
      return ++generation;
    },
    invalidate() {
      generation++;
    },
    isCurrent(captured) {
      return captured === generation;
    },
  };
}
