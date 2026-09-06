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

/** Matches the daemon's bound; anything longer is truncated there anyway. */
export const MAX_CUSTOM_VOICE_INSTRUCTIONS_LENGTH = 1000;

/**
 * The optional prompt components the daemon lets a call turn off. The daemon
 * owns the registry and ignores unknown and locked ids, so this list only has
 * to name what the settings page offers — drift shows up as a dead toggle, not
 * a broken call.
 */
export const LIVE_VOICE_OPTIONAL_PROMPT_COMPONENTS = [
  "canonical-tools",
  "delegation-brevity",
  "cross-host-reach",
  "recipes",
  "speech-style",
] as const;

export type LiveVoiceOptionalPromptComponent =
  (typeof LIVE_VOICE_OPTIONAL_PROMPT_COMPONENTS)[number];

function toggleDisabledComponent(
  disabled: string[],
  id: LiveVoiceOptionalPromptComponent,
  enabled: boolean,
): string[] {
  if (enabled) {
    return disabled.filter((existing) => existing !== id);
  }
  if (disabled.includes(id)) {
    return disabled;
  }
  return [...disabled, id];
}

/**
 * A path, so short by nature. Bounded anyway because the daemon bounds it, and
 * a value rejected there would silently do nothing here.
 */
export const MAX_DEFAULT_WORKSPACE_DIRECTORY_LENGTH = 256;

interface LiveVoiceSettingsState {
  /** The realtime voice to use for new calls; null leaves selection to the provider. */
  voice: string | null;
  /**
   * Report agent sessions the call did not start — anything finishing, failing,
   * or asking for permission on any connected host.
   */
  ambientAgentReports: boolean;
  /** Free text handed to the model verbatim; empty means no standing instruction. */
  ambientAgentGuidance: string;
  /** Prompt component ids the user turned off. Empty means the full prompt. */
  disabledPromptComponents: string[];
  /** Standing instructions for the whole call, handed to the model verbatim. */
  customVoiceInstructions: string;
  /**
   * Where the call puts a new workspace when a request names none. Empty means
   * the call asks instead of choosing. Absolute or `~`-rooted; the daemon drops
   * anything else, since a relative path has no base on the host that would run
   * the creation.
   */
  defaultWorkspaceDirectory: string;
  /**
   * Backend-executor model for new calls; null uses the daemon's fast default.
   * This is the model that runs the call's actions, not the realtime voice.
   */
  backendModel: string | null;
  backendThinkingOptionId: string | null;
  setVoice: (voice: string | null) => void;
  setAmbientAgentReports: (enabled: boolean) => void;
  setAmbientAgentGuidance: (guidance: string) => void;
  setPromptComponentEnabled: (id: LiveVoiceOptionalPromptComponent, enabled: boolean) => void;
  setCustomVoiceInstructions: (instructions: string) => void;
  setDefaultWorkspaceDirectory: (directory: string) => void;
  setBackendModel: (model: string | null) => void;
  setBackendThinkingOptionId: (thinkingOptionId: string | null) => void;
}

export const useLiveVoiceSettingsStore = create<LiveVoiceSettingsState>()(
  persist(
    (set) => ({
      voice: null,
      // Off by default: it turns a call the user started for one thing into a
      // channel their whole machine can interrupt, which should be chosen.
      ambientAgentReports: false,
      ambientAgentGuidance: "",
      disabledPromptComponents: [],
      customVoiceInstructions: "",
      defaultWorkspaceDirectory: "",
      backendModel: null,
      backendThinkingOptionId: null,
      setVoice: (voice) => set({ voice }),
      setAmbientAgentReports: (enabled) => set({ ambientAgentReports: enabled }),
      setAmbientAgentGuidance: (guidance) =>
        set({ ambientAgentGuidance: guidance.slice(0, MAX_AMBIENT_AGENT_GUIDANCE_LENGTH) }),
      setPromptComponentEnabled: (id, enabled) =>
        set((state) => ({
          disabledPromptComponents: toggleDisabledComponent(
            state.disabledPromptComponents,
            id,
            enabled,
          ),
        })),
      setCustomVoiceInstructions: (instructions) =>
        set({
          customVoiceInstructions: instructions.slice(0, MAX_CUSTOM_VOICE_INSTRUCTIONS_LENGTH),
        }),
      setDefaultWorkspaceDirectory: (directory) =>
        set({
          defaultWorkspaceDirectory: directory.slice(0, MAX_DEFAULT_WORKSPACE_DIRECTORY_LENGTH),
        }),
      setBackendModel: (model) => set({ backendModel: model }),
      setBackendThinkingOptionId: (thinkingOptionId) =>
        set({ backendThinkingOptionId: thinkingOptionId }),
    }),
    {
      name: "paseo-live-voice-settings",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

export function getLiveVoiceVoice(): string | undefined {
  const voice = useLiveVoiceSettingsStore.getState().voice;
  return voice?.trim() || undefined;
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

/** Read outside React, like the ambient settings: calls start from event handlers. */
export function getLiveVoiceCallSettings(): {
  disabledPromptComponents: string[] | undefined;
  customVoiceInstructions: string | undefined;
  defaultWorkspaceDirectory: string | undefined;
  backendModel: string | undefined;
  backendThinkingOptionId: string | undefined;
} {
  const state = useLiveVoiceSettingsStore.getState();
  const instructions = state.customVoiceInstructions.trim();
  return {
    disabledPromptComponents: state.disabledPromptComponents.length
      ? [...state.disabledPromptComponents]
      : undefined,
    customVoiceInstructions: instructions || undefined,
    defaultWorkspaceDirectory: state.defaultWorkspaceDirectory.trim() || undefined,
    backendModel: state.backendModel?.trim() || undefined,
    backendThinkingOptionId: state.backendThinkingOptionId?.trim() || undefined,
  };
}
