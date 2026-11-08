import { afterAll, beforeAll, expect, test } from "vitest";
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Runs against the actual Paseo bundle in the compiled GPUI app. Start with
// RN_GPUI_TEST_DRIVER=1 and pass its loopback URL and token to this test.
const endpoint = process.env.PASEO_GPUI_TEST_URL;
const token = process.env.PASEO_GPUI_TEST_TOKEN;
const appearanceFixture = process.env.PASEO_GPUI_TEST_SCENE === "appearance";
let socket: WebSocket;
let nextId = 0;
interface Node {
  tag: number;
  component: string;
  testID: string;
  text: string;
  children?: Node[];
}
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

test.skipIf(!endpoint || appearanceFixture)(
  "real Paseo portal passes workspace clicks and the native composer edits text",
  async () => {
    const workspace = (await nodes()).find((node) =>
      node.testID.startsWith("sidebar-workspace-row-"),
    );
    expect(workspace, "connected daemon must have an existing workspace").toBeDefined();
    // Regression: the upstream box-none portal hit area intercepted this click.
    expect(await request("click", { tag: workspace!.tag })).toEqual({ clicked: true });
    await expect
      .poll(async () => (await nodes()).some((node) => node.testID === "workspace-header-title"), {
        timeout: 15_000,
      })
      .toBe(true);
    await expect
      .poll(async () => (await nodes()).some((node) => node.component === "TextInput"), {
        timeout: 15_000,
      })
      .toBe(true);
    const input = (await nodes()).find((node) => node.component === "TextInput")!;
    const original = (await request<{ text: string }>("getProps", { tag: input.tag })).text;
    try {
      await request("click", { tag: input.tag });
      await request("press", { key: "secondary-a" });
      await request("press", { key: "backspace" });
      expect(
        await request("type", { tag: input.tag, text: "GPUI native input regression" }),
      ).toEqual({ typed: true });
      await expect
        .poll(async () => (await request<{ text: string }>("getProps", { tag: input.tag })).text)
        .toBe("GPUI native input regression");
    } finally {
      await request("press", { key: "secondary-a" });
      await request("press", { key: "backspace" });
      if (original) await request("type", { tag: input.tag, text: original });
      await expect
        .poll(async () => (await request<{ text: string }>("getProps", { tag: input.tag })).text)
        .toBe(original);
    }
  },
  45_000,
);

async function nodeWithId(testID: string) {
  await expect.poll(async () => (await nodes()).some((node) => node.testID === testID)).toBe(true);
  return (await nodes()).find((node) => node.testID === testID)!;
}

async function expectBackground(node: Node, color: number) {
  await expect
    .poll(
      async () =>
        (await request<{ backgroundColor: number }>("getProps", { tag: node.tag })).backgroundColor,
    )
    .toBe(color);
}

test.skipIf(!endpoint || !appearanceFixture)(
  "Pressable render props receive hover state",
  async () => {
    const button = await nodeWithId("hover-render-prop");
    const outside = await nodeWithId("outside-hover");
    await request("hover", { tag: button.tag });
    await expectBackground(button, 0xff00ff00);
    await expect
      .poll(async () => (await nodes()).some((node) => node.text === "render hovered"))
      .toBe(true);
    await request("hover", { tag: outside.tag });
    await expectBackground(button, 0xff0000ff);
    await expect
      .poll(async () => (await nodes()).some((node) => node.text === "render idle"))
      .toBe(true);
  },
);

test.skipIf(!endpoint || !appearanceFixture)(
  "rounded borders follow the background curve",
  async () => {
    const node = await nodeWithId("rounded-border");
    const { png } = await request<{ png: string }>("screenshot", { tag: node.tag });
    const bytes = Buffer.from(png, "base64");
    const directory = path.resolve(import.meta.dirname, "../../../.artifacts/gpui/appearance");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "rounded-border.png"), bytes);
    const { data, info } = await sharp(bytes)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset =
        (Math.floor((y * info.height) / 100) * info.width + Math.floor((x * info.width) / 200)) *
        info.channels;
      return [...data.subarray(offset, offset + 3)];
    };
    // Outside the arc must be clear; the diagonal must have an actual curved
    // border, not four straight rules clipped to a rounded rectangle.
    expect(pixel(1, 1)).toEqual([255, 255, 255]);
    expect(pixel(8, 8)).toEqual([255, 0, 0]);
    expect(pixel(15, 15)).toEqual([0, 0, 255]);
    expect(pixel(100, 1)).toEqual([255, 0, 0]);
    expect(pixel(198, 98)).toEqual([255, 255, 255]);
  },
);

test.skipIf(!endpoint || !appearanceFixture)(
  "Pressable hover highlights enter and leave",
  async () => {
    const button = await nodeWithId("hover-button");
    const outside = await nodeWithId("outside-hover");
    await request("hover", { tag: button.tag });
    await expectBackground(button, 0xff00ff00);
    await request("hover", { tag: outside.tag });
    await expectBackground(button, 0xff0000ff);
  },
);

test.skipIf(!endpoint || !appearanceFixture)(
  "row hover survives entering a nested Pressable",
  async () => {
    const row = await nodeWithId("hover-row");
    const child = await nodeWithId("nested-button");
    const outside = await nodeWithId("outside-hover");
    await request("hover", { tag: row.tag });
    await request("hover", { tag: child.tag });
    await expectBackground(row, 0xff00ff00);
    await request("hover", { tag: outside.tag });
    await expectBackground(row, 0xff0000ff);
  },
);
