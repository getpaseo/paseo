/**
 * Native Live Voice transport for iOS and Android.
 *
 * The Codex handshake is identical to the browser transport. React Native
 * supplies the peer connection and media tracks through react-native-webrtc;
 * remote audio is rendered by the native WebRTC audio device.
 */

import type {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection as NativeRTCPeerConnection,
} from "react-native-webrtc";
import {
  beginLiveVoiceBackgroundCall,
  endLiveVoiceBackgroundCall,
  isLiveVoiceBackgroundCallSupported,
} from "./background-call-lifetime";
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

const ICE_GATHERING_TIMEOUT_MS = 10_000;
const SUSTAINED_DISCONNECT_MS = 8_000;
const EVENT_CHANNEL_LABEL = "oai-events";

export const isLiveVoiceSessionSupported = true;
export const isLiveVoiceBackgroundSessionSupported = isLiveVoiceBackgroundCallSupported();

// `react-native-webrtc` implements EventTarget methods at runtime, but its
// published declaration output omits the inherited methods. Use the typed
// `on*` accessors until the upstream declarations expose them.
// oxlint-disable unicorn/prefer-add-event-listener
export async function startLiveVoiceSession(
  options: StartLiveVoiceSessionOptions,
): Promise<LiveVoiceSession> {
  let stream: MediaStream | null = null;
  let micTrack: MediaStreamTrack | null = null;
  let pc: NativeRTCPeerConnection | null = null;
  let channel: ReturnType<NativeRTCPeerConnection["createDataChannel"]> | null = null;
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backgroundCallActive = false;
  let closed = false;
  let terminalReported = false;

  function clearDisconnectTimer(): void {
    if (disconnectTimer === null) {
      return;
    }
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }

  function handleChannelMessage(event: { data: unknown }): void {
    console.debug("[LiveVoice] oai-events message", event.data);
  }

  function handleChannelError(event: unknown): void {
    console.warn("[LiveVoice] oai-events channel error", event);
  }

  function handleConnectionStateChange(): void {
    handleConnectionState(pc?.connectionState ?? "closed");
  }

  function handleIceConnectionStateChange(): void {
    handleConnectionState(pc?.iceConnectionState ?? "closed");
  }

  function cleanup(): void {
    if (closed) {
      return;
    }
    closed = true;
    clearDisconnectTimer();

    if (channel) {
      channel.onmessage = null;
      channel.onerror = null;
    }
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
    }

    channel?.close();
    channel = null;
    pc?.close();
    pc = null;

    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
    stream?.release();
    stream = null;

    // WebRTC must release the shared iOS audio session before the lifetime
    // module deactivates it. Android likewise no longer needs its foreground
    // microphone service once capture has stopped.
    if (backgroundCallActive) {
      backgroundCallActive = false;
      void endLiveVoiceBackgroundCall().catch((error) => {
        console.warn("[LiveVoice] Failed to end background call lifetime", error);
      });
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
    clearDisconnectTimer();
  }

  try {
    // Loading this package evaluates its native TurboModule bindings. Keep that
    // outside the app's import path so an OTA bundle can still start on an older
    // binary that predates mobile Live Voice.
    const { mediaDevices, RTCPeerConnection } = await import("react-native-webrtc");
    stream = await requestMicrophone(mediaDevices);
    micTrack = stream.getAudioTracks()[0] ?? null;
    if (!micTrack) {
      throw new LiveVoiceSessionError("mic_unavailable", "No microphone track was produced.");
    }

    if (options.mode === "background") {
      try {
        await beginLiveVoiceBackgroundCall();
        backgroundCallActive = true;
      } catch (error) {
        console.warn("[LiveVoice] Failed to establish background call lifetime", error);
        throw new LiveVoiceSessionError(
          "background_unavailable",
          "Live Voice could not establish background audio support.",
          { cause: error },
        );
      }
    }

    pc = new RTCPeerConnection();
    pc.addTrack(micTrack, stream);

    channel = pc.createDataChannel(EVENT_CHANNEL_LABEL);
    channel.onmessage = handleChannelMessage;
    channel.onerror = handleChannelError;
    pc.onconnectionstatechange = handleConnectionStateChange;
    pc.oniceconnectionstatechange = handleIceConnectionStateChange;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    const offerSdp = pc.localDescription?.sdp;
    if (!offerSdp) {
      throw new LiveVoiceSessionError("webrtc_failed", "The local SDP offer was never produced.");
    }

    const negotiation = await options.negotiate(offerSdp);
    if (closed) {
      throw new LiveVoiceSessionError("webrtc_failed", "Live voice session closed while starting.");
    }

    await pc.setRemoteDescription({ type: "answer", sdp: negotiation.answerSdp });
    options.onAudioResumed();

    const activeMicTrack = micTrack;
    return {
      liveSessionId: negotiation.liveSessionId,
      setMuted(nextMuted) {
        activeMicTrack.enabled = !nextMuted;
      },
      async resumeAudio() {},
      close() {
        cleanup();
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
// oxlint-enable unicorn/prefer-add-event-listener

async function requestMicrophone(
  mediaDevices: typeof import("react-native-webrtc").mediaDevices,
): Promise<MediaStream> {
  try {
    return await mediaDevices.getUserMedia({ audio: true });
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

function waitForIceGatheringComplete(pc: NativeRTCPeerConnection): Promise<void> {
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
      pc.onicegatheringstatechange = null;
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

    pc.onicegatheringstatechange = onStateChange;
    onStateChange();
  });
}
