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
  frame?: [number, number, number, number];
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
    // Wait for async draft hydration (which resets an empty native TextInput once after mount).
    let settledTag: number | undefined;
    await expect
      .poll(
        async () => {
          const current = (await nodes()).find((node) => node.component === "TextInput")?.tag;
          const stable = current !== undefined && current === settledTag;
          settledTag = current;
          return stable;
        },
        { timeout: 15_000, interval: 500 },
      )
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

test.skipIf(!endpoint || appearanceFixture)(
  "real Paseo sizes controls for a pointer, not for touch",
  async () => {
    // Regression: GPUI took the native touch answer, so a 28 pt pointer control rendered at 44.
    const settings = await nodeWithId("sidebar-settings");
    const displays = await request<Array<{ primary: boolean; scaleFactor: number }>>("displays");
    const scale =
      displays.find((display) => display.primary)?.scaleFactor ?? displays[0]?.scaleFactor ?? 1;
    expect(settings.frame?.[3]).toBeDefined();
    expect(Math.abs(settings.frame![3] - 28)).toBeLessThanOrEqual(1 / scale);
  },
  20_000,
);

test.skipIf(!endpoint || appearanceFixture)(
  "real Paseo opens History",
  async () => {
    // Regression: the agent list's RefreshControl was undefined on GPUI, so History rendered
    // "Element type is invalid" instead of the list. The daemon needs at least one agent.
    const history = await nodeWithId("sidebar-sessions");
    expect(await request("click", { tag: history.tag })).toEqual({ clicked: true });
    // The list mounts after the agents load, so wait for a row, not for the search input.
    await expect
      .poll(
        async () => {
          const current = await nodes();
          if (current.some((node) => node.testID === "root-error-boundary")) return "error screen";
          return current.some((node) => node.testID.startsWith("agent-row-")) ? "list" : "loading";
        },
        { timeout: 15_000 },
      )
      .toBe("list");
  },
  30_000,
);

async function openWorkspaceAndWaitForComposer(workspaceRow: Node): Promise<Node> {
  expect(await request("click", { tag: workspaceRow.tag })).toEqual({ clicked: true });
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
  let settledTag: number | undefined;
  await expect
    .poll(
      async () => {
        const current = (await nodes()).find((node) => node.component === "TextInput")?.tag;
        const stable = current !== undefined && current === settledTag;
        settledTag = current;
        return stable;
      },
      { timeout: 15_000, interval: 500 },
    )
    .toBe(true);
  return (await nodes()).find((node) => node.component === "TextInput")!;
}

test.skipIf(!endpoint || appearanceFixture)(
  "real Paseo submits the composer on Enter and inserts a newline on Shift+Enter",
  async () => {
    await expect
      .poll(
        async () => (await nodes()).some((n) => n.testID.startsWith("sidebar-workspace-row-")),
        {
          timeout: 15_000,
        },
      )
      .toBe(true);
    const workspace = (await nodes()).find((n) => n.testID.startsWith("sidebar-workspace-row-"))!;
    const input = await openWorkspaceAndWaitForComposer(workspace);
    await request("click", { tag: input.tag });
    await request("press", { key: "secondary-a" });
    await request("press", { key: "backspace" });

    const marker = `GPUI Enter ${Date.now()}`;
    await request("type", { tag: input.tag, text: marker });
    await request("press", { key: "shift-enter" });
    await request("type", { tag: input.tag, text: "line2" });
    await expect
      .poll(async () => (await request<{ text: string }>("getProps", { tag: input.tag })).text)
      .toBe(`${marker}\nline2`);

    await request("press", { key: "enter" });
    await expect
      .poll(
        async () => {
          const current = (await nodes()).find((node) => node.component === "TextInput");
          if (!current) return null;
          return (await request<{ text: string }>("getProps", { tag: current.tag })).text;
        },
        { timeout: 15_000 },
      )
      .toBe("");
    await expect
      .poll(async () => (await nodes()).some((node) => node.text.includes(marker)), {
        timeout: 15_000,
      })
      .toBe(true);
  },
  45_000,
);

test.skipIf(!endpoint || appearanceFixture)(
  "real Paseo keeps the first workspace mounted when switching between two workspaces",
  async () => {
    await expect
      .poll(
        async () =>
          (await nodes()).filter((n) => n.testID.startsWith("sidebar-workspace-row-")).length >= 2,
        { timeout: 15_000 },
      )
      .toBe(true);
    const rows = (await nodes()).filter((n) => n.testID.startsWith("sidebar-workspace-row-"));
    const firstInput = await openWorkspaceAndWaitForComposer(rows[0]!);
    const firstTitle = (await nodes()).find((n) => n.testID === "workspace-header-title")?.text;

    await request("click", { tag: firstInput.tag });
    await request("press", { key: "secondary-a" });
    await request("press", { key: "backspace" });
    await request("type", { tag: firstInput.tag, text: "Kept across workspace switch" });
    await expect
      .poll(async () => (await request<{ text: string }>("getProps", { tag: firstInput.tag })).text)
      .toBe("Kept across workspace switch");

    try {
      expect(await request("click", { tag: rows[1]!.tag })).toEqual({ clicked: true });
      await expect
        .poll(
          async () => {
            const title = (await nodes()).find((n) => n.testID === "workspace-header-title")?.text;
            return title !== undefined && title !== firstTitle;
          },
          { timeout: 15_000 },
        )
        .toBe(true);

      expect(await request("click", { tag: rows[0]!.tag })).toEqual({ clicked: true });
      await expect
        .poll(
          async () => (await nodes()).find((n) => n.testID === "workspace-header-title")?.text,
          { timeout: 15_000 },
        )
        .toBe(firstTitle);

      // The exact Fabric node tag and draft text must survive because desktop retention keeps
      // inactive workspaces mounted instead of unmounting on switch.
      expect((await request<{ text: string }>("getProps", { tag: firstInput.tag })).text).toBe(
        "Kept across workspace switch",
      );
    } finally {
      await request("click", { tag: firstInput.tag });
      await request("press", { key: "secondary-a" });
      await request("press", { key: "backspace" });
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

test.skipIf(!endpoint || !appearanceFixture)(
  "onLayout fires with React Native layout shape for View, Text, TextInput, Image, and ScrollView",
  async () => {
    interface LayoutEntry {
      count: number;
      keys: string[];
      layout: { x: number; y: number; width: number; height: number };
    }
    const readLayouts = async () => {
      const node = await nodeWithId("layout-results");
      return JSON.parse(node.text) as Record<string, LayoutEntry>;
    };
    const targets = [
      ["view", "layout-view"],
      ["text", "layout-text"],
      ["textInput", "layout-text-input"],
      ["image", "layout-image"],
      ["scrollView", "layout-scroll"],
    ] as const;

    await expect
      .poll(async () => Object.keys(await readLayouts()).sort())
      .toEqual(targets.map(([key]) => key).sort());

    const initial = await readLayouts();
    const treeNodes = await nodes();
    for (const [key, testID] of targets) {
      const entry = initial[key];
      expect(entry.count, `${key} initial onLayout count`).toBe(1);
      expect(entry.keys, `${key} layout keys`).toEqual(["height", "width", "x", "y"]);
      expect(entry.layout.width, `${key} width`).toBeGreaterThan(0);
      expect(entry.layout.height, `${key} height`).toBeGreaterThan(0);
      const treeNode = treeNodes.find((n) => n.testID === testID);
      expect(treeNode?.frame, `${testID} frame`).toBeDefined();
      expect(entry.layout.x).toBeCloseTo(treeNode!.frame![0], 2);
      expect(entry.layout.y).toBeCloseTo(treeNode!.frame![1], 2);
      expect(entry.layout.width).toBeCloseTo(treeNode!.frame![2], 2);
      expect(entry.layout.height).toBeCloseTo(treeNode!.frame![3], 2);
    }

    const toggle = await nodeWithId("layout-resize-toggle");
    expect(await request("click", { tag: toggle.tag })).toEqual({ clicked: true });
    await expect
      .poll(async () => {
        const parsed = await readLayouts();
        return targets.every(([key]) => (parsed[key]?.count ?? 0) >= 2);
      })
      .toBe(true);

    const resized = await readLayouts();
    for (const [key] of targets) {
      expect(resized[key].count, `${key} resized onLayout count`).toBe(2);
      expect(resized[key].layout.width, `${key} resized width`).toBeGreaterThan(
        initial[key].layout.width,
      );
    }
  },
);
