import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client";

const playReadAloudSegment = vi.fn().mockResolvedValue(undefined);
const setReadAloudPlaybackRate = vi.fn();
const stopReadAloudAudio = vi.fn();

vi.mock("@/read-aloud/read-aloud-audio", () => ({
  isReadAloudAudioSupported: true,
  playReadAloudSegment: (params: { audioBase64: string; format: string }) =>
    playReadAloudSegment(params),
  setReadAloudPlaybackRate: (rate: number) => setReadAloudPlaybackRate(rate),
  stopReadAloudAudio: () => stopReadAloudAudio(),
}));

const { getReadAloudSnapshot, READ_ALOUD_RATES, setReadAloudRate, startReadAloud, stopReadAloud } =
  await import("@/read-aloud/read-aloud-store");

/** Minimal stand-in: the store only ever calls `startReadAloud` on the client. */
function createClient(): DaemonClient {
  return {
    startReadAloud: vi.fn().mockReturnValue({ requestId: "req-1", cancel: vi.fn() }),
  } as unknown as DaemonClient;
}

describe("read aloud playback rate", () => {
  beforeEach(() => {
    stopReadAloud();
    setReadAloudRate(1);
    vi.clearAllMocks();
  });

  it("offers speeds capped at 2x, because playback is not pitch-corrected", () => {
    expect(READ_ALOUD_RATES).toEqual([1, 1.5, 2]);
  });

  it("applies a rate change to audio that is already playing", () => {
    startReadAloud({ client: createClient(), text: "hello" });
    setReadAloudRate(2);

    expect(setReadAloudPlaybackRate).toHaveBeenCalledWith(2);
    expect(getReadAloudSnapshot().rate).toBe(2);
  });

  it("keeps the chosen rate after stopping, and re-applies it on the next read", () => {
    setReadAloudRate(1.5);
    stopReadAloud();

    // The rate outlives the playback it was chosen during: picking 1.5x once
    // should still be 1.5x for the next selection.
    expect(getReadAloudSnapshot().rate).toBe(1.5);

    setReadAloudPlaybackRate.mockClear();
    startReadAloud({ client: createClient(), text: "hello again" });

    // Re-applied rather than assumed: the audio engine is lazily created and
    // starts at 1x, so a stale engine would silently play at the wrong speed.
    expect(setReadAloudPlaybackRate).toHaveBeenCalledWith(1.5);
  });

  it("ignores a tap on the rate that is already selected", () => {
    setReadAloudRate(2);
    setReadAloudPlaybackRate.mockClear();

    setReadAloudRate(2);

    expect(setReadAloudPlaybackRate).not.toHaveBeenCalled();
  });

  it("reports the rate on every snapshot, including failures", () => {
    setReadAloudRate(2);
    const client = createClient();
    vi.mocked(client.startReadAloud).mockImplementation((params) => {
      params.onError({ code: "tts_unavailable", message: "no tts" });
      return { requestId: "req-1", cancel: vi.fn() };
    });

    startReadAloud({ client, text: "hello" });

    const snapshot = getReadAloudSnapshot();
    expect(snapshot.failure?.code).toBe("tts_unavailable");
    expect(snapshot.rate).toBe(2);
  });
});
