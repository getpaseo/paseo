import { expect, test, vi } from "vitest";
import type { AudioEngine } from "@/voice/audio-engine-types";
import { createDaemonAudioTransportFactory } from "@/voice-chat/transports/daemon-audio";
import type { VoiceTransportMediaState } from "@/voice-chat/transport";

function createEngine(): AudioEngine {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    startCapture: vi.fn().mockResolvedValue(undefined),
    stopCapture: vi.fn().mockResolvedValue(undefined),
    toggleMute: vi.fn().mockReturnValue(true),
    isMuted: vi.fn().mockReturnValue(false),
    play: vi.fn().mockResolvedValue(0.1),
    stop: vi.fn(),
    clearQueue: vi.fn(),
    isPlaying: vi.fn().mockReturnValue(false),
  };
}

test("daemon audio owns capture, playback, acknowledgement, and mute state", async () => {
  const engine = createEngine();
  const sent = vi.fn();
  const playback = vi.fn();
  const onError = vi.fn();
  const media: VoiceTransportMediaState[] = [];
  const factory = createDaemonAudioTransportFactory({ engine, onError });
  const prepared = await factory.prepare({
    sendTransportMessage: sent,
    setAssistantAudioPlaying: playback,
  });
  const transport = await prepared.accept({
    callId: "call-1",
    answer: { kind: "daemon-audio" },
    publish: (state) => media.push(state),
  });
  await transport.start();

  factory.handleCapturePcm(new Uint8Array([1, 2, 3]));
  transport.handleServerMessage({
    type: "audio",
    outputId: "audio-1",
    audio: "AQID",
    format: "pcm",
    isLastChunk: true,
  });
  transport.toggleMute();

  await vi.waitFor(() => {
    expect(sent).toHaveBeenCalledWith("call-1", { type: "played", outputId: "audio-1" });
  });
  expect(sent).toHaveBeenCalledWith("call-1", {
    type: "append",
    audio: "AQID",
    format: "audio/pcm;rate=16000;bits=16",
  });
  expect(playback).toHaveBeenNthCalledWith(1, true);
  expect(playback).toHaveBeenLastCalledWith(false);
  expect(media).toContainEqual(expect.objectContaining({ isMuted: true }));

  await transport.stop();
  expect(engine.stopCapture).toHaveBeenCalledOnce();
});

test("failed playback reports the error without acknowledging success", async () => {
  const engine = createEngine();
  vi.mocked(engine.play).mockRejectedValueOnce(new Error("speaker unavailable"));
  const sent = vi.fn();
  const onError = vi.fn();
  const prepared = await createDaemonAudioTransportFactory({ engine, onError }).prepare({
    sendTransportMessage: sent,
    setAssistantAudioPlaying: vi.fn(),
  });
  const transport = await prepared.accept({
    callId: "call-1",
    answer: { kind: "daemon-audio" },
    publish: vi.fn(),
  });
  await transport.start();

  transport.handleServerMessage({
    type: "audio",
    outputId: "audio-1",
    audio: "AQID",
    format: "pcm",
    isLastChunk: true,
  });
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));

  expect(sent).not.toHaveBeenCalledWith("call-1", {
    type: "played",
    outputId: "audio-1",
  });
  await transport.stop();
});
