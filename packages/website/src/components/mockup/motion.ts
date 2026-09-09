/**
 * Motion presets, hoisted to module scope because a fresh object literal in a
 * JSX prop re-renders the subtree on every parent render (and the lint rule that
 * enforces it).
 *
 * The mockup only ever cross-fades and resizes. No springs — a hero that bounces
 * reads as a toy.
 */
export const FADE_IN = { opacity: 1 };
export const FADE_OUT = { opacity: 0 };

const EASE_OUT: [number, number, number, number] = [0.22, 0.61, 0.36, 1];

export const MOCKUP_TRANSITION = { duration: 0.34, ease: EASE_OUT };
export const INSTANT_TRANSITION = { duration: 0 };
