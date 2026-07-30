/**
 * App-global microphone lease.
 *
 * Three features want the microphone — provider-agnostic voice mode, dictation,
 * and Live Voice — and on every platform only one of them can hold it at a time.
 * Rather than have each feature probe the others, they all acquire this lease
 * first. Phase 1 policy is strict rejection: `acquire` returns `null` while
 * another owner holds the lease and never interrupts the incumbent.
 *
 * `acquire`/`release` are synchronous so the check-and-take is atomic with
 * respect to any interleaved async work in the callers.
 */

export type AudioSessionOwner = "voiceMode" | "dictation" | "liveVoice";

/**
 * Opaque proof of ownership. Holding a stale token is harmless: `release` only
 * clears the lease when the token is the one currently held, so a late cleanup
 * from a previous owner can't steal the lease out from under the current one.
 */
export interface AudioSessionLeaseToken {
  readonly owner: AudioSessionOwner;
  readonly id: number;
}

export interface AudioSessionLease {
  acquire(owner: AudioSessionOwner): AudioSessionLeaseToken | null;
  release(token: AudioSessionLeaseToken | null | undefined): void;
  current(): AudioSessionOwner | null;
  /** Reentrant check: is this exact token still the live lease? */
  isHeldBy(token: AudioSessionLeaseToken | null | undefined): boolean;
  subscribe(listener: () => void): () => void;
  getSnapshot(): AudioSessionOwner | null;
}

export function createAudioSessionLease(): AudioSessionLease {
  let held: AudioSessionLeaseToken | null = null;
  let nextId = 1;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A broken subscriber must not wedge the lease.
      }
    }
  }

  return {
    acquire(owner) {
      if (held) {
        // Reentrant acquisition by the same owner would let a second start path
        // inside one feature run concurrently with the first, so it is refused
        // too. Features that legitimately restart must release first.
        return null;
      }
      held = { owner, id: nextId++ };
      notify();
      return held;
    },

    release(token) {
      if (!token || !held || held.id !== token.id) {
        return;
      }
      held = null;
      notify();
    },

    current() {
      return held?.owner ?? null;
    },

    isHeldBy(token) {
      return Boolean(token && held && held.id === token.id);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot() {
      return held?.owner ?? null;
    },
  };
}

/**
 * The one lease every audio feature shares. Module-level rather than
 * context-provided: dictation lives in a hook far from the voice provider tree,
 * and there is exactly one microphone per app process either way.
 */
export const audioSessionLease: AudioSessionLease = createAudioSessionLease();
