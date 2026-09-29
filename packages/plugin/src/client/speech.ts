export interface PluginSpeechInput {
  agentId: string;
  text: string;
  mode: "summary" | "full";
  /** Stable caller identity, used to associate progress with a response. */
  key: string;
}

export interface PluginSpeechState {
  status: "idle" | "preparing" | "speaking";
  key: string | null;
  error: string | null;
}

export interface PluginSpeech extends PluginSpeechState {
  /** Replaces current read-aloud playback on this client. Never starts microphone capture. */
  speak(input: PluginSpeechInput): Promise<void>;
  stop(): void;
}
