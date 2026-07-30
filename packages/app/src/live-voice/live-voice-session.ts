/**
 * Live Voice transport — platform-neutral contract and native stub.
 *
 * Phase 1 is web/Electron only: the call rides a real `RTCPeerConnection` and
 * the browser owns the media path end to end. Metro resolves
 * `live-voice-session.web.ts` on web and Electron; this base module is what
 * native gets, and it refuses to start.
 *
 * Import via the base name (`@/live-voice/live-voice-session`) so the platform
 * resolution happens at build time. Nothing in this file may touch the DOM.
 */

export type LiveVoiceSessionFailureCode =
  | "unsupported"
  | "mic_denied"
  | "mic_unavailable"
  | "ice_timeout"
  | "webrtc_failed";

/**
 * A local (pre-daemon) failure. Failures from `negotiate` propagate unwrapped so
 * callers can still read the daemon's `errorCode`.
 */
export class LiveVoiceSessionError extends Error {
  readonly name = "LiveVoiceSessionError";
  readonly code: LiveVoiceSessionFailureCode;

  constructor(code: LiveVoiceSessionFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/** What the daemon hands back once it has relayed the offer to the provider. */
export interface LiveVoiceNegotiationResult {
  liveSessionId: string;
  answerSdp: string;
}

export interface StartLiveVoiceSessionOptions {
  /**
   * Exchange the local offer for the provider's answer. Called once, after ICE
   * gathering completes. Rejections are re-thrown as-is (after cleanup).
   */
  negotiate(offerSdp: string): Promise<LiveVoiceNegotiationResult>;
  /**
   * Remote audio was produced but the browser's autoplay policy refused to play
   * it. Surface "tap to enable audio" and call {@link LiveVoiceSession.resumeAudio}
   * from the resulting user gesture.
   */
  onAudioBlocked(): void;
  /** Remote audio is playing (initially, or after a successful `resumeAudio`). */
  onAudioResumed(): void;
  /**
   * The transport went terminal. The session has already torn itself down; the
   * caller only has to update its own state and tell the daemon.
   */
  onTerminal(info: { code: string; message: string }): void;
}

export interface LiveVoiceSession {
  readonly liveSessionId: string;
  /** Mute is local: the mic track stays open but stops emitting. */
  setMuted(muted: boolean): void;
  /** Retry blocked playback. Must be called from a user gesture. */
  resumeAudio(): Promise<void>;
  /** Idempotent teardown. Does not fire `onTerminal`. */
  close(): void;
}

export const isLiveVoiceSessionSupported = false;

export function startLiveVoiceSession(
  _options: StartLiveVoiceSessionOptions,
): Promise<LiveVoiceSession> {
  return Promise.reject(
    new LiveVoiceSessionError("unsupported", "Live voice is not supported on this platform."),
  );
}
