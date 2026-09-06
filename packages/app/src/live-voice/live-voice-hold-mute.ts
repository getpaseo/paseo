/**
 * The call state the hold controller reads and drives. Kept to this shape so the
 * controller never captures a snapshot: a call outlives individual renders, and
 * every phase must be read at the moment the key moves.
 */
export interface LiveVoiceHoldMuteTarget {
  /** Whether a call is live and can accept a mute change right now. */
  isActive(): boolean;
  isMuted(): boolean;
  setMuted(muted: boolean): void;
}

export interface LiveVoiceHoldMuteController {
  /**
   * The chord went down. Inverts the call's mute state and remembers what to
   * restore. Returns whether the action was consumed; a repeat press while the
   * chord is already held is consumed but changes nothing.
   */
  press(): boolean;
  /** The chord came up. Restores the mute state captured at press. */
  release(): boolean;
  /**
   * The call this hold applied to is gone. Drops the captured state so a later
   * release cannot push a dead call's mute value onto a different one.
   */
  cancel(): void;
  isHeld(): boolean;
}

export function createLiveVoiceHoldMuteController(
  target: LiveVoiceHoldMuteTarget,
): LiveVoiceHoldMuteController {
  // The mute value to restore on release, or null when the chord is not held.
  let restoreMuted: boolean | null = null;

  return {
    press() {
      if (restoreMuted !== null) {
        return true;
      }
      if (!target.isActive()) {
        return false;
      }
      restoreMuted = target.isMuted();
      target.setMuted(!restoreMuted);
      return true;
    },

    release() {
      if (restoreMuted === null) {
        return false;
      }
      const muted = restoreMuted;
      restoreMuted = null;
      // The call can end mid-hold. Restoring into a dead call is a no-op in the
      // runtime, but checking here keeps that contract local.
      if (!target.isActive()) {
        return true;
      }
      target.setMuted(muted);
      return true;
    },

    cancel() {
      restoreMuted = null;
    },

    isHeld() {
      return restoreMuted !== null;
    },
  };
}
