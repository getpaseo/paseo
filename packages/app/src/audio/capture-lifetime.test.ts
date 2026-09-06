import { describe, expect, it } from "vitest";
import { createAudioSessionLease } from "./audio-session-lease";
import { AudioCaptureBusyError, createAudioCaptureLifetime } from "./capture-lifetime";

async function noCapture(): Promise<void> {}

describe("audio capture lifetime", () => {
  it("stops a late microphone acquisition before releasing its lease", async () => {
    const lease = createAudioSessionLease();
    const opened = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let capturing = false;
    const capture = createAudioCaptureLifetime({
      owner: "dictation",
      lease,
      async stop() {
        await closed.promise;
        capturing = false;
      },
    });
    const starting = capture.start(async () => {
      entered.resolve();
      await opened.promise;
      capturing = true;
    });
    await entered.promise;
    const stopping = capture.stop();
    expect(lease.acquire("liveVoice")).toBeNull();
    expect(() => capture.start(noCapture)).toThrow(AudioCaptureBusyError);

    opened.resolve();
    expect(await starting).toBe(false);
    expect(capturing).toBe(true);
    expect(lease.acquire("liveVoice")).toBeNull();
    closed.resolve();
    await stopping;
    expect(capturing).toBe(false);
    expect(lease.current()).toBeNull();
  });

  it("cleans up partially opened capture when startup fails", async () => {
    const lease = createAudioSessionLease();
    let capturing = false;
    const failure = new Error("Capture initialization failed");
    const capture = createAudioCaptureLifetime({
      owner: "dictation",
      lease,
      async stop() {
        capturing = false;
      },
    });
    await expect(
      capture.start(async () => {
        capturing = true;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(capturing).toBe(false);
    expect(lease.current()).toBeNull();
  });

  it("retains ownership after failed shutdown until a successful retry", async () => {
    const lease = createAudioSessionLease();
    let failStop = true;
    const failure = new Error("Capture is still open");
    const capture = createAudioCaptureLifetime({
      owner: "voiceMode",
      lease,
      async stop() {
        if (failStop) throw failure;
      },
    });
    await capture.start(async () => undefined);
    await expect(capture.stop()).rejects.toBe(failure);
    expect(lease.acquire("liveVoice")).toBeNull();
    expect(() => capture.start(noCapture)).toThrow(AudioCaptureBusyError);
    failStop = false;
    await capture.stop();
    expect(lease.current()).toBeNull();
  });

  it("keeps the same lease during an active voice agent switch", async () => {
    const lease = createAudioSessionLease();
    const owners: Array<string | null> = [];
    lease.subscribe(() => owners.push(lease.current()));
    const capture = createAudioCaptureLifetime({
      owner: "voiceMode",
      lease,
      stop: async () => undefined,
    });
    await capture.start(async () => undefined);
    await capture.start(async () => undefined);
    expect(owners).toEqual(["voiceMode"]);
    await capture.stop();
    expect(owners).toEqual(["voiceMode", null]);
  });

  it("does not open capture if cancelled before startup executes", async () => {
    const lease = createAudioSessionLease();
    let starts = 0;
    const capture = createAudioCaptureLifetime({
      owner: "dictation",
      lease,
      stop: async () => undefined,
    });
    const starting = capture.start(async () => {
      starts += 1;
    });
    const stopping = capture.stop();
    expect(await starting).toBe(false);
    await stopping;
    expect(starts).toBe(0);
    expect(lease.current()).toBeNull();
  });
});
