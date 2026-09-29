import { describe, expect, it, vi } from "vitest";
import type { AudioPlaybackSource } from "./audio-engine-types";
import { createReadAloud, splitSpeechText } from "./read-aloud";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const input = { agentId: "agent", key: "response", mode: "full" as const, text: "Hello world." };
function setup() {
  const engine = {
    initialize: vi.fn(async () => {}),
    play: vi.fn(async (_audio: AudioPlaybackSource) => 1),
    stop: vi.fn(),
    clearQueue: vi.fn(),
  };
  const render = vi.fn(async (_request: { text: string; operation: string }) => ({
    audio: "AAAA",
    format: "pcm",
  }));
  return { engine, render, runtime: createReadAloud(engine) };
}

describe("read-aloud playback", () => {
  it("reports loading while each audio chunk is generated and speaking only during playback", async () => {
    const { runtime, engine } = setup();
    const generating = vi.fn();
    const playing = vi.fn();
    engine.play.mockImplementation(async () => {
      playing(runtime.getSnapshot().status);
      return 1;
    });
    await runtime.speak(
      { ...input, text: "x".repeat(750) },
      async () => {
        generating(runtime.getSnapshot().status);
        return { audio: "AAAA", format: "mp3" };
      },
      {},
    );
    expect(generating.mock.calls).toEqual([["preparing"], ["preparing"]]);
    expect(playing.mock.calls).toEqual([["speaking"], ["speaking"]]);
    expect(runtime.getSnapshot().status).toBe("idle");
  });

  it("reads every chunk of a long response, including code, without invoking summarization", async () => {
    const { runtime, render, engine } = setup();
    const text = "A complete sentence with details. ".repeat(70) + "```ts\nconst x = 42;\n``` End.";
    await runtime.speak({ ...input, text }, render, {});
    expect(
      render.mock.calls
        .map(([request]) => request.text)
        .join(" ")
        .replace(/\s+/g, " "),
    ).toBe(text.replace(/\s+/g, " "));
    expect(render.mock.calls.every(([request]) => request.operation === "synthesize")).toBe(true);
    expect(engine.play).toHaveBeenCalledTimes(render.mock.calls.length);
    expect(runtime.getSnapshot().status).toBe("idle");
    expect(engine.play.mock.calls[0][0].type).toBe("audio/pcm;rate=24000;bits=16");
  });

  it("summarizes only in summary mode and speaks the returned summary", async () => {
    const { runtime, engine } = setup();
    const render = vi.fn(async (request: { operation: string }) =>
      request.operation === "summarize"
        ? { text: "A short summary." }
        : { audio: "AAAA", format: "mp3" },
    );
    await runtime.speak({ ...input, mode: "summary" }, render, {});
    expect(render.mock.calls.map(([request]) => request)).toEqual([
      { agentId: "agent", operation: "summarize", text: input.text },
      { agentId: "agent", operation: "synthesize", text: "A short summary." },
    ]);
    expect(engine.play.mock.calls[0][0].type).toBe("audio/mpeg");
  });

  it("cancels pending summary work and ignores late results", async () => {
    const { runtime, engine } = setup();
    const pending = deferred<{ text: string }>();
    let signal: AbortSignal | undefined;
    const work = runtime.speak(
      { ...input, mode: "summary" },
      (_request, abort) => {
        signal = abort;
        return pending.promise;
      },
      {},
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    runtime.stop();
    expect(signal!.aborted).toBe(true);
    pending.resolve({ text: "Must never be played." });
    await work;
    expect(engine.play).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().status).toBe("idle");
  });

  it("replaces earlier playback and prevents its stale audio from leaking through", async () => {
    const { runtime, engine, render } = setup();
    const first = deferred<{ audio: string; format: string }>();
    const old = runtime.speak(input, () => first.promise, {});
    await Promise.resolve();
    await runtime.speak({ ...input, key: "new" }, render, {});
    first.resolve({ audio: "AAAA", format: "mp3" });
    await old;
    expect(engine.play).toHaveBeenCalledTimes(1);
  });

  it("stops between chunks and lets unrelated component cleanup leave playback alone", async () => {
    const { runtime, render, engine } = setup();
    const owner = {};
    const playback = deferred<number>();
    engine.play.mockImplementationOnce(() => playback.promise);
    const work = runtime.speak({ ...input, text: "One sentence. ".repeat(100) }, render, owner);
    await vi.waitFor(() => expect(engine.play).toHaveBeenCalledTimes(1));
    runtime.stop({});
    expect(runtime.getSnapshot().status).toBe("speaking");
    runtime.stop(owner);
    playback.resolve(1);
    await work;
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("surfaces synthesis failures and permits retry", async () => {
    const { runtime, render } = setup();
    await expect(
      runtime.speak(
        input,
        async () => {
          throw new Error("TTS unavailable");
        },
        {},
      ),
    ).rejects.toThrow("TTS unavailable");
    expect(runtime.getSnapshot().error).toBe("TTS unavailable");
    await runtime.speak(input, render, {});
    expect(runtime.getSnapshot().error).toBeNull();
  });

  it("rejects oversized input explicitly instead of silently truncating", async () => {
    const { runtime, render } = setup();
    await expect(runtime.speak({ ...input, text: "x".repeat(200001) }, render, {})).rejects.toThrow(
      "too large",
    );
    expect(render).not.toHaveBeenCalled();
  });

  it("preserves unicode characters at chunk boundaries", () => {
    const text = "x".repeat(499) + "😀" + "y".repeat(600);
    const parts = splitSpeechText(text);
    expect(parts.join("")).toBe(text);
    expect(parts.every((part) => part.length <= 500 && !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
  });
});
