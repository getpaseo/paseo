export type LiveVoiceSessionFailureCode =
  | "unsupported"
  | "mic_denied"
  | "mic_unavailable"
  | "background_unavailable"
  | "ice_timeout"
  | "webrtc_failed";

/**
 * A local transport failure. Failures from `negotiate` propagate unwrapped so
 * callers can still inspect the daemon's structured error.
 */
export class LiveVoiceSessionError extends Error {
  readonly name = "LiveVoiceSessionError";
  readonly code: LiveVoiceSessionFailureCode;

  constructor(code: LiveVoiceSessionFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/** What the daemon returns after relaying the local offer to Codex/OpenAI. */
export interface LiveVoiceNegotiationResult {
  liveSessionId: string;
  answerSdp: string;
}

export type LiveVoiceSessionMode = "foreground" | "background";

export interface StartLiveVoiceSessionOptions {
  /** Whether native transports should keep the call alive after the app backgrounds. */
  mode: LiveVoiceSessionMode;
  /** Exchange a fully gathered local offer for the provider's SDP answer. */
  negotiate(offerSdp: string): Promise<LiveVoiceNegotiationResult>;
  /** Browser autoplay blocked remote audio; native transports never call this. */
  onAudioBlocked(): void;
  /** Remote audio is available, initially or after a browser resume gesture. */
  onAudioResumed(): void;
  /** The transport is terminal and has already torn itself down locally. */
  onTerminal(info: { code: string; message: string }): void;
}

export interface LiveVoiceSession {
  readonly liveSessionId: string;
  /** Keep the mic open while enabling or disabling its outgoing audio track. */
  setMuted(muted: boolean): void;
  /** Retry browser playback after autoplay blocking; a no-op on native. */
  resumeAudio(): Promise<void>;
  /** Idempotent local teardown. Does not invoke `onTerminal`. */
  close(): void;
}
