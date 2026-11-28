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
  await expect
    .poll(async () => {
      const node = (await nodes()).find((item) => item.testID === testID);
      return (node?.frame?.[2] ?? 0) > 0 && (node?.frame?.[3] ?? 0) > 0;
    })
    .toBe(true);
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
  await new Promise((r) => setTimeout(r, 800));
});

afterAll(() => socket?.close());

async function captureRaw(tag: number) {
  let png: string | undefined;
  await expect
    .poll(
      async () => {
        try {
          const res = await request<{ png: string }>("screenshot", { tag });
          png = res.png;
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000, interval: 100 },
    )
    .toBe(true);
  const bytes = Buffer.from(png!, "base64");
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { bytes, data, width: info.width, height: info.height, channels: info.channels };
}

function diffPixelCount(
  a: { data: Buffer; width: number; height: number; channels: number },
  b: { data: Buffer; width: number; height: number; channels: number },
  xMax = Math.min(a.width, b.width),
) {
  const w = Math.min(a.width, b.width, xMax);
  const h = Math.min(a.height, b.height);
  let diff = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * a.width + x) * a.channels;
      const ib = (y * b.width + x) * b.channels;
      if (
        Math.abs(a.data[ia]! - b.data[ib]!) > 12 ||
        Math.abs(a.data[ia + 1]! - b.data[ib + 1]!) > 12 ||
        Math.abs(a.data[ia + 2]! - b.data[ib + 2]!) > 12
      ) {
        diff++;
      }
    }
  }
  return diff;
}

function countMatchingPixels(
  img: { data: Buffer; width: number; height: number; channels: number },
  pred: (r: number, g: number, b: number, x: number, y: number) => boolean,
) {
  let count = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * img.channels;
      if (pred(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, x, y)) {
        count++;
      }
    }
  }
  return count;
}

test.skipIf(!endpoint || !markdownFixture)(
  "RN <Text> bold and italic probe matches renderer font resolution",
  async () => {
    const plain = await captureRaw((await nodeWithId("probe-text-plain")).tag);
    const bold = await captureRaw((await nodeWithId("probe-text-bold")).tag);
    const italic = await captureRaw((await nodeWithId("probe-text-italic")).tag);

    const boldDiff = diffPixelCount(plain, bold);
    const italicDiff = diffPixelCount(plain, italic);
    console.log(
      `[probe-text] plain=${plain.width}x${plain.height} boldDiff=${boldDiff} italicDiff=${italicDiff}`,
    );
    expect(bold.width).toBeGreaterThan(20);
  },
  20_000,
);

test.skipIf(!endpoint || !markdownFixture)(
  "EnrichedMarkdown renders every Phase 1 block type through caller interfaces and asserts regression.png",
  async () => {
    const view = await nodeWithId("markdown-view");
    expect(view.component).toBe("EnrichedMarkdown");
    expect(view.frame?.[2] ?? 0).toBeGreaterThan(200);
    expect(view.frame?.[3] ?? 0).toBeGreaterThan(250);

    const layoutNode = await nodeWithId("markdown-layout");
    const initialLayout = JSON.parse(layoutNode.text) as { height?: number; width?: number };
    expect(initialLayout.width ?? 0).toBeGreaterThan(200);
    expect(initialLayout.height ?? 0).toBeGreaterThan(250);

    // 1. Headings scale vertically between H1 and H5.
    const h1Node = await nodeWithId("block-h1-md");
    const h5Node = await nodeWithId("block-h5-md");
    expect(h1Node.frame?.[3] ?? 0).toBeGreaterThan((h5Node.frame?.[3] ?? 0) + 4);

    // 2. Emphasis + strikethrough visibly alter rendered ink vs plain prose.
    const empPlain = await captureRaw((await nodeWithId("block-emphasis-plain")).tag);
    const empStyled = await captureRaw((await nodeWithId("block-emphasis-styled")).tag);
    expect(diffPixelCount(empPlain, empStyled)).toBeGreaterThan(30);

    // 3. Inline code paints its #e2e8f0 pill background and keeps distinct glyph pixels.
    const codePlain = await captureRaw((await nodeWithId("block-inline-code-plain")).tag);
    const codeStyled = await captureRaw((await nodeWithId("block-inline-code")).tag);
    const pillBg = (r: number, g: number, b: number) =>
      Math.abs(r - 0xe2) <= 8 && Math.abs(g - 0xe8) <= 8 && Math.abs(b - 0xf0) <= 8 && b - r >= 6;
    expect(countMatchingPixels(codePlain, pillBg)).toBeLessThan(15);
    expect(countMatchingPixels(codeStyled, pillBg)).toBeGreaterThan(150);

    // 4. Unordered and ordered lists paint distinct gutter markers.
    const ulImg = await captureRaw((await nodeWithId("block-ul")).tag);
    const ulGutterX = Math.round(ulImg.width * 0.28);
    const ulGutterInk = countMatchingPixels(
      ulImg,
      (r, g, b, x) => x < ulGutterX && r < 140 && g < 140 && b < 140,
    );
    expect(ulGutterInk).toBeGreaterThan(12);

    const ol1 = await captureRaw((await nodeWithId("block-ol-1")).tag);
    const ol8 = await captureRaw((await nodeWithId("block-ol-8")).tag);
    expect(diffPixelCount(ol1, ol8, Math.round(ol1.width * 0.3))).toBeGreaterThan(10);

    // 5. Task lists paint checked vs unchecked state and toggle via caller event.
    const taskChecked = await captureRaw((await nodeWithId("block-task-checked")).tag);
    const taskUnchecked = await captureRaw((await nodeWithId("block-task-unchecked")).tag);
    const taskGutterX = Math.round(taskChecked.width * 0.22);
    const accentBlue = (r: number, g: number, b: number, x: number) =>
      x < taskGutterX && b - r > 50 && r < 80;
    expect(countMatchingPixels(taskChecked, accentBlue)).toBeGreaterThan(40);
    expect(countMatchingPixels(taskUnchecked, accentBlue)).toBe(0);

    const taskToggleNode = await nodeWithId("block-task-toggle-md");
    expect(await request("click", { tag: taskToggleNode.tag })).toEqual({ clicked: true });
    await expect.poll(async () => (await nodeWithId("task-event")).text).toBe("0:true:Ok");

    // 6. Blockquote paints left accent bar and tinted background.
    const bqImg = await captureRaw((await nodeWithId("block-blockquote")).tag);
    const bqBarX = Math.max(24, Math.round(bqImg.width * 0.08));
    const bqBar = countMatchingPixels(bqImg, (r, g, b, x) => x < bqBarX && b - r > 80 && r < 80);
    const bqFill = countMatchingPixels(
      bqImg,
      (r, g, b) => Math.abs(r - 0xef) < 12 && Math.abs(g - 0xf6) < 12 && b > 240,
    );
    expect(bqBar).toBeGreaterThan(40);
    expect(bqFill).toBeGreaterThan(400);

    // 7. Code block paints dark card, TypeScript header band, syntax-highlighted tokens, and fires onCodeBlockPress.
    const cbImg = await captureRaw((await nodeWithId("block-code")).tag);
    const cbSplitY = Math.round(cbImg.height * 0.42);
    const cbDarkBg = countMatchingPixels(cbImg, (r, g, b) => r < 30 && g < 40 && b < 70);
    const cbHeaderInk = countMatchingPixels(
      cbImg,
      (r, g, b, _x, y) => y < cbSplitY && (r > 90 || g > 90 || b > 100),
    );
    const cbSyntaxColors = countMatchingPixels(
      cbImg,
      (r, g, b, _x, y) =>
        y >= cbSplitY &&
        ((r > 150 && b > 200 && g < 180) || // purple keyword (#c084fc)
          (b > 200 && g > 150 && r < 120) || // cyan type (#38bdf8)
          (r > 200 && g > 150 && b < 110)), // amber number (#fbbf24)
    );
    expect(cbDarkBg).toBeGreaterThan(2000);
    expect(cbHeaderInk).toBeGreaterThan(25);
    expect(cbSyntaxColors).toBeGreaterThan(30);

    const codeNode = await nodeWithId("block-code-md");
    expect(await request("click", { tag: codeNode.tag })).toEqual({ clicked: true });
    await expect.poll(async () => (await nodeWithId("code-event")).text).toBe("ts:21");

    // 8. Table paints header tint and blue border.
    const tableImg = await captureRaw((await nodeWithId("block-table")).tag);
    const tableHeaderFill = countMatchingPixels(
      tableImg,
      (r, g, b) => Math.abs(r - 0xdb) < 16 && Math.abs(g - 0xea) < 16 && b > 240,
    );
    const tableBorderBlue = countMatchingPixels(tableImg, (r, g, b) => b - r > 80 && r < 80);
    expect(tableHeaderFill).toBeGreaterThan(400);
    expect(tableBorderBlue).toBeGreaterThan(100);

    // 9. Capture and structurally assert regression.png for the full composite document.
    const initialComposite = await captureRaw(view.tag);
    const directory = path.resolve(import.meta.dirname, "../../../.artifacts/gpui/markdown");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "regression.png"), initialComposite.bytes);

    expect(
      countMatchingPixels(initialComposite, (r, g, b) => r < 60 && g < 60 && b < 60),
    ).toBeGreaterThan(1500);
    expect(
      countMatchingPixels(initialComposite, (r, g, b) => b - r > 60 && r < 100),
    ).toBeGreaterThan(300);
    expect(
      countMatchingPixels(
        initialComposite,
        (r, g, b) =>
          (r > 150 && b > 200 && g < 180) ||
          (g > 180 && r < 160 && b < 190) ||
          (r > 200 && g > 150 && b < 110),
      ),
    ).toBeGreaterThan(80);
    // Dark code card + blue header table bands must both exist in the composite screenshot.
    expect(
      countMatchingPixels(initialComposite, (r, g, b) => r < 25 && g < 35 && b < 60),
    ).toBeGreaterThan(2000);
    expect(
      countMatchingPixels(
        initialComposite,
        (r, g, b) => Math.abs(r - 0xdb) < 16 && Math.abs(g - 0xea) < 16 && b > 240,
      ),
    ).toBeGreaterThan(300);

    // 10. Clicking a rendered link dispatches onLinkPress with the URL.
    const linkTarget = await nodeWithId("markdown-link-target");
    expect(linkTarget.frame?.[2] ?? 0).toBeGreaterThan(40);
    expect(linkTarget.frame?.[3] ?? 0).toBeGreaterThan(10);
    expect(await request("click", { tag: linkTarget.tag })).toEqual({ clicked: true });
    await expect
      .poll(async () => (await nodeWithId("pressed-link")).text)
      .toBe("https://example.com/docs");

    // 11. Streaming append increases layout height and paints new ink pixels in the composite screenshot.
    const streamBtn = await nodeWithId("markdown-stream-next");
    expect(await request("click", { tag: streamBtn.tag })).toEqual({ clicked: true });
    await expect
      .poll(
        async () =>
          (JSON.parse((await nodeWithId("markdown-layout")).text) as { height?: number }).height ??
          0,
      )
      .toBeGreaterThan(initialLayout.height ?? 0);

    await expect
      .poll(async () => {
        const streamedComposite = await captureRaw(view.tag);
        if (streamedComposite.height <= initialComposite.height) return 0;
        return countMatchingPixels(
          streamedComposite,
          (r, g, b, _x, y) => y >= initialComposite.height && r < 140 && g < 140 && b < 140,
        );
      })
      .toBeGreaterThan(80);
  },
  30_000,
);
