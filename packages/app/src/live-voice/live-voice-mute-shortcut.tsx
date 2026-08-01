import { useEffect, useRef } from "react";
import { useLiveVoiceOptional } from "@/contexts/live-voice-context";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";

/**
 * Registers the global mute/unmute shortcut for a Live Voice call.
 *
 * A keybind toggles mute rather than ending the call on purpose: mute is a
 * local, instant, reversible track flip, while ending tears down the hidden
 * host session and loses the realtime model's conversational memory. The
 * handler reports unhandled while no call is active so the chord stays inert.
 */
export function LiveVoiceMuteShortcut() {
  const liveVoice = useLiveVoiceOptional();
  const liveVoiceRef = useRef(liveVoice);

  useEffect(() => {
    liveVoiceRef.current = liveVoice;
  }, [liveVoice]);

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

  return null;
}
