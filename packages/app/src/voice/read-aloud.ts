import { Buffer } from "buffer";
import type { PluginSpeechInput, PluginSpeechState } from "@getpaseo/plugin/client";
import type { AudioEngine } from "./audio-engine-types";

type Render = (
  input: { agentId: string; operation: "summarize" | "synthesize"; text: string },
  signal: AbortSignal,
) => Promise<{
  text?: string;
  audio?: string;
  format?: string;
}>;

/** Retains all response content, including code and links in full-response mode. */
export function splitSpeechText(text: string, max = 500): string[] {
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining.length > max) {
    const prefix = remaining.slice(0, max);
    const sentence = [...prefix.matchAll(/[.!?]\s+/g)].at(-1);
    let boundary = sentence ? sentence.index + sentence[0].length : prefix.lastIndexOf(" ");
    if (boundary < max / 2) boundary = max;
    // Do not split a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]/.test(remaining[boundary - 1])) boundary--;
    parts.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function createReadAloud(
  engine: Pick<AudioEngine, "initialize" | "play" | "stop" | "clearQueue">,
) {
  let state: PluginSpeechState = { status: "idle", key: null, error: null };
  let generation = 0;
  let owner: object | null = null;
  let cancellation: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: PluginSpeechState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  function stop(forOwner?: object) {
    if (forOwner && owner !== forOwner) return;
    generation++;
    cancellation?.abort();
    cancellation = null;
    if (owner) {
      engine.stop();
      engine.clearQueue();
    }
    owner = null;
    publish({ status: "idle", key: null, error: null });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop,
    async speak(input: PluginSpeechInput, render: Render, nextOwner: object) {
      stop();
      const current = generation;
      owner = nextOwner;
      cancellation = new AbortController();
      const signal = cancellation.signal;
      publish({ status: "preparing", key: input.key, error: null });
      try {
        if (!input.text.trim()) throw new Error("This response has no text to read.");
        if (input.text.length > 200_000)
          throw new Error("This response is too large to read aloud (200,000 character limit).");
        // Run from the click gesture so browsers can unlock audio before server work.
        await engine.initialize();
        if (generation !== current) return;
        let text = input.text;
        if (input.mode === "summary") {
          const result = await render(
            { agentId: input.agentId, operation: "summarize", text },
            signal,
          );
          if (generation !== current) return;
          if (!result.text?.trim()) throw new Error("Summary generation returned no text.");
          text = result.text;
        }
        for (const part of splitSpeechText(text)) {
          if (generation !== current) return;
          publish({ status: "preparing", key: input.key, error: null });
          const result = await render(
            { agentId: input.agentId, operation: "synthesize", text: part },
            signal,
          );
          if (generation !== current) return;
          if (!result.audio || !result.format)
            throw new Error("Speech synthesis returned no audio.");
          const bytes = Buffer.from(result.audio, "base64");
          let type = `audio/${result.format}`;
          if (result.format === "pcm") type = "audio/pcm;rate=24000;bits=16";
          if (result.format === "mp3") type = "audio/mpeg";
          publish({ status: "speaking", key: input.key, error: null });
          await engine.play({
            size: bytes.length,
            type,
            arrayBuffer: async () => Uint8Array.from(bytes).buffer,
          });
        }
        if (generation === current) {
          owner = null;
          publish({ status: "idle", key: null, error: null });
        }
      } catch (error) {
        if (generation !== current) return;
        owner = null;
        engine.stop();
        engine.clearQueue();
        publish({
          status: "idle",
          key: input.key,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}
