import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import type { EncodedVideoChunk, EncodedVideoFrame } from "@getpaseo/plugin/client/react-native";
import { encodedVideoHtml } from "./runtime";

interface Message {
  type: string;
  frame?: EncodedVideoFrame;
  requestId?: number;
  generation?: number;
  message?: string;
}
let browser: Browser;

/** Exercise the exact private document with real VP8 encoding and decoding. */
async function openCanvas() {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    Reflect.set(window, "messages", []);
    Reflect.set(window, "ReactNativeWebView", {
      postMessage(value: string) {
        Reflect.get(window, "messages").push(JSON.parse(value));
      },
    });
  });
  await page.route("http://localhost/video", (route) =>
    route.fulfill({ body: encodedVideoHtml, contentType: "text/html" }),
  );
  await page.goto("http://localhost/video");
  await page.waitForFunction(() =>
    Reflect.get(window, "messages").some((message: Message) => message.type === "ready"),
  );
  return page;
}

/** Produce raw key/delta chunks with the source encoder's Annex B H.264 setting. */
interface EncodingOptions {
  page: Page;
  codec?: string;
  count?: number;
}

async function encodedFrames({ page, codec = "vp8", count = 1 }: EncodingOptions) {
  return page.evaluate(
    async ({ encoderCodec, frameCount }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      const context = canvas.getContext("2d")!;
      const chunks: EncodedVideoChunk[] = [];
      let failure: DOMException | null = null;
      const encoder = new VideoEncoder({
        output(chunk) {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          let binary = "";
          for (const byte of data) binary += String.fromCharCode(byte);
          chunks.push({ type: chunk.type, timestamp: chunk.timestamp, dataBase64: btoa(binary) });
        },
        error(error) {
          failure = error;
        },
      });
      try {
        encoder.configure({
          codec: encoderCodec,
          ...(encoderCodec.startsWith("avc") ? { avc: { format: "annexb" as const } } : {}),
          width: 16,
          height: 16,
          bitrate: 100000,
          latencyMode: "realtime",
        });
        for (let index = 0; index < frameCount; index += 1) {
          context.fillStyle = index === 0 ? "red" : "lime";
          context.fillRect(0, 0, 16, 16);
          const frame = new VideoFrame(canvas, { timestamp: (index + 1) * 1000 });
          encoder.encode(frame, { keyFrame: index === 0 });
          frame.close();
        }
        await encoder.flush();
        if (failure) throw failure;
        return chunks;
      } finally {
        encoder.close();
      }
    },
    { encoderCodec: codec, frameCount: count },
  );
}
async function keyframe(options: Omit<EncodingOptions, "count">) {
  const frames = await encodedFrames(options);
  return frames[0]!.dataBase64;
}

async function send(page: Page, message: object) {
  await page.evaluate((value) => Reflect.get(window, "__PASEO_VIDEO__")(value), message);
}
/** Wait for codec/paint events without relying on wall-clock delays. */
async function waitForMessage(page: Page, type: string) {
  await page.waitForFunction(
    (expected) =>
      Reflect.get(window, "messages").some((message: Message) => message.type === expected),
    type,
  );
}
async function waitForFrame(page: Page, timestamp: number) {
  await page.waitForFunction(
    (expected) =>
      Reflect.get(window, "messages").some(
        (message: Message) => message.frame?.timestamp === expected,
      ),
    timestamp,
  );
}
async function nextPaint(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}
async function messages(page: Page): Promise<Message[]> {
  return page.evaluate(() => Reflect.get(window, "messages"));
}

beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PASEO_TEST_CHROMIUM_EXECUTABLE,
  });
});
afterAll(async () => {
  await browser?.close();
});

describe("Android video canvas document", () => {
  it.each(["vp8", "avc1.420033"])(
    "decodes %s and acknowledges only an explicitly painted frame",
    async (codec) => {
      const page = await openCanvas();
      try {
        const dataBase64 = await keyframe({ page, codec });
        await send(page, {
          type: "configure",
          generation: 1,
          config: { codec, codedWidth: 16, codedHeight: 16, optimizeForLatency: true },
        });
        await send(page, {
          type: "decode",
          generation: 1,
          chunk: { type: "key", timestamp: 1000, dataBase64 },
        });
        await waitForMessage(page, "frame");
        const output = await messages(page);
        const frame = output.find((message) => message.type === "frame")!.frame!;
        expect(frame).toEqual({ id: 1, timestamp: 1000, displayWidth: 16, displayHeight: 16 });
        expect(output.filter((message) => message.type === "presented")).toEqual([]);
        await send(page, { type: "present", generation: 1, frameId: frame.id, requestId: 3 });
        await waitForMessage(page, "presented");
        expect((await messages(page)).find((message) => message.type === "presented")).toEqual({
          type: "presented",
          generation: 1,
          requestId: 3,
        });
        const pixel = await page.evaluate(() =>
          Array.from(
            document.querySelector("canvas")!.getContext("2d")!.getImageData(8, 8, 1, 1).data,
          ),
        );
        expect(pixel[0]).toBeGreaterThan(240);
        expect(pixel[1]).toBeLessThan(10);
        expect(pixel[2]).toBeLessThan(10);
        expect(pixel[3]).toBe(255);
        expect((await messages(page)).filter((message) => message.type === "dequeue")).toHaveLength(
          1,
        );
      } finally {
        await page.close();
      }
    },
  );

  it.each(["vp8", "avc1.420033"])("presents a continuous %s key/delta chain", async (codec) => {
    const page = await openCanvas();
    try {
      const chunks = await encodedFrames({ page, codec, count: 3 });
      expect(chunks.map((chunk) => chunk.type)).toEqual(["key", "delta", "delta"]);
      await send(page, {
        type: "configure",
        generation: 1,
        config: { codec, codedWidth: 16, codedHeight: 16, optimizeForLatency: true },
      });
      for (const chunk of chunks) {
        await send(page, { type: "decode", generation: 1, chunk });
        await waitForFrame(page, chunk.timestamp);
      }
      const frame = (await messages(page)).find(
        (message) => message.frame?.timestamp === 3000,
      )!.frame!;
      await send(page, { type: "present", generation: 1, frameId: frame.id, requestId: 1 });
      await waitForMessage(page, "presented");
      const pixel = await page.evaluate(() =>
        Array.from(
          document.querySelector("canvas")!.getContext("2d")!.getImageData(8, 8, 1, 1).data,
        ),
      );
      expect(pixel[0]).toBeLessThan(10);
      expect(pixel[1]).toBeGreaterThan(240);
      expect(pixel[2]).toBeLessThan(10);
      expect((await messages(page)).filter((message) => message.type === "error")).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("reset releases retained frames and cannot acknowledge obsolete paint", async () => {
    const page = await openCanvas();
    try {
      const dataBase64 = await keyframe({ page });
      await send(page, {
        type: "configure",
        generation: 1,
        config: { codec: "vp8", codedWidth: 16, codedHeight: 16 },
      });
      await send(page, {
        type: "decode",
        generation: 1,
        chunk: { type: "key", timestamp: 1000, dataBase64 },
      });
      await waitForMessage(page, "frame");
      await page.evaluate(() => {
        const receive = Reflect.get(window, "__PASEO_VIDEO__");
        receive({ type: "present", generation: 1, frameId: 1, requestId: 1 });
        receive({ type: "reset", generation: 2 });
      });
      await nextPaint(page);
      await nextPaint(page);
      expect((await messages(page)).filter((message) => message.type === "presented")).toEqual([]);
      await send(page, { type: "present", generation: 2, frameId: 1, requestId: 2 });
      expect((await messages(page)).at(-1)).toMatchObject({
        type: "error",
        message: "Video frame was released",
      });
    } finally {
      await page.close();
    }
  });

  it("settles presentation failure when its retained frame is released before paint", async () => {
    const page = await openCanvas();
    try {
      const dataBase64 = await keyframe({ page });
      await send(page, {
        type: "configure",
        generation: 1,
        config: { codec: "vp8", codedWidth: 16, codedHeight: 16 },
      });
      await send(page, {
        type: "decode",
        generation: 1,
        chunk: { type: "key", timestamp: 1000, dataBase64 },
      });
      await waitForMessage(page, "frame");
      await page.evaluate(() => {
        const receive = Reflect.get(window, "__PASEO_VIDEO__");
        receive({ type: "present", generation: 1, frameId: 1, requestId: 1 });
        receive({ type: "release", generation: 1, frameId: 1 });
      });
      await nextPaint(page);
      await nextPaint(page);
      const output = await messages(page);
      expect(output.filter((message) => message.type === "presented")).toEqual([]);
      expect(output.at(-1)).toMatchObject({
        type: "error",
        generation: 1,
        message: "Video frame was released before presentation",
      });
    } finally {
      await page.close();
    }
  });

  it("decodes and presents a supported codec after configuration fails", async () => {
    const page = await openCanvas();
    try {
      await send(page, {
        type: "configure",
        generation: 1,
        config: { codec: "invalid-codec", codedWidth: 16, codedHeight: 16 },
      });
      await waitForMessage(page, "error");
      expect((await messages(page)).at(-1)).toMatchObject({ type: "error", generation: 1 });

      const dataBase64 = await keyframe({ page });
      await send(page, {
        type: "configure",
        generation: 3,
        config: { codec: "vp8", codedWidth: 16, codedHeight: 16 },
      });
      await send(page, {
        type: "decode",
        generation: 3,
        chunk: { type: "key", timestamp: 1000, dataBase64 },
      });
      await waitForFrame(page, 1000);
      const frame = (await messages(page)).find((message) => message.type === "frame")!.frame!;
      await send(page, { type: "present", generation: 3, frameId: frame.id, requestId: 1 });
      await waitForMessage(page, "presented");
      expect((await messages(page)).at(-1)).toMatchObject({
        type: "presented",
        generation: 3,
        requestId: 1,
      });
    } finally {
      await page.close();
    }
  });

  it("blocks network requests from the private decoder document", async () => {
    const page = await openCanvas();
    let requested = false;
    try {
      await page.route("https://paseo-video.invalid/probe", (route) => {
        requested = true;
        return route.abort();
      });
      const blocked = await page.evaluate(async () => {
        try {
          await fetch("https://paseo-video.invalid/probe");
          return false;
        } catch {
          return true;
        }
      });
      expect(blocked).toBe(true);
      expect(requested).toBe(false);
    } finally {
      await page.close();
    }
  });
});
