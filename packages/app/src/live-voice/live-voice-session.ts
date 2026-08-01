/**
 * Live Voice transport — platform-neutral contract and unsupported fallback.
 *
 * Metro resolves `.web.ts` for browsers/Electron and `.native.ts` for iOS and
 * Android. This base module is only a fail-closed fallback for other platforms.
 *
 * Import via the base name (`@/live-voice/live-voice-session`) so the platform
 * resolution happens at build time. Nothing in this file may touch the DOM.
 */

import {
  LiveVoiceSessionError,
  type LiveVoiceSession,
  type StartLiveVoiceSessionOptions,
} from "./live-voice-session.types";

export {
  LiveVoiceSessionError,
  type LiveVoiceNegotiationResult,
  type LiveVoiceSession,
  type LiveVoiceSessionFailureCode,
  type LiveVoiceSessionMode,
  type StartLiveVoiceSessionOptions,
} from "./live-voice-session.types";

export const isLiveVoiceSessionSupported = false;
export const isLiveVoiceBackgroundSessionSupported = false;

export function startLiveVoiceSession(
  _options: StartLiveVoiceSessionOptions,
): Promise<LiveVoiceSession> {
  return Promise.reject(
    new LiveVoiceSessionError("unsupported", "Live voice is not supported on this platform."),
  );
}
