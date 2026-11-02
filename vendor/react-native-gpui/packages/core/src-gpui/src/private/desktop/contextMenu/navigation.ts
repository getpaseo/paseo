/**
 * Keyboard navigation for one menu level, as a pure reducer.
 *
 * The host owns the timers and the focus; this file owns only the decision. It
 * takes the current highlight, a key and the type-ahead buffer, and returns the
 * next highlight plus what the caller should do (open a submenu, close a level,
 * choose the highlighted row). Separators and disabled rows are skipped here, so
 * every caller gets the same behaviour without repeating the checks.
 *
 * @format
 */

import type { MenuEntry } from './types';
import { entryLabel, isEnabled, isSeparator, isSubmenu } from './types';

/** How long a type-ahead buffer stays alive after its last keystroke. */
export const TYPEAHEAD_TIMEOUT_MS = 600;

export interface NavigationState {
  /** The highlighted row, or -1 when nothing is highlighted. */
  index: number;
  /** What the user has typed, so far, for type-to-select. */
  typed: string;
  /** When `typed` was last extended, on the caller's clock. */
  typedAt: number;
}

export type NavigationAction =
  'none' | 'openSubmenu' | 'closeLevel' | 'activate';

export interface NavigationInput {
  items: MenuEntry[];
  key: string;
  state: NavigationState;
  /**
   * The caller's clock. Leave it out to keep the type-ahead buffer alive; pass
   * `Date.now()` from a component and the buffer expires on its own.
   */
  now?: number;
  /** Held modifiers. A command or control shortcut is never type-ahead. */
  modifiers?: { alt?: boolean; ctrl?: boolean; meta?: boolean };
}

export interface NavigationResult {
  state: NavigationState;
  action: NavigationAction;
}

export const EMPTY_NAVIGATION: NavigationState = {
  index: -1,
  typed: '',
  typedAt: 0,
};

/** The keys are GPUI's spellings, with the DOM names accepted as aliases. */
function normaliseKey(key: string): string {
  const lower = key.toLowerCase();
  switch (lower) {
    case 'arrowup':
      return 'up';
    case 'arrowdown':
      return 'down';
    case 'arrowleft':
      return 'left';
    case 'arrowright':
      return 'right';
    case 'return':
      return 'enter';
    case 'esc':
      return 'escape';
    case ' ':
    case 'space':
    case 'spacebar':
      return 'space';
    default:
      return lower;
  }
}

/** Only a row that can be chosen: not a separator and not disabled. */
export function canHighlight(items: MenuEntry[], index: number): boolean {
  if (index < 0 || index >= items.length) {
    return false;
  }
  return isEnabled(items[index]);
}

/**
 * The next highlighted row in `direction`, wrapping at both ends.
 *
 * Wrapping is what a menu does at its edges, and skipping keeps a disabled row
 * or a separator from ever becoming the highlight. Starting from -1 in either
 * direction lands on the first (or last) selectable row, so the first Down press
 * on a newly opened menu highlights the top row rather than the second.
 */
export function nextEnabledIndex(
  items: MenuEntry[],
  from: number,
  direction: 1 | -1,
): number {
  const count = items.length;
  if (count === 0) {
    return -1;
  }
  // `-1` means "nothing highlighted yet". Going up from there has to land on the
  // last row, so the walk starts just past the end rather than at -1, which would
  // wrap to the second-to-last row.
  let index = from >= 0 ? from : direction === 1 ? -1 : count;
  // Walk at most one full cycle, so a level with no selectable rows terminates.
  for (let step = 0; step < count; step += 1) {
    index = (index + direction + count) % count;
    if (isEnabled(items[index])) {
      return index;
    }
  }
  return -1;
}

export function firstEnabledIndex(items: MenuEntry[]): number {
  return nextEnabledIndex(items, -1, 1);
}

export function lastEnabledIndex(items: MenuEntry[]): number {
  return nextEnabledIndex(items, 0, -1);
}

/**
 * Type-to-select: the first selectable row whose label starts with `typed`.
 *
 * A fresh single character starts searching after the highlight so that pressing
 * the same letter again cycles through the rows sharing it; extending an
 * existing buffer searches from the top, because the user is narrowing a match
 * rather than asking for the next one. A row already matching is kept when the
 * buffer grows, which is what makes "e" then "d" stay on "Edit" instead of
 * jumping to a later "Edge" row.
 */
export function typeaheadIndex(
  items: MenuEntry[],
  typed: string,
  from: number,
  extended: boolean,
): number {
  const needle = typed.toLowerCase();
  if (needle.length === 0) {
    return from;
  }
  if (extended && from >= 0 && from < items.length) {
    const current = items[from];
    if (
      isEnabled(current) &&
      entryLabel(current).toLowerCase().startsWith(needle)
    ) {
      return from;
    }
  }
  const start = extended ? 0 : from + 1;
  const count = items.length;
  for (let step = 0; step < count; step += 1) {
    const index = (start + step) % count;
    const entry = items[index];
    if (!isEnabled(entry) || isSeparator(entry)) {
      continue;
    }
    if (entryLabel(entry).toLowerCase().startsWith(needle)) {
      return index;
    }
  }
  return from;
}

/**
 * Whether a printable character is type-ahead rather than a shortcut. The
 * space key is excluded: it chooses the highlighted row, which is the native
 * menu behaviour.
 */
function isTypeaheadKey(key: string): boolean {
  return key.length === 1 && key !== ' ' && key.trim().length > 0;
}

export function navigate({
  items,
  key,
  state,
  now,
  modifiers,
}: NavigationInput): NavigationResult {
  const pressed = normaliseKey(key);
  if (modifiers?.alt || modifiers?.ctrl || modifiers?.meta) {
    return { state, action: 'none' };
  }

  switch (pressed) {
    case 'up':
      return {
        state: {
          index: nextEnabledIndex(items, state.index, -1),
          typed: '',
          typedAt: 0,
        },
        action: 'none',
      };
    case 'down':
      return {
        state: {
          index: nextEnabledIndex(items, state.index, 1),
          typed: '',
          typedAt: 0,
        },
        action: 'none',
      };
    case 'home':
      return {
        state: { index: firstEnabledIndex(items), typed: '', typedAt: 0 },
        action: 'none',
      };
    case 'end':
      return {
        state: { index: lastEnabledIndex(items), typed: '', typedAt: 0 },
        action: 'none',
      };
    case 'right':
      // The caller decides whether the submenu actually opens; a row without
      // one leaves the highlight alone.
      return {
        state: { ...state, index: state.index },
        action:
          state.index >= 0 && isSubmenu(items[state.index])
            ? 'openSubmenu'
            : 'none',
      };
    case 'left':
    case 'escape':
      return { state, action: 'closeLevel' };
    case 'enter':
    case 'space': {
      const entry = state.index >= 0 ? items[state.index] : undefined;
      if (entry == null || !isEnabled(entry)) {
        return { state, action: 'none' };
      }
      return {
        state,
        action: isSubmenu(entry) ? 'openSubmenu' : 'activate',
      };
    }
    default:
      break;
  }

  if (!isTypeaheadKey(key)) {
    return { state, action: 'none' };
  }

  const expired =
    now == null ||
    state.typed === '' ||
    now - state.typedAt > TYPEAHEAD_TIMEOUT_MS;
  const typed = expired ? key : state.typed + key;
  const index = typeaheadIndex(items, typed, state.index, !expired);
  return {
    state: {
      index,
      typed,
      // Without a clock there is nothing to expire against; the caller's next
      // call with a clock then starts a fresh buffer.
      typedAt: now ?? state.typedAt,
    },
    action: 'none',
  };
}
