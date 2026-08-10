import { UNASSIGNED_COMBO, type ShortcutOverrides } from "@/keyboard/keyboard-shortcuts";

const EMPTY_OVERRIDES: ShortcutOverrides = {};

/** A binding's stored value, or `undefined` to drop its override entirely. */
export type ShortcutOverrideValue = ShortcutOverrides[string] | undefined;

/** Where the override map is persisted. Async and able to fail. */
export interface ShortcutOverrideStorage {
  write(serialized: string): Promise<void>;
  remove(): Promise<void>;
}

/** What the UI renders from. Synchronous and always succeeds. */
export interface ShortcutOverrideCache {
  read(): ShortcutOverrides;
  write(next: ShortcutOverrides): void;
}

export interface ShortcutOverrideStore {
  set(bindingId: string, comboString: string): Promise<void>;
  /** Unassign the shortcut: it keeps a row in Settings but matches nothing. */
  clear(bindingId: string): Promise<void>;
  /** Drop the override entirely, restoring the binding's default combo. */
  remove(bindingId: string): Promise<void>;
  resetAll(): Promise<void>;
}

export interface CreateShortcutOverrideStoreOptions {
  storage: ShortcutOverrideStorage;
  cache: ShortcutOverrideCache;
  onError(err: unknown): void;
}

/**
 * Applies override changes to the cache optimistically and persists them,
 * reverting the cache if the write fails.
 *
 * Operations are serialized: each one runs to completion before the next
 * starts. Two things go wrong without that ordering, and both end with the
 * user's shortcut changing on its own after a restart. Two changes to the same
 * binding can interleave so the earlier one's failure rolls back a value the
 * later one already persisted; and a Reset all can delete a rebind the user
 * made after it, because `remove` and `write` race. Serializing also makes the
 * rollback a whole-map restore again — nothing else can have touched the cache
 * while the write was in flight.
 *
 * The cost is that the second of two rapid changes waits one storage
 * round-trip before its row updates. Every change here comes from a settings
 * row the user has to click through, so that queue is never more than a couple
 * of operations deep.
 */
export function createShortcutOverrideStore({
  storage,
  cache,
  onError,
}: CreateShortcutOverrideStoreOptions): ShortcutOverrideStore {
  let tail: Promise<void> = Promise.resolve();

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const run = tail.then(operation);
    // A rejected tail would wedge every later operation, so the chain that the
    // next caller waits on swallows failures. The returned promise does not.
    tail = run.then(noop, noop);
    return run;
  }

  function commit(bindingId: string, value: ShortcutOverrideValue): Promise<void> {
    return enqueue(async () => {
      const prev = cache.read();
      const next = withOverride(prev, bindingId, value);
      cache.write(next);
      try {
        await storage.write(JSON.stringify(next));
      } catch (err) {
        cache.write(prev);
        onError(err);
      }
    });
  }

  return {
    set: (bindingId, comboString) => commit(bindingId, comboString),
    clear: (bindingId) => commit(bindingId, UNASSIGNED_COMBO),
    remove: (bindingId) => commit(bindingId, undefined),
    resetAll: () =>
      enqueue(async () => {
        const prev = cache.read();
        cache.write(EMPTY_OVERRIDES);
        try {
          await storage.remove();
        } catch (err) {
          cache.write(prev);
          onError(err);
        }
      }),
  };
}

/**
 * `null` (unassigned) and absent (use the default) are distinct states, so
 * dropping an override cannot go through a spread.
 */
export function withOverride(
  overrides: ShortcutOverrides,
  bindingId: string,
  value: ShortcutOverrideValue,
): ShortcutOverrides {
  if (value === undefined) {
    const { [bindingId]: _removed, ...rest } = overrides;
    return rest;
  }
  return { ...overrides, [bindingId]: value };
}

function noop(): void {}
