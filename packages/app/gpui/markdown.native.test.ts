import { afterAll, beforeAll, expect, test } from "vitest";
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const endpoint = process.env.PASEO_GPUI_TEST_URL;
const token = process.env.PASEO_GPUI_TEST_TOKEN;
const markdownFixture = process.env.PASEO_GPUI_TEST_SCENE === "markdown";

interface Node {
  tag: number;
  component: string;
  testID: string;
  text: string;
  frame?: [number, number, number, number];
  children?: Node[];
}

let socket: WebSocket;
let nextId = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

function request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`GPUI ${method} timed out`));
    }, 15_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value as T);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, token } }));
  });
}

function flatten(node: Node): Node[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

async function nodes() {
  return (await request<{ children: Node[] }>("tree")).children.flatMap(flatten);
}

async function nodeWithId(testID: string) {
  await expect.poll(async () => (await nodes()).some((node) => node.testID === testID)).toBe(true);
  return (await nodes()).find((node) => node.testID === testID)!;
}

beforeAll(async () => {
  if (!endpoint) return;
  if (!token) throw new Error("PASEO_GPUI_TEST_TOKEN is required");
  socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("GPUI driver connection failed")), {
      once: true,
    });
  });
  socket.addEventListener("message", (event) => {
    const response = JSON.parse(String(event.data));
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    const error = response.error ?? response.result?.error;
    if (error) waiter.reject(new Error(JSON.stringify(error)));
    else waiter.resolve(response.result);
  });
});

afterAll(() => socket?.close());

test.skipIf(!endpoint || !markdownFixture)(
  "EnrichedMarkdown renders non-empty blocks, handles links, grows on stream updates, and paints pixels",
  async () => {
    const view = await nodeWithId("markdown-view");
    expect(view.component).toBe("EnrichedMarkdown");
    expect(view.frame?.[2] ?? 0).toBeGreaterThan(200);
    expect(view.frame?.[3] ?? 0).toBeGreaterThan(200);

    const layoutNode = await nodeWithId("markdown-layout");
    const initialLayout = JSON.parse(layoutNode.text) as { height?: number; width?: number };
    expect(initialLayout.width ?? 0).toBeGreaterThan(200);
    expect(initialLayout.height ?? 0).toBeGreaterThan(200);

    // Screenshot must contain non-uniform rendered ink and code/table surfaces.
    const { png } = await request<{ png: string }>("screenshot", { tag: view.tag });
    const bytes = Buffer.from(png, "base64");
    const directory = path.resolve(import.meta.dirname, "../../../.artifacts/gpui/markdown");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "regression.png"), bytes);

    const { data, info } = await sharp(bytes)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let darkPixels = 0;
    let blueOrColoredPixels = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (r < 60 && g < 60 && b < 60) darkPixels++;
      if (b - r > 40 || g - r > 30) blueOrColoredPixels++;
    }
    expect(darkPixels).toBeGreaterThan(500);
    expect(blueOrColoredPixels).toBeGreaterThan(50);

    // Clicking a rendered link dispatches onLinkPress with the URL.
    const linkTarget = await nodeWithId("markdown-link-target");
    expect(linkTarget.frame?.[2] ?? 0).toBeGreaterThan(40);
    expect(linkTarget.frame?.[3] ?? 0).toBeGreaterThan(10);
    expect(await request("click", { tag: linkTarget.tag })).toEqual({ clicked: true });
    await expect
      .poll(async () => (await nodeWithId("pressed-link")).text)
      .toBe("https://example.com/docs");

    // Streaming append increases measured markdown height cleanly.
    const streamBtn = await nodeWithId("markdown-stream-next");
    expect(await request("click", { tag: streamBtn.tag })).toEqual({ clicked: true });
    await expect
      .poll(
        async () =>
          (JSON.parse((await nodeWithId("markdown-layout")).text) as { height?: number }).height ??
          0,
      )
      .toBeGreaterThan(initialLayout.height ?? 0);
  },
);
