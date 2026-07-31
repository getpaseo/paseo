/**
 * Live Voice transport — WebRTC implementation (web + Electron).
 *
 * This module is the only place in the Live Voice feature that touches WebRTC or
 * the DOM. Metro resolves it for the `web` platform (including Electron), so the
 * raw DOM use here needs no `isWeb` guard.
 *
 * The handshake order is not negotiable; the provider rejects offers that don't
 * match it (see the Live Voice plan's "Validated constraints"):
 *
 *   getUserMedia → addTrack → createDataChannel("oai-events") → createOffer →
 *   setLocalDescription → ICE gathering complete → negotiate → setRemoteDescription
 *
 * In particular the data channel must exist *before* `createOffer`, and the
 * offer must carry fully gathered candidates — a hand-rolled or trickled SDP
 * comes back as `invalid_offer`.
 *
 * Every failure path funnels through one idempotent `cleanup()`.
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

/** Full ICE gathering on a healthy network finishes in well under a second. */
const ICE_GATHERING_TIMEOUT_MS = 10_000;
/**
 * `disconnected` is recoverable — a brief network blip produces it and then
 * `connected` again. Only a sustained disconnect is terminal.
 */
const SUSTAINED_DISCONNECT_MS = 8_000;

/**
 * The provider's control channel. Phase 1 logs it and nothing more: the daemon's
 * `voice.live.update` transcripts are canonical and the two must never be merged.
 */
const EVENT_CHANNEL_LABEL = "oai-events";

export const isLiveVoiceSessionSupported =
  typeof RTCPeerConnection === "function" &&
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getUserMedia === "function";
export const isLiveVoiceBackgroundSessionSupported = false;

export async function startLiveVoiceSession(
  options: StartLiveVoiceSessionOptions,
): Promise<LiveVoiceSession> {
  if (!isLiveVoiceSessionSupported) {
    throw new LiveVoiceSessionError(
      "unsupported",
      "This browser does not support the WebRTC APIs live voice needs.",
    );
  }

  let stream: MediaStream | null = null;
  let micTrack: MediaStreamTrack | null = null;
  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let audioElement: HTMLAudioElement | null = null;
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let terminalReported = false;
  // Scopes every listener on the peer connection and the data channel to the
  // session's lifetime: one `abort()` in `cleanup` detaches all of them.
  const listeners = new AbortController();

  function clearDisconnectTimer(): void {
    if (disconnectTimer !== null) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
  }

  /** Idempotent. Every exit path — success teardown, failure, terminal — lands here. */
  function cleanup(): void {
    if (closed) {
      return;
    }
    closed = true;
    clearDisconnectTimer();
    listeners.abort();

    for (const track of stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        // Already stopped.
      }
    }
    stream = null;

    if (channel) {
      try {
        channel.close();
      } catch {
        // Already closing with the peer connection.
      }
      channel = null;
    }

    if (audioElement) {
      try {
        audioElement.pause();
      } catch {
        // Detaching below is what actually matters.
      }
      audioElement.srcObject = null;
      audioElement.remove();
      audioElement = null;
    }

    if (pc) {
      try {
        pc.close();
      } catch {
        // Already closed.
      }
      pc = null;
    }
  }

  function reportTerminal(code: string, message: string): void {
    if (terminalReported) {
      return;
    }
    terminalReported = true;
    cleanup();
    options.onTerminal({ code, message });
  }

  async function attachRemoteAudio(remoteStream: MediaStream): Promise<void> {
    if (closed) {
      return;
    }
    if (!audioElement) {
      const element = document.createElement("audio");
      element.autoplay = true;
      // Not user-visible; it exists purely as a playback sink. It still has to be
      // in the document for autoplay-policy resumption to behave predictably.
      element.style.display = "none";
      document.body.appendChild(element);
      audioElement = element;
    }
    audioElement.srcObject = remoteStream;
    await playAudioElement();
  }

  async function playAudioElement(): Promise<void> {
    const element = audioElement;
    if (!element) {
      return;
    }
    try {
      await element.play();
      options.onAudioResumed();
    } catch {
      // Autoplay policy: playback needs a user gesture. Not fatal — the call is
      // up, the user just can't hear it until they tap.
      options.onAudioBlocked();
    }
  }

  function handleConnectionState(state: string): void {
    if (closed) {
      return;
    }
    if (state === "failed" || state === "closed") {
      reportTerminal("webrtc_failed", `WebRTC connection ${state}.`);
      return;
    }
    if (state === "disconnected") {
      if (disconnectTimer === null) {
        disconnectTimer = setTimeout(() => {
          disconnectTimer = null;
          reportTerminal("webrtc_failed", "WebRTC connection stayed disconnected.");
        }, SUSTAINED_DISCONNECT_MS);
      }
      return;
    }
    // Any other transition (connecting/connected/completed/new) means we
    // recovered; drop a pending sustained-disconnect verdict.
    clearDisconnectTimer();
  }

  try {
    stream = await requestMicrophone();
    micTrack = stream.getAudioTracks()[0] ?? null;
    if (!micTrack) {
      throw new LiveVoiceSessionError("mic_unavailable", "No microphone track was produced.");
    }

    pc = new RTCPeerConnection();
    // `addTrack` gives us a sendrecv audio transceiver, which is both the offer's
    // required audio m-line and the receive path for the model's voice.
    pc.addTrack(micTrack, stream);

    const listenerScope = { signal: listeners.signal };

    channel = pc.createDataChannel(EVENT_CHANNEL_LABEL);
    channel.addEventListener(
      "message",
      (event) => {
        // Log only. Daemon transcripts are canonical in phase 1.
        console.debug("[LiveVoice] oai-events message", event.data);
      },
      listenerScope,
    );
    channel.addEventListener(
      "error",
      (event) => {
        console.warn("[LiveVoice] oai-events channel error", event);
      },
      listenerScope,
    );

    pc.addEventListener(
      "track",
      (event) => {
        const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
        void attachRemoteAudio(remoteStream);
      },
      listenerScope,
    );
    pc.addEventListener(
      "connectionstatechange",
      () => {
        handleConnectionState(pc?.connectionState ?? "closed");
      },
      listenerScope,
    );
    pc.addEventListener(
      "iceconnectionstatechange",
      () => {
        handleConnectionState(pc?.iceConnectionState ?? "closed");
      },
      listenerScope,
    );

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    const offerSdp = pc.localDescription?.sdp;
    if (!offerSdp) {
      throw new LiveVoiceSessionError("webrtc_failed", "The local SDP offer was never produced.");
    }

    const negotiation = await options.negotiate(offerSdp);

    if (closed) {
      // Terminal transition or an explicit close raced the handshake. The daemon
      // side is the caller's problem; ours is to not leave a half-open pc.
      throw new LiveVoiceSessionError("webrtc_failed", "Live voice session closed while starting.");
    }

    await pc.setRemoteDescription({ type: "answer", sdp: negotiation.answerSdp });

    const activeMicTrack = micTrack;
    return {
      liveSessionId: negotiation.liveSessionId,
      setMuted(nextMuted) {
        activeMicTrack.enabled = !nextMuted;
      },
      resumeAudio() {
        return playAudioElement();
      },
      close() {
        cleanup();
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function requestMicrophone(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const denied = name === "NotAllowedError" || name === "SecurityError";
    throw new LiveVoiceSessionError(
      denied ? "mic_denied" : "mic_unavailable",
      denied
        ? "Microphone access was denied."
        : "The microphone could not be opened for live voice.",
      { cause: error },
    );
  }
}

/**
 * The provider needs a fully gathered offer, so we wait out ICE rather than
 * trickling. A stalled gathering is a hard failure — sending a partial offer
 * just produces `invalid_offer` a round trip later.
 */
function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(
        new LiveVoiceSessionError(
          "ice_timeout",
          `ICE gathering did not complete within ${ICE_GATHERING_TIMEOUT_MS}ms.`,
        ),
      );
    }, ICE_GATHERING_TIMEOUT_MS);

    function finish(error?: LiveVoiceSessionError): void {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }

    function onStateChange(): void {
      if (pc.iceGatheringState === "complete") {
        finish();
      }
    }

    pc.addEventListener("icegatheringstatechange", onStateChange);
    // The state can flip between the guard above and the listener registration.
    onStateChange();
  });
}
