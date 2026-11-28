import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { existsSync, rmSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";
import { projectTimelineRows } from "../timeline-projection.js";
import { describe, expect, test } from "vitest";

import {
  MAX_PROVIDER_IMAGE_BYTES,
  isProviderImageMarkdown,
  materializeProviderImage,
  renderProviderImageOutputAsAssistantMarkdown,
} from "./provider-image-output.js";

const HASH = "a".repeat(64);

async function renderImageMarkdown(imagePath: string): Promise<string> {
  const item = await renderProviderImageOutputAsAssistantMarkdown({ path: imagePath });
  if (!item || item.type !== "assistant_message") {
    throw new Error("Expected provider image output to render as assistant markdown.");
  }
  return item.text;
}

describe("isProviderImageMarkdown", () => {
  test("matches the markdown emitted for a materialized attachment", () => {
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments/${HASH}.png)`)).toBe(true);
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments-a1B2c3/${HASH}.png)`)).toBe(
      true,
    );
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments/user-1000/${HASH}.png)`)).toBe(
      true,
    );
    expect(isProviderImageMarkdown(`![shot](/var/folders/x/paseo-attachments/${HASH}.webp)`)).toBe(
      true,
    );
    // Windows: backslash path separators are doubled by escapeMarkdownImageSource.
    expect(
      isProviderImageMarkdown(
        `![Image](C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Temp\\\\paseo-attachments\\\\${HASH}.png)`,
      ),
    ).toBe(true);
  });

  test("emits Windows file paths as file URIs", async () => {
    const markdown = await renderImageMarkdown(
      `C:\\Users\\me\\AppData\\Local\\Temp\\paseo-attachments\\${HASH}.png`,
    );

    expect(markdown).toBe(
      `\n\n![Image](file:///C:/Users/me/AppData/Local/Temp/paseo-attachments/${HASH}.png)\n\n`,
    );
    expect(isProviderImageMarkdown(markdown)).toBe(true);
  });

  test("emits POSIX file paths with spaces as valid file URI markdown", async () => {
    const markdown = await renderImageMarkdown(
      "/home/user/Projects/Project With Spaces/screenshot.png",
    );

    expect(markdown).toBe(
      "\n\n![Image](file:///home/user/Projects/Project%20With%20Spaces/screenshot.png)\n\n",
    );
  });

  test("encodes URI-significant characters in POSIX file paths", async () => {
    const markdown = await renderImageMarkdown("/tmp/screenshot#1?draft.png");

    expect(markdown).toBe("\n\n![Image](file:///tmp/screenshot%231%3Fdraft.png)\n\n");
  });

  test("preserves double-leading slashes in POSIX file paths", async () => {
    const markdown = await renderImageMarkdown("//tmp/screenshot#1.png");

    expect(markdown).toBe("\n\n![Image](file:////tmp/screenshot%231.png)\n\n");
  });

  test.each([
    ["UNC", "\\\\server\\share\\shot#1.png", "file://server/share/shot%231.png"],
    [
      "extended UNC",
      "\\\\?\\UNC\\server\\share\\shot?draft.png",
      "file://server/share/shot%3Fdraft.png",
    ],
  ])("encodes %s image paths as file URIs", async (_label, imagePath, expectedSource) => {
    expect(await renderImageMarkdown(imagePath)).toBe(`\n\n![Image](${expectedSource})\n\n`);
  });

  test("rejects user-authored markdown that is not a materialized attachment", () => {
    // No content hash — a hand-written path, not something the writer produced.
    expect(isProviderImageMarkdown("![diagram](./paseo-attachments/notes.png)")).toBe(false);
    expect(isProviderImageMarkdown("![logo](https://example.com/logo.png)")).toBe(false);
    // Image markdown that does not start the text.
    expect(isProviderImageMarkdown("see the chart: ![chart](x.png)")).toBe(false);
  });
});

describe("materializeProviderImage", () => {
  test("recreates the private temp directory if the cached directory is removed", async () => {
    const first = await materializeProviderImage({
      data: "YWJjMTIz",
      mimeType: "image/png",
    });
    const firstDir = path.dirname(first.path);
    expect(existsSync(first.path)).toBe(true);

    rmSync(firstDir, { recursive: true, force: true });

    const second = await materializeProviderImage({
      data: "ZGVmNDU2",
      mimeType: "image/png",
    });
    const secondDir = path.dirname(second.path);

    try {
      expect(existsSync(second.path)).toBe(true);
    } finally {
      rmSync(secondDir, { recursive: true, force: true });
    }
  });
});

describe("provider image paragraph boundaries", () => {
  test.each(["", "\n"])("keeps image outputs separate from prose ending in %j", async (ending) => {
    const image = await renderProviderImageOutputAsAssistantMarkdown({
      url: "https://example.com/chart.png",
    });
    if (!image) throw new Error("Expected image output");
    const projected = projectTimelineRows({
      mode: "projected",
      rows: [
        {
          seq: 1,
          timestamp: "2026-10-16T15:08:23Z",
          item: { type: "assistant_message", text: `Before${ending}`, messageId: "commentary" },
        },
        { seq: 2, timestamp: "2026-10-16T15:08:24Z", item: image },
        {
          seq: 3,
          timestamp: "2026-10-16T15:08:25Z",
          item: { type: "assistant_message", text: "After" },
        },
      ],
    });
    expect(projected).toHaveLength(1);
    const item = projected[0]!.item;
    if (item.type !== "assistant_message") throw new Error("Expected assistant message");
    const paragraphs = new MarkdownIt()
      .parse(item.text, {})
      .filter((token) => token.type === "inline");
    expect(paragraphs.map((token) => token.content)).toEqual([
      "Before",
      "![Image](https://example.com/chart.png)",
      "After",
    ]);
  });
});

test("materialized image output retains paragraph boundaries and attachment recognition", async () => {
  const item = await renderProviderImageOutputAsAssistantMarkdown(
    { data: "YWJjMTIz", mimeType: "image/png" },
    { materialize: async () => ({ path: `/tmp/paseo-attachments/${HASH}.png` }) },
  );
  expect(item).toEqual({
    type: "assistant_message",
    text: `\n\n![Image](file:///tmp/paseo-attachments/${HASH}.png)\n\n`,
  });
  if (!item || item.type !== "assistant_message") throw new Error("Expected image output");
  expect(isProviderImageMarkdown(item.text)).toBe(true);
});

test("repeated content is reused without rewriting the attachment", async () => {
  const image = {
    data: Buffer.from("dedupe regression").toString("base64"),
    mimeType: "image/png",
  };
  const first = await materializeProviderImage(image);
  const before = statSync(first.path, { bigint: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await materializeProviderImage(image);
  expect(second.path).toBe(first.path);
  expect(statSync(second.path, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
});

test("64 MiB materialization leaves the event loop responsive and preserves bytes", async () => {
  const bytes = Buffer.alloc(64 * 1024 * 1024, 37);
  const data = bytes.toString("base64");
  const materializing = new AsyncLocalStorage<boolean>();
  let loopAdvanced = false;
  let yieldedBeforeFilesystem: boolean | undefined;
  const hook = createHook({
    init(_id, type) {
      // The first filesystem request follows hashing. A later turn could
      // come from filesystem I/O even if hashing blocked the event loop.
      if (
        type === "FSREQPROMISE" &&
        materializing.getStore() &&
        yieldedBeforeFilesystem === undefined
      ) {
        yieldedBeforeFilesystem = loopAdvanced;
      }
    },
  });
  const probe = setImmediate(() => {
    loopAdvanced = true;
  });
  hook.enable();
  try {
    const result = await materializing.run(true, () =>
      materializeProviderImage({ data, mimeType: "image/png" }),
    );
    try {
      expect(yieldedBeforeFilesystem).toBe(true);
      expect(readFileSync(result.path).equals(bytes)).toBe(true);
    } finally {
      rmSync(result.path, { force: true });
    }
  } finally {
    hook.disable();
    clearImmediate(probe);
  }
});

test("preserves base64 decoding across whitespace and chunk boundaries", async () => {
  const bytes = Buffer.alloc(1024 * 1024, 123);
  const base64 = bytes.toString("base64");
  const data = base64.match(/.{1,77}/g)!.join("\n");
  const result = await materializeProviderImage({ data, mimeType: "image/png" });
  expect(readFileSync(result.path).equals(bytes)).toBe(true);
});

test("rejects oversized materialization before work and leaves the queue usable", async () => {
  const data = "A".repeat(Math.ceil(MAX_PROVIDER_IMAGE_BYTES / 3) * 4 + 260);
  await expect(materializeProviderImage({ data, mimeType: "image/png" })).rejects.toThrow(
    "exceeds",
  );
  const omitted = await renderProviderImageOutputAsAssistantMarkdown(
    { data, mimeType: "image/png" },
    { materialize: materializeProviderImage },
  );
  expect(omitted).toEqual({
    type: "assistant_message",
    text: "Image output was omitted because it was not available as a file path or URL.",
  });
  const image = await materializeProviderImage({ data: "YWJjMTIz", mimeType: "image/png" });
  expect(readFileSync(image.path).toString()).toBe("abc123");
});

test("simultaneous requests for the same content share the published file", async () => {
  const image = {
    data: Buffer.from("concurrent dedupe fixture").toString("base64"),
    mimeType: "image/png",
  };
  const results = await Promise.all([
    materializeProviderImage(image),
    materializeProviderImage(image),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(readFileSync(results[0].path).toString()).toBe("concurrent dedupe fixture");
});

test("a small image finishes before an earlier distinct 64 MiB image", async () => {
  const largeData = Buffer.alloc(64 * 1024 * 1024, 42).toString("base64");
  const smallData = Buffer.from("live image during large replay").toString("base64");
  const completionOrder: string[] = [];
  const large = materializeProviderImage({ data: largeData, mimeType: "image/png" }).then(
    (image) => {
      completionOrder.push("large");
      return image;
    },
  );
  const small = materializeProviderImage({ data: smallData, mimeType: "image/png" }).then(
    (image) => {
      completionOrder.push("small");
      return image;
    },
  );
  const images = await Promise.all([large, small]);
  for (const image of images) rmSync(image.path, { force: true });
  expect(completionOrder).toEqual(["small", "large"]);
});

test("publishing small distinct images stays within eight event-loop turns per image", async () => {
  const count = 20;
  const materializing = new AsyncLocalStorage<boolean>();
  let turn = 0;
  let lastActiveTurn = -1;
  let activeTurns = 0;
  const hook = createHook({
    before() {
      // A spinning immediate can tick many times while a filesystem worker is
      // still running. Count only turns that advance the materializations.
      if (materializing.getStore() && turn !== lastActiveTurn) {
        lastActiveTurn = turn;
        activeTurns++;
      }
    },
  });
  let probe = setImmediate(function tick() {
    turn++;
    probe = setImmediate(tick);
  });
  const images: string[] = [];
  hook.enable();
  try {
    await materializing.run(true, async () => {
      for (let index = 0; index < count; index++) {
        const data = Buffer.from(`small attachment ${index}`).toString("base64");
        const image = await materializeProviderImage({ data, mimeType: "image/png" });
        images.push(image.path);
      }
    });
  } finally {
    hook.disable();
    clearImmediate(probe);
    for (const image of images) rmSync(image, { force: true });
  }
  expect(activeTurns).toBeLessThanOrEqual(8 * count);
});

test("six concurrent 8 MiB images share the main-thread CPU budget", async () => {
  const inputs = Array.from({ length: 6 }, (_, index) => ({
    data: Buffer.alloc(8 * 1024 * 1024, index + 1).toString("base64"),
    mimeType: "image/png",
  }));
  const threadCpuMs = () => {
    const { user, system } = process.threadCpuUsage();
    return (user + system) / 1000;
  };
  let previous = threadCpuMs();
  let longest = 0;
  const probe = setInterval(() => {
    const now = threadCpuMs();
    longest = Math.max(longest, now - previous);
    previous = now;
  }, 1);
  try {
    const images = await Promise.all(inputs.map(materializeProviderImage));
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (const image of images) rmSync(image.path, { force: true });
    expect(longest).toBeLessThan(50);
  } finally {
    clearInterval(probe);
  }
});

test("a busy event loop does not spend the image decode budget", async () => {
  const count = 8;
  const materializing = new AsyncLocalStorage<boolean>();
  let decodeYields = 0;
  const hook = createHook({
    init(_id, type) {
      // Count decode budget refills. Waiting for the filesystem can take
      // any number of event-loop turns without scheduling a refill.
      if (type === "Immediate" && materializing.getStore()) decodeYields++;
    },
  });
  let busyTurns = 0;
  let probe = setImmediate(function tick() {
    busyTurns++;
    // Simulate unrelated work that exceeds a 10 ms decode slice.
    const end = performance.now() + 20;
    while (performance.now() < end) {
      // Keep this event-loop turn busy.
    }
    probe = setImmediate(tick);
  });
  const paths: string[] = [];
  hook.enable();
  try {
    for (let index = 0; index < count; index++) {
      const data = Buffer.from(`attachment on a busy loop ${index}`).toString("base64");
      const image = await materializing.run(true, () =>
        materializeProviderImage({ data, mimeType: "image/png" }),
      );
      paths.push(image.path);
    }
  } finally {
    hook.disable();
    clearImmediate(probe);
    for (const image of paths) rmSync(image, { force: true });
  }
  expect(busyTurns).toBeGreaterThan(0);
  // A prior materialization can leave the shared budget nearly depleted.
  expect(decodeYields).toBeLessThanOrEqual(1);
});
