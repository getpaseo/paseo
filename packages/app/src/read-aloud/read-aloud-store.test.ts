import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client";

const playReadAloudSegment = vi.fn().mockResolvedValue(undefined);
const stopReadAloudAudio = vi.fn();

vi.mock("@/read-aloud/read-aloud-audio", () => ({
  isReadAloudAudioSupported: true,
  playReadAloudSegment: (params: { audioBase64: string; format: string }) =>
    playReadAloudSegment(params),
  stopReadAloudAudio: () => stopReadAloudAudio(),
}));

const { getReadAloudSnapshot, startReadAloud, stopReadAloud } =
  await import("@/read-aloud/read-aloud-store");

/** Minimal stand-in: the store only ever calls `startReadAloud` on the client. */
function createClient(): DaemonClient {
  return {
    startReadAloud: vi.fn().mockReturnValue({ requestId: "req-1", cancel: vi.fn() }),
  } as unknown as DaemonClient;
}

describe("read aloud playback", () => {
  beforeEach(() => {
    stopReadAloud();
    vi.clearAllMocks();
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

  it("surfaces a daemon failure on the snapshot", () => {
    const client = createClient();
    vi.mocked(client.startReadAloud).mockImplementation((params) => {
      params.onError({ code: "tts_unavailable", message: "no tts" });
      return { requestId: "req-1", cancel: vi.fn() };
    });

    startReadAloud({ client, text: "hello", ownerId: "turn-1", serverId: "srv-1" });

    const snapshot = getReadAloudSnapshot();
    expect(snapshot.failure?.code).toBe("tts_unavailable");
  });
});
