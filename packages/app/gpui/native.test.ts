import { afterAll, beforeAll, expect, test } from "vitest";

// Runs against the actual Paseo bundle in the compiled GPUI app. Start with
// RN_GPUI_TEST_DRIVER=1 and pass its loopback URL and token to this test.
const endpoint = process.env.PASEO_GPUI_TEST_URL;
const token = process.env.PASEO_GPUI_TEST_TOKEN;
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

test.skipIf(!endpoint)(
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
      await request("press", { key: "ctrl-a" });
      await request("press", { key: "backspace" });
      expect(
        await request("type", { tag: input.tag, text: "GPUI native input regression" }),
      ).toEqual({ typed: true });
      await expect
        .poll(async () => (await request<{ text: string }>("getProps", { tag: input.tag })).text)
        .toBe("GPUI native input regression");
    } finally {
      await request("press", { key: "ctrl-a" });
      await request("press", { key: "backspace" });
      if (original) await request("type", { tag: input.tag, text: original });
    }
  },
  45_000,
);
