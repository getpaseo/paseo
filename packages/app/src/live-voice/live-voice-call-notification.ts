/**
 * Keeps the ongoing call notification in step with the runtime.
 *
 * The notification is posted and torn down by the native foreground service,
 * which is bound to the background session's lifetime — not by this module. What
 * happens here is the other two halves: pushing state into a notification that
 * already exists, and turning its buttons back into runtime calls.
 *
 * Only a `background` call has a notification. A `foreground` call ends when the
 * app leaves the screen, so a persistent control for it would outlive the thing
 * it controls.
 */

import {
  subscribeLiveVoiceBackgroundCallActions,
  updateLiveVoiceBackgroundCall,
  type LiveVoiceBackgroundCallAction,
} from "@/live-voice/background-call-lifetime";
import type { LiveVoiceRuntime, LiveVoiceSnapshot } from "@/live-voice/live-voice-runtime";

export interface LiveVoiceNotificationState {
  /** Whether a notification is up, so state changes have somewhere to land. */
  isPresented: boolean;
  /** Last mute value pushed. Meaningless while `isPresented` is false. */
  isMuted: boolean;
}

export interface LiveVoiceNotificationUpdate {
  isMuted: boolean;
}

export const initialLiveVoiceNotificationState: LiveVoiceNotificationState = {
  isPresented: false,
  isMuted: false,
};

function hasNotification(snapshot: LiveVoiceSnapshot): boolean {
  return snapshot.phase === "active" && snapshot.sessionMode === "background";
}

/**
 * Edge-triggered like the cue latch: the runtime republishes a snapshot for every
 * transcript line, so pushing on each one would rebuild the notification dozens of
 * times a minute for nothing.
 */
export function advanceLiveVoiceNotificationState(
  state: LiveVoiceNotificationState,
  snapshot: LiveVoiceSnapshot,
): { state: LiveVoiceNotificationState; update: LiveVoiceNotificationUpdate | null } {
  const isPresented = hasNotification(snapshot);
  if (!isPresented) {
    // The service takes its own notification down; nothing to push on the way out.
    return { state: initialLiveVoiceNotificationState, update: null };
  }

  const isMuted = snapshot.isMuted;
  if (state.isPresented && state.isMuted === isMuted) {
    return { state, update: null };
  }
  // The first snapshot of a call pushes even when unmuted: the service posted its
  // notification from a default, and this is what confirms that default is right.
  return { state: { isPresented: true, isMuted }, update: { isMuted } };
}

export interface LiveVoiceCallNotificationPresenter {
  update(params: LiveVoiceNotificationUpdate): void;
  subscribeActions(listener: (action: LiveVoiceBackgroundCallAction) => void): () => void;
}

export function createLiveVoiceCallNotificationPresenter(): LiveVoiceCallNotificationPresenter {
  return {
    update(params) {
      void updateLiveVoiceBackgroundCall(params).catch((error) => {
        console.warn("[LiveVoice] Failed to update the call notification", error);
      });
    },
    subscribeActions: subscribeLiveVoiceBackgroundCallActions,
  };
}

/**
 * Bind the notification to a runtime. Returns an unsubscribe for the provider's
 * teardown.
 */
export function attachLiveVoiceCallNotification(
  runtime: LiveVoiceRuntime,
  presenter: LiveVoiceCallNotificationPresenter = createLiveVoiceCallNotificationPresenter(),
): () => void {
  let state = initialLiveVoiceNotificationState;

  const unsubscribeRuntime = runtime.subscribe(() => {
    const next = advanceLiveVoiceNotificationState(state, runtime.getSnapshot());
    state = next.state;
    if (next.update) {
      presenter.update(next.update);
    }
  });

  const unsubscribeActions = presenter.subscribeActions((action) => {
    // A button press races the call ending. Acting on a call that is already gone
    // would, for `end`, tear down whatever call started next.
    if (!hasNotification(runtime.getSnapshot())) {
      return;
    }
    if (action === "toggleMute") {
      runtime.toggleMute();
      return;
    }
    void runtime.stop().catch((error) => {
      console.warn("[LiveVoice] Failed to end the call from its notification", error);
    });
  });

  return () => {
    unsubscribeRuntime();
    unsubscribeActions();
  };
}
