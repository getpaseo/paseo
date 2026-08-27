import type { ShortcutKey } from "@/utils/format-shortcut";

/**
 * The combos a `Shortcut` should render, or `null` when it should render
 * nothing at all.
 *
 * `keys={[]}` is the trap this exists to close: it wraps to `[[]]`, whose first
 * element is an empty array — truthy — so a first-element check waves it
 * through and an empty badge pill renders. A shortcut with no keys, whether the
 * user unassigned it or it ships without a default combo, has to produce no
 * element at all.
 */
export function normalizeDisplayChord(
  chord?: ShortcutKey[][],
  keys?: ShortcutKey[],
): ShortcutKey[][] | null {
  const combos = chord ?? (keys ? [keys] : []);
  if (combos.length === 0) {
    return null;
  }
  // A chord with an empty step cannot be drawn honestly: rendering it would
  // show a blank pill, and dropping the step would advertise a shorter
  // sequence than the one that actually fires.
  if (combos.some((combo) => combo.length === 0)) {
    return null;
  }
  return combos;
}
