import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * The call's context budget is shared with the state snapshot and the rest of
 * the prompt, and this text is repeated to the model for the whole call rather
 * than said once. Long enough for a real instruction, short enough that it
 * cannot crowd out the snapshot.
 */
export const MAX_AMBIENT_AGENT_GUIDANCE_LENGTH = 600;

export const LIVE_VOICE_OPTIONS = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;

export type LiveVoiceVoice = (typeof LIVE_VOICE_OPTIONS)[number];

interface LiveVoiceSettingsState {
  /** The OpenAI Realtime voice to use for new calls; null leaves selection to the provider. */
  voice: LiveVoiceVoice | null;
  /**
   * Report agent sessions the call did not start — anything finishing, failing,
   * or asking for permission on any connected host.
   */
  ambientAgentReports: boolean;
  /** Free text handed to the model verbatim; empty means no standing instruction. */
  ambientAgentGuidance: string;
  setVoice: (voice: LiveVoiceVoice | null) => void;
  setAmbientAgentReports: (enabled: boolean) => void;
  setAmbientAgentGuidance: (guidance: string) => void;
}

export const useLiveVoiceSettingsStore = create<LiveVoiceSettingsState>()(
  persist(
    (set) => ({
      voice: null,
      // Off by default: it turns a call the user started for one thing into a
      // channel their whole machine can interrupt, which should be chosen.
      ambientAgentReports: false,
      ambientAgentGuidance: "",
      setVoice: (voice) => set({ voice }),
      setAmbientAgentReports: (enabled) => set({ ambientAgentReports: enabled }),
      setAmbientAgentGuidance: (guidance) =>
        set({ ambientAgentGuidance: guidance.slice(0, MAX_AMBIENT_AGENT_GUIDANCE_LENGTH) }),
    }),
    {
      name: "paseo-live-voice-settings",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

export function getLiveVoiceVoice(): LiveVoiceVoice | undefined {
  const voice = useLiveVoiceSettingsStore.getState().voice;
  return voice && LIVE_VOICE_OPTIONS.includes(voice) ? voice : undefined;
}

/**
 * Read outside React. The Live Voice runtime starts calls from event handlers
 * and reconnect paths that have no component to subscribe from.
 */
export function getLiveVoiceAmbientSettings(): {
  enabled: boolean;
  guidance: string | undefined;
} {
  const state = useLiveVoiceSettingsStore.getState();
  const guidance = state.ambientAgentGuidance.trim();
  return {
    enabled: state.ambientAgentReports,
    ...(guidance ? { guidance } : { guidance: undefined }),
  };
}
