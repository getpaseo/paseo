import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";

import { userMessageImages } from "./user-message-images.js";

test.each([
  [
    "Claude",
    { type: "image", source: { type: "base64", data: "aW1hZ2U=", media_type: "image/png" } },
  ],
  ["Pi/OMP/ACP", { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
  ["Codex", { type: "image", url: "data:image/png;base64,aW1hZ2U=" }],
  ["OpenCode", { type: "file", mime: "image/png", url: "data:image/png;base64,aW1hZ2U=" }],
  ["OpenCode v2", { type: "file", uri: "data:image/png;base64,aW1hZ2U=" }],
])(
  "recovers %s user image bytes without embedding base64 in the timeline",
  async (_provider, block) => {
    const images = await userMessageImages([block]);
    expect(images).toEqual([
      { id: expect.any(String), mimeType: "image/png", source: expect.any(String) },
    ]);
    expect(readFileSync(images[0].source, "utf8")).toBe("image");
    expect(images[0].source.startsWith("data:")).toBe(false);
  },
);

test("does not treat nested tool images or non-image files as user attachments", async () => {
  expect(
    await userMessageImages([
      {
        type: "tool_result",
        content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      },
      { type: "file", uri: "file:///tmp/report.pdf" },
    ]),
  ).toEqual([]);
});

// One unwritable image must not drop the message it travelled with.
vi.mock("./provider-image-output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-image-output.js")>();
  return {
    ...actual,
    materializeProviderImage: (
      image: Parameters<typeof actual.materializeProviderImage>[0],
    ): Promise<Awaited<ReturnType<typeof actual.materializeProviderImage>>> =>
      JSON.stringify(image).includes("UNWRITABLE")
        ? Promise.reject(new Error("image store write failed"))
        : actual.materializeProviderImage(image),
  };
});

test("keeps the images that stored when one fails", async () => {
  const images = await userMessageImages([
    { type: "image", data: "UNWRITABLE", mimeType: "image/png" },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  ]);
  expect(images).toHaveLength(1);
  expect(readFileSync(images[0].source, "utf8")).toBe("image");
});
