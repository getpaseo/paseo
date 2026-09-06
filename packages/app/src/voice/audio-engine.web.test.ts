import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudioEngine } from "./audio-engine.web";

afterEach(() => vi.unstubAllGlobals());

function createEngine() {
  return createAudioEngine({ onCaptureData() {}, onVolumeLevel() {} });
}

describe("browser audio lifetime", () => {
  it("stops acquired microphone tracks when graph construction fails", async () => {
    const stop = vi.fn();
    const failure = new Error("Cannot construct audio graph");
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
    });
    vi.stubGlobal("window", {
      AudioContext: class {
        state = "running";
        createMediaStreamSource() {
          throw failure;
        }
        async close() {}
      },
    });
    const engine = createEngine();
    await expect(engine.startCapture()).rejects.toBe(failure);
    expect(stop).toHaveBeenCalledOnce();
    await engine.destroy();
  });

  it.each(["context resume", "decoding"])(
    "does not start playback cancelled during %s",
    async (stage) => {
      const entered = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<void>();
      const start = vi.fn();
      vi.stubGlobal("window", {
        AudioContext: class {
          state = stage === "context resume" ? "suspended" : "running";
          destination = {};
          async resume() {
            entered.resolve();
            await pending.promise;
            this.state = "running";
          }
          async decodeAudioData() {
            if (stage === "decoding") {
              entered.resolve();
              await pending.promise;
            }
            return { duration: 1 };
          }
          createBufferSource() {
            let ended = () => {};
            return {
              connect() {},
              disconnect() {},
              stop() {},
              addEventListener(_name: string, listener: () => void) {
                ended = listener;
              },
              start() {
                start();
                ended();
              },
            };
          }
          async close() {}
        },
      });
      const engine = createEngine();
      const playing = engine.play({
        type: "audio/wav",
        size: 1,
        async arrayBuffer() {
          return new ArrayBuffer(1);
        },
      });
      const outcome = playing.catch((error: unknown) => error);
      await entered.promise;
      engine.stop();
      pending.resolve();
      expect(await outcome).toEqual(new Error("Playback stopped"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(start).not.toHaveBeenCalled();
      await engine.destroy();
    },
  );
});
