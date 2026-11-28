import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describeFrame } from "./server/frame-check";
import { openTestPattern } from "./server/test-pattern";
import { checkFrame } from "./shared/frame-check";
import { encodeMediaFrame, MediaOpcode, mediaStream } from "./shared/media-frames";

export default function contribute(server: PluginServerContext) {
  // Two streams share one subscription; each frame's opcode says which one it belongs to.
  server.handle(mediaStream, (_input, { push, signal }) => {
    const source = openTestPattern({
      video: (pixels, timestampMs, keyframe) =>
        void push(
          encodeMediaFrame({
            opcode: keyframe ? MediaOpcode.Keyframe : MediaOpcode.Video,
            timestampMs,
            payload: pixels,
          }),
        ),
      audio: (samples, timestampMs) =>
        void push(encodeMediaFrame({ opcode: MediaOpcode.Audio, timestampMs, payload: samples })),
    });
    signal.addEventListener("abort", () => source.close(), { once: true });
  });
  // A Uint8Array input arrives as the bytes the panel sent.
  server.handle(checkFrame, describeFrame);
  return () => {};
}
