import { expect, test } from "vitest";
import { createPlayAudio } from "./play-audio";
import { pcmToWav } from "./pcm";
import { playFile, type FilePlaybackStatus, type FilePlayer } from "./file-playback";

const source = { base64: "UklGRg==", mimeType: "audio/wav" };
test("passes RPC file bytes to the shared engine and awaits completion", async () => {
  const owner = new AbortController();
  let finish!: () => void;
  const played = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let completed = false;
  const play = createPlayAudio(
    {
      async play(audio, signal) {
        expect(signal).toBe(owner.signal);
        expect(audio.type).toBe("audio/wav");
        expect(audio.size).toBe(4);
        expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]));
        await played;
        return 1;
      },
    },
    owner.signal,
  );
  const result = play(source).then(() => {
    completed = true;
    return undefined;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  finish();
  await result;
  expect(completed).toBe(true);
});

test.each([
  { ...source, base64: "garbage!" },
  { ...source, base64: "" },
  { ...source, mimeType: "text/plain" },
])("rejects invalid input before reaching a decoder: %o", async (input) => {
  const play = createPlayAudio(
    {
      play() {
        throw new Error("Reached decoder");
      },
    },
    new AbortController().signal,
  );
  await expect(play(input)).rejects.toThrow(/^Audio must/);
});

test("rejects calls from an unloaded plugin", async () => {
  const owner = new AbortController();
  owner.abort(new Error("Plugin unloaded"));
  const play = createPlayAudio(
    {
      play() {
        throw new Error("Reached decoder");
      },
    },
    owner.signal,
  );
  await expect(play(source)).rejects.toThrow("Playback stopped");
});

test("wraps voice PCM with its original sample rate and samples", () => {
  const pcm = new Uint8Array([0, 0, 255, 127, 0, 128]);
  const wav = pcmToWav(pcm, "audio/pcm;rate=24000;bits=16");
  const view = new DataView(wav.buffer);
  expect(view.getUint32(24, true)).toBe(24000);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(pcm.length);
  expect(wav.slice(44)).toEqual(pcm);
});

function filePlayer() {
  let listener: (status: FilePlaybackStatus) => void = () => {};
  let removed = false;
  let started = false;
  const player: FilePlayer = {
    play() {
      started = true;
    },
    remove() {
      removed = true;
    },
    addListener(_event, callback) {
      listener = callback;
      return {
        remove() {
          listener = () => {};
        },
      };
    },
  };
  return {
    player,
    status: (status: Partial<FilePlaybackStatus>) =>
      listener({
        playbackState: "ready",
        duration: 1,
        didJustFinish: false,
        isLoaded: true,
        ...status,
      }),
    removed: () => removed,
    started: () => started,
  };
}

test("native file playback waits for completion and releases its player", async () => {
  const h = filePlayer();
  const promise = playFile(h.player, new AbortController().signal);
  expect(h.started()).toBe(true);
  h.status({ didJustFinish: true });
  await expect(promise).resolves.toBe(1);
  expect(h.removed()).toBe(true);
});

test("native decoder errors reject and release the player", async () => {
  const h = filePlayer();
  const promise = playFile(h.player, new AbortController().signal);
  h.status({ playbackState: "failed" });
  await expect(promise).rejects.toThrow("could not be decoded");
  expect(h.removed()).toBe(true);
});

test("native cancellation releases playback and settles the caller", async () => {
  const h = filePlayer();
  const owner = new AbortController();
  const promise = playFile(h.player, owner.signal);
  owner.abort(new Error("Plugin unloaded"));
  await expect(promise).rejects.toThrow("Playback stopped");
  expect(h.removed()).toBe(true);
});
