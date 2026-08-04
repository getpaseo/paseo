import { useEffect, useRef } from "react";
import { useLiveVoiceOptional } from "@/contexts/live-voice-context";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { createLiveVoiceHoldMuteController } from "@/live-voice/live-voice-hold-mute";

/**
 * Registers the global mute shortcuts for a Live Voice call: the toggle and the
 * press-and-hold invert.
 *
 * A keybind toggles mute rather than ending the call on purpose: mute is a
 * local, instant, reversible track flip, while ending tears down the hidden
 * host session and loses the realtime model's conversational memory. The
 * handlers report unhandled while no call is active so the chords stay inert.
 */
export function LiveVoiceMuteShortcut() {
  const liveVoice = useLiveVoiceOptional();
  const liveVoiceRef = useRef(liveVoice);
  const holdRef = useRef(
    createLiveVoiceHoldMuteController({
      isActive: () => liveVoiceRef.current?.phase === "active",
      isMuted: () => liveVoiceRef.current?.isMuted === true,
      setMuted: (muted) => liveVoiceRef.current?.setMuted(muted),
    }),
  );

  useEffect(() => {
    liveVoiceRef.current = liveVoice;
  }, [liveVoice]);

  // A call that ends while the chord is down takes the hold with it: the key-up
  // that arrives later must not push the old call's mute state onto whatever
  // call is live by then.
  useEffect(() => {
    if (liveVoice?.phase !== "active") {
      holdRef.current.cancel();
    }
  }, [liveVoice?.phase]);

  useEffect(() => {
    return keyboardActionDispatcher.registerHandler({
      handlerId: "live-voice-mute",
      actions: ["live-voice.mute-toggle"],
      enabled: true,
      priority: 0,
      handle: () => {
        const current = liveVoiceRef.current;
        if (!current || current.phase !== "active") {
          return false;
        }
        current.toggleMute();
        return true;
      },
    });
  }, []);

  useEffect(() => {
    const hold = holdRef.current;
    const unregister = keyboardActionDispatcher.registerHandler({
      handlerId: "live-voice-mute-hold-invert",
      actions: ["live-voice.mute-hold-invert"],
      enabled: true,
      priority: 0,
      handle: (action) => {
        if (action.id !== "live-voice.mute-hold-invert") {
          return false;
        }
        return action.phase === "press" ? hold.press() : hold.release();
      },
    });
    return () => {
      unregister();
      // Unmounting mid-hold would otherwise leave the call inverted with no
      // handler left to receive the release.
      hold.release();
    };
  }, []);

  return null;
}
