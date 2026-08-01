import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeRtc = vi.hoisted(() => {
  interface FakeDescription {
    type: string;
    sdp: string;
  }

  class FakeTrack {
    enabled = true;
    stopped = false;

    stop(): void {
      this.stopped = true;
    }
  }

  class FakeStream {
    readonly track = new FakeTrack();
    released = false;

    getAudioTracks(): FakeTrack[] {
      return [this.track];
    }

    getTracks(): FakeTrack[] {
      return [this.track];
    }

    release(): void {
      this.released = true;
    }
  }

  class FakeDataChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    closed = false;

    close(): void {
      this.closed = true;
    }
  }

  class FakePeerConnection {
    static instances: FakePeerConnection[] = [];

    readonly channel = new FakeDataChannel();
    readonly trace: string[];
    localDescription: FakeDescription | null = null;
    remoteDescription: FakeDescription | null = null;
    iceGatheringState = "complete";
    connectionState = "new";
    iceConnectionState = "new";
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    onicegatheringstatechange: (() => void) | null = null;
    closed = false;

    constructor() {
      this.trace = trace;
      FakePeerConnection.instances.push(this);
    }

    addTrack(): void {
      this.trace.push("addTrack");
    }

    createDataChannel(label: string): FakeDataChannel {
      this.trace.push(`createDataChannel:${label}`);
      return this.channel;
    }

    async createOffer(): Promise<FakeDescription> {
      this.trace.push("createOffer");
      return { type: "offer", sdp: OFFER_SDP };
    }

    async setLocalDescription(description: FakeDescription): Promise<void> {
      this.trace.push("setLocalDescription");
      this.localDescription = description;
    }

    async setRemoteDescription(description: FakeDescription): Promise<void> {
      this.trace.push("setRemoteDescription");
      this.remoteDescription = description;
    }

    close(): void {
      this.closed = true;
    }
  }

  const OFFER_SDP = "v=0\r\no=- native-offer";
  const ANSWER_SDP = "v=0\r\no=- provider-answer";
  const trace: string[] = [];
  let stream = new FakeStream();
  let microphoneFailure: Error | null = null;

  return {
    ANSWER_SDP,
    OFFER_SDP,
    FakePeerConnection,
    mediaDevices: {
      async getUserMedia(): Promise<FakeStream> {
        trace.push("getUserMedia");
        if (microphoneFailure) {
          throw microphoneFailure;
        }
        return stream;
      },
    },
    reset(): void {
      trace.length = 0;
      stream = new FakeStream();
      microphoneFailure = null;
      FakePeerConnection.instances.length = 0;
    },
    setMicrophoneFailure(error: Error): void {
      microphoneFailure = error;
    },
    stream(): FakeStream {
      return stream;
    },
    trace,
  };
});

const backgroundCallLifetime = vi.hoisted(() => ({
  isSupported: vi.fn(() => true),
  begin: vi.fn(async () => {
    nativeRtc.trace.push("beginBackgroundCall");
  }),
  end: vi.fn(async () => {
    nativeRtc.trace.push("endBackgroundCall");
  }),
}));

vi.mock("react-native-webrtc", () => ({
  mediaDevices: nativeRtc.mediaDevices,
  RTCPeerConnection: nativeRtc.FakePeerConnection,
}));

vi.mock("./background-call-lifetime", () => ({
  beginLiveVoiceBackgroundCall: backgroundCallLifetime.begin,
  endLiveVoiceBackgroundCall: backgroundCallLifetime.end,
  isLiveVoiceBackgroundCallSupported: backgroundCallLifetime.isSupported,
}));

import {
  isLiveVoiceBackgroundSessionSupported,
  LiveVoiceSessionError,
  startLiveVoiceSession,
} from "./live-voice-session.native";

describe("native live voice session", () => {
  beforeEach(() => {
    nativeRtc.reset();
    backgroundCallLifetime.begin.mockClear();
    backgroundCallLifetime.end.mockClear();
  });

  it("advertises background mode when the native lifetime module is installed", () => {
    expect(isLiveVoiceBackgroundSessionSupported).toBe(true);
  });

  it("negotiates the required WebRTC offer and owns native audio cleanup", async () => {
    const onAudioResumed = vi.fn();
    const session = await startLiveVoiceSession({
      mode: "background",
      negotiate: async (offerSdp) => {
        nativeRtc.trace.push("negotiate");
        expect(offerSdp).toBe(nativeRtc.OFFER_SDP);
        return { liveSessionId: "live-native", answerSdp: nativeRtc.ANSWER_SDP };
      },
      onAudioBlocked: vi.fn(),
      onAudioResumed,
      onTerminal: vi.fn(),
    });

    expect(nativeRtc.trace).toEqual([
      "getUserMedia",
      "beginBackgroundCall",
      "addTrack",
      "createDataChannel:oai-events",
      "createOffer",
      "setLocalDescription",
      "negotiate",
      "setRemoteDescription",
    ]);
    expect(onAudioResumed).toHaveBeenCalledTimes(1);

    const peer = nativeRtc.FakePeerConnection.instances[0];
    expect(peer?.remoteDescription).toEqual({
      type: "answer",
      sdp: nativeRtc.ANSWER_SDP,
    });

    session.setMuted(true);
    expect(nativeRtc.stream().track.enabled).toBe(false);
    session.setMuted(false);
    expect(nativeRtc.stream().track.enabled).toBe(true);

    session.close();
    expect(peer?.closed).toBe(true);
    expect(peer?.channel.closed).toBe(true);
    expect(nativeRtc.stream().track.stopped).toBe(true);
    expect(nativeRtc.stream().released).toBe(true);
    expect(nativeRtc.trace.at(-1)).toBe("endBackgroundCall");
    expect(backgroundCallLifetime.end).toHaveBeenCalledOnce();
  });

  it("runs a foreground session without activating background-call lifetime", async () => {
    const session = await startLiveVoiceSession({
      mode: "foreground",
      negotiate: async () => ({
        liveSessionId: "live-native",
        answerSdp: nativeRtc.ANSWER_SDP,
      }),
      onAudioBlocked: vi.fn(),
      onAudioResumed: vi.fn(),
      onTerminal: vi.fn(),
    });

    expect(nativeRtc.trace).toEqual([
      "getUserMedia",
      "addTrack",
      "createDataChannel:oai-events",
      "createOffer",
      "setLocalDescription",
      "setRemoteDescription",
    ]);
    expect(backgroundCallLifetime.begin).not.toHaveBeenCalled();

    session.close();
    expect(backgroundCallLifetime.end).not.toHaveBeenCalled();
    expect(nativeRtc.stream().track.stopped).toBe(true);
    expect(nativeRtc.stream().released).toBe(true);
  });

  it("reports a terminal peer failure once and tears down the microphone", async () => {
    const onTerminal = vi.fn();
    await startLiveVoiceSession({
      mode: "background",
      negotiate: async () => ({
        liveSessionId: "live-native",
        answerSdp: nativeRtc.ANSWER_SDP,
      }),
      onAudioBlocked: vi.fn(),
      onAudioResumed: vi.fn(),
      onTerminal,
    });

    const peer = nativeRtc.FakePeerConnection.instances[0];
    expect(peer).toBeDefined();
    if (!peer) {
      return;
    }
    peer.connectionState = "failed";
    peer.onconnectionstatechange?.();

    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith({
      code: "webrtc_failed",
      message: "WebRTC connection failed.",
    });
    expect(peer.closed).toBe(true);
    expect(nativeRtc.stream().released).toBe(true);
    expect(backgroundCallLifetime.end).toHaveBeenCalledOnce();
  });

  it("classifies a denied native microphone permission", async () => {
    const denied = new Error("Permission denied");
    denied.name = "SecurityError";
    nativeRtc.setMicrophoneFailure(denied);

    await expect(
      startLiveVoiceSession({
        mode: "background",
        negotiate: vi.fn(),
        onAudioBlocked: vi.fn(),
        onAudioResumed: vi.fn(),
        onTerminal: vi.fn(),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LiveVoiceSessionError>>({
        code: "mic_denied",
      }),
    );
    expect(backgroundCallLifetime.begin).not.toHaveBeenCalled();
    expect(backgroundCallLifetime.end).not.toHaveBeenCalled();
  });

  it("closes microphone capture when background-call activation fails", async () => {
    const refusal = new Error("foreground service refused");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    backgroundCallLifetime.begin.mockRejectedValueOnce(refusal);

    await expect(
      startLiveVoiceSession({
        mode: "background",
        negotiate: vi.fn(),
        onAudioBlocked: vi.fn(),
        onAudioResumed: vi.fn(),
        onTerminal: vi.fn(),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LiveVoiceSessionError>>({
        code: "background_unavailable",
      }),
    );

    expect(nativeRtc.stream().track.stopped).toBe(true);
    expect(nativeRtc.stream().released).toBe(true);
    expect(backgroundCallLifetime.end).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[LiveVoice] Failed to establish background call lifetime",
      refusal,
    );
    warn.mockRestore();
  });
});
