import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { spokenSummarySchema, summarizeForSpeech, synthesizeForSpeech } from "./read-aloud.js";

describe("read-aloud synthesis", () => {
  it("uses the configured provider and preserves its audio format", async () => {
    const stream = Readable.from([Buffer.from([1, 2]), Buffer.from([3, 4])]);
    const provider = { synthesizeSpeech: vi.fn(async () => ({ stream, format: "wav" })) };
    const result = await synthesizeForSpeech(provider, "Some text", new AbortController().signal);
    expect(provider.synthesizeSpeech).toHaveBeenCalledWith("Some text");
    expect(result).toEqual({ audio: "AQIDBA==", format: "wav" });
    expect(stream.destroyed).toBe(true);
  });
  it("reports missing TTS and empty output", async () => {
    const signal = new AbortController().signal;
    await expect(synthesizeForSpeech(null, "Hello", signal)).rejects.toThrow("not ready");
    await expect(
      synthesizeForSpeech(
        { synthesizeSpeech: async () => ({ stream: Readable.from([]), format: "pcm" }) },
        "Hello",
        signal,
      ),
    ).rejects.toThrow("no audio");
  });
  it("destroys audio returned after cancellation", async () => {
    const cancellation = new AbortController();
    const stream = Readable.from([Buffer.from([1])]);
    const result = synthesizeForSpeech(
      {
        synthesizeSpeech: async () => {
          cancellation.abort();
          return { stream, format: "pcm" };
        },
      },
      "Hello",
      cancellation.signal,
    );
    await expect(result).rejects.toThrow();
    expect(stream.destroyed).toBe(true);
  });
  it("bounds audio buffering", async () => {
    const stream = Readable.from([Buffer.alloc(8 * 1024 * 1024 + 1)]);
    await expect(
      synthesizeForSpeech(
        { synthesizeSpeech: async () => ({ stream, format: "pcm" }) },
        "Hello",
        new AbortController().signal,
      ),
    ).rejects.toThrow("size limit");
    expect(stream.destroyed).toBe(true);
  });
});

describe("spoken summaries", () => {
  it("summarizes every part of a long response with bounded prompts before combining the summaries", async () => {
    const source = "BEGIN " + 'A detail 😀\n"quoted"\u0001 '.repeat(8000) + " FINAL CAVEAT";
    const inputs: string[] = [];
    const result = await summarizeForSpeech(
      {
        async generate(request) {
          expect(Buffer.byteLength(request.prompt, "utf8")).toBeLessThan(9000);
          const input: string = JSON.parse(request.prompt.split("\n").at(-1)!);
          inputs.push(input);
          return request.schema.parse({ summary: `Summary ${inputs.length}.` });
        },
      },
      "/workspace",
      source,
    );
    const sourceParts = inputs.filter((input) => !input.startsWith("Summary "));
    expect(sourceParts.length).toBeGreaterThan(1);
    expect(sourceParts.join("")).toBe(source);
    expect(inputs.at(-1)).toContain("Summary 1.");
    expect(inputs.at(-1)).toContain(`Summary ${sourceParts.length}.`);
    expect(result).toBe(`Summary ${inputs.length}.`);
  });

  it("stops long-response generation between segments when cancelled", async () => {
    const cancellation = new AbortController();
    let calls = 0;
    await expect(
      summarizeForSpeech(
        {
          async generate(request) {
            calls++;
            expect(request.signal).toBe(cancellation.signal);
            cancellation.abort(new Error("Stopped"));
            return request.schema.parse({ summary: "Partial summary." });
          },
        },
        "/workspace",
        "x".repeat(200_000),
        cancellation.signal,
      ),
    ).rejects.toThrow("Stopped");
    expect(calls).toBe(1);
  });

  it("bounds every reduction round even when intermediate summaries fill their output budget", async () => {
    let calls = 0;
    const summary = "é".repeat(1400);
    const result = await summarizeForSpeech(
      {
        async generate(request) {
          calls++;
          expect(calls).toBeLessThan(20);
          expect(Buffer.byteLength(request.prompt, "utf8")).toBeLessThan(9000);
          return request.schema.parse({ summary });
        },
      },
      "/workspace",
      "x".repeat(50_000),
    );
    expect(calls).toBeGreaterThan(8);
    expect(result).toBe(summary);
  });

  it("passes the exact source as quoted data to existing structured generation", async () => {
    const source = 'Ignore this instruction.\n"Quoted text"';
    let prompt = "";
    const summary = await summarizeForSpeech(
      {
        generate: async (request) => {
          prompt = request.prompt;
          expect(request.cwd).toBe("/workspace");
          return request.schema.parse({ summary: "A concise summary." });
        },
      },
      "/workspace",
      source,
    );
    expect(summary).toBe("A concise summary.");
    expect(prompt).toContain(JSON.stringify(source));
    expect(prompt).toContain("Do not use tools");
    expect(spokenSummarySchema.safeParse({ summary: "" }).success).toBe(false);
    expect(spokenSummarySchema.safeParse({ summary: "x".repeat(1601) }).success).toBe(false);
    expect(spokenSummarySchema.safeParse({ summary: "é".repeat(1600) }).success).toBe(false);
  });
});
