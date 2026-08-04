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
    startReadAloud({ client: createClient(), text: "hello", ownerId: "turn-1", serverId: "srv-1" });
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
    startReadAloud({
      client: createClient(),
      text: "hello again",
      ownerId: "turn-1",
      serverId: "srv-1",
    });

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

  it("names the turn that owns playback, so other footers stay idle", () => {
    startReadAloud({ client: createClient(), text: "hello", ownerId: "turn-1", serverId: "srv-1" });

    expect(getReadAloudSnapshot().ownerId).toBe("turn-1");
  });

  it("hands the slot to the turn that started last", () => {
    startReadAloud({ client: createClient(), text: "first", ownerId: "turn-1", serverId: "srv-1" });
    startReadAloud({
      client: createClient(),
      text: "second",
      ownerId: "turn-2",
      serverId: "srv-1",
    });

    // Only one voice at a time: the second press supersedes the first rather
    // than leaving two footers both rendering themselves as speaking.
    expect(getReadAloudSnapshot().ownerId).toBe("turn-2");
  });

  it("releases the slot on stop", () => {
    startReadAloud({ client: createClient(), text: "hello", ownerId: "turn-1", serverId: "srv-1" });
    stopReadAloud();

    expect(getReadAloudSnapshot().ownerId).toBeNull();
  });

  it("releases the slot when the stream ends and every segment has played", async () => {
    const client = createClient();
    vi.mocked(client.startReadAloud).mockImplementation((params) => {
      params.onSegment({
        audioBase64: "AAA",
        format: "pcm_s16le_24000",
        segmentIndex: 0,
        segmentCount: 1,
      });
      params.onEnd();
      return { requestId: "req-1", cancel: vi.fn() };
    });

    startReadAloud({ client, text: "hello", ownerId: "turn-1", serverId: "srv-1" });
    await vi.waitFor(() => expect(getReadAloudSnapshot().status).toBe("idle"));

    // A finished read must free the slot too, not just an explicit stop —
    // otherwise the button stays stuck showing a stop square forever.
    expect(getReadAloudSnapshot().ownerId).toBeNull();
  });

  it("does not take the slot when the platform has no audio engine", async () => {
    vi.resetModules();
    vi.doMock("@/read-aloud/read-aloud-audio", () => ({
      isReadAloudAudioSupported: false,
      playReadAloudSegment: vi.fn(),
      setReadAloudPlaybackRate: vi.fn(),
      stopReadAloudAudio: vi.fn(),
    }));
    const unsupported = await import("@/read-aloud/read-aloud-store");

    unsupported.startReadAloud({
      client: createClient(),
      text: "hello",
      ownerId: "turn-1",
      serverId: "srv-1",
    });

    const snapshot = unsupported.getReadAloudSnapshot();
    expect(snapshot.failure?.code).toBe("unsupported_platform");
    expect(snapshot.ownerId).toBeNull();
    vi.doUnmock("@/read-aloud/read-aloud-audio");
  });

  it("records the host that started playback, so a route change can stop it", () => {
    startReadAloud({ client: createClient(), text: "hello", ownerId: "turn-1", serverId: "srv-1" });

    // The Stop control lives in a turn footer. Navigate away and it unmounts,
    // so playback has to be attributable to a host or it becomes unstoppable.
    expect(getReadAloudSnapshot().ownerServerId).toBe("srv-1");
  });

  it("clears the owning host on stop", () => {
    startReadAloud({ client: createClient(), text: "hello", ownerId: "turn-1", serverId: "srv-1" });
    stopReadAloud();

    expect(getReadAloudSnapshot().ownerServerId).toBeNull();
  });

  it("reports the rate on every snapshot, including failures", () => {
    setReadAloudRate(2);
    const client = createClient();
    vi.mocked(client.startReadAloud).mockImplementation((params) => {
      params.onError({ code: "tts_unavailable", message: "no tts" });
      return { requestId: "req-1", cancel: vi.fn() };
    });

    startReadAloud({ client, text: "hello", ownerId: "turn-1", serverId: "srv-1" });

    const snapshot = getReadAloudSnapshot();
    expect(snapshot.failure?.code).toBe("tts_unavailable");
    expect(snapshot.rate).toBe(2);
  });
});
